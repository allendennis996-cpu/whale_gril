'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {startServer} = require('../server');
const identities = require('../src/wechatIdentities');
const history = require('../src/wechatAccountHistory');
const A = 'wxid_bot_demo_A', B = 'wxid_bot_demo_B';

test('操作账号的名称/ID重启保留，离线自动选最近使用账号；手动选择优先且不串目录', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-account-history-'));
  const dbDir = path.join(root,'fake-wechat');
  for (const account of [A,B,'wxid_never_used']) fs.mkdirSync(path.join(dbDir,account,'db_storage'),{recursive:true});
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,wechat:{dbDir},gateway:{wechat:{enabled:true,inboundToken:'history-test'}},log:{level:'error'}}));
  let app = await startServer({root,port:0,env:{WHALE_LOG_FILE:''},openBrowser:false});
  t.after(async () => {await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const get = suffix => fetch(app.url+suffix).then(r=>r.json());
  const post = (suffix,body,token='history-test') => fetch(app.url+suffix,{method:'POST',headers:{'content-type':'application/json','x-bot-token':token},body:JSON.stringify(body)});
  assert.equal((await post('/api/bridge/heartbeat',{account:A,account_nick:'不能采信'},'bad-token')).status,403);
  assert.equal(history.accounts(app.runtime.config).length,0);
  await post('/api/bridge/heartbeat',{account:A,account_wxid:A,account_nick:'账号甲',account_db_dir:dbDir,text:'SECRET_BODY'});
  identities.remember(app.runtime.config,{platform:'wechat',chatType:'private',chatId:'wxid_shared',senderId:'wxid_shared',senderName:'甲的好友'},A);
  // 明确的历史先后关系，无须依赖机器计时精度。
  const aFile=identities.fileFor(path.join(root,'data'),A,'account.gateway');
  const aProfile=JSON.parse(fs.readFileSync(aFile,'utf8'));aProfile.lastActive=1;fs.writeFileSync(aFile,JSON.stringify(aProfile));
  await post('/api/bridge/heartbeat',{account:B,account_wxid:B,account_nick:'账号乙',account_db_dir:dbDir});
  identities.remember(app.runtime.config,{platform:'wechat',chatType:'private',chatId:'wxid_shared',senderId:'wxid_shared',senderName:'乙的好友'},B);
  await app.close();
  app = await startServer({root,port:0,env:{WHALE_LOG_FILE:''},openBrowser:false});
  const snapshot=await get('/api/wechat/accounts');
  assert.equal(snapshot.live.online,false);assert.equal(snapshot.wanted,'');assert.equal(snapshot.automatic,B);assert.equal(snapshot.resolved,B);
  assert.equal(snapshot.accounts.find(row=>row.account===A).nick,'账号甲');assert.equal(snapshot.accounts.find(row=>row.account===B).wxid,B);
  const choices=await get('/api/wechat/identities');assert.equal(choices.account,B);assert.equal(choices.accountName,'账号乙');assert.equal(choices.users[0].name,'乙的好友');
  const resolved=await post('/api/wechat/resolve-names',{type:'users',ids:['wxid_shared'],expectedAccount:B}).then(r=>r.json());
  assert.equal(resolved.ok,true);assert.equal(resolved.results[0].name,'乙的好友');assert.equal(resolved.results[0].source,'local');
  const refreshed=await post('/api/wechat/resolve-names',{type:'users',ids:['wxid_shared'],refresh:true}).then(r=>r.json());
  assert.equal(refreshed.ok,true);assert.equal(refreshed.results[0].source,'local');
  const self=await post('/api/wechat/resolve-names',{type:'users',ids:[B]}).then(r=>r.json());assert.equal(self.results[0].name,'账号乙');
  await post('/api/wechat/account',{account:A});
  await post('/api/bridge/heartbeat',{account:B,account_nick:'账号乙'});
  assert.equal((await get('/api/wechat/identities')).account,A);
  assert.equal((await get('/api/wechat/identities')).users[0].name,'甲的好友');
  await post('/api/wechat/account',{account:''});assert.equal((await get('/api/wechat/identities')).account,B);
  // 一分钟内再次操作旧账号也必须更新最近使用顺序，空昵称不能抹掉历史或继承另一账号。
  await post('/api/bridge/heartbeat',{account:A});
  const latest=await get('/api/wechat/accounts');assert.equal(latest.live.nick,'账号甲');assert.equal(latest.live.ok,null);
  await app.close();app=await startServer({root,port:0,env:{WHALE_LOG_FILE:''},openBrowser:false});
  assert.equal((await get('/api/wechat/identities')).account,A);
  for (const account of [A,B]) {
    const stored=fs.readFileSync(identities.fileFor(path.join(root,'data'),account,'account.gateway'),'utf8');
    assert.doesNotMatch(stored,/SECRET_BODY|"text"/);
    assert.deepEqual(Object.keys(JSON.parse(stored)).sort(),['account','dbDir','lastActive','nick','version','wxid']);
  }
});

test('桥接离线且数据库不可见时，按账号归属明确的旧目录恢复默认；不读取无归属目录', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-history-upgrade-'));
  const config={paths:{dataDir:path.join(root,'data')}};
  const file=identities.fileFor(config.paths.dataDir,A,'bridge');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({version:2,account:A,rows:[{id:'wxid_friend',name:'历史好友',lastSeen:100}]}));
  fs.writeFileSync(path.join(config.paths.dataDir,'wechat-identities.bridge.json'),JSON.stringify({rows:[{id:'wxid_legacy',name:'无归属身份'}]}));
  const app=await startServer({root,port:0,env:{WHALE_LOG_FILE:''},openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const choices=await fetch(app.url+'/api/wechat/identities').then(r=>r.json());
  assert.equal(choices.account,A);assert.deepEqual(choices.users.map(row=>row.id),['wxid_friend']);
  assert.equal((await fetch(app.url+'/api/wechat/accounts').then(r=>r.json())).accounts[0].account,A);
});

test('首次无任何账号才返回未确认；多个已发现数据库按活跃时间默认选择，历史资料不串号', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-first-account-'));
  const app=await startServer({root,port:0,env:{WHALE_LOG_FILE:''},openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const choices=()=>fetch(app.url+'/api/wechat/identities').then(r=>r.json());
  assert.equal((await choices()).account,'');
  app.runtime.config.wechat.dbDir=path.join(root,'fake-db');
  for (const [account,ts] of [[A,1000],[B,2000]]) {
    const dir=path.join(app.runtime.config.wechat.dbDir,account,'db_storage');fs.mkdirSync(dir,{recursive:true});
    const file=path.join(dir,'fake.db');fs.writeFileSync(file,'fake');fs.utimesSync(file,ts,ts);
  }
  assert.equal((await choices()).account,B);
  // Python 写入的账号资料使用同一命名空间；放错目录的账号标记不得采信。
  const file=identities.fileFor(app.runtime.config.paths.dataDir,A,'account.bridge');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({version:1,account:B,nick:'错误归属',lastActive:Date.now()}));
  assert.equal(history.accounts(app.runtime.config).length,0);
  fs.writeFileSync(file,JSON.stringify({version:1,account:A,wxid:A,nick:'桥接保存的账号甲',lastActive:Date.now()}));
  const result=await fetch(app.url+'/api/wechat/accounts').then(r=>r.json());
  assert.equal(result.resolved,A);assert.equal(result.accounts.find(row=>row.account===A).nick,'桥接保存的账号甲');
});
