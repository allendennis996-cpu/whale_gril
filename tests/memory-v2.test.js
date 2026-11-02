'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const v2=require('../src/memoryV2');
const maintenance=require('../src/memoryMaintenance');
const backup=require('../src/memoryBackup');
const {MemoryContext,tokens}=require('../src/memoryContext');
const lib=require('../src/personaLibrary');
const {DEFAULT_CONFIG}=require('../src/config');

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-memory-v2-'));
  fs.mkdirSync(path.join(root,'data'));
  const config=structuredClone(DEFAULT_CONFIG);
  config.paths={dataDir:path.join(root,'data'),storeFile:path.join(root,'data','store.json')};
  config.wechat.account='demo-account-a';config.wechat.allowlist={users:[{id:'demo-peer',name:'虚构用户'}],groups:[]};
  t.after(()=>fs.rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:50}));
  return {root,config,dir:config.paths.dataDir};
}
function seed(dir) {
  const snapshot={sessions:{
    'web:u:demo':{platform:'web',chatId:'demo',chatType:'private',messages:[{role:'user',text:'网页历史',ts:1}],profiles:{},state:{}},
    'wechat:u:demo-peer':{platform:'wechat',chatId:'demo-peer',chatType:'private',messages:[{role:'user',text:'旧微信历史',ts:2}],profiles:{},state:{}}
  }};
  fs.writeFileSync(path.join(dir,'store.json'),JSON.stringify(snapshot));return snapshot;
}

test('只读预检不改文件；未知账号保留；迁移可重复，回退保留命名空间和新增消息',t=>{
  const {root,config,dir}=fixture(t);seed(dir);
  const original=fs.readFileSync(path.join(dir,'store.json'),'utf8');
  assert.equal(maintenance.inspect(root).unassigned,1);
  assert.deepEqual(fs.readdirSync(dir),['store.json']);
  const migrated=maintenance.migrate(root,{'wechat:u:demo-peer':'demo-account-a'});
  assert.equal(migrated.ready,2);assert.equal(maintenance.migrate(root).already,true);
  let store=v2.createStore(config);const msg={platform:'wechat',account:'demo-account-a',chatType:'private',chatId:'demo-peer'};
  const key=store.keyFor(msg);assert.equal(store.messages(key)[0].text,'旧微信历史');
  assert.notEqual(key,store.keyFor({...msg,account:'demo-account-b'}));
  assert.throws(()=>store.keyFor({...msg,account:''}),/缺少来源账号/);
  assert.throws(()=>maintenance.rollback(root),/服务仍在运行/);
  store.appendMessage(key,{role:'assistant',text:'迁移后回复'});store.close();
  maintenance.rollback(root);store=v2.createStore(config);
  assert.equal(store.messages(key).at(-1).text,'迁移后回复');store.close();
  maintenance.migrate(root);store=v2.createStore(config);
  assert.equal(store.messages(key).length,2);store.close();
  assert.equal(fs.readFileSync(path.join(dir,'store.json'),'utf8'),original);
  assert.ok(fs.readdirSync(path.join(dir,'backups')).every(x=>x.startsWith('memory-maintenance-')));
});

