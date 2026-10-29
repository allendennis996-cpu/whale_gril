'use strict';

/**
 * 主人判定的唯一实现（src/master.js）：所有渠道只按 ID 识别；旧昵称配置与备注不能提权。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { matchMaster, masterWarnings, looksLikeWxid } = require('../src/master');

const cfg = (names, wxids) => ({ persona: { master: { names, wxids } } });
const wechat = (senderId, senderName) => ({ platform: 'wechat', senderId, senderName });

test('wxid 对上就是主人，昵称改成什么都认', () => {
  const r = matchMaster(cfg(['阿鲸'], ['wxid_master_test']), wechat('wxid_master_test', '随便改的昵称'));
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'wxid');
});

test('配了真 wxid 时，光把昵称改成主人名字冒充不了', () => {
  const r = matchMaster(cfg(['阿鲸'], ['wxid_master_test']), wechat('wxid_fake', '阿鲸'));
  assert.equal(r.isMaster, false);
  assert.equal(r.reason, '');
});

test('wxids 错填时，昵称不能兜底', () => {
  const r = matchMaster(cfg(['阿鲸'], ['my_own_wechat_id']), wechat('wxid_master_test', '阿鲸'));
  assert.equal(r.isMaster, false);
  assert.equal(r.reason, '');
});

test('一条真 wxid + 一条错填的，仍然只认真 wxid', () => {
  const r = matchMaster(cfg([], ['my_own_wechat_id', 'wxid_master_test']), wechat('wxid_fake', '阿鲸'));
  assert.equal(r.isMaster, false);
});

test('没配主人时谁都不是主人，也不叫主人', () => {
  for (const id of ['wxid_any', '']) {
    const r = matchMaster(cfg([], []), wechat(id, '阿鲸'));
    assert.equal(r.isMaster, false);
  }
});

test('微信、网页、抖音均只认 ID，同名、缺 ID 和旧昵称名单均不能认证', () => {
  for (const platform of ['wechat','web','douyin']) {
    for (const wxids of [[],['wxid_master_test']]) {
      const config=cfg(['A-Jing'],wxids);
      config.persona.master.labels=[{id:'wxid_master_test',name:'A-Jing'}];
      for (const senderId of ['', 'wxid_fake']) assert.equal(matchMaster(config,{platform,senderId,senderName:'A-Jing'}).isMaster,false);
    }
    assert.equal(matchMaster(cfg([],['wxid_master_test']),{platform,senderId:'wxid_master_test',senderName:'随便改名'}).isMaster,true);
  }
});

test('ID 去除首尾空格后精确匹配，大小写不同不算同一个 ID', () => {
  const r = matchMaster(cfg(['  阿鲸 '], ['  wxid_master_test  ']), wechat('wxid_master_test', '阿鲸'));
  assert.equal(r.isMaster, true);
  assert.equal(r.reason, 'wxid');
  assert.equal(matchMaster(cfg([],['WXID_MASTER_TEST']),wechat('wxid_master_test','阿鲸')).isMaster,false);
});

test('wxids 里填微信号会给出人话告警', () => {
  const warn = masterWarnings(cfg(['阿鲸'], ['my_own_wechat_id']));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /不是 wxid/);
});

test('只填旧昵称时仍提示未设置主人', () => {
  const warn = masterWarnings(cfg(['阿鲸'], []));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /还没设置主人/);
});

test('没配主人时提醒未设置', () => {
  const warn = masterWarnings(cfg([], []));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /还没设置主人/);
});

test('配对了就没有告警', () => {
  assert.deepEqual(masterWarnings(cfg(['阿鲸'], ['wxid_master_test'])), []);
});

test('looksLikeWxid 认得清 wxid 和微信号', () => {
  assert.equal(looksLikeWxid('wxid_master_test'), true);
  assert.equal(looksLikeWxid('my_own_wechat_id'), false);
  assert.equal(looksLikeWxid('阿鲸'), false);
  assert.equal(looksLikeWxid(''), false);
});
