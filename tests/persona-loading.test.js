'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const lib=require('../src/personaLibrary'),backup=require('../src/memoryBackup');
const {DEFAULT_CONFIG}=require('../src/config'),{startServer}=require('../server');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'persona-load-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const c=structuredClone(DEFAULT_CONFIG);c.paths={dataDir:dir};return {c,dir};}
function body(c,extra={}){return {...lib.state(c,''),changes:[],...extra};}
function apply(c,extra={}){return lib.commit(c,lib.prepare(c,body(c,extra),''));}
test('保存 Markdown 立即生效，重新构造配置读取同一正文',t=>{
 const {c,dir}=fixture(t),x=lib.save(c,{name:'测试卡',content:'温柔旧版本'});apply(c,{defaultId:x.id});
 const before=lib.effective(c);lib.save(c,{...x,content:'严肃新版本'});assert.notEqual(lib.effective(c).stamp,before.stamp);
 const reload=structuredClone(DEFAULT_CONFIG);reload.paths={dataDir:dir};lib.restoreTuning(reload);assert.equal(lib.effective(reload).content,'严肃新版本');
 apply(c);assert.equal(lib.effective(c).content,'严肃新版本');assert.notEqual(lib.effective(c).stamp,before.stamp);
});
test('首次升级快照保留当时生效卡片和所有运行值',t=>{
 const {c,dir}=fixture(t);c.chat.historyTurns=198;c.chat.groupHistoryTurns=148;
 fs.writeFileSync(path.join(dir,'persona-library.json'),JSON.stringify({version:1,defaultId:'legacy',cards:[{id:'legacy',name:'旧收藏',content:'旧收藏正文'}],bindings:{},epoch:'before'}));
 const before=structuredClone(c);assert.equal(lib.effective(c).content,'旧收藏正文');assert.deepEqual(c,before);
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'persona-library.json'))).version,5);
});
test('统一载入同卡所有绑定，未改变的独立人格不跨边界',t=>{
 const {c}=fixture(t),a=lib.save(c,{name:'A',content:'A1'}),b=lib.save(c,{name:'B',content:'B1'});
 const u={platform:'web',chatType:'private',chatId:'fixture-chat'},g={platform:'web',chatType:'group',chatId:'fixture-group'};
 apply(c,{defaultId:a.id,changes:[{...u,id:a.id},{...g,id:b.id}]});
 const before=lib.effective(c,g).stamp;lib.save(c,{...a,content:'A2'});apply(c);
 assert.equal(lib.effective(c,u).content,'A2');assert.equal(lib.effective(c).content,'A2');assert.equal(lib.effective(c,g).stamp,before);
});
test('失败提交不写盘不改参数；版本冲突和越权参数明确拒绝',t=>{
 const {c,dir}=fixture(t);const state=body(c),before=fs.readFileSync(path.join(dir,'persona-library.json'),'utf8'),cfg=structuredClone(c);
 assert.throws(()=>lib.prepare(c,{...state,params:{...state.params,historyTurns:401}}));assert.deepEqual(c,cfg);assert.equal(fs.readFileSync(path.join(dir,'persona-library.json'),'utf8'),before);
 lib.save(c,{name:'其他页面',content:'新版'});assert.throws(()=>lib.prepare(c,state),/变化/);
 assert.throws(()=>lib.prepare(c,body(c,{params:{...lib.state(c).params,temperature:1}})),/不允许/);
});
test('单文件提交写入失败不影响运行人格与参数',t=>{
 const {c,dir}=fixture(t);const x=lib.save(c,{name:'新卡',content:'新正文'}),next=lib.prepare(c,body(c,{defaultId:x.id,params:{...lib.state(c).params,historyTurns:400}}));
 const before=lib.effective(c).stamp,chat=structuredClone(c.chat);
 fs.mkdirSync(path.join(dir,'persona-library.json.tmp'));
 assert.throws(()=>lib.commit(c,next));assert.equal(lib.effective(c).stamp,before);assert.deepEqual(c.chat,chat);
});
test('调整聊天参数不改变人格边界和其他运行参数，重启保留',t=>{
 const {c,dir}=fixture(t),before=structuredClone(c),stamp=lib.effective(c).stamp;
 apply(c,{params:{...lib.state(c).params,historyTurns:400,groupHistoryTurns:300,emoji:'少',emojiChance:.2,maxBubbles:4}});
 assert.equal(lib.effective(c).stamp,stamp);for(const key of ['memory','deepseek','group','care','share','features','wechat'])assert.deepEqual(c[key],before[key]);
 const reload=structuredClone(DEFAULT_CONFIG);reload.paths={dataDir:dir};lib.restoreTuning(reload);assert.equal(reload.chat.historyTurns,400);assert.equal(reload.persona.emojiLevel,'少');
});
test('备份恢复包含当前 Markdown 正文和聊天设置',t=>{
 const {c}=fixture(t);
 const taskRoot=fs.mkdtempSync(path.join(os.tmpdir(),'persona-backup-'));t.after(()=>fs.rmSync(taskRoot,{recursive:true,force:true}));
 const data=path.join(taskRoot,'data');fs.mkdirSync(data);c.paths.dataDir=data;
 const x=lib.save(c,{name:'备份卡',content:'旧版'});apply(c,{defaultId:x.id});lib.save(c,{...x,content:'新版'});
 const bundle=backup.collect(taskRoot);assert.equal(bundle.files.personaLibrary.cards.find(c=>c.id===x.id).content,'新版');
 lib.save(c,{...lib.list(c).cards.find(row=>row.id===x.id),content:'第三版'});backup.restoreFrom(taskRoot,bundle);
 assert.equal(lib.effective(c).content,'新版');assert.equal(lib.list(c).cards.find(row=>row.id===x.id).content,'新版');
});
test('HTTP 分区提交校验候选与账号、身份跨入口保存和热重载保留',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'persona-http-'));fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,wechat:{account:'fixture-account'},log:{level:'error'}}));
 const app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const request=async(p,b)=>fetch(app.url+'/api/'+p,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
 const api=async(p,b)=>{if((p==='card'||p==='persona-library/card')&&b){const check=await request(p.replace(/card$/,'card-check'),b);if(!check.ok)return check;b={...b,targetId:check.targetId,confirmation:check.token,overwrite:check.overwrite};}return request(p,b);};
 let state=await api('persona-library/state');const initial=structuredClone(app.runtime.config);
 assert.equal((await api('persona-library/bind',{default:true,id:'little-fish'})).ok,false);
 assert.equal((await api('persona-library/apply',{...state,changes:[{platform:'wechat',chatType:'private',chatId:'unlisted',id:'little-fish'}]})).ok,false);
 assert.equal((await api('persona-library/apply',{...state,account:'other',changes:[]})).ok,false);
 app.runtime.llm.normalizePersona=async s=>'## 性格\n'+s;
 const made=await api('persona-library/card',{name:'分区卡',content:'这是新版本'});state=await api('persona-library/state');
 assert.equal((await api('persona-library/parameters',{...state,params:{...state.params,privateMaxChars:180,historyTurns:400}})).ok,true);
 assert.equal((await api('persona-library/bindings',{platform:'web',account:state.account,bindingRevision:state.bindingRevisions.web,changes:[{platform:'web',chatType:'private',chatId:'default:private',id:made.card.id}]})).ok,true);
 assert.equal(lib.effective(app.runtime.config).id,'little-fish');assert.equal(lib.effective(app.runtime.config,{platform:'web',chatType:'private',chatId:'default:private'}).id,made.card.id);
 assert.equal(app.runtime.config.chat.privateMaxChars,180);
 await api('config',{patch:{'persona.name':'测试新名','persona.aliases':['测试别名']}});assert.equal(app.runtime.config.persona.name,'测试新名');assert.equal(app.runtime.config.chat.historyTurns,400);
 assert.equal(JSON.parse(fs.readFileSync(path.join(root,'data','persona.json'))).name,'测试新名');
 for(const key of ['memory','deepseek','group','care','share','features','wechat'])assert.deepEqual(app.runtime.config[key],initial[key]);
 const choices=await api('persona-library/choices');assert.ok(choices.web.some(x=>x.chatId==='default:private'));
});


