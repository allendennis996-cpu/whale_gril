'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 class Element{
  constructor(){this.children=[];this.dataset={};this.value='';this.textContent='';this.classList={add(){},toggle(){}};}
  append(...items){this.children.push(...items);} replaceChildren(...items){this.children=items;}
  setAttribute(){} removeAttribute(){} querySelector(){return null;} querySelectorAll(){return [];}
 }
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 const ctx=vm.createContext({document:{getElementById:get,createElement:()=>new Element()},window:{addEventListener(){}},Option:class{constructor(name,id){this.value=id;}},structuredClone,console});
 vm.runInContext(fs.readFileSync(require.resolve('../web/assets/conversation-picker.js'),'utf8'),ctx);
 let source=fs.readFileSync(require.resolve('../web/assets/persona-cards.js'),'utf8');source=source.replace("load().catch(e=>message('message',e.message));",'');vm.runInContext(source,ctx);
 const run=code=>vm.runInContext(code,ctx);
 run("base={account:'fake-account',bindings:{},cards:[{id:'a',name:'A'}],loaded:{},defaultId:'a'};parameterBase={identity:{name:'',age:0,job:'',aliases:[]},params:{}};params={};$('platform').value='web';$('conversationType').value='private';");
 return {run,get};
}
test('新增空白行可撤销，切换筛选后仍保留草稿',()=>{
 const {run,get}=fixture();run("$('addConversation').onclick()");assert.equal(get('revertBindings').disabled,false);assert.equal(get('saveBindings').disabled,true);
 run("$('conversationType').value='group';$('conversationType').onchange();$('revertBindings').onclick()");assert.equal(run('rows.size'),0);
});
test('输入不匹配选中会话时禁止保存，重新渲染保留筛选文字',()=>{
 const {run,get}=fixture();run("const row={platform:'web',chatType:'private',chatId:'fake-user',name:'测试'};const key=scope(row);rows.set(key,row);changes.set(key,{...row,id:'a'});renderRows();update();");
 const input=get('conversationRows').children[0].children[0].children[0];input.value='其他会话';input.oninput();assert.equal(get('saveBindings').disabled,true);
 run('renderRows()');assert.equal(get('conversationRows').children[0].children[0].children[0].value,'其他会话');
 assert.match(get('conversationRows').children[0].children[0].children[2].textContent,/请重新选择会话/);
});
test('保存提示汇总被筛选隐藏的私聊和群聊修改',()=>{
 const {run,get}=fixture();run("changes.set('p',{platform:'web',chatType:'private',id:'a'});changes.set('g',{platform:'web',chatType:'group',id:'a'});changes.set('w',{platform:'wechat',chatType:'group',id:'a'});update();");
 assert.match(get('bindingSummary').textContent,/私聊 1 项、群聊 1 项/);
});
test('已保存绑定移除后保留待移除行，撤销恢复原绑定',()=>{
 const {run,get}=fixture();run("const row={platform:'web',chatType:'private',chatId:'fake-user',name:'测试'};const key=scope(row);base.bindings[key]={id:'a'};rows.set(key,row);renderRows();");
 get('conversationRows').children[0].children[2].onclick();assert.match(get('conversationRows').children[0].children[0].children[2].textContent,/待移除/);
 run("$('revertBindings').onclick()");assert.equal(run('changes.size'),0);assert.equal(run('[...rows.values()][0].removed'),undefined);
});
