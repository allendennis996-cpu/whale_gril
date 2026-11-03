'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DEFAULT_CONFIG}=require('../src/config');
const {IsolatedLegacyStore,V2Store}=require('../src/memoryV2');
const {Bot}=require('../src/bot');
const lib=require('../src/personaLibrary');
const persona=require('../src/persona');

for(const Store of [IsolatedLegacyStore,V2Store]) for(const chatType of ['private','group']) for(const switchPersona of [false,true]) {
 test(`${Store.name} ${chatType} 切换人格=${switchPersona}：重启后旧问题只在记忆区，当前区仅本轮新消息`,async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fish-history-boundary-'));
  const c=structuredClone(DEFAULT_CONFIG);c.paths={dataDir:dir};c.wechat.account='fixture-account';
  c.wechat.allowlist={users:[{id:'fixture-user',name:''}],groups:[{id:'fixture-group@chatroom',name:''}]};
  c.persona.emojiLevel='关';c.chat.maxBubbles=4;
  const file=path.join(dir,Store===V2Store?'memory-v2':'store.json');
  let store=new Store({file,limits:c.memory});
  t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const captured=[];
  const llm={isMock:false,model:'fixture-model',async complete(request){if(request.auxiliary)return '{"need":false}';captured.push(request);return '今天挺好的呀';}};
  let bot=new Bot({config:c,store,llm});
  const m={platform:'wechat',account:'fixture-account',chatType,chatId:chatType==='group'?'fixture-group@chatroom':'fixture-user',senderId:'fixture-user',senderName:'虚构用户',atMe:true};
  const previous=await bot.decide({...m,text:'请介绍你自己',msgId:'old-question'});
  bot.finalize(previous,'我曾经叫测试鱼。');
  store.close();
  // 模拟更新人格文件/切换人格并重启；旧记录仍保留在磁盘。
  if(switchPersona){const card=lib.save(c,{name:'新测试人格',content:'你是测试助手，自然聊天。'});lib.bind(c,{default:true,id:card.id});}
  store=new Store({file,limits:c.memory});bot=new Bot({config:c,store,llm});
  await bot.handle({...m,text:'今天怎么样',msgId:'new-question'});
  assert.equal(captured.length,1);
  const input=captured[0].turns.map(x=>x.content).join('\n');
  const marker='【当前需要回应的消息】\n';
  const current=input.slice(input.lastIndexOf(marker)+marker.length);
  assert.match(current,/今天怎么样/);assert.doesNotMatch(current,/请介绍你自己|我曾经叫测试鱼/);
  const records=input.split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
  const old=records.find(x=>x.内容==='我曾经叫测试鱼。');
  assert.equal(old.角色,'assistant');if(switchPersona)assert.match(old.说明,/旧人格/);
  assert.ok(records.some(x=>x.内容==='请介绍你自己'));
  assert.match(captured[0].system,/只回应【当前需要回应的消息】/);
  assert.match(captured[0].system,/仅指本轮收到/);
  const key=bot.sessionKey(bot.normalize(m));
  assert.equal(store.messages(key,20).filter(x=>x.msgId==='old-question').length,1);
  assert.ok(store.messages(key,20).some(x=>x.role==='assistant'&&x.text==='我曾经叫测试鱼。'));
  assert.equal((await bot.handle({...m,text:'今天怎么样',msgId:'new-question'})).action,'ignore');
  assert.equal(captured.length,1);
  // 本轮批次混入已处理的旧 ID 时，当前消息仍只包含新来源。
  await bot.handle({...m,text:'批次占位',msgId:'batch',sourceMessages:[{id:'old-question',text:'请介绍你自己'},{id:'new-batch',text:'晚饭吃什么'}]});
  const batch=captured.at(-1).turns.map(x=>x.content).join('\n');
  const batchCurrent=batch.slice(batch.lastIndexOf(marker)+marker.length);
  assert.match(batchCurrent,/晚饭吃什么/);assert.doesNotMatch(batchCurrent,/请介绍你自己/);
 });
}

test('气泡：极短回复不凑条数，独立话题可多条，调教台上限四条和一条均生效',()=>{
 const topics=['先回答身份和称呼，这两个问题相关，我放在一起说明，避免每个问题各占一条消息。','再说今天的近况，这属于另一个话题，内容较多时可以独立发送。','最后回应你的心情，我会认真听，也希望你今天能轻松一点。'];
 const text=topics.join('\n\n');
 assert.deepEqual(persona.splitBubbles('今天还行，就是有点困',{maxChars:140,maxBubbles:4}),['今天还行，就是有点困']);
 assert.deepEqual(persona.splitBubbles(text,{maxChars:140,maxBubbles:4}),topics);
 assert.equal(persona.splitBubbles(text,{maxChars:500,maxBubbles:1}).length,1);
 assert.ok(persona.splitBubbles([...topics,...topics].join('\n\n'),{maxChars:140,maxBubbles:4}).length<=4);
 const list='处理步骤：\n\n1. '+ '先检查配置。'.repeat(6)+'\n\n2. '+'再启动服务。'.repeat(6);
 assert.deepEqual(persona.splitBubbles(list,{maxChars:500,maxBubbles:4}),[list]);
 assert.deepEqual(persona.splitBubbles(text,{maxChars:500,maxBubbles:4,allowTopicSplit:false}),[text]);
});
