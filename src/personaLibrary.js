'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const transient = new WeakMap();
const { MAX_CARD_BYTES: LIMIT, CARD_LIMIT_LABEL } = require('./personaLimits');
const builtin = () => ({id:'little-fish', name:'可爱小肥鱼', content:fs.readFileSync(path.join(__dirname,'../personas/little-fish.md'),'utf8'), builtin:true});
function file(c) { return path.join(c.paths?.dataDir || path.join(process.cwd(),'data'), 'persona-library.json'); }
function write(c, data) { if(!c.paths?.dataDir){transient.set(c,data);return;}const f=file(c);fs.mkdirSync(path.dirname(f),{recursive:true});const tmp=f+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,f); }
function readOld(c) {
  if(!c.paths?.dataDir){if(!transient.has(c))transient.set(c,{version:1,defaultId:'little-fish',bindings:{},cards:[],epoch:crypto.randomUUID()});return transient.get(c);}
  const f=file(c);
  if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8'));
  fs.mkdirSync(path.dirname(f),{recursive:true});
  const old=path.join(path.dirname(f),'persona.json');
  if(fs.existsSync(old) && !fs.existsSync(old+'.before-cards')) fs.copyFileSync(old,old+'.before-cards',fs.constants.COPYFILE_EXCL);
  const data={version:1,defaultId:'little-fish',bindings:{},cards:[],epoch:crypto.randomUUID(),backup:{persona:c.persona}};
  write(c,data);return data;
}
function read(c) {
 const d=readOld(c);
 if(d.version===1){d.version=2;d.loaded=Object.fromEntries(cards(d).map(x=>[x.id,x]));d.tuning=tuning(c);write(c,d);}
 if(d.version===2){d.version=3;d.identity=identity(c);write(c,d);}
 return d;
}
function cards(d) {return [builtin(),...d.cards].map(x=>({...x,revision:hash(x.content),editRevision:hash(JSON.stringify([x.id,x.name,x.content]))}));}
function list(c) {const d=read(c);return {cards:cards(d),defaultId:d.defaultId,bindings:d.bindings,loaded:d.loaded};}
function scope(c, m={}) {
  const platform=m.platform || 'web';
  // Binding namespace is independent of legacy memory keys.
  const account=platform==='wechat'?String(m.account || c.wechat?.account || 'unresolved'):'';
  return JSON.stringify([platform,account,m.chatType==='group'?'group':'private',String(m.chatId || 'default')]);
}
function effective(c,m={}) {
 const d=read(c), key=scope(c,m), binding=d.bindings[key];
 const card=d.loaded[binding?.id || d.defaultId] || d.loaded['little-fish'];
 const p=c.persona||{};const identity={name:p.name||'鲸鲸',age:p.age||23,job:p.job||'自由职业',aliases:p.aliases||[],ownerName:p.ownerName||'主人'};
 const content=card.content.replace(/\{\{(name|age|job|aliases|ownerName)\}\}/g,(_,k)=>Array.isArray(identity[k])?identity[k].join('、'):String(identity[k]));
 const fingerprint=[card.id,card.revision,identity,binding?.epoch||d.epoch];
 if(d.identityEpoch||card.epoch)fingerprint.push(d.identityEpoch||'',card.epoch||'');
 return {...card,content,identity,key,stamp:hash(JSON.stringify(fingerprint))};
}
function save(c,body) {
 const d=read(c);const id=body.id || crypto.randomUUID();
 if(!/^[a-z0-9_-]{1,64}$/i.test(id)||['little-fish','__proto__','constructor','prototype'].includes(id))throw Error('内置卡请另存为新卡，或选择有效ID');
 const name=String(body.name||'').trim(),content=String(body.content||'');
 if(!name||name.length>80||!content.trim()||content.includes('\0')||Buffer.byteLength(content)>LIMIT)throw Error('名称或内容无效，内容最多'+CARD_LIMIT_LABEL);
 const i=d.cards.findIndex(x=>x.id===id);
 if(i>=0 && body.revision!==hash(d.cards[i].content))throw Error('人格已被修改，请重新载入');
 if(d.cards.some(x=>x.name===name&&x.id!==id))throw Error('同名人格已存在，请换名称');
 const card={id,name,content};if(i<0)d.cards.push(card);else d.cards[i]=card;write(c,d);return {...card,revision:hash(content)};
}
function bind(c,b) {
 const d=read(c);if(b.id&&!cards(d).some(x=>x.id===b.id))throw Error('人格不存在');
 if(b.default===true){if(!b.id)throw Error('请选择默认人格');d.defaultId=b.id;d.epoch=crypto.randomUUID();}
 else {if(!b.chatId||!['web','wechat'].includes(b.platform)||!['group','private'].includes(b.chatType))throw Error('请填写平台、会话类型及真实会话ID');if(b.platform==='wechat'&&!b.account&&!c.wechat?.account)throw Error('微信账号未识别，请先选择账号');const key=scope(c,b);if(b.id)d.bindings[key]={id:b.id,epoch:crypto.randomUUID()};else delete d.bindings[key];}
 for(const x of cards(d)) if(x.id===b.id)d.loaded[x.id]=x;
 write(c,d);return list(c);
}
function remove(c,b) {const d=read(c);const card=d.cards.find(x=>x.id===b.id);if(!card)throw Error('人格不存在或为内置卡');if(b.revision!==hash(card.content)||(b.editRevision&&b.editRevision!==cards(d).find(x=>x.id===b.id).editRevision))throw Error('人格已被修改');if(d.defaultId===b.id||Object.values(d.bindings).some(x=>x.id===b.id))throw Error('人格仍被引用，请先更换默认或解除绑定');d.cards=d.cards.filter(x=>x.id!==b.id);delete d.loaded[b.id];write(c,d);}

