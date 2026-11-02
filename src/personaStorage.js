'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const idOK=id=>typeof id==='string'&&/^[a-z0-9_-]{1,64}$/i.test(id)&&!['little-fish','__proto__','constructor','prototype'].includes(id);
const indexFile=dir=>path.join(dir,'persona-library.json');
function mdFile(dir,id){if(!idOK(id))throw Error('人格卡 ID 无效');return path.join(dir,'persona-cards',id+'.md');}
function atomic(file,text){const tmp=file+'.tmp';fs.writeFileSync(tmp,text,'utf8');fs.renameSync(tmp,file);}
function restore(dir,entries){for(const e of entries){const target=e.id===null?indexFile(dir):mdFile(dir,e.id);if(e.text===null){if(fs.existsSync(target))fs.unlinkSync(target);}else if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==e.text)atomic(target,e.text);}}
function recover(dir){const journal=path.join(dir,'persona-library.transaction.json');if(fs.existsSync(journal)){restore(dir,JSON.parse(fs.readFileSync(journal,'utf8')));fs.unlinkSync(journal);}}
function read(dir){recover(dir);const f=indexFile(dir);if(!fs.existsSync(f))return null;const data=JSON.parse(fs.readFileSync(f,'utf8'));if(data.version===5)for(const card of data.cards)card.content=fs.readFileSync(mdFile(dir,card.id),'utf8');return data;}
function write(dir,data){
 fs.mkdirSync(dir,{recursive:true});recover(dir);fs.mkdirSync(path.join(dir,'persona-cards'),{recursive:true});
 const f=indexFile(dir),old=fs.existsSync(f)?fs.readFileSync(f,'utf8'):null;
 const previous=old?JSON.parse(old):{cards:[]};const next=structuredClone(data);next.version=5;
 next.cardEpochs=Object.fromEntries(Object.entries(data.loaded||{}).map(([id,c])=>[id,c.epoch||'']));delete next.loaded;delete next.backup;
 next.cards=data.cards.map(({id,name})=>({id,name}));
 const edits=[];
 for(const card of data.cards){const target=mdFile(dir,card.id),before=fs.existsSync(target)?fs.readFileSync(target,'utf8'):null;if(before!==card.content)edits.push({id:card.id,text:before,next:card.content});}
 for(const card of previous.cards||[])if(!data.cards.some(x=>x.id===card.id)){const target=mdFile(dir,card.id);if(fs.existsSync(target))edits.push({id:card.id,text:fs.readFileSync(target,'utf8'),next:null});}
 const indexText=JSON.stringify(next,null,2);if(!edits.length&&old===indexText)return;
 const backup=[...edits.map(({id,text})=>({id,text})),{id:null,text:old}],journal=path.join(dir,'persona-library.transaction.json');
 atomic(journal,JSON.stringify(backup));
 try{
  for(const e of edits){const target=mdFile(dir,e.id);if(e.next===null)fs.unlinkSync(target);else atomic(target,e.next);}
  atomic(f,indexText);
 }catch(error){try{restore(dir,backup);fs.unlinkSync(journal);}catch{throw Error('人格卡保存失败，恢复待完成；请检查文件权限后重新读取');}throw error;}
 fs.unlinkSync(journal);
}
module.exports={read,write};
