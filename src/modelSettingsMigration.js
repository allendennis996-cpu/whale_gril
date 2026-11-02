'use strict';

const fs = require('node:fs');
const path = require('node:path');

function read(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(file + '.tmp', file);
}

// 只在加载配置的边界迁移。先保存 settings，再清除旧配置；中断后再次运行也不会覆盖新值。
function migrateModelSettings(root) {
  const configFile = path.join(root, 'config.json');
  const settingsFile = path.join(root, 'data', 'settings.json');
  const config = read(configFile), settings = read(settingsFile);
  if (!config.deepseek && !Object.hasOwn(settings, 'apiKey') && !Object.hasOwn(config.llm || {}, 'apiKey')) return false;
  const backup = path.join(root, 'data', 'backups', 'model-settings-migration');
  fs.mkdirSync(backup, { recursive: true });
  for (const file of [configFile, settingsFile]) {
    const target = path.join(backup, path.basename(file));
    if (fs.existsSync(file) && !fs.existsSync(target)) fs.copyFileSync(file, target);
  }
  const old = config.deepseek || {};
  const provider = config.provider || old.provider || 'deepseek';
  config.provider = provider;
  config.llm = config.llm || {};
  for (const key of ['baseUrl', 'model', 'temperature', 'thinking', 'frequencyPenalty', 'presencePenalty', 'timeoutMs', 'maxTokens', 'mock']) {
    if (config.llm[key] === undefined && old[key] !== undefined) config.llm[key] = old[key];
  }
  const keys = { ...(settings.keys || {}) };
  if (config.llm.apiKey && !keys[provider]) keys[provider] = config.llm.apiKey;
  if (old.apiKey && !keys[provider]) keys[provider] = old.apiKey;
  const active = settings.provider || provider;
  if (settings.apiKey && !settings.keys?.[active]) keys[active] = settings.apiKey;
  settings.keys = keys;
  delete settings.apiKey;
  delete config.llm.apiKey;
  delete config.deepseek;
  write(settingsFile, settings);
  write(configFile, config);
  return true;
}

module.exports = { migrateModelSettings };