test('超出新表单范围的既有值不因无关人格提交而被重置或拒绝',t=>{
 const {c}=fixture(t);c.chat.privateMaxChars=900;c.chat.groupMaxChars=450;c.chat.historyTurns=199;
 const before=structuredClone(c.chat);apply(c);assert.deepEqual(c.chat,before);
});
test('服务器重启保留已发布版本、身份及聊天参数；旧恢复接口不能绕过',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'persona-restart-'));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,log:{level:'error'}}));
 let app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const request=async(p,b)=>fetch(app.url+'/api/'+p,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
 const api=async(p,b)=>{if((p==='card'||p==='persona-library/card')&&b){const check=await request(p.replace(/card$/,'card-check'),b);if(!check.ok)return check;b={...b,targetId:check.targetId,confirmation:check.token,overwrite:check.overwrite};}return request(p,b);};
 app.runtime.llm.normalizePersona=async s=>'## 性格\n'+s;
 const card=(await api('persona-library/card',{name:'重启测试',content:'已载入旧版'})).card;
 const state=await api('persona-library/state');await api('persona-library/default',{id:card.id,defaultRevision:state.defaultRevision});await api('persona-library/parameters',{...state,params:{...state.params,historyTurns:400,groupHistoryTurns:300}});
 const saved=await api('persona-library/card',{...card,content:'保存即发布新版'});assert.ok(saved.ok,saved.error);
 await api('persona-library/identity',{name:'重启测试鱼',age:25,job:'测试职业',aliases:['测试别名']});
 assert.equal((await api('persona',{reset:true})).ok,false);assert.equal(lib.effective(app.runtime.config).id,card.id);
 await app.close();app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
 assert.match(lib.effective(app.runtime.config).content,/保存即发布新版/);
 assert.equal(app.runtime.config.chat.historyTurns,400);assert.equal(app.runtime.config.chat.groupHistoryTurns,300);assert.equal(app.runtime.config.persona.name,'重启测试鱼');
 assert.match(lib.list(app.runtime.config).cards.find(c=>c.id===card.id).content,/保存即发布新版/);
});
