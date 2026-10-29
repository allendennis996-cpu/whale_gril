'use strict';
// 只保存已操作账号的身份元数据；与聊天记录及放行配置独立，仅存本机。
const fs = require('node:fs');
const path = require('node:path');
const identities = require('./wechatIdentities');

function clean(raw) {
  if (!raw || typeof raw.account !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(raw.account) || raw.account === '.' || raw.account === '..') return null;
  return {
    account: raw.account,
    wxid: typeof raw.wxid === 'string' ? raw.wxid.slice(0, 200) : '',
    nick: typeof raw.nick === 'string' ? raw.nick.slice(0, 200) : '',
    dbDir: typeof raw.dbDir === 'string' ? raw.dbDir : '',
    lastActive: Number.isFinite(raw.lastActive) ? Math.max(0, raw.lastActive) : 0,
  };
}
function readProfile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw.version === 1 ? clean(raw) : null;
  } catch { return null; }
}
function accounts(config) {
  const dir = config?.paths?.dataDir;
  if (!dir) return [];
  const root = path.join(dir, 'wechat-identities');
  let folders;
  try { folders = fs.readdirSync(root).filter(name => /^[a-f0-9]{64}$/.test(name)); } catch { return []; }
  const seen = new Map();
  const add = row => {
    const old = seen.get(row.account);
    const newer = !old || row.lastActive >= old.lastActive;
    seen.set(row.account, {
      account: row.account,
      wxid: (newer ? row.wxid : old.wxid) || old?.wxid || row.wxid,
      nick: (newer ? row.nick : old.nick) || old?.nick || row.nick,
      dbDir: (newer ? row.dbDir : old.dbDir) || old?.dbDir || row.dbDir,
      lastActive: Math.max(old?.lastActive || 0, row.lastActive),
    });
  };
  for (const folder of folders) {
    for (const source of ['account.bridge', 'account.gateway']) {
      const file = path.join(root, folder, source + '.json');
      const row = readProfile(file);
      if (row && identities.fileFor(dir, row.account, source) === file) add(row);
    }
    // 兼容升级前已按账号隔离的目录；不猜测旧版无账号目录的归属。
    for (const source of ['bridge', 'gateway']) {
      const file = path.join(root, folder, source + '.json');
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const row = clean({account:raw.account, lastActive:0});
        if (!row || raw.version !== 2 || identities.fileFor(dir, row.account, source) !== file || !Array.isArray(raw.rows)) continue;
        row.lastActive = raw.rows.reduce((latest, item) => Math.max(latest, Number(item?.lastSeen) || 0), 0) || fs.statSync(file).mtimeMs;
        add(row);
      } catch { /* 损坏记录不改变其他账号的归属。 */ }
    }
  }
  return [...seen.values()].sort((a,b) => b.lastActive-a.lastActive || a.account.localeCompare(b.account));
}
function remember(config, info) {
  const dir = config?.paths?.dataDir;
  const row = clean({account:info?.account, wxid:info?.account_wxid, nick:info?.account_nick, dbDir:info?.account_db_dir, lastActive:Date.now()});
  if (!dir || !row) return;
  try {
    const file = identities.fileFor(dir, row.account, 'account.gateway');
    const old = readProfile(file);
    for (const key of ['wxid','nick','dbDir']) row[key] ||= old?.[key] || '';
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file+'.tmp', JSON.stringify({version:1,...row}));
    fs.renameSync(file+'.tmp', file);
  } catch { /* 不把本机身份信息写入日志。 */ }
}
module.exports = {accounts, remember};
