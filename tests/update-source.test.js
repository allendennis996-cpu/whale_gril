'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/update-source.ps1');
const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const available = spawnSync(shell, ['-NoProfile','-Command','exit 0']).status === 0;

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-source-update-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const remote=path.join(root,'remote.git'), seed=path.join(root,'seed'), local=path.join(root,'local');
  const git=(cwd,...args)=>{
    const result=spawnSync('git',['-C',cwd,...args],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);return result.stdout.trim();
  };
  fs.mkdirSync(seed);git(seed,'init','-b','main');
  git(seed,'config','user.name','Update Test');git(seed,'config','user.email','test@example.invalid');
  for(const [file,content] of Object.entries({'.gitignore':'data/\nconfig.json\n.venv/\n','server.js':'// initial\n','package.json':'{"version":"1"}\n'})) fs.writeFileSync(path.join(seed,file),content);
  git(seed,'add','.');git(seed,'commit','-m','initial');
  git(root,'clone','--bare',seed,remote);git(root,'clone',remote,local);
  // 更新器必须使用显式仓库，即使 origin 配错也不能下载上游。
  git(local,'remote','set-url','origin',path.join(root,'absent.git'));
  git(local,'config','user.name','Update Test');git(local,'config','user.email','test@example.invalid');
  fs.mkdirSync(path.join(local,'data'));fs.writeFileSync(path.join(local,'data','local-only.json'),'LOCAL_TEST_DATA');
  fs.writeFileSync(path.join(local,'config.json'),'LOCAL_TEST_CONFIG');
  const advance=(files={'server.js':'// updated\n'})=>{
    for(const [file,content] of Object.entries(files)) {fs.mkdirSync(path.dirname(path.join(seed,file)),{recursive:true});fs.writeFileSync(path.join(seed,file),content);git(seed,'add','-f','--',file);}
    git(seed,'commit','-m','remote change');git(seed,'push',remote,'main');return git(seed,'rev-parse','HEAD');
  };
  const update=(...args)=>spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Root',local,'-Repository',remote,'-Yes',...args],{encoding:'utf8',timeout:30000});
  const head=()=>git(local,'rev-parse','HEAD');
  return {root,remote,seed,local,git,advance,update,head};
}

test('源码更新只从指定仓库快进；检查不写入，未提交改动不会被 Force 丢弃，本机数据保留',{skip:!available},t=>{
  const f=fixture(t),initial=f.head(),target=f.advance();
  for(const flag of ['-Check','-DryRun']) {
    const result=f.update(flag);assert.equal(result.status,0,result.stdout+result.stderr);
    assert.equal(f.head(),initial);assert.equal(fs.existsSync(path.join(f.local,'.git','FETCH_HEAD')),false);
  }
  fs.writeFileSync(path.join(f.local,'unsaved.txt'),'unsaved');
  assert.equal(f.update('-Force').status,1);assert.equal(f.head(),initial);
  assert.equal(fs.readFileSync(path.join(f.local,'unsaved.txt'),'utf8'),'unsaved');fs.unlinkSync(path.join(f.local,'unsaved.txt'));
  const result=f.update();assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(f.head(),target);
  assert.equal(fs.readFileSync(path.join(f.local,'data','local-only.json'),'utf8'),'LOCAL_TEST_DATA');
  assert.equal(fs.readFileSync(path.join(f.local,'config.json'),'utf8'),'LOCAL_TEST_CONFIG');
  assert.equal(f.update().status,0);
});

test('源码更新拒绝分叉、其他分支及远端隐私文件，不改本地 HEAD',{skip:!available},async t=>{
  for(const kind of ['diverged','branch','private']) await t.test(kind,t=>{
    const f=fixture(t);
    if(kind==='diverged') {fs.writeFileSync(path.join(f.local,'own.js'),'// own change');f.git(f.local,'add','.');f.git(f.local,'commit','-m','own change');}
    if(kind==='branch') f.git(f.local,'checkout','-b','personal');
    const before=f.head();f.advance(kind==='private'?{'data/should-never-upload.json':'SYNTHETIC_TEST_DATA'}:undefined);
    const result=f.update('-Force');assert.equal(result.status,1,result.stdout+result.stderr);assert.equal(f.head(),before);
    assert.equal(fs.existsSync(path.join(f.local,'data','should-never-upload.json')),false);
  });
});

test('进程识别只返回本项目，系统 Node 可识别，其他目录和同名前缀不会误停',{skip:!available || process.platform!=='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-process-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const helper=path.resolve(__dirname,'../scripts/project-processes.ps1');
  const quote=value=>"'"+value.replaceAll("'","''")+"'";
  const fixtures=[
    {ProcessId:101,Name:'node.exe',ExecutablePath:'C:\\tools\\node.exe',CommandLine:`node "${root}\\server.js" --no-browser`},
    {ProcessId:102,Name:'python.exe',ExecutablePath:path.join(root,'.venv','Scripts','python.exe'),CommandLine:'python examples\\wechatauto_bridge.py'},
    {ProcessId:103,Name:'cmd.exe',CommandLine:`cmd /c "${root}\\scripts\\bridge_loop.bat"`},
    {ProcessId:201,Name:'node.exe',ExecutablePath:path.join(root+'-other','node.exe'),CommandLine:`node "${root}-other\\server.js"`},
    {ProcessId:202,Name:'cmd.exe',CommandLine:'cmd /c "C:\\other\\scripts\\bridge_loop.bat"'},
    {ProcessId:203,Name:'python.exe',ExecutablePath:'C:\\tools\\python.exe',CommandLine:`python "${root}\\server.js.bak"`},
    {ProcessId:204,Name:'cmd.exe',CommandLine:`cmd /c echo "${root}"`}
  ];
  const result=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-Command',`. ${quote(helper)}; function Get-CimInstance {param($ClassName,$ErrorAction) foreach($item in (ConvertFrom-Json $env:WHALE_PROCESS_FIXTURE)) {$item}}; ConvertTo-Json -Compress @(Get-WhaleProjectProcesses -Root ${quote(root)} | ForEach-Object {$_.Id})`],{encoding:'utf8',env:{...process.env,WHALE_PROCESS_FIXTURE:JSON.stringify(fixtures)}});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stderr,'');assert.deepEqual(JSON.parse(result.stdout),[101,102,103]);
});

test('运行时下载缓存损坏时安装失败，但不删除已有环境',{skip:!available || process.platform!=='win32'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-runtime-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'scripts'));fs.mkdirSync(path.join(root,'runtime'));
  const installer=path.join(root,'scripts','setup-runtime.ps1');fs.copyFileSync(path.resolve(__dirname,'../scripts/setup-runtime.ps1'),installer);
  const marker=path.join(root,'runtime','KEEP.txt');fs.writeFileSync(marker,'KEEP_EXISTING_ENVIRONMENT');
  const cache=path.join(root,'data','runtime-downloads','allendennis996-cpu_whale_gril');fs.mkdirSync(cache,{recursive:true});
  fs.writeFileSync(path.join(cache,'runtime-3.50.zip'),Buffer.alloc(11*1024*1024));
  const result=spawnSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',installer],{encoding:'utf8',timeout:15000});
  assert.notEqual(result.status,0);assert.equal(fs.readFileSync(marker,'utf8'),'KEEP_EXISTING_ENVIRONMENT');
});
