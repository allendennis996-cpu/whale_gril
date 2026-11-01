'use strict';

/**
 * 有人骂主人：她要能看出来，并且知道骂的是谁。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot({ reply = '你算什么东西', rng = () => 0.99 } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  require('./allowlist-fixture').permit(config);
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-defend-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const llm = { isMock: false, model: 'deepseek-chat', reload() {}, async complete() { return reply; } };
  const bot = new Bot({ config, store, llm, logger: null, mockChunkDelayMs: 0, rng });
  return { bot, config, store, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
}

const g = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1@chatroom', chatType: 'group',
  senderId: 'wxid_other', senderName: '赔笙', text, chatTitle: '马➕', ...extra,
});
const boss = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1@chatroom', chatType: 'group',
  senderId: 'wxid_boss', senderName: 'Master', text, chatTitle: '马➕', atMe: false, ...extra,
});



test('没人骂主人时，不会凭空开战', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(boss('有人骂我吗'));
  assert.notEqual(r.msg.fight, true);
  cleanup();
});

test('普通对话里出现「机器人」不算骂人', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(g('这个机器人挺好用的'));
  assert.notEqual(r.msg.fight, true);
  cleanup();
});
