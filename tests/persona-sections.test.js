'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const lib=require('../src/personaLibrary'),normalizer=require('../src/personaNormalizer');
const {DEFAULT_CONFIG}=require('../src/config'),{DeepSeekClient}=require('../src/llm'),{startServer}=require('../server');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'persona-sections-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const c=structuredClone(DEFAULT_CONFIG);c.paths={dataDir:dir};lib.list(c);return {c,dir};}
function publish(c,name,content){return lib.publish(c,{name,content});}
function setDefault(c,id){lib.setDefault(c,{id,defaultRevision:lib.state(c).defaultRevision});}

test('参数提交原子保存身份与表达，不发布历史草稿或修改绑定和其他参数',t=>{
 const {c,dir}=fixture(t),card=publish(c,'A','旧版');setDefault(c,card.id);
 lib.save(c,{...card,content:'旧机制未发布草稿'});
 const before=structuredClone(c),state=lib.state(c),stamp=lib.effective(c).stamp;
 lib.saveParameters(c,{...state,params:{...state.params,historyTurns:400}});
 assert.equal(lib.effective(c).stamp,stamp);assert.equal(lib.effective(c).content,'旧版');
 const next=lib.state(c);lib.saveParameters(c,{...next,identity:{...next.identity,name:'新名字',aliases:['小鱼']}});
 assert.notEqual(lib.effective(c).stamp,stamp);assert.equal(c.persona.name,'新名字');
 for(const k of ['memory','deepseek','care','share','wechat','features','group','links'])assert.deepEqual(c[k],before[k]);
 const reload=structuredClone(DEFAULT_CONFIG);reload.paths={dataDir:dir};lib.restoreTuning(reload);assert.equal(reload.persona.name,'新名字');assert.equal(reload.chat.historyTurns,400);assert.equal(lib.effective(reload).content,'旧版');
});
test('参数失败和并发冲突均不写盘、不更新运行状态',t=>{
 const {c,dir}=fixture(t),s=lib.state(c),file=path.join(dir,'persona-library.json'),before=fs.readFileSync(file,'utf8'),cfg=structuredClone(c);
 assert.throws(()=>lib.saveParameters(c,{...s,identity:{...s.identity,name:''}}));
 assert.throws(()=>lib.saveParameters(c,{...s,params:{...s.params,historyTurns:402}}));assert.equal(fs.readFileSync(file,'utf8'),before);
 fs.mkdirSync(file+'.tmp');assert.throws(()=>lib.saveParameters(c,{...s,identity:{...s.identity,name:'不能半保存'}}));assert.deepEqual(c,cfg);fs.rmdirSync(file+'.tmp');
 lib.updateIdentity(c,{name:'另一个页面'});assert.throws(()=>lib.saveParameters(c,s),/其他页面/);
});
test('三类版本互不干扰；发布只改变使用同一卡片的会话',t=>{
 const {c}=fixture(t),a=publish(c,'A','A1'),b=publish(c,'B','B1'),s=lib.state(c,'fixture-account');
 setDefault(c,a.id);
 lib.saveBindings(c,{platform:'web',account:'fixture-account',bindingRevision:s.bindingRevisions.web,changes:[{platform:'web',chatType:'group',chatId:'fixture-group',id:b.id}]},'fixture-account');
 const group={platform:'web',chatType:'group',chatId:'fixture-group'},before=lib.effective(c,group).stamp;
 lib.publish(c,{...a,content:'A2'});lib.saveParameters(c,{...s,params:{...s.params,maxBubbles:3}});
 assert.equal(lib.effective(c).content,'A2');assert.equal(lib.effective(c,group).stamp,before);
 assert.throws(()=>lib.publish(c,{...a,content:'过期覆盖'}),/已被修改/);
 assert.throws(()=>lib.remove(c,lib.list(c).cards.find(x=>x.id===a.id)),/仍被引用/);
});
test('会话版本按账号和平台独立；跟随默认及无变化提交不扰动指纹',t=>{
 const {c}=fixture(t),a=publish(c,'A','A'),s=lib.state(c,'account-a'),web={platform:'web',chatType:'private',chatId:'fixture-user',id:a.id};
 const body={platform:'web',account:'account-a',bindingRevision:s.bindingRevisions.web,changes:[web]};lib.saveBindings(c,body,'account-a');
 assert.throws(()=>lib.saveBindings(c,body,'account-a'),/已变化/);
 const next=lib.state(c,'account-a'),stamp=lib.effective(c,web).stamp;
 lib.saveBindings(c,{...body,bindingRevision:next.bindingRevisions.web},'account-a');assert.equal(lib.effective(c,web).stamp,stamp);
 lib.saveBindings(c,{platform:'wechat',account:'account-a',bindingRevision:next.bindingRevisions.wechat,changes:[{...web,platform:'wechat'}]},'account-a');
 assert.equal(lib.effective(c,{...web,platform:'wechat',account:'account-b'}).id,'little-fish');
 assert.throws(()=>lib.saveBindings(c,{...body,account:'account-b'},'account-a'),/账号/);
 lib.saveBindings(c,{...body,bindingRevision:lib.state(c,'account-a').bindingRevisions.web,changes:[{...web,id:''}]},'account-a');assert.equal(lib.effective(c,web).id,'little-fish');
});
test('升级v2保留真正生效版本和待发布正文，不改变配置',t=>{
 const {c,dir}=fixture(t),d=JSON.parse(fs.readFileSync(path.join(dir,'persona-library.json')));d.version=2;delete d.identity;
 d.cards=[{id:'old',name:'历史卡',content:'仅保存的草稿'}];d.loaded.old={id:'old',name:'历史卡',content:'正在生效',revision:'old-rev'};d.defaultId='old';
 fs.writeFileSync(path.join(dir,'persona-library.json'),JSON.stringify(d));const before=structuredClone(c);
 assert.equal(lib.effective(c).content,'正在生效');assert.equal(lib.list(c).cards.find(x=>x.id==='old').content,'仅保存的草稿');assert.deepEqual(c,before);
});
test('人格内容或身份改回旧值也不会复活生成中的旧结果',t=>{
 const {c}=fixture(t),a=publish(c,'A','A1');setDefault(c,a.id);
 const first=lib.effective(c),m={personaVersion:{stamp:first.stamp}};
 const second=lib.publish(c,{...a,content:'A2'});lib.publish(c,{...second,content:'A1'});assert.equal(lib.current(c,m),false);
 const after=lib.effective(c),oldName=c.persona.name;lib.updateIdentity(c,{name:'另一个名字'});lib.updateIdentity(c,{name:oldName});assert.notEqual(lib.effective(c).stamp,after.stamp);
 const unchanged=lib.effective(c).stamp;lib.saveParameters(c,lib.state(c));assert.equal(lib.effective(c).stamp,unchanged);
});
test('整理结果补齐参数、保留他人姓名、去围栏和重复身份段，别名真正替换',async t=>{
 const {c}=fixture(t);let received;
 const text=await normalizer.normalize({async normalizePersona(s){received=s;return '```markdown\n## 性格\n朋友阿明，喜欢吃饭。\n```';}},'名字被覆盖的原文');
 for(const k of ['name','age','job','aliases','ownerName'])assert.ok(text.includes('{{'+k+'}}'));assert.match(text,/朋友阿明/);
 assert.equal((normalizer.normalizedMarkdown(text).match(/<!-- agent-identity -->/g)||[]).length,1);assert.equal(received,'名字被覆盖的原文');
 const card=publish(c,'参数卡',text);setDefault(c,card.id);c.persona.aliases=['甲','乙'];assert.match(lib.effective(c).content,/甲、乙/);assert.doesNotMatch(lib.effective(c).content,/\{\{aliases\}\}/);
 await assert.rejects(()=>normalizer.normalize({normalizePersona(){throw Error('不应调用');}},'鱼'.repeat(90000)),/256 KB/);
 assert.throws(()=>normalizer.normalizedMarkdown('鱼'.repeat(90000)),/256 KB/);assert.throws(()=>normalizer.normalizedMarkdown(''),/为空/);
});
test('256KB为UTF-8字节上限，整理结果加身份段后仍检查上限，不截断正文',async t=>{
 const {c}=fixture(t),{MAX_CARD_BYTES}=require('../src/personaLimits');
 const exact='x'.repeat(MAX_CARD_BYTES);assert.ok(publish(c,'边界卡',exact));assert.throws(()=>publish(c,'超限卡',exact+'x'),/256 KB/);
 assert.equal(lib.state(c).limits.cardBytes,MAX_CARD_BYTES);
 const large='鱼'.repeat(30000);let received;
 const normalized=await normalizer.normalize({async normalizePersona(s){received=s;return '## 性格\n'+s;}},large);
 assert.equal(received,large);assert.ok(normalized.includes(large));assert.ok(Buffer.byteLength(normalized)>60*1024);
 assert.throws(()=>normalizer.normalizedMarkdown(exact),/完整卡片超过256 KB/);
});
test('内置卡与完整目标文件一致，重新载入及设默认保留参数与独立绑定',t=>{
 const {c}=fixture(t),a=publish(c,'独立卡','独立风格');setDefault(c,a.id);
 const state=lib.state(c,'fixture-account'),group={platform:'web',chatType:'group',chatId:'fixture-group',id:a.id};
 lib.saveBindings(c,{platform:'web',account:'fixture-account',bindingRevision:state.bindingRevisions.web,changes:[group]},'fixture-account');
 const before=structuredClone(c),bindings=structuredClone(lib.list(c).bindings),otherStamp=lib.effective(c,group).stamp;
 const target=fs.readFileSync(path.join(__dirname,'../personas/目标性格-微信版.md'),'utf8');
 assert.equal(lib.list(c).cards.find(x=>x.id==='little-fish').content,target);
 lib.reloadBuiltin(c,{defaultRevision:lib.state(c).defaultRevision,makeDefault:true});
 const current=lib.effective(c),list=lib.list(c);assert.equal(list.defaultId,'little-fish');assert.equal(list.loaded['little-fish'].content,target);
 for(const k of ['name','age','job','aliases','ownerName'])assert.ok(target.includes('{{'+k+'}}'));
 assert.equal(lib.effective(c,group).stamp,otherStamp);assert.deepEqual(list.bindings,bindings);assert.deepEqual(c,before);
 lib.reloadBuiltin(c,{defaultRevision:lib.state(c).defaultRevision,makeDefault:true});assert.notEqual(lib.effective(c).stamp,current.stamp);
});

