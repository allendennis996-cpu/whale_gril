'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const identities = require('../src/wechatIdentities');
const {startServer} = require('../server');

test('未放行群消息仅登记群/发送者元数据；不记录正文，不触发回复，重启后目录仍在', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-discovered-'));
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,server:{openBrowser:false},gateway:{wechat:{enabled:true,inboundToken:'identity-test'}}}));
  let app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const payload={chat_id:'456@chatroom',chat_type:'group',sender_id:'wxid_new',nickname:'小新',chat_title:'测试群',text:'SECRET_BODY_不可记录',media:'PRIVATE_MEDIA',msg_id:'one'};
  const response=await fetch(app.url+'/webhook/wechat',{method:'POST',headers:{'content-type':'application/json','x-bot-token':'identity-test','x-whale-bridge':'1'},body:JSON.stringify(payload)}).then(r=>r.json());
  assert.equal(response.reason,'not_allowlisted');
  let choices=await fetch(app.url+'/api/wechat/identities').then(r=>r.json());
  assert.equal(choices.users.find(r=>r.id==='wxid_new').name,'小新');
  assert.equal(choices.groups.find(r=>r.id==='456@chatroom').name,'测试群');
  const file=path.join(root,'data','wechat-identities.json');
  const stored=fs.readFileSync(file,'utf8');assert.doesNotMatch(stored,/SECRET_BODY|PRIVATE_MEDIA|msg_id|"text"/);
  for(const row of JSON.parse(stored).rows) assert.deepEqual(Object.keys(row).sort(),['id','lastSeen','name','type']);
  const state=await fetch(app.url+'/api/debug/state').then(r=>r.json());assert.equal(state.memory.messages,0);assert.equal(state.memory.sessions,0);
  await app.close();app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  choices=await fetch(app.url+'/api/wechat/identities').then(r=>r.json());assert.equal(choices.users.length,1);assert.equal(choices.groups.length,1);
});
test('合并桥接/网关/旧记录时按真实ID去重，不用空名称覆盖已知名称', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-id-merge-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'wechat-identities.bridge.json'),JSON.stringify({rows:[{id:'wxid_x',name:'桥接名称',lastSeen:3},{id:'456@chatroom',name:'群名称',lastSeen:4}]}));
  const result=identities.choices({paths:{dataDir:dir}},[{id:'wxid_x',name:'',lastSeen:5,text:'禁止'}]);
  assert.equal(result.users.length,1);assert.equal(result.users[0].name,'桥接名称');assert.equal(result.users[0].text,undefined);
  assert.equal(result.groups[0].name,'群名称');
  assert.equal(identities.clean({id:'unknown',name:'昵称'}),null);
});
