'use strict';

/**
 * C1/C2/C3 三条「顺手」修复的回归：
 *  C1 桥接同类错误日志节流（没配看图 Key 时以前每张图刷一条）
 *  C2 data/media-cache 启动时清理（以前永不清理）
 *  C3 搜「最新/现在」时过滤明显过期结果（以前把 2010 年的文章当现状）
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mediaCache = require('../src/mediaCache');
const websearch = require('../src/websearch');

const ROOT = path.resolve(__dirname, '..');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-c-'));
}

function writeFile(dir, name, { size = 10, ageDays = 0 } = {}) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 1));
  if (ageDays) {
    const t = (Date.now() - ageDays * 86400000) / 1000;
    fs.utimesSync(file, t, t);
  }
  return file;
}

test('C2：超过保留天数的媒体文件会被清掉，新的留着', () => {
  const dir = tmpDir();
  const old = writeFile(dir, 'old.jpg', { ageDays: 30 });
  const fresh = writeFile(dir, 'new.jpg', { ageDays: 1 });
  const r = mediaCache.cleanup(dir, { maxAgeDays: 7, maxTotalMB: 500 });
  assert.equal(fs.existsSync(old), false, '30 天前的应该删掉');
  assert.equal(fs.existsSync(fresh), true, '1 天前的要留着');
  assert.equal(r.removed, 1);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('C2：总量超限时按最旧优先删，不删空的', () => {
  const dir = tmpDir();
  const files = [
    writeFile(dir, 'a.jpg', { size: 400 * 1024, ageDays: 5 }),
    writeFile(dir, 'b.jpg', { size: 400 * 1024, ageDays: 3 }),
    writeFile(dir, 'c.jpg', { size: 400 * 1024, ageDays: 1 }),
  ];
  // 上限 0.5MB，必然要删
  const r = mediaCache.cleanup(dir, { maxAgeDays: 365, maxTotalMB: 0.5 });
  assert.ok(r.removed >= 1, '超总量必须删');
  assert.equal(fs.existsSync(files[2]), true, '最新的那个要留着');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

test('C2：目录不存在时安静返回，不抛异常', () => {
  const r = mediaCache.cleanup(path.join(os.tmpdir(), 'whale-nonexistent-' + Date.now()));
  assert.deepEqual(r, { removed: 0, freedMB: 0, kept: 0 });
});

const searchRouter=require('../src/searchRouter');
const searchNow=new Date('2026-11-03T15:00:00+08:00');
test('C3：新流程解析相对日期、发布日期；没有日期不认定为最新',()=>{
  assert.equal(searchRouter.publishedTime('3 天之前 正文',searchNow),+searchNow-3*86400000);
  assert.ok(searchRouter.publishedTime('2026年9月5日 正文',searchNow)<+searchNow);
  assert.equal(searchRouter.publishedTime('没有日期',searchNow),null);
});
test('C3：实时查询拒绝过期资料，未知日期标注限制',()=>{
  const intent={query:'显卡价格',fresh:'strict'};
  assert.equal(searchRouter.assess({title:'显卡价格',snippet:'2010年3月4日 价格100元'},intent,searchNow),null);
  assert.equal(searchRouter.assess({title:'显卡价格',snippet:'显卡价格100元'},intent,searchNow).checked,false);
});
test('C3：历史事实保留旧资料，不强加实时限制',()=>{
  assert.ok(searchRouter.assess({title:'红楼梦作者',snippet:'2010年3月4日 红楼梦作者为曹雪芹'}, {query:'红楼梦作者',fresh:'any'},searchNow));
});
test('C3：所有结果过期时不恢复旧结果充当最新资料',()=>{
  const results=[{title:'显卡价格',snippet:'2010年3月4日 显卡价格100元'}];
  assert.equal(results.map(r=>searchRouter.assess(r,{query:'显卡价格',fresh:'strict'},searchNow)).filter(Boolean).length,0);
});

test('C1：桥接里识别失败日志走节流函数', () => {
  const src = fs.readFileSync(path.join(ROOT, 'examples', 'wechatauto_bridge.py'), 'utf8');
  assert.match(src, /def log_throttled/, '要有节流函数');
  assert.match(src, /log_throttled\("img-fail:/, '看图失败要走节流');
  assert.match(src, /log_throttled\("voice-fail:/, '语音失败要走节流');
  assert.doesNotMatch(src, /\n\s+log\("第 %d 段识别失败/, '不能再无条件刷日志');
});

test('C3：清理查询词保留用户时间范围，不机械加年份',()=>{
  assert.equal(websearch.cleanQuery('查一下DeepSeek最新版本'),'DeepSeek最新版本');
  assert.equal(websearch.cleanQuery('查一下去年显卡价格'),'去年显卡价格');
});

test('C2：config.example 里能调媒体缓存策略', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(cfg.storage.mediaKeepDays, 7);
  assert.equal(cfg.storage.mediaMaxMB, 500);
});

test('C2：不写配置也有默认清理策略（config.storage 必须存在）', () => {
  const { loadConfig } = require('../src/config');
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{}');
  const cfg = loadConfig({ root: dir, env: {} });
  assert.equal(cfg.storage.mediaKeepDays, 7);
  assert.equal(cfg.storage.mediaMaxMB, 500);
  fs.writeFileSync(
    path.join(dir, 'config.json'),
    JSON.stringify({ storage: { mediaKeepDays: 30, mediaMaxMB: 1024 } })
  );
  const cfg2 = loadConfig({ root: dir, env: {} });
  assert.equal(cfg2.storage.mediaKeepDays, 30, '用户自己配的要生效');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
});