async function serverFixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'persona-section-api-'));fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,log:{level:'error'},wechat:{account:'fixture-account'}}));
 const app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const api=async(p,b)=>fetch(app.url+'/api/persona-library/'+p,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());return {app,api,root};
}
test('HTTP 模型失败和编辑期间并发变更不保存，卡片成功发布更新全部引用',async t=>{
 const {app,api,root}=await serverFixture(t);const c=app.runtime.config,card=publish(c,'A','A1');setDefault(c,card.id);
 const file=path.join(root,'data','persona-library.json'),before=fs.readFileSync(file,'utf8');
 app.runtime.llm.normalizePersona=async()=>{throw Error('模拟超时');};assert.equal((await api('card',{...card,content:'A2'})).ok,false);assert.equal(fs.readFileSync(file,'utf8'),before);
 app.runtime.llm.normalizePersona=async()=>{lib.publish(c,{...card,content:'另页发布'});return '## 性格\n过期模型结果';};
 assert.equal((await api('card',{...card,content:'A2'})).ok,false);assert.equal(lib.effective(c).content,'另页发布');
 const fresh=lib.list(c).cards.find(x=>x.id===card.id);app.runtime.llm.normalizePersona=async()=> '## 性格\n最新性格';
 const next=await api('card',{...fresh,content:'新编辑'});assert.ok(next.ok,next.error);assert.match(lib.effective(c).content,/最新性格/);
});
test('HTTP 保存参数不调用模型，非法候选和旧跨区接口均拒绝',async t=>{
 const {app,api}=await serverFixture(t);app.runtime.llm.normalizePersona=async()=>{throw Error('参数不应调用模型');};
 const s=await api('state');assert.ok((await api('parameters',{...s,params:{...s.params,historyTurns:400}})).ok);
 assert.equal((await api('apply',{...s,changes:[]})).ok,false);
 assert.equal((await api('bindings',{platform:'wechat',account:s.account,bindingRevision:s.bindingRevisions.wechat,changes:[{platform:'wechat',chatType:'private',chatId:'invented',id:'little-fish'}]})).ok,false);
 assert.equal((await api('card',{name:'失败',content:'不能在演示模式保存'})).ok,false);
});
test('真实协议整理请求使用当前模型、独立预算，不裁短或自动改服务商',async t=>{
 let seen,finish='stop';const fake=http.createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{seen=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{finish_reason:finish,message:{content:'## 性格\n安静温柔'}}]}));});});
 await new Promise(r=>fake.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>fake.close(r)));
 const client=new DeepSeekClient({logger:null,config:{llm:{baseUrl:'http://127.0.0.1:'+fake.address().port,model:'fixture-current-model',maxTokens:100,temperature:.8},paths:{settingsFile:path.join(os.tmpdir(),'missing-'+Math.random())},env:{}}});
 const before={model:client.model,maxTokens:client.maxTokens,provider:client.provider,temperature:client.temperature};
 assert.match(await client.normalizePersona('输入卡'),/温柔/);assert.equal(seen.model,'fixture-current-model');assert.ok(seen.max_tokens>=4096);assert.equal(seen.messages.length,2);assert.equal(seen.messages[1].content,'输入卡');assert.equal(seen.frequency_penalty,undefined);assert.match(seen.messages[0].content,/只做必要适配，尽量保留原味/);assert.match(seen.messages[0].content,/Markdown 导入还是 JSON 导入/);assert.match(seen.messages[0].content,/不为了统一文风而重写全文/);
 finish='length';await assert.rejects(()=>client.normalizePersona('输入卡'),/未完整输出/);assert.deepEqual({model:client.model,maxTokens:client.maxTokens,provider:client.provider,temperature:client.temperature},before);
 client.mock=true;await assert.rejects(()=>client.normalizePersona('输入卡'),/演示模式/);
});
