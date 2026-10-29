'use strict';

/**
 * 主人身份认证 —— 全项目只在这里判断「这条消息是不是主人发的」。
 *
 * 为什么要单独一个文件：以前 bot.js（真正跑消息的地方）和 server.js（调试台预览提示词）
 * 各写了一套规则，两边不一致 —— 调试台显示「识别为主人」，微信里却当陌生人，
 * 于是在控制台怎么改都像没生效。现在两边都调 matchMaster()。
 *
 * 所有渠道只按发送者真实 ID 精确匹配；不使用昵称或名称备注认证。
 * 老配置中的 master.names 不再参与认证。
 */

const WXID_RE = /^wxid_[A-Za-z0-9_-]+$/;

function asList(value) {
  return (Array.isArray(value) ? value : [])
    .map((v) => String(v == null ? '' : v).trim())
    .filter(Boolean);
}

/** 取出主人名单（顺手去掉空行和首尾空格，网页里一行一个） */
function masterLists(config) {
  const master = (config && config.persona && config.persona.master) || {};
  return { wxids: asList(master.wxids) };
}

/** 这串是不是微信内部 id（wxid_xxx）。自己设的微信号（形如 abc12345）和昵称都不算 */
function looksLikeWxid(value) {
  return WXID_RE.test(String(value == null ? '' : value).trim());
}

/**
 * 判断这条消息的发送者是不是主人。
 * @param {object} config 运行时配置
 * @param {{platform?: string, senderId?: string, senderName?: string}} msg
 * @returns {{
 *   isMaster: boolean, reason: string, wxids: string[],
 *   senderId: string, senderName: string, platform: string
 * }}
 * reason: 'wxid' 按 ID 认证 / '' 非主人
 */
function matchMaster(config, msg = {}) {
  const { wxids } = masterLists(config);
  const senderId = String((msg && msg.senderId) || '').trim();
  const senderName = String((msg && msg.senderName) || '').trim();
  const platform = String((msg && msg.platform) || '').trim().toLowerCase();

  const isMaster = Boolean(senderId) && wxids.includes(senderId);
  return { isMaster, reason:isMaster ? 'wxid' : '', wxids, senderId, senderName, platform };
}

/** 配置明显有问题时返回人话提示（调试台和日志用，不影响判定） */
function masterWarnings(config) {
  const { wxids } = masterLists(config);
  const out = [];
  if (!wxids.length) {
    out.push('还没设置主人：主人 ID 名单为空，谁都不算主人');
    return out;
  }
  const bad = wxids.filter((w) => !looksLikeWxid(w));
  if (bad.length) {
    out.push(
      '「' + bad.join('、') + '」不是 wxid（微信内部 id 形如 wxid_xxxxxxxx，不是你设置的微信号），' +
      '在微信里认不出来'
    );
  }
  return out;
}

module.exports = { matchMaster, masterWarnings, masterLists, looksLikeWxid };