test('原文追加后可崩溃恢复；半写尾行修复；中段损坏拒绝启动而不清库',t=>{
  const {root,config,dir}=fixture(t);seed(dir);maintenance.migrate(root);
  let store=v2.createStore(config);const key='web:u:demo';
  store.appendMessage(key,{role:'user',text:'已确认的新消息'});store.close();
  const folder=v2.directory(dir,v2.mode(dir));const file=path.join(folder,v2.hash(key),'messages.jsonl');
  fs.appendFileSync(file,'{"op":');
  store=v2.createStore(config);assert.equal(store.messages(key).at(-1).text,'已确认的新消息');
  store.appendMessage(key,{role:'user',text:'尾行修复后'});store.close();
  store=v2.createStore(config);assert.equal(store.messages(key).length,3);store.resetSession(key);store.close();
  store=v2.createStore(config);assert.equal(store.messages(key).length,0);store.close();
  fs.appendFileSync(file,'BROKEN\n');const before=fs.readFileSync(file,'utf8');
  assert.throws(()=>v2.createStore(config),/中段损坏/);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('记忆跨人格共享，生成期间人格变更仍作废',t=>{
  const {root,config}=fixture(t);maintenance.migrate(root);const store=v2.createStore(config);t.after(()=>store.close());
  const msg={platform:'web',chatId:'demo',chatType:'private'};
  lib.history(config,msg,[],store);
  const history=[{role:'assistant',text:'旧人格回复',personaVersion:{...msg.personaVersion}}];
  const saved=lib.publish(config,{name:'虚构人格',content:'当前人格正文'});
  lib.setDefault(config,{id:saved.id,defaultRevision:lib.state(config).defaultRevision});
  assert.equal(lib.current(config,msg),false);
  const shared=lib.history(config,{...msg},history,store);assert.equal(shared.length,1);assert.match(shared[0].text,/旧人格回复/);
});

test('后台整理低频执行；重置后迟到结果不能写回；token预算包含输出预留',async t=>{
  const {root,config}=fixture(t);maintenance.migrate(root);const store=v2.createStore(config);t.after(()=>store.close());
  const key='web:u:demo',msg={platform:'web',chatType:'private',chatId:'demo',text:'我们之前聊的咖啡'};
  store.ensureSession(key,msg);
  for(let i=0;i<20;i++)store.appendMessage(key,{role:'user',uid:'demo-user',text:'我喜欢咖啡'+i});
  let release,entered;const started=new Promise(resolve=>entered=resolve);
  const llm={maxTokens:256,model:'fixture',complete:()=>{entered();return new Promise(resolve=>release=resolve);}};
  const worker=new MemoryContext(store,config);store.worker=worker;
  const selected=worker.select(key,msg,store.messages(key,100),'系统人格',llm);
  assert.ok(tokens(selected.history.map(x=>x.text).join(''))<config.memory.dialogueBudget);
  assert.equal(store.activity.get(key).outputReserve,256);
  await started;store.resetSession(key);release('{"summary":"不得回写","facts":[]}');
  await new Promise(resolve=>setImmediate(resolve));assert.equal(store.ensureSession(key).derived.summary,undefined);
});

test('v2备份含独立人格正文，离线恢复；v1导入不猜微信归属，已有密钥优先',t=>{
  const {root,config,dir}=fixture(t);seed(dir);maintenance.migrate(root);
  const store=v2.createStore(config);lib.publish(config,{name:'虚构备份卡',content:'卡片正文'});store.close();
  fs.writeFileSync(path.join(dir,'settings.json'),JSON.stringify({keys:{qwen:'fixture-current'}}));
  const bundle=backup.collect(root);assert.equal(bundle.version,2);assert.equal(bundle.memoryBackend,'v2');
  assert.ok(bundle.files.personaLibrary.cards.some(c=>c.content==='卡片正文'));assert.equal(bundle.files.settings.keys,undefined);
  bundle.files.settings.keys={qwen:'fixture-old'};
  maintenance.restore(root,bundle);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'settings.json'))).keys.qwen,'fixture-current');
  const legacy={kind:'whale-girl-memory',version:1,files:{store:seed(dir)}};
  maintenance.restore(root,legacy);assert.equal(maintenance.inspect(root).unassigned,1);
  const recovered=v2.createStore(config);assert.equal(recovered.messages('web:u:demo')[0].text,'网页历史');recovered.close();
});

test('后台事实整理成功可跨重启检索；五分钟内不重复整理；账号撤权丢弃迟到结果',async t=>{
  const {root,config}=fixture(t);maintenance.migrate(root);
  let store=v2.createStore(config);
  const msg={platform:'wechat',account:'demo-account-a',chatType:'private',chatId:'demo-peer',text:'咖啡'};
  const key=store.keyFor(msg);store.ensureSession(key,msg);
  for(let i=0;i<20;i++)store.appendMessage(key,{role:'user',uid:'demo-user',name:'虚构用户',text:'我喜欢咖啡'+i});
  let calls=0;
  const llm={maxTokens:256,complete:async({turns})=>{
    calls++;const input=JSON.parse(turns[0].content);const speaker=input.messages.find(x=>x.role==='user').speaker;
    return JSON.stringify({summary:'用户喜欢咖啡',facts:[{speaker,text:'喜欢咖啡'}]});
  }};
  let worker=new MemoryContext(store,config);store.worker=worker;
  worker.schedule(key,msg,llm);await worker.drain();
  assert.equal(store.ensureSession(key).derived.facts[0].uid,'demo-user');
  worker.schedule(key,msg,llm,true);await worker.drain();assert.equal(calls,1);
  store.close();store=v2.createStore(config);t.after(()=>store.close());worker=new MemoryContext(store,config);store.worker=worker;
  assert.equal(store.ensureSession(key).derived.summary,'用户喜欢咖啡');
  assert.match(worker.select(key,msg,[], '系统',llm).extra,/咖啡/);
  assert.equal(store.messages(store.keyFor({...msg,account:'demo-account-b'})).length,0);
  let release,entered;const started=new Promise(r=>entered=r);
  store.ensureSession(key).derived.lastAttempt=0;
  worker.schedule(key,msg,{complete:()=>{entered();return new Promise(r=>release=r);}},true);
  const done=worker.drain();await started;config.wechat.allowlist.users=[];
  release('{"summary":"撤权后禁止回写","facts":[]}');await done;
  assert.equal(store.ensureSession(key).derived.summary,'用户喜欢咖啡');
});

