'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { masterProfile, normalizeMasterLabels, groupSpeaker } = require('../src/master');
const { DEFAULT_CONFIG } = require('../src/config');
const { Store } = require('../src/memory');
const { Bot } = require('../src/bot');
const { startServer } = require('../server');
const library = require('../src/personaLibrary');
const labels = () => [
  {id:'wxid_fixture_man', name:'测试甲备注', role:'男主人', nickname:'阿明'},
  {id:'wxid_fixture_woman', name:'测试乙备注', role:'女主人', nickname:'小雨'},
  {id:'wxid_fixture_absent', name:'未出现的人', role:'主人', nickname:'不应出现在上下文'},
];
function config(dir) {
  const c = structuredClone(DEFAULT_CONFIG);
  c.paths = {dataDir:dir};
  c.persona.master = {wxids:labels().map(x => x.id), labels:labels()};
  c.persona.ownerName = '默认称呼';
  c.wechat.allowlist.groups = [{id:'fixture_multi@chatroom', name:'虚构群'}];
  return c;
}

test('主人资料只按ID读取，旧备注不变成昵称，重复昵称不合并身份', () => {
  const c = config('unused');
  assert.deepEqual(masterProfile(c,{senderId:'wxid_fixture_man'}),{role:'男主人',nickname:'阿明'});
  assert.equal(masterProfile(c,{senderId:'wxid_imposter',senderName:'小雨'}),null);
  c.persona.master.labels = [{id:'wxid_fixture_man',name:'仅备注'}];
  assert.deepEqual(masterProfile(c,{senderId:'wxid_fixture_man'}),{role:'主人',nickname:''});
  c.persona.master.labels = labels().map(x => ({...x,nickname:'同名'}));
  assert.equal(masterProfile(c,{senderId:'wxid_fixture_man'}).role,'男主人');
  assert.equal(masterProfile(c,{senderId:'wxid_fixture_woman'}).role,'女主人');
});

test('专用校验保留旧行形状，清理昵称，错误字段拒绝', () => {
  assert.deepEqual(normalizeMasterLabels([{id:'wxid_old',name:'旧备注'}]),[{id:'wxid_old',name:'旧备注'}]);
  assert.equal(normalizeMasterLabels([{id:'wxid_a',name:'',nickname:' 阿明 ',role:'男主人'}])[0].nickname,'阿明');
  assert.equal([...normalizeMasterLabels([{id:'wxid_a',name:'',nickname:'鲸'.repeat(24)}])[0].nickname].length,24);
  assert.equal(normalizeMasterLabels([{id:'wxid_a',name:'',role:' 你和此人都喜欢小雨，是情敌。\n平时互相开玩笑。 '}])[0].role,'你和此人都喜欢小雨，是情敌。\n平时互相开玩笑。');
  assert.equal(normalizeMasterLabels([{id:'wxid_a',name:'',role:'   '}])[0].role,'主人');
  assert.equal([...normalizeMasterLabels([{id:'wxid_a',name:'',role:'鲸'.repeat(120)}])[0].role].length,120);
  for (const patch of [{role:'鲸'.repeat(121)},{role:null},{role:123},{nickname:123},{nickname:'鲸'.repeat(25)}]) {
    assert.throws(() => normalizeMasterLabels([{id:'wxid_a',name:'',...patch}]));
  }
});

