'use strict';

/**
 * 回归：「状态播报」权重太高，她句句「我刚泡完脚，手还湿着呢」，人机感重。
 * 规则：时间照给；「在干嘛」按小时抽样，只当背景，并明确要求不要说出来。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig } = require('../src/config');
const persona = require('../src/persona');

function makeConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-status-'));
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(require('./allowlist-fixture').permit({})));
  const config = loadConfig({ root, env: {} });
  return { config, cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }) };
}

const msg = (extra = {}) => ({
  platform: 'wechat',
  chatId: 'wxid_status_self',
  chatType: 'private',
  senderId: 'wxid_status_self',
  senderName: 'Banan',
  text: '在吗',
  isMaster: false,
  ...extra,
});

function promptAt(config, date) {
  return persona.buildSystem({ config, msg: msg(), profile: {}, notes: [], now: date });
}




test('时间还是要给的（不然她会活在过去）', () => {
  const { config, cleanup } = makeConfig();
  const sys = promptAt(config, new Date(2026, 9, 26, 15, 42, 0));
  assert.match(sys, /15:42/, '当前时间必须出现在提示词里');
  cleanup();
});
