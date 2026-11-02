'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const lib=require('../src/personaLibrary'),{DEFAULT_CONFIG}=require('../src/config');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'persona-current-')),c=structuredClone(DEFAULT_CONFIG);c.paths={dataDir:dir};t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return {c,dir};}
function bind(c,card,chatId,type='private',account='fake-account'){lib.saveBindings(c,{platform:'wechat',account,bindingRevision:lib.state(c,account).bindingRevisions.wechat,changes:[{platform:'wechat',chatType:type,chatId,id:card.id}]},account);}
function confirm(c,b){const info=lib.inspectCard(c,b);return {...b,targetId:info.targetId,confirmation:info.token,overwrite:info.overwrite};}
test('删除提示按保存顺序取第一条引用，并优先提示默认人格',t=>{
 const {c}=fixture(t),a=lib.publish(c,{name:'A',content:'A'});bind(c,a,'fake-group','group','other-account');bind(c,a,'fake-user');
 assert.throws(()=>lib.remove(c,a,x=>x.account==='other-account'?'测试群':''),/人格仍被“群聊·测试群·fake-group”引用/);
 assert.throws(()=>lib.remove(c,a),/群聊·未备注·fake-group/);
 lib.setDefault(c,{id:a.id,defaultRevision:lib.state(c).defaultRevision});assert.throws(()=>lib.remove(c,a),/该人格是当前默认人格/);
});
test('同名覆盖保持目标ID与引用，保留源卡，内置卡不能覆盖',t=>{
 const {c}=fixture(t),a=lib.publish(c,{name:'A',content:'A'}),b=lib.publish(c,{name:'B',content:'B'});bind(c,b,'fake-user');
 const request=confirm(c,{id:a.id,editRevision:a.editRevision,name:' B ',content:'新内容',copy:false});const checked=lib.confirmedCard(c,request);assert.equal(checked.body.id,b.id);assert.equal(checked.needsModel,true);
 const saved=lib.publish(c,checked.body);assert.equal(saved.id,b.id);assert.equal(lib.list(c).cards.find(x=>x.id===a.id).content,'A');assert.equal(Object.values(lib.list(c).bindings)[0].id,b.id);
 const builtin=lib.list(c).cards[0];assert.throws(()=>lib.inspectCard(c,{name:builtin.name,content:'x',copy:true}),/内置卡不允许覆盖/);
 const same=confirm(c,{...saved,copy:true});assert.equal(lib.confirmedCard(c,same).needsModel,false);assert.throws(()=>lib.confirmedCard(c,{...same,overwrite:false}),/确认覆盖/);
});
test('检查只读、仅改名跳过模型、引用或默认变化不阻止保存',t=>{
 const {c,dir}=fixture(t),a=lib.publish(c,{name:'A',content:'A'}),before=fs.readFileSync(path.join(dir,'persona-library.json'),'utf8');
 const request=confirm(c,{...a,name:'改名'});assert.equal(lib.confirmedCard(c,request).needsModel,false);assert.equal(fs.readFileSync(path.join(dir,'persona-library.json'),'utf8'),before);
 bind(c,a,'fake-user');assert.equal(lib.confirmedCard(c,request).body.id,a.id);
 const fresh=confirm(c,{...a,name:'改名'});lib.setDefault(c,{id:a.id,defaultRevision:lib.state(c).defaultRevision});assert.equal(lib.confirmedCard(c,fresh).body.id,a.id);
});
test('单一Markdown为读取来源，改名不改正文，删除清理对应文件',t=>{
 const {c,dir}=fixture(t),a=lib.publish(c,{name:'A',content:'A'}),file=path.join(dir,'persona-cards',a.id+'.md');
 const metadata=JSON.parse(fs.readFileSync(path.join(dir,'persona-library.json')));assert.equal(metadata.loaded,undefined);assert.equal(metadata.cards[0].content,undefined);
 fs.writeFileSync(file,'手动更新的后台内容');const latest=lib.list(c).cards.find(x=>x.id===a.id);assert.equal(latest.content,'手动更新的后台内容');
 lib.publish(c,{...latest,name:'改名'});assert.equal(fs.readFileSync(file,'utf8'),latest.content);lib.remove(c,lib.list(c).cards.find(x=>x.id===a.id));assert.equal(fs.existsSync(file),false);
});
test('迁移保留已保存稿、绑定与默认选择；文件缺失明确失败',t=>{
 const {c,dir}=fixture(t);const old={version:4,defaultId:'old',cards:[{id:'old',name:'旧卡',content:'已保存内容'}],loaded:{old:{content:'旧生效稿'}},bindings:{fake:{id:'old'}},epoch:'fake-epoch'};
 fs.writeFileSync(path.join(dir,'persona-library.json'),JSON.stringify(old));assert.equal(lib.effective(c).content,'已保存内容');assert.deepEqual(lib.list(c).bindings,old.bindings);
 fs.unlinkSync(path.join(dir,'persona-cards','old.md'));assert.throws(()=>lib.list(c),/ENOENT/);
});
test('Markdown或索引提交失败回滚，迁移失败不破坏旧JSON',t=>{
 const {c,dir}=fixture(t),a=lib.publish(c,{name:'A',content:'原文'}),file=path.join(dir,'persona-library.json'),before=fs.readFileSync(file,'utf8');
 fs.mkdirSync(file+'.tmp');assert.throws(()=>lib.publish(c,{...a,content:'新文'}));assert.equal(fs.readFileSync(file,'utf8'),before);assert.equal(lib.list(c).cards.find(x=>x.id===a.id).content,'原文');fs.rmdirSync(file+'.tmp');
 const old={version:3,defaultId:'old',cards:[{id:'old',name:'旧卡',content:'旧文'}],bindings:{}};fs.writeFileSync(file,JSON.stringify(old));fs.mkdirSync(file+'.tmp');assert.throws(()=>lib.list(c));assert.equal(fs.readFileSync(file,'utf8'),JSON.stringify(old));assert.equal(fs.existsSync(path.join(dir,'persona-cards','old.md')),false);
});
test('HTTP 必须确认，改名不调模型，旧页面和引用变化不阻止保存',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'persona-confirm-api-'));fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,log:{level:'error'}}));const app=await require('../server').startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 let calls=0;app.runtime.llm.normalizePersona=async s=>{calls++;return '## 性格\n'+s;};
 const api=async(p,b)=>fetch(app.url+'/api/persona-library/'+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
 const save=async b=>{const info=await api('card-check',b);assert.ok(info.ok,info.error);return api('card',{...b,targetId:info.targetId,confirmation:info.token,overwrite:info.overwrite});};
 assert.equal((await api('card',{name:'A',content:'A'})).ok,false);assert.equal(calls,0);
 const made=await save({name:'A',content:'A'});assert.ok(made.ok,made.error);const renamed=await save({...made.card,name:'改名'});assert.ok(renamed.ok,renamed.error);assert.equal(calls,1);assert.equal(renamed.card.content,made.card.content);
 const same=await save({...renamed.card,copy:true});assert.ok(same.ok,same.error);assert.equal(calls,1);
 app.runtime.llm.normalizePersona=async s=>{bind(app.runtime.config,renamed.card,'fake-user');return s;};const conflict=await save({...same.card,content:'修改'});assert.ok(conflict.ok,conflict.error);assert.match(lib.list(app.runtime.config).cards.find(x=>x.id===made.card.id).content,/修改/);
 app.runtime.llm.normalizePersona=async s=>'## 正文\n'+s;
 const stalePage=await save({...made.card,name:'改名',content:'页面B最后保存'});assert.ok(stalePage.ok,stalePage.error);assert.match(lib.list(app.runtime.config).cards.find(x=>x.id===made.card.id).content,/页面B最后保存/);
});
