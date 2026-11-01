'use strict';

/**
 * 回怼火力：贴吧老哥档。既要有攻击力，也不能越底线。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const persona = require('../src/persona');
const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

const root = path.resolve(__dirname, '..');
const lines = fs.readFileSync(path.join(root, 'resources', 'clapback.txt'), 'utf8')
  .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));

const cats = new Set(lines.map((s) => s.split('|')[0].trim()));
const texts = lines.map((s) => s.split('|').slice(1).join('|').trim());

test('回怼库有贴吧火力档：重、爹味、反问、典、急了、轻、收尾', () => {
  for (const c of ['重', '爹味', '反问', '典', '急了', '轻', '叫滚', '收尾', '一般']) {
    assert.ok(cats.has(c), '缺少类别：' + c);
  }
  const heavy = lines.filter((s) => /^(重|爹味)\|/.test(s));
  assert.ok(heavy.length >= 45, '重火力台词太少：' + heavy.length);
  assert.ok(lines.length >= 180, '总台词太少：' + lines.length);
});

test('重火力里真的有脏字和爹味，不是软绵绵的礼貌话', () => {
  const heavyText = lines.filter((s) => /^(重|爹味)\|/.test(s)).join('\n');
  assert.match(heavyText, /他妈|妈的|傻逼|孙子|你爹|爹我|乖/, '重火力档应该有脏字或爹味自称');
});

test('守底线：不碰性、不咒家人死、不搞歧视、不威胁线下', () => {
  const banned = [
    /(你|他|她|妈|全家|祖宗)[^，。]{0,4}(死|坟|骨灰|殡|下葬)/, // 冲着人咒死
    /(去死|死全家|死一户口本|快点死)/,
    /强奸|操你妈|艹你妈|日你妈/,     // 性侮辱
    /艾滋|娘炮|人妖|残废|乡下人|外地人|省人/, // 歧视
    /住址|身份证|学校|公司地址|弄死|找人打/, // 人肉/线下威胁
  ];
  for (const t of texts) {
    for (const re of banned) {
      assert.doesNotMatch(t, re, '越线台词：' + t);
    }
  }
});

test('每条台词都是短句，适合微信群聊', () => {
  for (const t of texts) {
    assert.ok(t.length >= 2, '空台词');
    assert.ok(t.length <= 40, '太长（' + t.length + '）：' + t);
  }
});









function makeBot({ rng = () => 0, llm } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'whale-fight-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0, rng,
    llm: llm || { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
}

const groupMsg = (text, extra = {}) => ({
  platform: 'web', chatId: 'g1', chatType: 'group',
  senderId: 'u-x', senderName: '路人', text, chatTitle: '深海鱼塘', ...extra,
});




test('主人被骂不会被回怼（豁免仍然有效）', async () => {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'whale-fight2-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0, rng: () => 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  const r = await bot.decide(groupMsg('@鲸鲸 傻逼', { atMe: true, senderId: 'wxid_boss', senderName: 'Master' }));
  assert.notEqual(r.reason, 'clapback');
  store.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});