test('待归属记录可显式认领；维护锁和损坏记录阻止切换',t=>{
  const {root,config,dir}=fixture(t);seed(dir);maintenance.migrate(root);
  assert.equal(maintenance.inspect(root).unassigned,1);
  maintenance.migrate(root,{'wechat:u:demo-peer':'demo-account-a'});
  assert.equal(maintenance.inspect(root).unassigned,0);
  const store=v2.createStore(config);store.close();
  fs.writeFileSync(path.join(dir,'memory-maintenance.lock'),JSON.stringify({pid:process.pid}));
  assert.throws(()=>v2.createStore(config),/维护中/);
  fs.unlinkSync(path.join(dir,'memory-maintenance.lock'));
  fs.writeFileSync(path.join(dir,'memory-mode.json'),JSON.stringify({backend:'legacy'}));
  fs.writeFileSync(path.join(dir,'store.json'),JSON.stringify({sessions:{bad:{messages:'broken'}}}));
  assert.equal(maintenance.inspect(root).damaged,1);
  assert.throws(()=>maintenance.migrate(root),/损坏会话/);
  assert.equal(v2.mode(dir).backend,'legacy');
});

test('fsync失败不确认追加；上下文超限不调用模型；待整理期间清空不启动旧任务',async t=>{
  const {root,config}=fixture(t);maintenance.migrate(root);const store=v2.createStore(config);t.after(()=>store.close());
  const msg={platform:'web',chatType:'private',chatId:'demo',text:'输入'},key='web:u:demo';store.ensureSession(key,msg);store.markDirty();store.flush();
  const sync=fs.fsyncSync;fs.fsyncSync=()=>{throw Error('模拟磁盘同步失败');};
  try {assert.throws(()=>store.appendMessage(key,{role:'user',text:'不能确认'}),/同步失败/);}finally{fs.fsyncSync=sync;}
  assert.equal(store.messages(key).length,0);
  const worker=new MemoryContext(store,config);store.worker=worker;
  config.memory.contextTokens=600;
  assert.throws(()=>worker.select(key,msg,[],'长人格'.repeat(300),{maxTokens:256}),/上下文预算/);
  config.memory.contextTokens=0;
  let calls=0;for(let i=0;i<20;i++)store.appendMessage(key,{role:'user',text:'虚构内容'});
  worker.schedule(key,msg,{complete:async()=>{calls++;return '{"summary":"","facts":[]}';}});
  store.resetSession(key);await worker.drain();assert.equal(calls,0);
});


test('进程直接退出仍恢复已确认追加；清空日志在元数据更新前可重放',t=>{
  const {root,config,dir}=fixture(t);maintenance.migrate(root);
  const folder=v2.directory(dir,v2.mode(dir));
  const child=require('node:child_process').spawnSync(process.execPath,['-e',
    'const {V2Store}=require(process.argv[1]);const s=new V2Store({file:process.argv[2]});s.ensureSession("web:u:demo",{platform:"web",chatId:"demo"});s.appendMessage("web:u:demo",{role:"user",text:"退出前已确认"});process.exit(0);',require.resolve('../src/memoryV2'),folder],{windowsHide:true});
  assert.equal(child.status,0,child.stderr?.toString());
  let store=v2.createStore(config);assert.equal(store.messages('web:u:demo')[0].text,'退出前已确认');
  store.addNote('web:u:demo','demo-user','应清除的笔记');store.setMuted('web:u:demo',100000);
  store.markSeen('web:u:demo','demo-msg');store.flush();
  store.journal('web:u:demo',{op:'reset',revision:1,clearProfiles:true});store.close();
  store=v2.createStore(config);assert.equal(store.messages('web:u:demo').length,0);
  assert.equal(store.getState('web:u:demo').mutedUntil,0);
  assert.deepEqual(store.ensureSession('web:u:demo').seenIds,[]);
  assert.deepEqual(store.listNotes('web:u:demo'),[]);store.close();
});

