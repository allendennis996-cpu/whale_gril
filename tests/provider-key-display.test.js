'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { startServer } = require('../server');
const { saveSettings, maskKey } = require('../src/config');

test('设置接口为每个服务商返回独立的脱敏密钥状态，不返回密钥原文', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-key-display-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({watchConfig:false, features:{stickers:false}}));
  const app = await startServer({root, env:{}, port:0, openBrowser:false});
  t.after(async () => { await app.close(); fs.rmSync(root, {recursive:true, force:true}); });
  const deepseekKey = 'sk-fixture-deepseek-1111';
  const zhipuKey = 'fixture-zhipu-2222';
  saveSettings(app.runtime.config, {provider:'deepseek', apiKey:deepseekKey});
  saveSettings(app.runtime.config, {provider:'zhipu', apiKey:zhipuKey});
  app.runtime.llm.reload();
  const response = await fetch(app.url + '/api/settings');
  const raw = await response.text();
  const data = JSON.parse(raw);
  assert.equal(data.providers.deepseek.keyMasked, maskKey(deepseekKey));
  assert.equal(data.providers.zhipu.keyMasked, maskKey(zhipuKey));
  assert.equal(data.providers.deepseek.hasKey, true);
  assert.equal(data.providers.zhipu.hasKey, true);
  assert.equal(data.providers.qwen.hasKey, false);
  assert.equal(data.providers.qwen.keyMasked, '');
  assert.equal(raw.includes(deepseekKey), false);
  assert.equal(raw.includes(zhipuKey), false);
});

test('切换服务商立即切换已保存提示，未配置和本地服务不会沿用上家状态', () => {
  const source = fs.readFileSync(path.join(__dirname, '../web/assets/app.js'), 'utf8');
  const elements = {provider:{value:'deepseek'}, baseUrl:{value:'https://example.com'}, apiKey:{}, keyState:{}, mockMode:{checked:true}, mockHelp:{}};
  const context = vm.createContext({
    $: id => elements[id], isLocalBaseUrl: value => value.includes('127.0.0.1'),
    state:{settings:{provider:'deepseek',hasKey:true,keyMasked:'ds****1111'}},
  });
  vm.runInContext(source.slice(source.indexOf('function applyKeyExpectation('), source.indexOf('function fillProviderFields(')), context);
  vm.runInContext("applyKeyExpectation({hasKey:true,keyMasked:'ds****1111'})", context);
  assert.equal(elements.keyState.textContent, '已保存 ds****1111');
  elements.provider.value = 'zhipu';
  vm.runInContext("applyKeyExpectation({hasKey:true,keyMasked:'zp****2222'})", context);
  assert.equal(elements.keyState.textContent, '已保存 zp****2222');
  elements.provider.value = 'qwen';
  vm.runInContext('applyKeyExpectation({hasKey:false})', context);
  assert.equal(elements.keyState.textContent, '（未配置）');
  elements.baseUrl.value = 'http://127.0.0.1:11434/v1';
  vm.runInContext('applyKeyExpectation({needsKey:false})', context);
  assert.equal(elements.keyState.textContent, '（不需要）');
  assert.equal(elements.mockMode.checked, false);
});
