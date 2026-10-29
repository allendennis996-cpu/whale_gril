'use strict';
const fs = require('node:fs');
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('白名单必须是对象');
  const out = {};
  for (const kind of ['users', 'groups']) {
    if (!Array.isArray(value[kind])) throw Error('白名单 ' + kind + ' 必须是列表');
    const seen = new Set();
    out[kind] = value[kind].flatMap((row, i) => {
      const error = () => { throw Error(`白名单 ${kind} 第 ${i + 1} 行：ID 或名称不合法，或 ID 重复`); };
      if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') return error();
      const id = row.id.trim(), name = row.name.trim();
      if (!id && !name) return [];
      if (!/^[A-Za-z0-9_.@-]+$/.test(id) || id === 'unknown' || id.includes('*') || (kind === 'groups' ? !/^[A-Za-z0-9_.-]+@chatroom$/.test(id) : id.includes('@')) || seen.has(id)) return error();
      seen.add(id); return [{id, name}];
    });
  }
  return out;
}
function current(config) {
  try {
    // 每次检查读取落盘值，配置读取失败时不沿用之前的权限。
    const file = config?.paths?.configFile;
    const cfg = file ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : config;
    return normalize(cfg?.wechat?.allowlist);
  } catch { return {users: [], groups: []}; }
}
function allows(config, msg) {
  if (msg?.platform !== 'wechat') return true;
  const id = String(msg.chatId || '');
  const kind = msg.chatType === 'group' ? 'groups' : 'users';
  return current(config)[kind].some(row => row.id === id);
}
function target(config, id) { return allows(config, {platform:'wechat', chatId:id, chatType: String(id).endsWith('@chatroom') ? 'group' : 'private'}); }
module.exports = {normalize, current, allows, target};
