'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
function fileFor(dir, account, source = 'gateway') {
  if (!dir || typeof account !== 'string' || !account.trim()) return null;
  const key = crypto.createHash('sha256').update(account.trim(), 'utf8').digest('hex');
  return path.join(dir, 'wechat-identities', key, source + '.json');
}
const LIMIT = 10000;
function clean(row) {
  if (!row || typeof row.id !== 'string' || !/^[A-Za-z0-9_.@-]+$/.test(row.id) || row.id === 'unknown') return null;
  const type = row.id.endsWith('@chatroom') ? 'groups' : 'users';
  if (row.type && row.type !== type) return null;
  if (type === 'groups' ? !/^[A-Za-z0-9_.-]+@chatroom$/.test(row.id) : row.id.includes('@')) return null;
  return {id:row.id, type, name:typeof row.name === 'string' ? row.name.slice(0,200) : '', lastSeen:Number(row.lastSeen) || 0};
}
function read(file, account) {
  try { const data=JSON.parse(fs.readFileSync(file,'utf8'));if (!account || data.version !== 2 || data.account !== account) return [];const rows=data.rows;return Array.isArray(rows) ? rows.map(clean).filter(Boolean) : []; } catch {return [];}
}
function merge(rows) {
  const seen = new Map();
  for (const raw of rows) {const row=clean(raw);if (!row) continue;const old=seen.get(row.id);if (!old || row.lastSeen >= old.lastSeen) seen.set(row.id,{...row,name:row.name || old?.name || ''});else if (!old.name && row.name) old.name=row.name;}
  return [...seen.values()].sort((a,b)=>b.lastSeen-a.lastSeen).slice(0,LIMIT);
}
function remember(config,msg,account) {
  const dir=config?.paths?.dataDir;
  if (msg?.platform !== 'wechat' || !dir || typeof account !== 'string' || !account.trim()) return;
  account=account.trim();
  try {
    const now=Date.now(), rows=[{id:msg.chatId,type:msg.chatType === 'group' ? 'groups':'users',name:msg.chatTitle || (msg.chatType !== 'group' ? msg.senderName : ''),lastSeen:now},{id:msg.senderId,type:'users',name:msg.senderName,lastSeen:now}];
    const file=fileFor(dir,account);
    const previous=read(file,account);
    if (rows.every(row=>{const old=previous.find(x=>x.id===row.id);return old && (!row.name || old.name===row.name) && now-old.lastSeen<60000;})) return;
    fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.tmp';
    fs.writeFileSync(temp,JSON.stringify({version:2,account,rows:merge([...previous,...rows])}));fs.renameSync(temp,file);
  } catch { /* 元数据失败不能放行消息或输出消息正文。 */ }
}
function choices(config, account) {
  const dir=config?.paths?.dataDir;
  const rows=dir && account ? merge([...read(fileFor(dir,account),account),...read(fileFor(dir,account,'bridge'),account)]) : [];
  return {account:account || '', users:rows.filter(r=>r.type==='users'),groups:rows.filter(r=>r.type==='groups')};
}
module.exports={clean,read,merge,remember,choices,fileFor};
