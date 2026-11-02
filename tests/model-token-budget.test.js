const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {loadConfig, saveSettings, resolveRuntime, defaultMaxTokens} = require('../src/config');
const {DeepSeekClient} = require('../src/llm');

test('输出预算按服务商、地址和模型隔离，重启恢复，重试不缩小预算', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-token-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  let cfg = loadConfig({root, env:{}});
  assert.equal(resolveRuntime(cfg).maxTokens, 4096);
  saveSettings(cfg, {provider:'custom', baseUrl:'http://localhost:1234/v1/', model:'model-a', maxTokens:8192});
  saveSettings(cfg, {model:'model-b', maxTokens:2048});
  saveSettings(cfg, {model:'model-a'});
  cfg = loadConfig({root, env:{}});
  const client = new DeepSeekClient({config:cfg});
  assert.equal(client.maxTokens, 8192);
  assert.equal(client.buildPayload({system:'s',safe:true}).max_tokens, 8192);
  assert.equal(client.buildPayload({system:'s',safe:true,maxTokens:32}).max_tokens, 32);
  saveSettings(cfg, {baseUrl:'http://localhost:4321/v1'});
  assert.equal(resolveRuntime(cfg).maxTokens, 4096);
  saveSettings(cfg, {baseUrl:'http://localhost:1234/v1'});
  assert.equal(resolveRuntime(cfg).maxTokens, 8192);
  saveSettings(cfg, {provider:'ollama'});
  assert.equal(resolveRuntime(cfg).maxTokens, 4096);
  for (const maxTokens of [0,-1,1.5,131073,NaN,'4096']) {
    assert.throws(() => saveSettings(cfg, {maxTokens}), /最大输出 token/);
  }
});

test('通用默认值保留显式小预算，不再读取旧 deepseek 字段', () => {
  assert.equal(defaultMaxTokens({deepseek:{maxTokens:1500}}),4096);
  assert.equal(defaultMaxTokens({llm:{maxTokens:700}}),700);
});