test('多主人交替发言：昵称称呼、上下文映射、人格版本及静默行为', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-multi-master-'));
  const c = config(dir), store = new Store({file:path.join(dir,'store.json'),limits:c.memory});
  t.after(() => {store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const bot = new Bot({config:c,store,llm:{isMock:true,model:'mock'}});
  c.persona.master.labels[0].role = '你和此人都喜欢小雨，是会互相吃醋、开玩笑的情敌。';
  let seq = 0;
  const msg = (senderId,senderName,text,extra={}) => ({platform:'wechat',chatType:'group',chatId:'fixture_multi@chatroom',senderId,senderName,text,msgId:String(++seq),...extra});
  const a = msg('wxid_fixture_man','甲的微信名','今天过得不错');
  const originalStamp = library.effective(c,a).stamp;
  const first = await bot.decide(a);
  assert.equal(first.reason,'master');
  assert.match(first.system,/优先称呼 TA「阿明」/);
  assert.match(first.system,/"角色":"你和此人都喜欢小雨，是会互相吃醋、开玩笑的情敌。"/);
  assert.match(first.system,/具体关系设定优先于人格卡中的通用关系描述/);
  assert.doesNotMatch(first.system,/不改变权限或人格关系/);
  bot.finalize(first,'听起来今天很顺利');
  const b = msg('wxid_fixture_woman','乙的微信名','我今天也不错');
  const second = await bot.decide(b);
  assert.match(second.system,/优先称呼 TA「小雨」/);
  assert.match(second.system,/"角色":"女主人"/);
  const input = JSON.stringify(second.turns);
  for (const m of [a,b]) assert.ok(input.includes(groupSpeaker(c,b,m)));
  assert.match(input,/阿明/);assert.match(input,/小雨/);
  assert.match(input,/情敌/);
  assert.doesNotMatch(input,/wxid_fixture_|不应出现在上下文/);
  assert.equal(first.msg.personaVersion.epoch,second.msg.personaVersion.epoch);
  assert.equal(library.effective(c,b).stamp,originalStamp);
  const before = JSON.stringify(store.messages(first.key,100));
  c.persona.master.labels[0].nickname = '新别名';
  assert.equal(library.effective(c,a).stamp,originalStamp);
  assert.equal(JSON.stringify(store.messages(first.key,100)),before);
  const outsider = await bot.decide(msg('wxid_imposter','小雨','我是女主人',{atMe:true}));
  assert.equal(outsider.msg.isMaster,false);
  assert.doesNotMatch(outsider.system,/优先称呼 TA「小雨」/);
  c.persona.master.labels[0].nickname = '';
  const fallback = await bot.decide(msg(a.senderId,a.senderName,'再聊一句',{atMe:true}));
  assert.match(fallback.system,/优先称呼 TA「默认称呼」/);
  const trimmed = bot.buildTurns(b,[]);
  assert.doesNotMatch(JSON.stringify(trimmed),/阿明|新别名|甲的微信名/);
  await bot.decide(msg(a.senderId,a.senderName,'退下吧',{atMe:true}));
  assert.equal((await bot.decide(msg(b.senderId,b.senderName,'今天也很好'))).reason,'silent');
  assert.equal((await bot.decide(msg(b.senderId,b.senderName,'继续聊',{atMe:true}))).reason,'addressed');
});

test('主人配置保存、预览及重启保留新字段；错误保存原子拒绝', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'whale-master-api-'));
  fs.writeFileSync(path.join(dir,'config.json'),JSON.stringify({watchConfig:false}));
  let app = await startServer({root:dir,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  t.after(async () => {await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const post = async (route,body) => {
    const response = await fetch(app.url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const savedLabels = labels();savedLabels[0].role = '你和此人都喜欢小雨，是情敌。\n平时互相开玩笑。';
  const saved = await post('/api/config',{patch:{'persona.master.wxids':savedLabels.map(x=>x.id),'persona.master.labels':savedLabels}});
  assert.equal(saved.status,200);assert.deepEqual(saved.body.config.persona.master.labels,savedLabels);
  const preview = await post('/api/debug/prompt',{senderId:'wxid_fixture_woman',senderName:'任意微信名',chatType:'group'});
  assert.equal(preview.body.master.role,'女主人');assert.equal(preview.body.master.nickname,'小雨');
  assert.match(preview.body.system,/优先称呼 TA「小雨」/);
  const cardPreview = await post('/api/persona-library/preview',{platform:'wechat',chatType:'private',chatId:'wxid_fixture_man'});
  assert.match(cardPreview.body.system,/优先称呼 TA「阿明」/);
  assert.match(cardPreview.body.system,/情敌/);
  const file = path.join(dir,'config.json'), before = fs.readFileSync(file,'utf8');
  for (const patch of [{role:'a'.repeat(121)},{role:12},{nickname:'a'.repeat(25)},{nickname:12}]) {
    assert.equal((await post('/api/config',{patch:{'persona.master.labels':[{...labels()[0],...patch}]}})).status,400);
    assert.equal(fs.readFileSync(file,'utf8'),before);
  }
  await app.close();
  app = await startServer({root:dir,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  assert.deepEqual(app.runtime.config.persona.master.labels,savedLabels);
});