test('切换前中断不改活动存储，重试不重复；回退后的待归属数据仍可认领',t=>{
  const {root,config,dir}=fixture(t);seed(dir);
  const rename=fs.renameSync;
  fs.renameSync=(from,to)=>{if(to===path.join(dir,'memory-mode.json'))throw Error('模拟切换前中断');return rename(from,to);};
  try {assert.throws(()=>maintenance.migrate(root),/切换前中断/);}finally{fs.renameSync=rename;}
  assert.equal(v2.mode(dir).backend,'legacy');
  maintenance.migrate(root);maintenance.rollback(root);
  maintenance.migrate(root,{'wechat:u:demo-peer':'demo-account-a'});
  assert.equal(maintenance.inspect(root).unassigned,0);
  const store=v2.createStore(config);
  assert.equal(store.messages('web:u:demo').length,1);
  assert.equal(store.messages(store.keyFor({platform:'wechat',account:'demo-account-a',chatType:'private',chatId:'demo-peer'})).length,1);
  store.close();
  fs.unlinkSync(path.join(v2.directory(dir,v2.mode(dir)),'manifest.json'));
  assert.throws(()=>v2.createStore(config),/清单缺失/);
});


test('合并批次部分重复时只处理新原消息，重启后仍能去重',async t=>{
  const {root,config}=fixture(t);maintenance.migrate(root);const store=v2.createStore(config);t.after(()=>store.close());
  config.links.enabled=false;config.websearch.enabled=false;
  const {Bot}=require('../src/bot');const bot=new Bot({config,store,llm:{isMock:true,maxTokens:256}});bot.mockChunkDelayMs=0;
  const msg={platform:'web',chatType:'private',chatId:'demo',senderId:'demo-user',senderName:'虚构用户'};
  await bot.handle({...msg,text:'先发',sourceMessages:[{id:'demo-first',text:'先发'}]});
  await bot.handle({...msg,text:'先发\n后发',sourceMessages:[{id:'demo-first',text:'先发'},{id:'demo-second',text:'后发'}]});
  const user=store.messages('web:u:demo').filter(x=>x.role==='user');
  assert.deepEqual(user.map(x=>x.text),['先发','后发']);assert.deepEqual(user[1].sourceIds,['demo-second']);
  const duplicate=await bot.handle({...msg,text:'后发',sourceMessages:[{id:'demo-second',text:'后发'}]});
  assert.equal(duplicate.action,'ignore');store.close();
  const reloaded=v2.createStore(config);assert.equal(reloaded.isDuplicate('web:u:demo','demo-second'),true);reloaded.close();
});

test('发送前接口拒绝旧选择、旧人格、过期和撤权回复',async t=>{
  const {root,config}=fixture(t);
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,log:{level:'error'},wechat:config.wechat,features:{memorySnapshot:false,mediaCleanup:false}}));
  const app=await require('../server').startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});t.after(()=>app.close());
  const current=app.runtime.config;
  const guard={platform:'wechat',account:'demo-account-a',selection:'demo-account-a',chatType:'private',chatId:'demo-peer',expiresAt:Date.now()+299000};
  guard.stamp=lib.effective(current,guard).stamp;
  const valid=async payload=>{const response=await fetch(app.url+'/api/bridge/reply-valid',{method:'POST',headers:{'Content-Type':'application/json','x-bot-token':current.gateway.wechat.inboundToken},body:JSON.stringify(payload)});return (await response.json()).valid;};
  assert.equal(await valid(guard),true);
  assert.equal(await valid({...guard,selection:'demo-account-b'}),false);
  assert.equal(await valid({...guard,stamp:'old-persona'}),false);
  assert.equal(await valid({...guard,expiresAt:Date.now()-1}),false);
  const disk=JSON.parse(fs.readFileSync(path.join(root,'config.json')));disk.wechat.allowlist.users=[];
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify(disk));assert.equal(await valid(guard),false);
});
