'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {route, lookup, parseRoute} = require('../src/searchRouter');
const {DeepSeekClient} = require('../src/llm');

test('辅助调用超时真正关闭 HTTP；不重试、不修改主模型思考与输出设置', async () => {
  let count=0, body;
  let closed;
  const disconnected=new Promise(resolve=>closed=resolve);
  const server=http.createServer((req,res)=>{
    count++;let raw='';req.on('data',c=>raw+=c);req.on('end',()=>body=JSON.parse(raw));
    res.on('close',closed);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const client=new DeepSeekClient({config:{paths:{},env:{}},runtime:{provider:'qwen',providerLabel:'测试',model:'qwen-plus',baseUrl:`http://127.0.0.1:${server.address().port}`,apiKey:'',needsKey:false,mock:false,maxTokens:80,thinking:true,timeoutMs:5000}});
    const result=await route(client,'查一下新型号',{timeoutMs:150});
    assert.equal(result.failed,true);
    await Promise.race([disconnected,new Promise((_,reject)=>setTimeout(()=>reject(Error('socket 未关闭')),2000).unref())]);
    assert.equal(count,1);assert.equal(body.max_tokens,400);assert.equal(body.enable_thinking,false);
    assert.equal(client.thinking,true);assert.equal(client.maxTokens,80);
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
});
