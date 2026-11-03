'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { startServer } = require('../server');

test('冒烟脚本按当前人格接口契约检查隔离服务', { skip: process.platform !== 'win32' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-smoke-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'web', 'assets'), { recursive: true });
  const script = path.join(root, 'scripts', 'smoke.ps1');
  fs.copyFileSync(path.join(__dirname, '..', 'scripts', 'smoke.ps1'), script);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    watchConfig: false, llm: { mock: true }, log: { level: 'error' },
    gateway: { wechat: { enabled: true, inboundToken: 'fake-smoke-token' } },
  }));
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html><title>鲸鲸</title>');
  // 本测试只覆盖脚本与 API 契约；静态资源使用独立夹具，不依赖用户图片。
  for (const asset of ['style.css', 'app.js', 'avatar.jpg', 'jingjing.jpg']) {
    fs.writeFileSync(path.join(root, 'web', 'assets', asset), 'fixture '.repeat(50));
  }
  const app = await startServer({ root, env: { WHALE_LOG_FILE: '' }, port: 0, openBrowser: false });
  app.runtime.bot.mockChunkDelayMs = 0;
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-BaseUrl', app.url], {
        windowsHide: true, timeout: 60000,
      });
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, output }));
    });
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /\[PASS\] GET \/api\/persona/);
  } finally {
    await app.close();
  }
});
