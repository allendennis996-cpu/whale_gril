'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const v2=require('./memoryV2');

function source(dir) {
  const selected=v2.mode(dir);
  return selected.backend==='legacy-isolated' ? path.join(dir,'store-isolated.json') : path.join(dir,'store.json');
}
function prepare(dir, accounts={}, input) {
  const raw=input || v2.read(source(dir),{sessions:{}});
  if(!raw || typeof raw.sessions!=='object' || Array.isArray(raw.sessions))throw Error('旧记忆结构损坏');
  const selection=v2.mode(dir);
  const inherited=selection.previousDirectory ? v2.read(path.join(v2.directory(dir,{directory:selection.previousDirectory}),'unassigned.json'),{}) : {};
  const sessions={},pending={...inherited};let messages=0,damaged=0;
  for(const [key, original] of Object.entries({...inherited,...raw.sessions})) {
    const match=key.match(/^(web|wechat|douyin):([ugp]):(.+)$/);
    const sess={...original};
    sess.platform ||= match?.[1];sess.chatType ||= match?.[2]==='g'?'group':'private';sess.chatId ||= match?.[3];
    if(!sess.platform || !sess.chatId || !Array.isArray(sess.messages) || sess.messages.some(m=>!m || !['user','assistant'].includes(m.role) || typeof m.text!=='string')) {damaged++;continue;}
    messages+=sess.messages.length;
    if(sess.platform==='wechat') {
      sess.account ||= accounts[key] || '';
      if(typeof sess.account!=='string' || !sess.account.trim() || ['unknown','unresolved'].includes(sess.account)) {pending[key]=original;continue;}
    }
    delete pending[key];
    const scoped=v2.namespace(sess);
    if(sessions[scoped])throw Error('迁移会话映射冲突，请先检查旧记录');
    sessions[scoped]={...sess,key:scoped};
  }
  return {snapshot:{version:2,stats:raw.stats,digest:raw.digest,sessions},pending,
    report:{sessions:Object.keys({...inherited,...raw.sessions}).length,messages,damaged,unassigned:Object.keys(pending).length,ready:Object.keys(sessions).length}};
}
function inspect(root, accounts={}) {
  const dir=path.join(root,'data');
  const selected=v2.mode(dir);
  if(selected.backend==='v2') {
    const snap=v2.readSnapshot(dir);
    return {backend:'v2',sessions:Object.keys(snap.sessions).length,messages:Object.values(snap.sessions).reduce((n,s)=>n+s.messages.length,0),unassigned:Object.keys(v2.read(path.join(v2.directory(dir,selected),'unassigned.json'),{})).length};
  }
  return {backend:selected.backend,...prepare(dir,accounts).report};
}
function assertStopped(dir) {
  const ready=v2.read(path.join(dir,'bridge-ready.json'),null);
  if(ready?.pid) {
    let alive=true;try{process.kill(ready.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive)throw Error('桥接仍在运行，请停止后维护');
  }
  const portFile=path.join(dir,'server-port.txt');
  if(fs.existsSync(portFile)) {
    const port=Number(fs.readFileSync(portFile,'utf8'));
    if(Number.isInteger(port)&&port>0&&port<65536) {
      const probe=require('node:child_process').spawnSync(process.execPath,['-e',
        'const s=require("node:net").connect({host:"127.0.0.1",port:Number(process.argv[1])});s.setTimeout(700);s.on("connect",()=>{s.destroy();process.exit(2)});s.on("error",()=>process.exit(0));s.on("timeout",()=>process.exit(3));',String(port)],{timeout:2000,windowsHide:true});
      if(probe.status!==0)throw Error('主服务端口仍在监听或无法确认停止，请先关闭主服务与桥接');
    }
  }
  const file=path.join(dir,'memory-runtime.lock');
  if(!fs.existsSync(file))return;
  const lock=v2.read(file);
  if(!Number.isInteger(lock.pid) || lock.pid<=0)throw Error('运行锁无效，请人工检查');
  try {process.kill(lock.pid,0);} catch(e) {if(e.code==='ESRCH'){fs.unlinkSync(file);return;}throw e;}
  throw Error('服务仍在运行，请停止主服务与桥接后再执行维护');
}
function maintenance(root, action) {
  const dir=path.join(root,'data');fs.mkdirSync(dir,{recursive:true});
  const file=path.join(dir,'memory-maintenance.lock');
  // 中断后只回收已退出进程的维护锁。
  if(fs.existsSync(file)) {
    const previous=v2.read(file);let alive=true;
    try {process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
    if(alive)throw Error('另一个维护任务仍在运行');
    fs.unlinkSync(file);
  }
  const fd=fs.openSync(file,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.closeSync(fd);
  try {assertStopped(dir);return action(dir);} finally {fs.unlinkSync(file);}
}
function checksum(snapshot) {
  return v2.hash(JSON.stringify(Object.entries(snapshot.sessions).sort(([a],[b])=>a.localeCompare(b)).map(([key,s])=>[key,s.messages])));
}
function safeguard(root,dir,reason) {
  const folder=path.join(dir,'backups','memory-maintenance-'+Date.now()+'-'+crypto.randomUUID());
  fs.mkdirSync(folder,{recursive:true});
  const backup=require('./memoryBackup').collect(root,{withSecrets:true});
  v2.atomic(path.join(folder,'bundle.json'),backup);
  for(const name of ['config.json'])if(fs.existsSync(path.join(root,name)))fs.copyFileSync(path.join(root,name),path.join(folder,name));
  v2.atomic(path.join(folder,'operation.json'),{reason,mode:v2.mode(dir)});
  return folder;
}
function migrate(root,accounts={}) {
  return maintenance(root,dir=>{
    const currentMode=v2.mode(dir);
    let prepared;
    if(currentMode.backend==='v2') {
      if(!Object.keys(accounts).length)return {already:true,...inspect(root)};
      const current=v2.readSnapshot(dir);
      const unassigned=v2.read(path.join(v2.directory(dir,currentMode),'unassigned.json'),{});
      prepared=prepare(dir,accounts,{sessions:unassigned});
      for(const key of Object.keys(prepared.snapshot.sessions))if(current.sessions[key])throw Error('待归属记录与现有会话冲突，禁止自动混合');
      prepared.snapshot={...current,sessions:{...current.sessions,...prepared.snapshot.sessions}};
    } else prepared=prepare(dir,accounts);
    const {snapshot,pending,report}=prepared;
    if(report.damaged)throw Error('存在损坏会话，已停止迁移，原始文件未改动');
    const backup=safeguard(root,dir,'migrate');
    const name='memory-v2-'+crypto.randomUUID();
    const folder=path.join(dir,name);
    v2.writeSnapshotTo(folder,snapshot);
    v2.atomic(path.join(folder,'unassigned.json'),pending);
    const reader=new v2.V2Store({file:folder});
    if(checksum(reader.snapshot())!==checksum(snapshot))throw Error('迁移校验不一致，未切换模式');
    reader.close();
    v2.atomic(path.join(dir,'memory-mode.json'),{backend:'v2',directory:name,version:2});
    return {...report,backend:'v2',backup};
  });
}
function rollback(root) {
  return maintenance(root,dir=>{
    const selected=v2.mode(dir);
    if(selected.backend!=='v2')return {already:true,backend:selected.backend};
    const backup=safeguard(root,dir,'rollback');
    const snapshot=v2.readSnapshot(dir);
    v2.atomic(path.join(dir,'store-isolated.json'),{...snapshot,version:1});
    if(checksum(v2.read(path.join(dir,'store-isolated.json')))!==checksum(snapshot))throw Error('回退校验失败');
    v2.atomic(path.join(dir,'memory-mode.json'),{backend:'legacy-isolated',version:2,previousDirectory:selected.directory});
    return {backend:'legacy-isolated',backup};
  });
}

function restore(root,bundle) {
  return maintenance(root,dir=>{
    safeguard(root,dir,'restore');
    return require('./memoryBackup').restoreFrom(root,bundle);
  });
}
module.exports={inspect,migrate,rollback,restore,maintenance,checksum,prepare};
