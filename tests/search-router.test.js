'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {route, lookup, parseRoute} = require('../src/searchRouter');
const {DeepSeekClient} = require('../src/llm');

test('语义路由验证 JSON；闲聊不搜索，明确平台不落入头条', async () => {
  assert.equal(parseRoute('{"query":"x"}'), null);
  assert.equal(parseRoute('{"need":true}'), null);
  const calls=[];
  const search={searchText:async(q,o)=>{calls.push([q,o]);return '资料';},hotNewsText:async()=>{throw Error('不应查头条');}};
  const llm={complete:async()=>'{"need":false}'};
  assert.equal(await lookup(llm,'晚安',{search}), '');
  assert.equal(await lookup(llm,'搜一下B站热搜',{search}),'资料');
  assert.match(calls[0][0],/site:bilibili.com/);
  llm.complete=async()=>'{"need":true,"query":"某个梗","fresh":"any"}';
  await lookup(llm,'这个梗来自哪里',{search});
  assert.equal(calls[1][1].fresh,'any');
});

test('路由失败回退规则；天气优先用户城市', async () => {
  let chosen;
  const search={weatherText:async(city)=>{chosen=city;return '天气资料';}, ipCity:async()=>{throw Error('不应猜城市');}};
  assert.equal(await lookup({complete:async()=>'{bad'},'上海天气如何',{config:{city:'北京'}, search}), '天气资料');
  assert.equal(chosen,'上海');
});

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
    assert.equal(count,1);assert.equal(body.max_tokens,160);assert.equal(body.enable_thinking,false);
    assert.equal(client.thinking,true);assert.equal(client.maxTokens,80);
  } finally {server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));}
});
