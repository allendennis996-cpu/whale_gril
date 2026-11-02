'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {loadConfig, loadSettings, resolveRuntime, saveSettings, mergeSettings, prepareModelSettings, modelTokenKey} = require('../src/config');
const {migrateModelSettings} = require('../src/modelSettingsMigration');
const {DeepSeekClient} = require('../src/llm');
const {startServer} = require('../server');
const {spawnSync} = require('node:child_process');

function fixture(t, config = {}, settings) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-model-settings-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  fs.mkdirSync(path.join(root,'data'));
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({watchConfig:false, features:{stickers:false}, ...config}));
  if (settings) fs.writeFileSync(path.join(root,'data/settings.json'),JSON.stringify(settings));
  return root;
}
function snapshot(root) {
  const out = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file = path.join(dir,entry.name);
      if (entry.isDirectory()) walk(file);
      else out[path.relative(root,file)] = [fs.readFileSync(file).toString('base64'), fs.statSync(file).mtimeMs];
    }
  }
  walk(root);
  return out;
}

test('语音密钥仅复用内置 DashScope 的千问密钥，自定义地址必须使用专用密钥', t => {
  const root=fixture(t);
  const script=`
import ast, json, os, sys
source = open(sys.argv[1], encoding='utf-8-sig').read()
function = next(node for node in ast.parse(source).body if isinstance(node, ast.FunctionDef) and node.name == '_resolve_voice_key')
scope = {'os': os, 'json': json, 'ROOT': sys.argv[2], 'VOICE_BASE_URL': 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'}
exec(compile(ast.Module(body=[function], type_ignores=[]), '<voice-key-test>', 'exec'), scope)
resolve = scope['_resolve_voice_key']
file = os.path.join(sys.argv[2], 'data', 'settings.json')
with open(file, 'w') as stream:
    json.dump({'apiKey':'fixture-wrong-main', 'keys': {'zhipu':'fixture-wrong-vision', 'deepseek':'fixture-wrong-ds', 'qwen':'fixture-qwen'}}, stream)
assert resolve({}) == 'fixture-qwen'
assert resolve({'voice':{'baseUrl':'https://custom.invalid/asr'}}) == ''
assert resolve({'voice':{'baseUrl':'https://dashscope.aliyuncs.com.evil.invalid/asr'}}) == ''
assert resolve({'voice':{'apiKey':'fixture-explicit'}}) == 'fixture-explicit'
with open(file, 'w') as stream:
    json.dump({'voiceApiKey':'fixture-voice', 'keys':{'qwen':'fixture-qwen'}}, stream)
assert resolve({'voice':{'baseUrl':'https://custom.invalid/asr'}}) == 'fixture-voice'
`;
  const result=spawnSync('python',['-c',script,path.join(__dirname,'../examples/wechatauto_bridge.py'),root],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr || result.error?.message);
});

test('旧字段一次迁移：新值优先、显式小预算保留、密钥按所属服务保存、备份不覆盖', t => {
  const root = fixture(t, {provider:'zhipu', deepseek:{provider:'deepseek',apiKey:'fixture-old-key',model:'glm-4-flash',maxTokens:700,temperature:1.15, mock:false},llm:{temperature:0}},
    {provider:'qwen',apiKey:'fixture-active-key',keys:{zhipu:'fixture-new-key'}});
  const cfg = loadConfig({root,env:{}});
  const raw = JSON.parse(fs.readFileSync(cfg.paths.configFile));
  const saved = loadSettings(cfg);
  assert.equal(raw.deepseek, undefined);
  assert.equal(raw.llm.maxTokens,700);
  assert.equal(raw.llm.temperature,0);
  assert.equal(saved.apiKey,undefined);
  assert.equal(saved.keys.zhipu,'fixture-new-key');
  assert.equal(saved.keys.qwen,'fixture-active-key');
  assert.equal(resolveRuntime(cfg).model,'qwen-flash');
  const backup = path.join(root,'data/backups/model-settings-migration/config.json');
  assert.ok(JSON.parse(fs.readFileSync(backup)).deepseek);
  const before = snapshot(root);
  assert.equal(migrateModelSettings(root),false);
  resolveRuntime(cfg); loadConfig({root,env:{}});
  assert.deepEqual(snapshot(root),before);
});

