'use strict';

/**
 * 「三个人格预设没用，每次调完还是没区别」——三处叠加的 bug：
 *
 *   1. web/persona.html 的 save() 根本没把 customPrompt 发出去 →
 *      在「自定义提示词」里写什么，点保存都被静默丢弃；
 *   2. 同一个页面的 fill() 也没回填 customPrompt →
 *      导入 v1/v2/v3 之后框里还是空的，用户看不出预设到底生效没有；
 *      而 v1/v2/v3 的差异**只**在 customPrompt 里（preset 都是「正常」、text 基本相同）。
 *   3. personaStore.save() 会把空字符串统一删掉，于是 apply() 读不到这个键 →
 *      自定义提示词一旦写入就永远清不掉，之后改性格/外貌/整体语气全部无效。
 *      这才是「调完还是没区别」的主因。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const personaStore = require('../src/personaStore');

const root = path.resolve(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'web', 'persona.html'), 'utf8');

function freshConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-persona-'));
  return { paths: { dataDir: dir }, persona: {}, chat: {}, links: {}, group: {}, memory: {} };
}




test('清空自定义提示词能真的清掉（不会再被空值清理吞掉）', () => {
  const cfg = freshConfig();
  personaStore.save(cfg, { customPrompt: 'AAAA' });
  assert.equal(cfg.persona.customPrompt, 'AAAA');
  personaStore.save(cfg, { customPrompt: '' });
  assert.equal(cfg.persona.customPrompt, '', '空字符串必须让 apply() 看到，才能清空');
  // 落盘时不该留空串
  const file = JSON.parse(fs.readFileSync(path.join(cfg.paths.dataDir, 'persona.json'), 'utf8'));
  assert.ok(!('customPrompt' in file) || file.customPrompt !== '', '文件里别留空字符串');
});

test('清空后能改回用控件（性格/语气重新生效）', () => {
  const cfg = freshConfig();
  personaStore.save(cfg, { customPrompt: 'AAAA', personality: '很凶' });
  personaStore.save(cfg, { customPrompt: '' });
  assert.equal(cfg.persona.customPrompt, '');
  assert.equal(cfg.persona.personality, '很凶', '清空自定义提示词不该动别的字段');
});




test('预设标题不能当她的名字；只有 personaName 才能改名', () => {
  const presets = require('../src/presets');
  const cfg = { paths: { root } };
  for (const item of presets.list(cfg)) {
    const one = presets.load(cfg, item.id);
    const patch = presets.toPatch(one);
    assert.ok(one.name, item.id + ' 预设本身有标题');
    assert.ok(!('name' in patch), item.id + ' 的标题不能写进 persona.name');
  }
  const patch = presets.toPatch({ name: '别拿标题当名字', personaName: '真正的名字' });
  assert.equal(patch.name, '真正的名字');
});



/**
 * 「恢复默认」也得能清掉自定义提示词。
 * 3.3.5 的 DEFAULTS 里没有 customPrompt / sourcePreset，
 * 于是 clear() → apply(DEFAULTS) 看不到这两个键，旧提示词继续盖在控件人设上面，
 * 用户点「恢复默认」还是没变化。默认人格必须是「正常人格」。
 */
test('恢复默认会清掉自定义提示词，回到正常人格', () => {
  const { DEFAULT_CONFIG } = require('../src/config');
  // 出厂配置本身不该带自定义提示词
  assert.equal(String(DEFAULT_CONFIG.persona.customPrompt || ''), '', '出厂不该预设自定义提示词');
  assert.equal(String(DEFAULT_CONFIG.persona.stylePreset || ''), '', '出厂不该预设整体语气');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-reset-'));
  const cfg = { paths: { dataDir: dir }, persona: {}, chat: {}, links: {}, group: {}, memory: {} };
  personaStore.save(cfg, { customPrompt: 'AAAA', sourcePreset: 'persona-v3', personality: '很凶' });
  personaStore.clear(cfg);
  assert.equal(cfg.persona.customPrompt, '', '恢复默认必须清掉自定义提示词');
  assert.equal(cfg.persona.sourcePreset, '', '恢复默认要清掉预设来源');
  assert.match(cfg.persona.personality, /温柔/, '性格要回到出厂设定');
});
