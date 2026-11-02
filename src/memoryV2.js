'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {Store} = require('./memory');

const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function atomic(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp = file + `.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeFileSync(fd,JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}
function read(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch(e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function namespace(msg) {
  if (msg.platform === 'wechat' && !msg.account) throw Error('微信消息缺少来源账号，禁止访问会话记忆');
  if (msg.platform !== 'wechat') return `${msg.platform || 'web'}:${msg.chatType === 'group' ? 'g' : 'u'}:${String(msg.chatId || 'default')}`;
  return 'v2:' + hash(JSON.stringify([msg.platform || 'web', msg.platform === 'wechat' ? msg.account : '', msg.chatType === 'group' ? 'group' : 'private', String(msg.chatId || 'default')]));
}
function mode(dir) { return read(path.join(dir, 'memory-mode.json'), {backend:'legacy'}); }
function directory(dir, selection) {
  if (!/^memory-v2-[a-f0-9-]+$/.test(selection.directory || '')) throw Error('记忆目录无效');
  return path.join(dir, selection.directory);
}

// 元数据清单按会话落盘；原文追加日志先 fsync，再向调用方确认成功。
class V2Store extends Store {
  load() {
    this.v2 = true;
    this.generation = (this.generation || 0) + 1;
    this.activity = new Map();
    this.damaged = [];
    if (fs.existsSync(this.file) && !fs.existsSync(path.join(this.file,'manifest.json')) && fs.readdirSync(this.file).length) throw Error('记忆 v2 清单缺失，停止加载以保留数据');
    const manifest = read(path.join(this.file, 'manifest.json'), {version:2, chats:[], stats:{messages:0,replies:0},digest:[]});
    if (manifest.version !== 2 || !Array.isArray(manifest.chats)) throw Error('记忆 v2 清单损坏，未创建空库');
    this.stats = manifest.stats || this.stats;
    this.digest = manifest.digest || [];
    for (const id of manifest.chats) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw Error('记忆会话目录无效');
      const meta = read(path.join(this.file, id, 'meta.json'));
      if (!meta || hash(meta.key) !== id) throw Error('记忆会话元数据损坏');
      const sess = this.normalizeSession(meta.key, {...meta,messages:[]});
      Object.assign(sess, {account:meta.account || '', state:{...sess.state,...meta.state}, seq:meta.seq || 0, derived:meta.derived || {}, revision:meta.revision || 0});
      const journal = path.join(this.file, id, 'messages.jsonl');
      const raw = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '';
      const lines = raw.split('\n');
      let validBytes = 0;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i]) continue;
        let event;
        try { event = JSON.parse(lines[i]); }
        catch {
          if (i !== lines.length - 1) throw Error('记忆日志中段损坏，停止加载以保留数据');
          this.damaged.push({file:journal, bytes:validBytes});
          break;
        }
        validBytes += Buffer.byteLength(lines[i] + '\n');
        if (event.op === 'append') {sess.messages.push(event.message); if(event.seq > (meta.seq||0)) {if(event.state)sess.state={...sess.state,...event.state};if(event.seenIds)sess.seenIds=event.seenIds;}}
        else if (event.op === 'reset') {
          sess.messages=[];
          if(event.seq>(meta.seq||0)) {
            sess.state=super.normalizeSession(meta.key,{}).state;sess.seenIds=[];sess.derived={};
            if(event.clearProfiles)sess.profiles={};
          }
          sess.revision=Math.max(sess.revision||0,event.revision||0);
        }
        else if (event.op === 'redact' && sess.messages.length) sess.messages.at(-1).text = event.text;
        else if (!['append','reset','redact'].includes(event.op)) throw Error('未知记忆日志事件');
        sess.seq=Math.max(sess.seq||0,event.seq||0);
      }
      this.sessions.set(sess.key, sess);
    }
  }
  normalizeSession(key, sess) {
    const out = super.normalizeSession(key, sess);
    out.messages = Array.isArray(sess.messages) ? sess.messages.slice() : [];
    out.account = sess.account || '';
    return out;
  }
  keyFor(msg) { return namespace(msg); }
  prune() {} // 原文首版不按容量或年龄自动删除。
  ensureSession(key, meta = {}) {
    const sess = super.ensureSession(key, meta);
    if (meta.account) sess.account = meta.account;
    return sess;
  }
  journal(key, event) {
    const sess = this.ensureSession(key);
    const folder = path.join(this.file, hash(key));
    const file = path.join(folder, 'messages.jsonl');
    // 首条日志之前先建立可发现的元数据，崩溃不能留下无法找到的已确认消息。
    if (!fs.existsSync(path.join(folder, 'meta.json'))) { this.dirty=true; this.flush(); }
    const damage = this.damaged.find(x=>x.file===file);
    if (damage) {
      const raw=fs.readFileSync(file); const cut=Math.min(damage.bytes,raw.length);
      fs.writeFileSync(file+'.damaged-tail',raw.subarray(cut)); fs.truncateSync(file,cut);
      this.damaged=this.damaged.filter(x=>x!==damage);
    }
    if (fs.existsSync(file) && fs.statSync(file).size) {
      const fd=fs.openSync(file,'r');const last=Buffer.alloc(1);
      try {fs.readSync(fd,last,0,1,fs.statSync(file).size-1);} finally {fs.closeSync(fd);}
      if (last[0]!==10) fs.appendFileSync(file,'\n');
    }
    event.seq=(sess.seq||0)+1;
    const fd = fs.openSync(file, 'a');
    try { fs.writeFileSync(fd, JSON.stringify(event)+'\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    sess.seq=event.seq;
    return sess;
  }
  appendMessage(key, message) {
    const session=this.ensureSession(key);
    const count = session.messages.length;
    const previousStats={...this.stats}, previousState=structuredClone(session.state);
    const old = this.limits.maxMessages;
    this.limits.maxMessages = Number.MAX_SAFE_INTEGER;
    let entry;
    try {
      const spell = this.config?.admin?.spell;
      const safe = spell && String(message.text).includes(spell) ? {...message,text:'（已隐藏：管理员验证）'} : message;
      entry = super.appendMessage(key, safe);
      this.journal(key, {op:'append',message:entry,state:this.ensureSession(key).state,seenIds:this.ensureSession(key).seenIds});
    } catch(e) {
      this.ensureSession(key).messages.splice(count);
      this.ensureSession(key).state=previousState;this.stats=previousStats;
      throw e;
    } finally { this.limits.maxMessages = old; }
    return entry;
  }
  redactLastMessage(key, replacement = '（已隐藏）') {
    if (!this.ensureSession(key).messages.length) return false;
    this.journal(key, {op:'redact',text:String(replacement).slice(0,200)});
    return super.redactLastMessage(key,replacement);
  }
  resetSession(key, clearProfiles = false) {
    const sess=this.ensureSession(key), revision=(sess.revision||0)+1;
    this.journal(key,{op:'reset',revision,clearProfiles});
    super.resetSession(key); sess.revision=revision; sess.derived={};
    if(clearProfiles)sess.profiles={};
    this.generation++;
    this.activity.delete(key);
    this.flush();
  }
  resetAll() {
    for (const key of this.sessions.keys()) this.resetSession(key,true);
    this.stats={messages:0,replies:0}; this.digest=[]; this.markDirty(); this.flush();
  }
  markDirty() {
    this.dirty=true;
    if(this.saveTimer)return;
    this.saveTimer=setTimeout(()=>{
      this.saveTimer=null;
      try {this.flush();} catch {this.logger?.error('记忆元数据保存失败，已保留追加日志与待保存状态');}
    },800);
    this.saveTimer.unref?.();
  }
  flush() {
    if (!this.dirty) return;
    const chats=[];
    for (const [key, sess] of this.sessions) {
      const id=hash(key); chats.push(id);
      const {messages, ...meta}=sess;
      atomic(path.join(this.file,id,'meta.json'),meta);
    }
    atomic(path.join(this.file,'manifest.json'),{version:2,chats,stats:this.stats,digest:this.digest});
    this.dirty=false;
  }
  snapshot() {
    this.flush();
    return {version:2,stats:this.stats,digest:this.digest,sessions:Object.fromEntries(this.sessions)};
  }
  summary() { return {...super.summary(), backend:'v2', diagnostics:Object.fromEntries(this.activity || [])}; }
}

class IsolatedLegacyStore extends Store {
  keyFor(msg) { return namespace(msg); }
  normalizeSession(key,sess) {return {...super.normalizeSession(key,sess),messages:Array.isArray(sess.messages)?sess.messages.slice():[],account:sess.account || ''};}
  prune() {}
  appendMessage(key,message) {const old=this.limits.maxMessages;this.limits.maxMessages=Number.MAX_SAFE_INTEGER;try{return super.appendMessage(key,message);}finally{this.limits.maxMessages=old;}}
  ensureSession(key,meta={}) {const sess=super.ensureSession(key,meta);if(meta.account)sess.account=meta.account;return sess;}
  summary() {return {...super.summary(),backend:'legacy-isolated'};}
}

const active = new Map();
function runtimeLock(dir) {
  const file=path.join(dir,'memory-runtime.lock');
  if (fs.existsSync(path.join(dir,'memory-maintenance.lock'))) throw Error('记忆维护中，请完成后再启动服务');
  fs.mkdirSync(dir,{recursive:true});
  if (active.has(file)) {active.set(file,active.get(file)+1);}
  else {
    try {const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const prior=read(file);let alive=true;
      try {process.kill(prior.pid,0);} catch(err) {if(err.code==='ESRCH')alive=false;else throw err;}
      if(alive)throw Error('已有记忆服务运行，请先停止');
      fs.unlinkSync(file);return runtimeLock(dir);
    }
    active.set(file,1);
  }
  if (fs.existsSync(path.join(dir,'memory-maintenance.lock'))) {
    active.delete(file);fs.unlinkSync(file);throw Error('记忆维护中，请稍后再启动');
  }
  let released=false;
  return ()=>{if(released)return;released=true;const n=active.get(file)-1;if(n){active.set(file,n);}else{active.delete(file);try {fs.unlinkSync(file);}catch(e){if(e.code!=='ENOENT')throw e;}}};
}
function createStore(config, logger) {
  const dir=config.paths.dataDir || path.dirname(config.paths.storeFile);
  const release=runtimeLock(dir);
  try {
    const selected=mode(dir);
    const options={file:config.paths.storeFile,limits:config.memory,logger};
    let store;
    if(selected.backend==='v2') {
      const folder=directory(dir,selected);
      if(!fs.existsSync(path.join(folder,'manifest.json')))throw Error('记忆 v2 清单缺失，禁止创建空库');
      store=new V2Store({...options,file:folder});
    }
    else if(selected.backend==='legacy-isolated') store=new IsolatedLegacyStore({...options,file:path.join(dir,'store-isolated.json')});
    else if(selected.backend==='legacy') store=new Store(options);
    else throw Error('未知记忆存储模式');
    store.config=config;
    const close=store.close.bind(store);
    store.close=()=>{try {store.worker?.close();close();}finally{release();}};
    return store;
  } catch(e) {release();throw e;}
}

function readSnapshot(dir) {
  const selection=mode(dir);
  if(selection.backend==='legacy')return read(path.join(dir,'store.json'),{sessions:{}});
  if(selection.backend==='legacy-isolated')return read(path.join(dir,'store-isolated.json'),{sessions:{}});
  const store=new V2Store({file:directory(dir,selection)});
  const snapshot={version:2,stats:store.stats,digest:store.digest,sessions:Object.fromEntries(store.sessions)};
  return snapshot;
}
function writeSnapshotTo(folder, snapshot) {
  fs.mkdirSync(folder,{recursive:false});
  const store=new V2Store({file:folder});
  for(const [key, sess] of Object.entries(snapshot.sessions || {})) {
    store.sessions.set(key,{...sess,key,messages:[],state:sess.state||{},profiles:sess.profiles||{},seenIds:sess.seenIds||[]});
    store.dirty=true;store.flush();
    for(const message of sess.messages || []) {store.journal(key,{op:'append',message});store.sessions.get(key).messages.push(message);}
  }
  store.stats=snapshot.stats||store.stats;store.digest=snapshot.digest||[];store.dirty=true;store.close();
}

module.exports={V2Store,IsolatedLegacyStore,createStore,namespace,hash,atomic,read,mode,directory,readSnapshot,writeSnapshotTo};
