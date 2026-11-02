'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {parse}=require('../web/assets/persona-import');
test('JSON、Markdown、TXT 均完整导入，仅统一换行，名称来自文件名',()=>{
 for(const filename of ['角色.md','角色.markdown','角色.txt','角色.json'])assert.deepEqual(parse(filename,'原文\r\n内容'),{name:'角色',content:'原文\n内容'});
 for(const text of ['{}','[]','null','{','{"name":"内部名称","customPrompt":"正文","其他字段":"不可丢失"}','任意非 JSON 文本'])assert.deepEqual(parse('卡.json',text),{name:'卡',content:text});
});
test('未知扩展名、空正文及空字符拒绝导入',()=>{
 assert.throws(()=>parse('卡.exe','内容'));
 for(const ext of ['json','md','txt'])for(const text of ['', '  ', '\0'])assert.throws(()=>parse('卡.'+ext,text));
});

test('发布的 Markdown 原样保存独立文件，JSON 保持兼容',t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),lib=require('../src/personaLibrary');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'persona-md-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const c=structuredClone(require('../src/config').DEFAULT_CONFIG);c.paths={dataDir:dir};
 lib.publish(c,{name:'测试',content:'# 性格\n温柔\n'});
 const files=fs.readdirSync(path.join(dir,'persona-cards'));assert.ok(files.some(f=>fs.readFileSync(path.join(dir,'persona-cards',f),'utf8')==='# 性格\n温柔\n'));
 assert.equal(lib.list(c).cards.find(x=>x.name==='测试').content,'# 性格\n温柔\n');
});