test('迁移在写 settings 后中断，重跑不覆盖新密钥及独立预算', t => {
  const token = modelTokenKey('deepseek','https://api.deepseek.com','deepseek-flash');
  const root = fixture(t, {deepseek:{apiKey:'fixture-old-key',maxTokens:320}}, {keys:{deepseek:'fixture-new-key'},modelMaxTokens:{[token]:8192}});
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => { if (to === path.join(root,'config.json')) throw Error('fixture-interruption'); return rename(from,to); };
    assert.throws(()=>migrateModelSettings(root),/fixture-interruption/);
  } finally { fs.renameSync = rename; }
  assert.ok(JSON.parse(fs.readFileSync(path.join(root,'config.json'))).deepseek);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'data/settings.json'))).keys.deepseek,'fixture-new-key');
  const cfg = loadConfig({root,env:{}});
  assert.equal(resolveRuntime(cfg).apiKey,'fixture-new-key');
  assert.equal(resolveRuntime(cfg).maxTokens,8192);
  assert.equal(cfg.llm.maxTokens,320);
});

test('温度 0 / 1.15 / 1.25 保留，解析无副作用，切换不跨服务取配置或密钥', t => {
  const root = fixture(t,{provider:'deepseek',llm:{baseUrl:'https://fixture.invalid',model:'fixture-model'}});
  const cfg = loadConfig({root,env:{DEEPSEEK_API_KEY:'fixture-env-key'}});
  for (const temperature of [0,1.15,1.25]) {
    saveSettings(cfg,{temperature});
    const before = snapshot(root);
    const client = new DeepSeekClient({config:cfg});
    assert.equal(client.buildPayload({}).temperature,temperature);
    assert.equal(client.buildPayload({safe:true}).temperature,Math.min(.7,temperature));
    assert.deepEqual(snapshot(root),before);
  }
  const draft = mergeSettings(cfg,loadSettings(cfg),prepareModelSettings(cfg,{provider:'zhipu',apiKey:''}));
  const rt = resolveRuntime(cfg,draft);
  assert.equal(rt.apiKey,'');
  assert.equal(rt.model,'glm-4-flash');
  assert.equal(rt.baseUrl,'https://open.bigmodel.cn/api/paas/v4');
  assert.equal(resolveRuntime(cfg).apiKey,'fixture-env-key');
  const envSwitch=loadConfig({root,env:{LLM_PROVIDER:'qwen',DEEPSEEK_API_KEY:'fixture-env-key'}});
  assert.equal(resolveRuntime(envSwitch).model,'qwen-flash');
  assert.equal(resolveRuntime(envSwitch).apiKey,'');
});

test('面板服务商优先于环境变量时，仍恢复配置文件所属服务商的自定义连接', t => {
  const root = fixture(t, {provider:'deepseek',llm:{baseUrl:'https://fixture.invalid/v1',model:'fixture-model'}}, {provider:'deepseek'});
  const cfg = loadConfig({root,env:{LLM_PROVIDER:'qwen'}});
  assert.equal(resolveRuntime(cfg).provider,'deepseek');
  assert.equal(resolveRuntime(cfg).baseUrl,'https://fixture.invalid/v1');
  assert.equal(resolveRuntime(cfg).model,'fixture-model');
});

test('原有主动接话命令仍可跨重启保存，网页保存只清理该字段的旧覆盖值', async t => {
  const root=fixture(t,{group:{freeChat:false}});
  const personaFile=path.join(root,'data/persona.json');
  fs.writeFileSync(personaFile,JSON.stringify({freeChat:true,emoji:'少'}));
  const instances=[];
  t.after(async()=>{for(const app of instances) await app.close();});
  const boot=async()=>{const app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});instances.push(app);return app;};
  const first=await boot();
  assert.equal(first.runtime.config.group.freeChat,true,'不能让 config 默认值盖掉原有命令存档');
  const response=await fetch(first.url+'/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({group:{freeChat:false}})});
  assert.equal(response.status,200);
  assert.equal((await boot()).runtime.config.group.freeChat,false);
  assert.equal(JSON.parse(fs.readFileSync(personaFile)).emoji,'少');
  require('../src/personaStore').save(first.runtime.config,{freeChat:true});
  assert.equal((await boot()).runtime.config.group.freeChat,true,'后续原有命令仍应正常保存');
});

