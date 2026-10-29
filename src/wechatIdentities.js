'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LIMIT = 10000;
function clean(row) {
  if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_.@-]+$/.test(row.id) || row.id === 'unknown') return null;
  const type = row.id.endsWith('@chatroom') ? 'groups' : 'users';
  if (row.type && row.type !== type) return null;
  if (type === 'groups' ? !/^[A-Za-z0-9_.-]+@chatroom$/.test(row.id) : row.id.includes('@')) return null;
  return {id:row.id, type, name:typeof row.name === 'string' ? row.name.slice(0,200) : '', lastSeen:Number(row.lastSeen) || 0};
}
function read(file) {
  try { const rows=JSON.parse(fs.readFileSync(file,'utf8')).rows;return Array.isArray(rows) ? rows.map(clean).filter(Boolean) : []; } catch {return [];}
}
function merge(rows) {
  const seen = new Map();
  for (const raw of rows) {const row=clean(raw);if (!row) continue;const old=seen.get(row.id);if (!old || row.lastSeen >= old.lastSeen) seen.set(row.id,{...row,name:row.name || old?.name || ''});else if (!old.name && row.name) old.name=row.name;}
  return [...seen.values()].sort((a,b)=>b.lastSeen-a.lastSeen).slice(0,LIMIT);
}
function remember(config,msg) {
  const dir=config?.paths?.dataDir;
  if (msg?.platform !== 'wechat' || !dir) return;
  try {
    const now=Date.now(), rows=[{id:msg.chatId,type:msg.chatType === 'group' ? 'groups':'users',name:msg.chatTitle || (msg.chatType !== 'group' ? msg.senderName : ''),lastSeen:now},{id:msg.senderId,type:'users',name:msg.senderName,lastSeen:now}];
    const file=path.join(dir,'wechat-identities.json');
    const previous=read(file);
    if (rows.every(row=>{const old=previous.find(x=>x.id===row.id);return old && (!row.name || old.name===row.name) && now-old.lastSeen<60000;})) return;
    fs.mkdirSync(dir,{recursive:true});const temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({version:1,rows:merge([...previous,...rows])}));fs.renameSync(temp,file);
  } catch { /* 元数据失败不能放行消息或输出消息正文。 */ }
}
function choices(config, fallback=[]) {
  const dir=config?.paths?.dataDir;
  const rows=merge([...(dir ? [...read(path.join(dir,'wechat-identities.json')),...read(path.join(dir,'wechat-identities.bridge.json'))] : []),...fallback]);
  return {users:rows.filter(r=>r.type==='users'),groups:rows.filter(r=>r.type==='groups')};
}
module.exports={clean,read,merge,remember,choices};
