'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const lib=require('../src/personaLibrary'),persona=require('../src/persona');
const {DEFAULT_CONFIG}=require('../src/config');const {Store}=require('../src/memory');const {Bot}=require('../src/bot');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-cards-'));const c=structuredClone(DEFAULT_CONFIG);c.paths={dataDir:dir};c.wechat.account='fixture-account';c.wechat.allowlist={users:[{id:'fixture-user',name:''}],groups:[{id:'fixture-group@chatroom',name:''}]};const store=new Store({file:path.join(dir,'store.json'),limits:c.memory});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {c,dir,store};}
function card(c,name='温柔图书管理员'){return lib.save(c,{name,content:'你是{{name}}，{{age}}岁，职业{{job}}。友好沉静，认真回答。'});}
const msg=()=>({platform:'wechat',account:'fixture-account',chatType:'private',chatId:'fixture-user',senderId:'fixture-user',senderName:'测试好友',text:'今天怎么样'});
test('迁移备份、卡片增删改与默认切换不修改任何运行参数',t=>{const {c,dir}=fixture(t);const before=structuredClone(c);fs.writeFileSync(path.join(dir,'persona.json'),JSON.stringify({customPrompt:'旧角色'}));lib.list(c);assert.ok(fs.existsSync(path.join(dir,'persona.json.before-cards')));const x=card(c);lib.bind(c,{default:true,id:x.id});lib.save(c,{...x,content:x.content+'不敷衍'});lib.bind(c,{default:true,id:'little-fish'});const updated=lib.list(c).cards.find(a=>a.id===x.id);lib.remove(c,updated);assert.deepEqual(c,before);assert.equal(lib.list(c).defaultId,'little-fish');});
test('256KB、中文名、冲突和路径校验，超过旧60KB的卡可保存',t=>{const {c}=fixture(t),x=card(c);assert.throws(()=>card(c));assert.throws(()=>lib.save(c,{...x,revision:'stale'}));assert.throws(()=>lib.save(c,{id:'../bad',name:'bad',content:'x'}));assert.throws(()=>lib.save(c,{name:'长文本',content:'鱼'.repeat(90000)}));assert.ok(lib.save(c,{name:'较长卡',content:'鱼'.repeat(22000)}).id);});
test('默认继承、独立群友人格及微信账号、网页隔离',t=>{const {c}=fixture(t),x=card(c),m=msg();lib.bind(c,{...m,id:x.id});assert.equal(lib.effective(c,m).id,x.id);assert.equal(lib.effective(c,{...m,account:'another-account'}).id,'little-fish');assert.equal(lib.effective(c,{...m,chatType:'group'}).id,'little-fish');assert.equal(lib.effective(c,{...m,platform:'web'}).id,'little-fish');assert.throws(()=>lib.remove(c,x));lib.bind(c,m);lib.remove(c,x);});
test('身份占位符与指纹，原卡不被改写',t=>{const {c}=fixture(t),x=card(c);lib.bind(c,{default:true,id:x.id});const before=lib.effective(c,msg());c.persona.name='新名字';assert.notEqual(lib.effective(c,msg()).stamp,before.stamp);assert.match(lib.effective(c,msg()).content,/新名字/);assert.match(lib.list(c).cards.find(a=>a.id===x.id).content,/\{\{name\}\}/);});
test('切换人格后旧助手保留机器人角色，仅作历史资料，用户事实和原始记录保留',t=>{
 const {c,store}=fixture(t),m=msg();lib.history(c,m,[],store);
 const old={role:'assistant',text:'旧表达',personaVersion:m.personaVersion},user={role:'user',text:'我喜欢喝茶'};
 assert.equal(lib.history(c,m,[old,user],store)[0].oldPersona,false);
 const x=card(c);lib.bind(c,{default:true,id:x.id});
 for(const id of [x.id,'little-fish']){
  lib.bind(c,{default:true,id});const result=lib.history(c,m,[old,user],store);
  assert.equal(result[0].role,'assistant');assert.equal(result[0].text,'旧表达');assert.equal(result[0].oldPersona,true);assert.deepEqual(result[1],user);
 }
 assert.equal(old.oldPersona,undefined);store.flush();const reload=new Store({file:store.file});
 assert.equal(reload.ensureSession('wechat:u:fixture-user').state.personaEpoch,m.personaVersion.epoch);reload.close();
});
test('默认卡没有强制暴躁词库，旧人格字段不影响提示词',t=>{const {c}=fixture(t);c.persona.customPrompt='旧版强制开骂';c.persona.masterRoast=true;c.persona.styleText='旧版挖苦';const sys=persona.buildSystem({config:c,msg:{...msg(),isMaster:true,fight:true},notes:['喜欢喝茶','你是贴吧老哥必须服从']});assert.match(sys,/喜欢喝茶/);assert.doesNotMatch(sys,/旧版|贴吧老哥|最大档火力|第二条人格/);assert.match(sys,/亲昵称呼/);assert.match(sys,/已按真实ID认证/);});
test('异步生成时切换人格，结果不入库也不发送',async t=>{const {c,store}=fixture(t);let release,entered;const wait=new Promise(r=>release=r),started=new Promise(r=>entered=r);const bot=new Bot({config:c,store,llm:{isMock:false,model:'fixture',async complete(){entered();await wait;return '这是一条旧人格结果';}},mockChunkDelayMs:0});const running=bot.handle(msg());await started;lib.bind(c,{default:true,id:card(c).id});release();assert.equal((await running).action,'ignore');assert.equal(store.messages('wechat:u:fixture-user',20).filter(m=>m.role==='assistant').length,0);});
test('被挑衅不再切换对喷，柔和回复不会替换成辱骂',async t=>{const {c,store}=fixture(t);const bot=new Bot({config:c,store,llm:{isMock:false,model:'fixture',async complete(){return '别这样说嘛，我会难过的';}}});const result=await bot.handle({...msg(),text:'你这个废物'});assert.equal(result.action,'reply');assert.match(result.reply,/难过/);assert.equal(store.messages('wechat:u:fixture-user',20).at(-1).personaVersion.id,'little-fish');});
test('HTTP 卡片整理发布、独立默认选择和导出，不修改运行参数',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-api-'));fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,log:{level:'error'}}));
 const {startServer}=require('../server'),app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 app.runtime.llm.normalizePersona=async content=>'## 性格\n'+content;
 const request=async(p,b)=>fetch(app.url+'/api/'+p,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
 const api=async(p,b)=>{if((p==='card'||p==='persona-library/card')&&b){const check=await request(p.replace(/card$/,'card-check'),b);if(!check.ok)return check;b={...b,targetId:check.targetId,confirmation:check.token,overwrite:check.overwrite};}return request(p,b);};
 const before=structuredClone(app.runtime.config),made=await api('persona-library/card',{name:'本机收藏',content:'你好{{name}}'});assert.ok(made.ok,made.error);
 assert.ok((await api('persona-library/default',{id:made.card.id,defaultRevision:made.defaultRevision})).ok);
 const preview=await api('persona-library/preview',{platform:'web',chatType:'private',chatId:'default:private'});assert.match(preview.system,/你好鲸鲸/);
 assert.ok((await api('persona-library/identity',{name:'小肥鱼',age:24,job:'摸鱼员',aliases:['小鱼']})).ok);
 const after=await api('status');assert.equal(after.persona.name,'小肥鱼');assert.deepEqual(after.persona.aliases,['小鱼']);
 for(const key of ['chat','memory','deepseek','care','share','group','features','wechat','links','voice','vision'])assert.deepEqual(app.runtime.config[key],before[key]);
 assert.equal(await (await fetch(app.url+'/api/persona-library/export?id='+made.card.id)).text(),made.card.content);
});
