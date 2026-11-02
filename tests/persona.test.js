'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const persona = require('../src/persona');
const { DEFAULT_CONFIG } = require('../src/config');

const config = {
  ...DEFAULT_CONFIG,
  persona: { ...DEFAULT_CONFIG.persona, name: '鲸鲸', aliases: ['鲸鲸', '鲸娘', '小鲸'], ownerName: '主人', master: { names: ['Master'], wxids: ['wxid_test_master'] } },
  chat: { ...DEFAULT_CONFIG.chat },
};



for (const [label, customPrompt] of [['默认', ''], ['自定义', '你是鲸鲸，保持一点俏皮。']]) {
  const promptConfig = { ...config, persona: { ...config.persona, customPrompt, stylePreset: '抽象' } };
  const build = (extra = {}) => persona.buildSystem({
    config: promptConfig,
    msg: { chatType: 'group', senderName: '阿螈', chatTitle: '深海鱼塘', ...extra },
    now: new Date('2024-05-01T14:30:00'),
  });


  test(`${label}提示词区分当前参与者、提及目标和请求回应状态`, () => {
    const sys = build({
      text: '@鲸鲸 帮我看下小海对阿螈说的「你」指谁',
      groupParticipants: ['阿螈', '小海', '旁观者'],
      mentionedNames: ['小海', '阿螈'],
      addressedToBot: true,
    });
    assert.match(sys, /【当前上下文参与者】\["阿螈","小海","旁观者"\]/);
    assert.match(sys, /不代表完整群成员名单/);
    assert.match(sys, /【当前消息提及目标】\["小海","阿螈"\]/);
    assert.match(sys, /【当前消息请求机器人回应】是/);
    assert.match(sys, /仅为路由信息，不改变引用和其他人的代词指向/);
    assert.match(sys, /参与者名单不等于当前被提及或被说话的对象/);
  });

  test(`${label}提示词保留显式未指向机器人，不推断缺失元数据`, () => {
    assert.match(build({ addressedToBot: false }), /【当前消息请求机器人回应】否/);
    for (const extra of [{}, { groupParticipants: [], mentionedNames: [] }]) {
      const sys = build(extra);
      assert.doesNotMatch(sys, /【当前上下文参与者】|【当前消息提及目标】|【当前消息请求机器人回应】/);
      assert.doesNotMatch(sys, /undefined|\[object Object\]/);
    }
  });
}


test('深夜心情自动变困', () => {
  const late = persona.moodFor(new Date('2024-05-01T02:00:00'));
  assert.equal(late.name, '有点困');
  const noon = persona.moodFor(new Date('2024-05-01T12:00:00'));
  assert.ok(persona.MOODS.some((m) => m.name === noon.name));
});

test('能识别 @ 和名字，并清洗掉提及', () => {
  assert.deepEqual(persona.cleanIncoming('@鲸鲸 在吗', config), { text: '在吗', atMe: true, hadAlias: true });
  assert.equal(persona.cleanIncoming('鲸娘，今天好累', config).atMe, true);
  assert.equal(persona.cleanIncoming('鲸娘，今天好累', config).text, '今天好累');
  const plain = persona.cleanIncoming('今天好累', config);
  assert.equal(plain.atMe, false);
  assert.equal(plain.text, '今天好累');
  // 名字出现在句子中间也算在叫她（群里常见说法）
  assert.equal(persona.cleanIncoming('我觉得鲸娘很可爱', config).atMe, true);
  assert.equal(persona.cleanIncoming('我觉得鲸娘很可爱', config).text, '我觉得 很可爱');
  // 但不能把更长昵称吞掉
  assert.equal(persona.cleanIncoming('@小鲸鱼 你好', config).atMe, false);
  assert.equal(persona.cleanIncoming('小鲸鱼今天好可爱', config).atMe, false);
});

test('演示台词：命中意图、不会为空、群聊更短', () => {
  const r = persona.mockReply({ text: '你好', chatType: 'private', rng: () => 0 });
  assert.ok(r.length > 0);
  const g = persona.mockReply({ text: '你是谁', chatType: 'group', rng: () => 0 });
  assert.ok(g.length > 0 && g.length < 80);
  for (const t of ['今天天气怎么样', '我好难过', '讲个笑话', '晚安', '随便说点什么']) {
    const reply = persona.mockReply({ text: t, chatType: 'private', rng: Math.random });
    assert.ok(reply.trim().length > 0, '对 ' + t + ' 应有回复');
    assert.ok(!reply.includes('作为AI'), '不应出现 AI 套话');
  }
});

test('splitBubbles：短句一条，长句按句号拆，数量受限', () => {
  assert.deepEqual(persona.splitBubbles('咕噜~', { maxChars: 50, maxBubbles: 2 }), ['咕噜~']);
  const long = '第一句话。第二句话！第三句话？第四句话。第五句话。';
  const bubbles = persona.splitBubbles(long, { maxChars: 12, maxBubbles: 2 });
  assert.ok(bubbles.length >= 1 && bubbles.length <= 2);
  assert.ok(bubbles.join('').length > 0);
  const one = persona.splitBubbles(long, { maxChars: 12, maxBubbles: 1 });
  assert.equal(one.length, 1);
  assert.ok(one[0].length <= 20);
});


test('主人权限不能只靠可修改昵称识别', () => {
  const sys = persona.buildSystem({
    config,
    msg: { chatType: 'private', senderName: 'master' },
    now: new Date('2024-05-01T14:30:00'),
  });
  assert.doesNotMatch(sys, /【主人】/);
});



test('别名是其他昵称的前缀时不能误删', () => {
  const atOther = persona.cleanIncoming('@小鲸鱼 你好', config);
  assert.equal(atOther.atMe, false);
  assert.equal(atOther.text, '@小鲸鱼 你好');
  const plainOther = persona.cleanIncoming('小鲸鱼好可爱', config);
  assert.equal(plainOther.atMe, false);
  assert.equal(plainOther.text, '小鲸鱼好可爱');
});

test('回复组织：相关多问题不要求逐条分段，气泡由程序负责', () => {
  const sys = persona.buildSystem({config, msg:{chatType:'private',senderName:'测试用户'}});
  assert.match(sys, /不要求默认挤在一条/);
  assert.match(sys, /程序按停顿、长度和调教台气泡上限/);
  assert.doesNotMatch(sys, /如果有几个不同的问题，逐条简短回应/);
});

test('气泡拆分保留短回复和必要结构，不按每句话连发', () => {
  const ordinary='来啦，今天精神不错。你问的几个事我一起说吧！';
  assert.deepEqual(persona.splitBubbles(ordinary,{maxChars:140,maxBubbles:8}),[ordinary]);
  const structured='先说原因。\n\n1. 检查配置\n2. 再启动服务\n\n```js\nconst x = 1;\n```';
  assert.deepEqual(persona.splitBubbles(structured,{maxChars:140,maxBubbles:8}),[structured]);
  const long='第一部分说明原因。\n\n第二部分提供步骤。\n\n第三部分补充结论。';
  const chunks=persona.splitBubbles(long,{maxChars:23,maxBubbles:3});
  assert.equal(chunks.join('').replace(/\s/g,''),long.replace(/\s/g,''));
  assert.ok(chunks.every(x=>x.length<=23));
  const clipped=persona.splitBubbles('长'.repeat(100),{maxChars:20,maxBubbles:2});
  assert.equal(clipped.length,2);
  assert.ok(clipped.every(x=>x.length<=20));
  assert.ok(clipped[1].endsWith('…'));
});
