'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { loadConfig, saveSettings, PROVIDERS } = require('../src/config');
const { DeepSeekClient } = require('../src/llm');
const { startServer } = require('../server');
const { applyThinking, thinkingCapability } = require('../src/thinking');

test('通用思考开关按接口映射，不向旧模型、强制推理和未知网关发送参数', () => {
  const cases = [
    ['deepseek', 'deepseek-flash', 'thinking', { type: 'enabled' }, { type: 'disabled' }],
    ['qwen', 'qwen-flash', 'enable_thinking', true, false],
    ['qwen', 'qwen-plus', 'enable_thinking', true, false],
    ['zhipu', 'glm-4.5-air', 'thinking', { type: 'enabled' }, { type: 'disabled' }],
    ['zhipu', 'glm-5.2', 'thinking', { type: 'enabled' }, { type: 'disabled' }],
    ['siliconflow', 'Qwen/Qwen3-8B', 'enable_thinking', true, false],
    ['ollama', 'qwen3:8b', 'reasoning_effort', 'medium', 'none'],
  ];
  for (const [provider, model, key, on, off] of cases) {
    assert.deepEqual(applyThinking({}, provider, model, true), { [key]: on });
    assert.deepEqual(applyThinking({}, provider, model, false), { [key]: off });
  }
  for (const [provider, model] of [
    ['qwen', 'qwen-turbo'], ['qwen', 'qwen-plus-2024-12-01'], ['zhipu', 'glm-4-flash'],
    ['zhipu', 'glm-5.3'], ['zhipu', 'glm-5.3-flash'], ['ollama', 'deepseek-r1:7b'],
    ['siliconflow', 'deepseek-ai/DeepSeek-R1'], ['siliconflow', 'Qwen/Qwen2.5-7B-Instruct'],
    ['opencode', 'deepseek-v4-pro'], ['custom', 'qwen-plus'], ['tju', 'tju-llm'],
  ]) {
    for (const enabled of [true, false]) assert.deepEqual(applyThinking({}, provider, model, enabled), {});
  }
  assert.equal(thinkingCapability('zhipu', 'glm-5.3').forced, true);
});

test('DeepSeek 思考模式独立于模型，保存重载后生效，其他服务不发送该参数', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-thinking-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let config = loadConfig({ root, env: {} });
  let client = new DeepSeekClient({ config });
  assert.equal(client.model, 'deepseek-flash');
  assert.deepEqual(client.buildPayload({}).thinking, { type: 'disabled' });
  saveSettings(config, { thinking: true, model: 'deepseek-v4-pro' });
  config = loadConfig({ root, env: {} });
  client = new DeepSeekClient({ config });
  assert.equal(client.model, 'deepseek-v4-pro');
  assert.deepEqual(client.buildPayload({ safe: true }).thinking, { type: 'enabled' });
  saveSettings(config, { provider: 'qwen' });
  client.reload();
  assert.equal(Object.hasOwn(client.buildPayload({}), 'thinking'), false);
});

test('聊天设置与调试台双向同步，关闭可覆盖已保存的开启值', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-thinking-api-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ watchConfig: false, features: { stickers: false }, server: { openBrowser: false } }));
  const app = await startServer({ root, env: {}, port: 0, openBrowser: false });
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const get = url => fetch(app.url + url).then(r => r.json());
  const post = (url, body) => fetch(app.url + url, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await get('/api/settings')).thinking, false);
  const saved = await post('/api/settings', { thinking: true, model: 'deepseek-v4-pro' });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).settings.thinking, true);
  let debug = await get('/api/config');
  assert.equal(debug.config.deepseek.thinking, true);
  assert.equal(debug.config.deepseek.model, 'deepseek-v4-pro');
  assert.equal((await post('/api/config', { patch: { 'deepseek.thinking': false, 'deepseek.model': 'deepseek-flash' } })).status, 200);
  const settings = await get('/api/settings');
  assert.equal(settings.thinking, false);
  assert.equal(settings.model, 'deepseek-flash');
  assert.deepEqual(app.runtime.llm.buildPayload({}).thinking, { type: 'disabled' });
  assert.equal((await post('/api/settings', { thinking: 'false' })).status, 400);
  const reloaded = new DeepSeekClient({ config: loadConfig({ root, env: {} }) });
  assert.equal(reloaded.thinking, false);
  assert.equal(reloaded.model, 'deepseek-flash');
  await post('/api/settings', { provider: 'qwen', model: 'qwen-flash', thinking: true });
  debug = await get('/api/config');
  assert.equal(debug.config.deepseek.model, 'qwen-flash');
  assert.equal(debug.config.deepseek.thinking, true);
  assert.equal(app.runtime.llm.buildPayload({}).enable_thinking, true);
  await post('/api/config', { patch: { 'deepseek.thinking': false, 'deepseek.model': 'qwen-plus' } });
  const qwenSettings = await get('/api/settings');
  assert.equal(qwenSettings.model, 'qwen-plus');
  assert.equal(qwenSettings.thinking, false);
  assert.equal(app.runtime.llm.buildPayload({}).enable_thinking, false);
});

