'use strict';

/**
 * 主人最高指令：主人的话无条件执行，别人冒充无效。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Bot } = require('../src/bot');
const { Store } = require('../src/memory');
const { DEFAULT_CONFIG } = require('../src/config');

function makeBot() {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  require('./allowlist-fixture').permit(config);
  config.persona.master = { names: ['Master'], wxids: ['wxid_boss'] };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-master-'));
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  const bot = new Bot({
    config, store, logger: null, mockChunkDelayMs: 0,
    llm: { isMock: true, model: 'mock', reload() {}, describe() { return {}; } },
  });
  return { bot, config, cleanup() { store.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }); } };
}

const master = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1@chatroom', chatType: 'group',
  senderId: 'wxid_boss', senderName: 'Master', text, chatTitle: '深海鱼塘', ...extra,
});
const stranger = (text, extra = {}) => ({
  platform: 'wechat', chatId: 'g1@chatroom', chatType: 'group',
  senderId: 'wxid_stranger', senderName: '路人', text, chatTitle: '深海鱼塘', ...extra,
});

test('主人在群里不 @ 她也会回', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('今天怎么这么安静'));
  assert.equal(r.action, 'reply');
  cleanup();
});

test('主人在群里不 @ 也能执行命令', async () => {
  const { bot, config, cleanup } = makeBot();
  const r = await bot.decide(master('上下文 20'));
  assert.equal(r.action, 'command');
  assert.equal(config.chat.historyTurns, 20);
  cleanup();
});

test('主人在群里说「闭麦」直接执行', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('闭麦 5 分钟'));
  assert.equal(r.action, 'command');
  assert.equal(r.commandType, 'mute');
  cleanup();
});

test('普通人同样的话不执行、也不理', async () => {
  const { bot, config, cleanup } = makeBot();
  const before = config.chat.historyTurns;
  const r = await bot.decide(stranger('上下文 20'));
  assert.equal(r.action, 'ignore');
  assert.equal(config.chat.historyTurns, before, '普通人不能改配置');
  const r2 = await bot.decide(stranger('闭麦 5 分钟', { msgId: 'x2' }));
  assert.notEqual(r2.action, 'command');
  cleanup();
});

test('冒充主人（改昵称）没有命令权', async () => {
  const { bot, config, cleanup } = makeBot();
  const before = config.chat.historyTurns;
  const r = await bot.decide({ ...stranger('上下文 20'), senderName: 'Master', senderId: 'wxid_fake' });
  assert.equal(r.action, 'ignore');
  assert.equal(config.chat.historyTurns, before);
  cleanup();
});




test('主人骂她不会触发回怼', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(master('你就是个废物'));
  assert.equal(r.msg.fight, false);
  cleanup();
});


test('普通人收到的提示词里没有「身份纠错」那一段', async () => {
  const { bot, cleanup } = makeBot();
  const r = await bot.decide(stranger('@鲸鲸 在吗', { atMe: true }));
  assert.doesNotMatch(r.system, /身份纠错/);
  cleanup();
});
