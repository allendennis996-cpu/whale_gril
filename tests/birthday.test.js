'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const birthday=require('../src/birthday'),lib=require('../src/personaLibrary');
const {normalizedMarkdown}=require('../src/personaNormalizer');
const {DEFAULT_CONFIG}=require('../src/config');
test('生日严格采用 MM-DD，检查实际月份天数并允许闰日和空值',()=>{
 for(const value of ['01-01','02-29','04-30','12-31',''])assert.equal(birthday(value),value);
 for(const value of ['2-03','02-3','2026-02-03','02-30','04-31','00-10','13-01','01-00',' 01-01',123])assert.throws(()=>birthday(value),/生日/);
});
test('生日纳入身份保存、重载、人格指纹和占位符；清空后不编造',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-birthday-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const c=structuredClone(DEFAULT_CONFIG);c.paths={dataDir:dir};const before=lib.effective(c);
 lib.updateIdentity(c,{birthday:'02-29'});const after=lib.effective(c);
 assert.notEqual(before.stamp,after.stamp);assert.match(after.content,/生日：02-29/);
 assert.match(normalizedMarkdown('## 测试\n正文'),/生日：\{\{birthday\}\}/);
 const reload=structuredClone(DEFAULT_CONFIG);reload.paths=c.paths;lib.restoreTuning(reload);assert.equal(reload.persona.birthday,'02-29');
 const state=lib.state(reload);lib.saveParameters(reload,{...state,identity:{...state.identity,birthday:''}});
 const again=structuredClone(DEFAULT_CONFIG);again.paths=c.paths;lib.restoreTuning(again);assert.equal(again.persona.birthday,'');assert.match(lib.effective(again).content,/生日：未设定/);
});
test('调试台和调教台共享生日，拒绝非法日期且重启后保留清空',async t=>{
 const {startServer}=require('../server');const root=fs.mkdtempSync(path.join(os.tmpdir(),'fish-birthday-api-'));
 fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false,log:{level:'error'}}));
 let app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
 t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
 const api=async(p,b)=>fetch(app.url+'/api/'+p,b===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json());
 assert.equal((await api('config',{patch:{'persona.birthday':'06-18'}})).ok,true);
 let state=await api('persona-library/state');assert.equal(state.identity.birthday,'06-18');
 assert.equal((await api('config',{patch:{'persona.birthday':'02-30'}})).ok,false);assert.equal(app.runtime.config.persona.birthday,'06-18');
 assert.equal((await api('persona-library/parameters',{...state,identity:{...state.identity,birthday:'12-31'}})).ok,true);
 await app.close();app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});assert.equal(app.runtime.config.persona.birthday,'12-31');
 state=await api('persona-library/state');assert.equal((await api('persona-library/parameters',{...state,identity:{...state.identity,birthday:'04-31'}})).ok,false);
 assert.equal((await api('config',{patch:{'persona.birthday':''}})).ok,true);
 await app.close();app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});assert.equal(app.runtime.config.persona.birthday,'');
 assert.equal((await api('persona',{birthday:'02-29'})).ok,true);
 await app.close();app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});assert.equal(app.runtime.config.persona.birthday,'02-29');
});