test('调试台模型候选可渲染，保留手动输入的模型名', () => {
  const page = fs.readFileSync(path.join(__dirname, '../web/debug.html'), 'utf8');
  const source = page.slice(page.indexOf('function fieldId('), page.indexOf('function fieldsHtml('));
  const context = vm.createContext({ META: {}, PROVIDERS, CFG: { provider: 'deepseek' }, SECRET: new Set(), SECRETS: {}, JSON_FIELDS: new Set(), isPlainObject: () => false, esc: s => String(s) });
  vm.runInContext(source, context);
  const html = vm.runInContext("fieldHtml('deepseek.model', 'future-model')", context);
  assert.match(html, /value="future-model"/);
  assert.match(html, /<select[^>]*id="debugModelList"/);
  assert.doesNotMatch(html, /<datalist/);
  assert.match(html, /deepseek-flash/);
  assert.match(html, /deepseek-v4-pro/);
  assert.doesNotMatch(html, /deepseek-chat|deepseek-reasoner/);
  const preset = vm.runInContext("fieldHtml('deepseek.model', 'deepseek-flash')", context);
  assert.match(preset, /value="deepseek-flash" selected/);
  assert.match(preset, /<input[^>]* hidden>/);
  assert.match(preset, /自定义模型…/);
});

test('聊天设置只显示模型下拉框，自定义时才展开输入且保留模型值', () => {
  const app = fs.readFileSync(path.join(__dirname, '../web/assets/app.js'), 'utf8');
  const elements = {
    model: { value: 'deepseek-flash', hidden: false, focus() {}, select() {} },
    modelList: { value: '', textContent: '', options: [], appendChild(option) { this.options.push(option); } },
    providerHint: {}, provider: {value:'deepseek'}, baseUrl: {}, thinkingMode: {}, thinkingHelp: {},
  };
  const context = vm.createContext({
    $: id => elements[id], providerMeta: () => PROVIDERS,
    document: { createElement: () => ({}) },
    applyKeyExpectation() {}, refreshMaxTokens() {}, refreshThinking() {},
  });
  vm.runInContext(app.slice(app.indexOf('function fillProviderFields('), app.indexOf('function refreshMaxTokens(')), context);
  vm.runInContext("fillProviderFields('deepseek', {keepValues:true})", context);
  assert.equal(elements.model.hidden, true);
  assert.equal(elements.modelList.value, 'deepseek-flash');
  assert.ok(elements.modelList.options.some(option => option.value === 'deepseek-v4-pro'));
  elements.provider.value = 'qwen';
  elements.model.value = 'qwen-flash';
  vm.runInContext("fillProviderFields('qwen', {keepValues:true})", context);
  assert.equal(elements.thinkingMode.disabled, false);
  elements.provider.value = 'zhipu';
  elements.model.value = 'glm-4-flash';
  vm.runInContext("fillProviderFields('zhipu', {keepValues:true})", context);
  assert.equal(elements.thinkingMode.disabled, true);
  elements.model.value = 'glm-5.3';
  vm.runInContext('refreshThinking()', context);
  assert.match(elements.thinkingHelp.textContent, /始终推理/);
  const change = app.match(/\$\('modelList'\)\.addEventListener\('change', \(\) => \{([\s\S]*?)\n  \}\);/)[1];
  elements.modelList.value = '';
  vm.runInContext('(() => {' + change + '})()', context);
  assert.equal(elements.model.hidden, false);
  elements.model.value = 'future-model';
  elements.modelList.value = 'deepseek-v4-pro';
  vm.runInContext('(() => {' + change + '})()', context);
  assert.equal(elements.model.hidden, true);
  assert.equal(elements.model.value, 'deepseek-v4-pro');
});
