'use strict';

/**
 * 「聊久了乱说话」—— 用户截图里的表现：句子开头通顺、越说越离谱、越说越长、
 * 而且几乎不带标点，最后被截断。
 *
 * 根因：frequency_penalty 0.35 + presence_penalty 0.25 会强迫模型避开常用词，
 * 再叠加 temperature 1.15 的高随机性，它就去挑生僻搭配：语法还是中文，语义全散了。
 *
 * 修法：① 默认参数归零惩罚项、温度降到 0.95、max_tokens 给到 4096；
 *       ② 旧字段一次迁移，保留用户明确保存的参数；
 *       ③ 输出侧兜底：识别跑飞/被截断 → 换保守参数重试，还不行就只发第一句。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG, loadConfig } = require('../src/config');
const { looksDegenerate, cutToSentence, DeepSeekClient } = require('../src/llm');

// 截图里那种「全是字但不成话」的样本
const BAD =
  '认真说这双随机数挺不卖转店号都查快递没做线我拿置谷配个零和让你行收快递时好上紫光这味一上举大你一用会弄头到还要顺你安找不早哦' +
  '而这边半夜能做的就一张干巴巴的眼一睁眼就算觉了再不把打拳摘了没别的就是把大半夜瞪天花板越想越清醒睡不着就别硬躺';

test('默认参数不再逼模型「避开常用词」', () => {
  const ds = DEFAULT_CONFIG.llm;
  assert.equal(Number(ds.frequencyPenalty) || 0, 0, 'frequency_penalty 必须归零');
  assert.equal(Number(ds.presencePenalty) || 0, 0, 'presence_penalty 必须归零');
  assert.ok(Number(ds.temperature) <= 1.0, '温度不该超过 1.0，实测 1.15 会跑飞：' + ds.temperature);
  assert.ok(Number(ds.temperature) >= 0.8, '也别太低，否则没「人味」：' + ds.temperature);
  assert.ok(Number(ds.maxTokens) >= 600, '输出预算要够，不然好东西被截断：' + ds.maxTokens);
});

test('config.example.json 和代码默认值一致（新装的用户不该踩坑）', () => {
  const ex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.example.json'), 'utf8'));
  assert.equal(Number(ex.llm.frequencyPenalty) || 0, 0);
  assert.equal(Number(ex.llm.presencePenalty) || 0, 0);
  assert.equal(Number(ex.llm.temperature), Number(DEFAULT_CONFIG.llm.temperature));
  assert.equal(Number(ex.llm.maxTokens), Number(DEFAULT_CONFIG.llm.maxTokens));
});



test('能认出手里这条「全是字但不成话」的跑飞样本', () => {
  assert.equal(looksDegenerate(BAD), true, '截图里那种回复必须被判为跑飞');
  // 正常回复不能误判
  const normal = [
    '累就先瘫着呗。怎么个累法，是身累还是心累？',
    '我叫鲸鲸啊，乐乐是别人瞎起的吧，我不认这个名。',
    '你这话说得挺逗的，那你倒是说说看，你行你上啊？',
    '行行行，你说什么都对。不过说真的，早点睡吧，别熬了。',
  ];
  for (const s of normal) assert.equal(looksDegenerate(s), false, '正常回复不该被误判：' + s);
});

test('撞上长度上限时退到最后一个完整句子', () => {
  const text = '今天天气挺好的呀。要不我们出去走走？我最近一直在家憋着，整个人都要长蘑菇了。然后呢，我还想';
  const cut = cutToSentence(text);
  assert.ok(cut.length < text.length, '要被截短');
  assert.ok(/[。？]$/.test(cut), '要停在完整句子上：' + cut);
});

/** 按真实路径造一个临时配置，再交给 DeepSeekClient（它会自己 resolveRuntime） */
function clientWith(deepseek, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-llm-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ deepseek, provider: 'deepseek' }), 'utf8');
  fs.writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify(settings), 'utf8');
  return new DeepSeekClient({ config: loadConfig({ root: dir, env: {} }) });
}


test('设置面板滑块的默认值不再是 1.25', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'web', 'index.html'), 'utf8');
  assert.doesNotMatch(page, /id="temperature"[^>]*value="1\.25"/, '滑块默认值不能还是 1.25');
  assert.match(page, /id="temperature"[^>]*value="0\.95"/, '滑块默认值应是 0.95');
});



test('跑飞重试会去掉惩罚项、压低温度', () => {
  // 注意：这些值故意不等于旧默认值，迁移不会动它们
  const client = clientWith({
    apiKey: 'sk-test',
    temperature: 1.3,
    frequencyPenalty: 0.5,
    presencePenalty: 0.4,
    maxTokens: 320,
  });
  const normal = client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }] });
  assert.equal(normal.frequency_penalty, 0.5, '正常请求保留用户配置');
  assert.equal(normal.presence_penalty, 0.4);
  assert.equal(normal.temperature, 1.3);

  const safe = client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }], safe: true });
  assert.equal('frequency_penalty' in safe, false, '保守参数不带惩罚项');
  assert.equal('presence_penalty' in safe, false);
  assert.ok(safe.temperature <= 0.7, '保守参数温度要低：' + safe.temperature);
  assert.ok(safe.max_tokens === 320, '保守参数保留显式输出预算：' + safe.max_tokens);
});

test('默认配置下惩罚项根本不会发给接口', () => {
  const client = clientWith({ apiKey: 'sk-test' });
  const payload = client.buildPayload({ system: 's', turns: [{ role: 'user', content: 'hi' }] });
  assert.equal('frequency_penalty' in payload, false);
  assert.equal('presence_penalty' in payload, false);
  assert.equal(payload.max_tokens, 4096);
  assert.equal(payload.temperature, DEFAULT_CONFIG.llm.temperature);
});
