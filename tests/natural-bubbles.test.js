'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const persona=require('../src/persona');
const {DEFAULT_CONFIG}=require('../src/config');

test('普通连贯聊天按语义自然分条，没有换行也能拆；条数和单条长度受控',()=>{
 const text='还行呀，今天没什么大事，躺了一天摸鱼，脑子都懒得转。不过你晚上这一来，倒是有点精神了。你呢，今天过得开心不？';
 const chunks=persona.splitBubbles(text,{maxChars:140,maxBubbles:4});
 assert.ok(chunks.length>1&&chunks.length<=4);
 assert.equal(chunks.join(''),text);
 assert.ok(chunks.every(x=>x.length>=10&&x.length<=140));
 const lines='主人，讲个冷的哈——有一天白米饭去游泳，回来就变成粥了。\n这个是不是有点冷，不过我自己还挺喜欢的。';
 assert.equal(persona.splitBubbles(lines,{maxChars:140,maxBubbles:4}).length,2);
 assert.deepEqual(persona.splitBubbles(text,{maxChars:140,maxBubbles:1}),[text]);
 assert.deepEqual(persona.splitBubbles(text,{maxChars:140,maxBubbles:4,allowTopicSplit:false}),[text]);
 for(const maxBubbles of [1,2,4]){
  const many=persona.splitBubbles((text+'\n').repeat(5),{maxChars:140,maxBubbles});
  assert.ok(many.length<=maxBubbles);assert.ok(many.every(x=>x.length<=140));
 }
});

test('自然分条不制造等待用户的假象，所有人格共享时间边界',()=>{
 const c=structuredClone(DEFAULT_CONFIG);
 const sys=persona.buildSystem({config:c,msg:{chatType:'private',senderName:'虚构用户'}});
 assert.match(sys,/本轮回复尚未发送完成/);
 assert.match(sys,/不得自行推断用户已经沉默、离开或没有反应/);
 assert.match(sys,/不在同一轮里先讲完又催回复/);
 assert.match(sys,/发送间隔是程序节奏，不是用户沉默的证据/);
 assert.match(sys,/只回应【当前需要回应的消息】/);
 assert.doesNotMatch(sys,/日常默认一个连贯段落/);
});

test('网页单条和多气泡首条延迟一秒显示，后续按长度递增安排，不固定极速连发',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../web/assets/app.js'),'utf8');
 const fn=src.slice(src.indexOf('function expandBubbles('),src.indexOf('\nfunction showTyping('));
 const delays=[];
 const context={setTimeout(fn,delay){delays.push(delay);},addMessage(){},nowLabel(){return 'now';}};
 vm.runInNewContext(fn+'\nexpandBubbles({row:{remove(){}}}, ["第一条消息", "中等长度的消息内容", "长".repeat(60)]);',context);
 assert.equal(delays[0],1000);assert.ok(delays[1]-delays[0]>=800&&delays[1]-delays[0]<=1200);
 assert.equal(delays[2]-delays[1],1200);
 delays.length=0; vm.runInNewContext(fn+'\nexpandBubbles(null,["只有一条"]);',context);
 assert.deepEqual(delays,[1000]);
});

test('微信打字间隔按下一条长度计算，范围有界，已接入实际发送循环',()=>{
 const dir=path.join(__dirname,'../examples');
 const result=spawnSync('python',['-B','-c','from chat_pacing import bubble_delay_seconds as d; assert d("短") == 0.8; assert 0.8 < d("字"*20) < 1.2; assert d("字"*1000) == 1.2; assert d("") == 0.8'],{cwd:dir,encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
 const bridge=fs.readFileSync(path.join(dir,'wechatauto_bridge.py'),'utf8');
 assert.match(bridge,/time\.sleep\(1\.0 if first else bubble_delay_seconds\(line\)\)/);
});

test('网页生成片段先缓存，生成结束才交给延迟发送，避免全文提前显示',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../web/assets/app.js'),'utf8');
 const start=src.indexOf('const handleEvent = (evt) => {');
 const handler=src.slice(start,src.indexOf('\n    };',start)+7);
 const sends=[];
 const context={showTyping(){},expandBubbles(node,bubbles){sends.push(Array.from(bubbles));},addMessage(){throw Error('内容提前显示');},toast(){}};
 vm.runInNewContext('let full=""; let gotAny=false; '+handler+'\nhandleEvent({type:"delta",text:"第一句话"});',context);
 assert.equal(sends.length,0);
 vm.runInNewContext('handleEvent({type:"done",text:"第一句话",bubbles:["第一句话"]});',context);
 assert.deepEqual(sends,[['第一句话']]);
});