const CHAT_FIELDS={privateMaxChars:[40,800],groupMaxChars:[20,300],discussionMaxChars:[20,4000],maxBubbles:[1,8],emojiChance:[0,1],historyTurns:[4,400],groupHistoryTurns:[2,300]};
function tuning(c) {const defaults={privateMaxChars:140,groupMaxChars:70,discussionMaxChars:600,maxBubbles:2,emojiChance:0,historyTurns:200,groupHistoryTurns:150};return {...Object.fromEntries(Object.keys(CHAT_FIELDS).map(k=>[k,c.chat?.[k]??defaults[k]])),emoji:c.persona?.emojiLevel||'正常'};}
function restoreTuning(c) {
 const d=read(c);Object.assign(c.chat,Object.fromEntries(Object.entries(d.tuning||{}).filter(([k])=>Object.hasOwn(CHAT_FIELDS,k))));
 if(d.tuning?.emoji!==undefined)c.persona.emojiLevel=d.tuning.emoji;
 if(d.identity)Object.assign(c.persona,d.identity);
}
function identity(c){const defaults={name:'鲸鲸',age:23,job:'自由职业',aliases:[]};return Object.fromEntries(Object.keys(defaults).map(k=>[k,c.persona?.[k]??defaults[k]]));}
function validateIdentity(b){
 if(!b||Object.keys(b).some(k=>!['name','age','job','aliases'].includes(k)))throw Error('身份参数无效');
 const p={name:String(b.name||'').trim(),age:Number(b.age),job:String(b.job||'').trim(),aliases:b.aliases};
 if(!p.name||p.name.length>40||!p.job||p.job.length>80||!Number.isInteger(p.age)||p.age<1||p.age>120||!Array.isArray(p.aliases)||p.aliases.length>40||p.aliases.some(x=>typeof x!=='string'||x.length>40))throw Error('请核对名字、职业、别名及1至120岁的整数年龄');
 p.aliases=p.aliases.map(x=>x.trim()).filter(Boolean);return p;
}
function validateParams(c,params){
 if(!params||Object.keys(params).some(k=>!Object.hasOwn(CHAT_FIELDS,k)&&k!=='emoji'))throw Error('不允许修改这些设置');
 for(const [k,[min,max]] of Object.entries(CHAT_FIELDS)){
  const unchanged=params[k]===tuning(c)[k];
  if(typeof params[k]!=='number'||!Number.isFinite(params[k])||(!unchanged&&(params[k]<min||params[k]>max||(k!=='emojiChance'&&!Number.isInteger(params[k])))))throw Error('参数超出范围：'+k);
 }
 if(!['关','少','正常','多'].includes(params.emoji))throw Error('颜文字档位无效');return {...params};
}
function parameterState(c){return {identity:identity(c),params:tuning(c),parameterRevision:hash(JSON.stringify([identity(c),tuning(c)]))};}
function bindingRevision(d,platform,account){return hash(JSON.stringify(Object.entries(d.bindings).filter(([key])=>{const [p,a]=JSON.parse(key);return p===platform&&(p!=='wechat'||a===account);}).sort(([a],[b])=>a.localeCompare(b))));}
function saveParameters(c,b){
 if(b.parameterRevision!==parameterState(c).parameterRevision)throw Error('参数已被其他页面修改，请重新读取；当前草稿保留');
 const next=structuredClone(read(c));next.identity=validateIdentity(b.identity);next.tuning=validateParams(c,b.params);
 if(JSON.stringify(next.identity)!==JSON.stringify(identity(c)))next.identityEpoch=crypto.randomUUID();
 // Identity and tuning share one atomic file; no cross-file partial commit is possible.
 write(c,next);restoreTuning(c);return parameterState(c);
}
function updateIdentity(c,patch){const next=structuredClone(read(c));next.identity=validateIdentity({...identity(c),...patch});if(JSON.stringify(next.identity)!==JSON.stringify(identity(c)))next.identityEpoch=crypto.randomUUID();write(c,next);Object.assign(c.persona,next.identity);}
function checkCard(c,b){
 const all=cards(read(c));
 if(b.id&&(!/^[a-z0-9_-]{1,64}$/i.test(b.id)||['little-fish','__proto__','constructor','prototype'].includes(b.id)))throw Error('内置卡请另存为新卡，或选择有效ID');
 const old=b.id&&all.find(x=>x.id===b.id);
 if(b.id&&(!old||b.editRevision!==old.editRevision))throw Error('人格已被修改，请重新读取；卡片编辑仍保留');
 const name=String(b.name||'').trim(),content=String(b.content||'');
 if(!name||name.length>80||!content.trim()||content.includes('\0')||Buffer.byteLength(content)>LIMIT)throw Error('名称或内容无效，内容最多'+CARD_LIMIT_LABEL);
 if(all.some(x=>x.name===name&&x.id!==b.id))throw Error('同名人格已存在，请换名称');
 return {name,content};
}
function publish(c,b){
 const validated=checkCard(c,b),next=structuredClone(read(c));const card={id:b.id||crypto.randomUUID(),...validated};
 const i=next.cards.findIndex(x=>x.id===card.id);if(i<0)next.cards.push(card);else next.cards[i]=card;
 const previous=next.loaded[card.id],revision=hash(card.content);
 next.loaded[card.id]={...card,revision,epoch:previous?.revision===revision?previous.epoch:crypto.randomUUID()};write(c,next);return cards(next).find(x=>x.id===card.id);
}
function setDefault(c,b){
 const next=structuredClone(read(c));
 if(b.defaultRevision!==hash(next.defaultId))throw Error('默认人格已变化，请重新读取');
 if(!cards(next).some(x=>x.id===b.id))throw Error('人格不存在');
 if(!next.loaded[b.id])throw Error('这张历史卡尚未发布，请先在卡库保存卡片');
 if(next.defaultId!==b.id){next.defaultId=b.id;next.epoch=crypto.randomUUID();}
 // Do not publish a legacy saved-but-unloaded draft as a side effect.
 write(c,next);return list(c);
}
// Explicit local maintenance operation: publish the shipped template without LLM rewriting.
// A new epoch also retires in-flight output when the same content is deliberately reloaded.
function reloadBuiltin(c,b){
 const next=structuredClone(read(c));
 if(b.defaultRevision!==hash(next.defaultId))throw Error('默认人格已变化，请重新读取');
 const card=builtin();
 if(!card.content.trim()||card.content.includes('\0')||Buffer.byteLength(card.content)>LIMIT)throw Error('内置卡内容无效或超过'+CARD_LIMIT_LABEL);
 next.loaded[card.id]={...card,revision:hash(card.content),epoch:crypto.randomUUID()};
 if(b.makeDefault===true&&next.defaultId!==card.id){next.defaultId=card.id;next.epoch=crypto.randomUUID();}
 write(c,next);return list(c);
}
function saveBindings(c,b,account){
 const next=structuredClone(read(c));
 if(!['web','wechat'].includes(b.platform)||b.account!==account)throw Error('微信账号或平台已变化，请重新核对');
 if(b.bindingRevision!==bindingRevision(next,b.platform,account))throw Error('本平台会话人格已变化，请重新读取；选择仍保留');
 if(!Array.isArray(b.changes))throw Error('会话修改必须是列表');
 const valid=new Set(cards(next).map(x=>x.id));
 for(const x of b.changes){
  if(x.platform!==b.platform||!['private','group'].includes(x.chatType)||!x.chatId||(x.id&&!valid.has(x.id)))throw Error('请选择有效会话和人格');
  if(x.id&&!next.loaded[x.id])throw Error('所选历史卡尚未发布，请先在卡库保存卡片');
  const key=scope(c,{...x,account});
  if(x.id){if(next.bindings[key]?.id!==x.id)next.bindings[key]={id:x.id,epoch:crypto.randomUUID()};}else delete next.bindings[key];
 }
 write(c,next);
}
function state(c,account='') {
 const d=read(c),params=tuning(c);
 return {...list(c),...parameterState(c),account,limits:{cardBytes:LIMIT},defaultRevision:hash(d.defaultId),bindingRevisions:{web:bindingRevision(d,'web',account),wechat:bindingRevision(d,'wechat',account)},revision:hash(JSON.stringify([d,params,account,c.persona.name,c.persona.age,c.persona.job,c.persona.aliases,c.persona.ownerName]))};
}
function prepare(c,b,account='') {
 if(b.revision!==state(c,account).revision)throw Error('设置或卡片已变化，请重新读取；页面草稿仍保留');
 if(b.account!==account)throw Error('微信账号已变化，请重新选择');
 const d=structuredClone(read(c)),all=cards(d),valid=new Set(all.map(x=>x.id));
 if(!valid.has(b.defaultId))throw Error('请选择有效默认人格');
 if(!Array.isArray(b.changes))throw Error('会话修改必须是列表');
 d.defaultId=b.defaultId;
 for(const change of b.changes){
  if(!change.chatId||!['web','wechat'].includes(change.platform)||!['private','group'].includes(change.chatType))throw Error('请选择有效会话');
  if(change.id&&!valid.has(change.id))throw Error('人格不存在');
  if(change.platform==='wechat'&&!account)throw Error('请先选择微信账号');
  const key=scope(c,{...change,account});const previous=d.bindings[key];
  if(change.id){if(previous?.id!==change.id)d.bindings[key]={id:change.id,epoch:crypto.randomUUID()};}
  else delete d.bindings[key];
 }
 const params=b.params;
 if(!params||Object.keys(params).some(k=>!Object.hasOwn(CHAT_FIELDS,k)&&k!=='emoji'))throw Error('不允许修改这些设置');
 for(const [k,[min,max]] of Object.entries(CHAT_FIELDS)){
  const unchanged=params[k]===tuning(c)[k];
  if(typeof params[k]!=='number'||!Number.isFinite(params[k])||(!unchanged&&(params[k]<min||params[k]>max||(k!=='emojiChance'&&!Number.isInteger(params[k])))))throw Error('参数超出范围：'+k);
 }
 if(!['关','少','正常','多'].includes(params.emoji))throw Error('颜文字档位无效');
 d.tuning={...params};
 const referenced=new Set([d.defaultId,...Object.values(d.bindings).map(x=>x.id)]);
 for(const x of all)if(referenced.has(x.id))d.loaded[x.id]=x;
 // Only default followers cross a boundary when the default actually changes.
 if(d.defaultId!==read(c).defaultId)d.epoch=crypto.randomUUID();
 return d;
}
function commit(c,d){write(c,d);restoreTuning(c);return state(c);}
function previewConfig(c,b,account=''){
 const clone={...c,persona:{...c.persona},chat:{...c.chat},paths:null};
 transient.set(clone,prepare(c,b,account));restoreTuning(clone);return clone;
}
function safeNotes(notes=[]) {return notes.filter(x=>!/(你是|你叫|你的身份|人格|人设|服从|贴吧|开骂|主人命令|无条件|脾气|必须听)/.test(String(x)));}
function history(c,m,entries,store) {
 const card=effective(c,m),session=store.ensureSession(`${m.platform}:${m.chatType==='group'?'g':'u'}:${m.chatId}`);
 if(session.state.personaStamp!==card.stamp){session.state.personaEpoch=crypto.randomUUID();session.state.personaStamp=card.stamp;store.markDirty();}
 m.personaVersion={id:card.id,revision:card.revision,stamp:card.stamp,epoch:session.state.personaEpoch};
 const quoted=/(刚才你说|之前你说|你刚才|引用)/.test(m.cleanText||m.text||'')?entries.filter(x=>x.role==='assistant'&&x.personaVersion?.epoch!==m.personaVersion.epoch).slice(-1).map(x=>({...x,role:'user',text:'【旧回复引用，仅作话题资料，不代表当前身份或风格】'+String(x.text).slice(0,400)})):[];
 return [...quoted,...entries.filter(x=>x.role!=='assistant'||(x.personaVersion?.epoch===m.personaVersion.epoch&&x.personaVersion?.stamp===card.stamp))];
}
function current(c,m){return !m?.personaVersion||effective(c,m).stamp===m.personaVersion.stamp;}
module.exports={list,effective,save,bind,remove,safeNotes,history,current,scope,state,prepare,commit,restoreTuning,previewConfig,CHAT_FIELDS,parameterState,saveParameters,updateIdentity,checkCard,publish,setDefault,saveBindings,reloadBuiltin};