test('连接测试成功、失败、超时和并发均不保存草稿或改变正式客户端', async t => {
  const hits=[];
  const fake=http.createServer((req,res)=>{
    let body=''; req.on('data',c=>body+=c); req.on('end',()=>{
      const payload=JSON.parse(body); hits.push({payload,key:req.headers.authorization});
      if(payload.model==='timeout') return;
      if(payload.model==='failure') {res.writeHead(401);res.end('{"error":"fixture-denied"}');return;}
      setTimeout(()=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{content:'咕噜'}}]}));},15);
    });
  });
  await new Promise(r=>fake.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>fake.close(r)));
  const root=fixture(t,{}, {provider:'deepseek',keys:{deepseek:'fixture-main-key',zhipu:'fixture-target-key'}});
  const app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  t.after(()=>app.close());
  const post=body=>fetch(app.url+'/api/settings/test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const before=snapshot(root), client=app.runtime.llm;
  const state={provider:client.provider,model:client.model,apiKey:client.apiKey,sessionId:client.sessionId,config:JSON.stringify(app.runtime.config)};
  const baseUrl='http://127.0.0.1:'+fake.address().port;
  const common={provider:'zhipu',baseUrl,maxTokens:777,temperature:0,timeoutMs:1000,userName:'不能保存',group:{freeChat:true},visionApiKey:'fixture-vision-key'};
  const responses=await Promise.all(['success-a','success-b','failure','timeout'].map(model=>post({...common,model,...(model==='timeout'?{timeoutMs:10}:{}),...(model==='success-b'?{apiKey:'fixture-draft-key'}:{})})));
  assert.equal(responses[0].ok,true); assert.equal(responses[1].ok,true);
  assert.equal(responses[2].ok,false); assert.equal(responses[3].ok,false);
  assert.equal(hits.find(h=>h.payload.model==='success-a').key,'Bearer fixture-target-key');
  assert.equal(hits.find(h=>h.payload.model==='success-b').key,'Bearer fixture-draft-key');
  assert.ok(hits.every(h=>h.payload.max_tokens===777 && h.payload.temperature===0));
  assert.deepEqual(snapshot(root),before);
  assert.equal(app.runtime.llm,client);
  assert.deepEqual({provider:client.provider,model:client.model,apiKey:client.apiKey,sessionId:client.sessionId,config:JSON.stringify(app.runtime.config)},state);
  assert.equal((await post({...common,temperature:3})).ok,false);
  assert.deepEqual(snapshot(root),before);
});

test('调试台与聊天设置共用模型设置、脱敏密钥和预算；群聊与称呼一起保存后重启保留', async t => {
  const root=fixture(t);
  fs.writeFileSync(path.join(root,'data/persona.json'),JSON.stringify({freeChat:false}));
  const app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  t.after(()=>app.close());
  const post=(url,body)=>fetch(app.url+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
  const get=url=>fetch(app.url+url).then(r=>r.json());
  assert.equal((await post('/api/settings',{provider:'qwen',apiKey:'fixture-qwen-key',maxTokens:8192,temperature:0,userName:'测试称呼',group:{freeChat:true,requireAt:false,freeChatChance:.4,cooldownSec:17}})).ok,true);
  let debug=await get('/api/config');
  assert.equal(Object.hasOwn(debug.config,'configuredProvider'),false);
  assert.equal(debug.config.provider,'qwen'); assert.equal(debug.config.llm.model,'qwen-flash');
  assert.equal(debug.config.llm.temperature,0); assert.equal(debug.config.llm.apiKey,'');
  assert.equal(debug.secrets['llm.apiKey'],true); assert.doesNotMatch(JSON.stringify(debug),/fixture-qwen-key/);
  assert.equal((await post('/api/config',{patch:{'llm.temperature':1.25,'llm.frequencyPenalty':.3,'llm.timeoutMs':5000}})).ok,true);
  assert.equal((await get('/api/settings')).temperature,1.25);
  assert.equal(app.runtime.llm.frequencyPenalty,.3); assert.equal(app.runtime.llm.timeoutMs,5000);
  assert.equal((await post('/api/config',{patch:{provider:'ollama'}})).ok,true);
  assert.equal((await get('/api/settings')).model,'qwen2.5:7b');
  const cfg=loadConfig({root,env:{}});
  assert.equal(cfg.group.freeChat,true); assert.equal(cfg.group.requireAt,false);
  assert.equal(cfg.group.freeChatChance,.4); assert.equal(cfg.group.cooldownSec,17);
  assert.equal(cfg.persona.ownerName,'测试称呼');
  assert.equal(loadSettings(cfg).apiKey,undefined);
  saveSettings(cfg,{provider:'qwen'});
  assert.equal(resolveRuntime(cfg).maxTokens,8192);
  const restarted=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  t.after(()=>restarted.close());
  assert.equal(restarted.runtime.config.group.freeChat,true);
  assert.equal(restarted.runtime.config.group.requireAt,false);
});
