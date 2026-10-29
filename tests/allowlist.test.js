'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {spawnSync} = require('node:child_process');
const list = require('../src/allowlist');
const {Bot} = require('../src/bot');
const {Gateway} = require('../src/adapters/gateway');
const {startServer} = require('../server');
const {DEFAULT_CONFIG} = require('../src/config');
const empty = () => ({users:[],groups:[]});
const config = () => ({wechat:{allowlist:{users:[{id:'wxid_a',name:'甲'}],groups:[{id:'123@chatroom',name:'群'}]}}});
const msg = (id='wxid_a', type='private') => ({platform:'wechat',chatId:id,chatType:type,senderId:'wxid_a',text:'https://example.com'});

test('白名单精确匹配且私聊群聊互不放行；名称和主人身份不参与权限', () => {
  const cfg = config();
  assert.equal(list.allows(cfg,msg()),true);
  assert.equal(list.allows(cfg,msg('123@chatroom','group')),true);
  for(const m of [msg('甲'),msg('wxid_a','group'),msg('123@chatroom'),msg('unknown'),msg('wxid')]) assert.equal(list.allows(cfg,m),false);
  assert.equal(list.allows({},msg()),false);
  assert.equal(list.allows({}, {...msg(),platform:'web'}),true);
  assert.equal(list.allows({}, {...msg(),platform:'douyin'}),true);
  cfg.wechat.allowlist.users[0].name='另一个人';assert.equal(list.allows(cfg,msg()),true);
  cfg.wechat.allowlist.groups='bad';assert.equal(list.allows(cfg,msg()),false);
});
test('校验清洗空白行，拒绝重复/越界类型/名称无ID/非字符串', () => {
  assert.deepEqual(list.normalize({users:[{id:' wxid_a ',name:' 甲 '},{id:' ',name:''}],groups:[]}),{users:[{id:'wxid_a',name:'甲'}],groups:[]});
  for(const users of [[{id:'',name:'甲'}],[{id:'a',name:''},{id:'a',name:''}],[{id:'*',name:''}],[{id:'123@chatroom',name:''}],['a']]) assert.throws(()=>list.normalize({users,groups:[]}));
});
test('未放行消息在链接读取、日志、会话创建之前被拦截，包括直接调用核心', async () => {
  const trap = () => {throw Error('不应产生副作用');};
  const cfg=structuredClone(DEFAULT_CONFIG);
  const bot=new Bot({config:cfg, store:{ensureSession:trap},llm:{},logger:{info:trap},linkReader:trap});
  assert.equal((await bot.decide(msg())).reason,'not_allowlisted');
  const gateway=new Gateway({platform:'wechat',bot,logger:{info:trap}});
  assert.equal((await gateway.handleInbound(msg())).reason,'not_allowlisted');
});
test('生成期间撤销名单：最终写入和网关交付都被拦截',async()=>{
  const cfg=config();
  const bot=new Bot({config:cfg,store:{appendMessage(){throw Error('不得写入');}},llm:{}});
  cfg.wechat.allowlist=empty();assert.deepEqual(bot.finalize({msg:msg()},'回复'),[]);
  cfg.wechat.allowlist=config().wechat.allowlist;
  const gateway=new Gateway({platform:'wechat',bot:{config:cfg,async handle(){cfg.wechat.allowlist=empty();return {action:'reply',reply:'不应发送'};}}});
  assert.equal((await gateway.handleInbound({chat_id:'wxid_a',text:'你好'})).reason,'not_allowlisted');
});
test('配置API保存对象名单、重载及错误行原子拒绝；名称解析失败不影响备注保存', async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-allowlist-'));
  const app=await startServer({root,env:{WHALE_LOG_FILE:''},port:0,openBrowser:false});
  t.after(async()=>{await app.close();fs.rmSync(root,{recursive:true,force:true});});
  const request=async(patch)=>{const response=await fetch(app.url+'/api/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({patch})});return {status:response.status,body:await response.json()};};
  const saved=await request({'wechat.allowlist.users':[{id:' wxid_a ',name:'<名称>'}]});
  assert.equal(saved.status,200);assert.deepEqual(saved.body.config.wechat.allowlist.users,[{id:'wxid_a',name:'<名称>'}]);
  assert.equal(list.allows(app.runtime?.config || {paths:{configFile:path.join(root,'config.json')}},msg()),true);
  const owners=await request({'persona.master.wxids':['wxid_owner'], 'persona.master.labels':[{id:'wxid_owner',name:'主人备注'}]});
  assert.equal(owners.status,200);
  assert.deepEqual(owners.body.config.persona.master.labels,[{id:'wxid_owner',name:'主人备注'}]);
  assert.deepEqual(owners.body.config.persona.master.wxids,['wxid_owner']);
  assert.deepEqual(owners.body.config.persona.master.names,[]);
  const before=fs.readFileSync(path.join(root,'config.json'),'utf8');
  assert.equal((await request({'wechat.allowlist.users':[{id:'',name:'没有ID'}]})).status,400);
  assert.equal(fs.readFileSync(path.join(root,'config.json'),'utf8'),before);
  const names=await fetch(app.url+'/api/wechat/resolve-names',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'users',ids:['wxid_a']})}).then(r=>r.json());
  assert.equal(names.ok,false);
  await request({'wechat.allowlist':empty()});assert.equal(list.target({paths:{configFile:path.join(root,'config.json')}},'wxid_a'),false);
});
test('JavaScript/Python共享同一批匹配样例，磁盘配置损坏时共同拒绝',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-list-python-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json');fs.writeFileSync(file,JSON.stringify(config()));
  const cases=[['wxid_a',true],['123@chatroom',true],['甲',false],['wxid_b',false],['',false]];
  for(const [id,expected] of cases) assert.equal(list.target({paths:{configFile:file}},id),expected);
  const script="import sys,json;sys.path.insert(0,'examples');from wechat_allowlist import allowed;print(json.dumps([allowed(sys.argv[1],x) for x in json.loads(sys.argv[2])]))";
  const child=spawnSync('python',['-c',script,file,JSON.stringify(cases.map(x=>x[0]))],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),cases.map(x=>x[1]));
  fs.writeFileSync(file,'broken');assert.equal(list.target({paths:{configFile:file}},'wxid_a'),false);
});

function ui() {
  const source=fs.readFileSync(path.join(__dirname,'../web/debug.html'),'utf8');
  const nodes={};let pending;
  class Element {
    constructor(){this.value='';this.isConnected=true;this.style={};this.children=[];this.parts={};}
    set innerHTML(v){this.html=v;if(v.includes('al-id')) for(const key of ['al-id','al-name','al-state','al-resolve','al-remove','al-toggle']) this.parts['.'+key]=new Element();}
    setAttribute(key,value){this[key]=value;}
    getAttribute(key){return this[key];} removeAttribute(key){delete this[key];}
    querySelector(k){return this.parts[k];} append(e){this.children.push(e);} remove(){this.isConnected=false;}
  }
  nodes['al-masters']=new Element();nodes['addMasterRow']=new Element();nodes['id-choices-users']=new Element();nodes['id-choices-groups']=new Element();nodes['al-users']=new Element();nodes.allowlistResult=new Element();
  const ctx=vm.createContext({document:{createElement:()=>new Element()},$:id=>nodes[id],esc:s=>String(s).replaceAll('<','&lt;'),refreshDirty(){},fetch:(url)=>url === '/api/wechat/identities' ? Promise.resolve({ok:true,json:async()=>({ok:true,...(ctx.serverChoices || {users:[],groups:[],account:''})})}) : new Promise(resolve=>{pending=resolve;})});
  vm.runInContext(source.slice(source.indexOf('function renderAllowlistResult('),source.indexOf('function renderForm(')),ctx);
  ctx.addAllowlistRow('users',{id:'',name:''});
  const row=nodes['al-users'].children[0];
  return {row,ctx,nodes,complete(data){pending({ok:true,json:async()=>data});}};
}
test('名称识别自动填空字段，手动备注保留，迟到结果不能覆盖新ID',async()=>{
  const h=ui(),row=h.row,id=row.querySelector('.al-id'),name=row.querySelector('.al-name');
  id.value='wxid_a';const first=id.onblur();h.complete({ok:true,results:[{found:true,name:'自动名称'}]});await first;assert.equal(name.value,'自动名称');
  name.value='手动备注';name.oninput();const second=id.onblur();h.complete({ok:true,results:[{found:true,name:'新名称'}]});await second;assert.equal(name.value,'手动备注');
  const third=id.onblur();id.value='wxid_b';id.oninput();h.complete({ok:true,results:[{found:true,name:'旧账号'}]});await third;assert.equal(name.value,'');
  h.ctx.renderAllowlistResult({users:[{id:'wxid_a',name:'<备注>'}],groups:[]});assert.match(h.nodes.allowlistResult.html,/&lt;备注>/);
});

test('主人wxid自动放行私聊，不放行群或昵称；移除主人后即时撤销', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-master-allow-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'config.json');
  const cfg={wechat:{allowlist:empty()},persona:{master:{wxids:[' wxid_owner ','123@chatroom','nickname'],names:['路人']}}};
  fs.writeFileSync(file,JSON.stringify(cfg));
  const runtime={paths:{configFile:file}};
  assert.equal(list.target(runtime,'wxid_owner'),true);
  assert.equal(list.allows(runtime,msg('123@chatroom','group')),false);
  assert.equal(list.target(runtime,'nickname'),false);
  const script="import sys,json;sys.path.insert(0,'examples');from wechat_allowlist import allowed;print(json.dumps([allowed(sys.argv[1],x) for x in ['wxid_owner','123@chatroom','nickname']]))";
  const child=spawnSync('python',['-c',script,file],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout),[true,false,false]);
  cfg.wechat.allowlist.users=[{id:'wxid_owner',name:'备注'}];fs.writeFileSync(file,JSON.stringify(cfg));
  assert.equal(list.current(runtime).users.length,1);
  cfg.persona.master.wxids=[];cfg.wechat.allowlist=empty();fs.writeFileSync(file,JSON.stringify(cfg));
  assert.equal(list.target(runtime,'wxid_owner'),false);
  const h=ui();h.ctx.renderAllowlistResult(empty(),['wxid_owner']);
  assert.match(h.nodes.allowlistResult.html,/主人（自动放行）/);assert.doesNotMatch(h.nodes.allowlistResult.html,/全部静默/);
});


test('主人行复用识别备注；下拉候选按用户/群隔离、去重并保留手输',async()=>{
  const h=ui();
  h.ctx.updateIdChoices({users:[{id:'wxid_a',name:'最近发言者'},{id:'wxid_a',name:'重复'},{id:'123@chatroom',name:'不应出现'}],groups:[{id:'123@chatroom',name:'测试群'},{id:'wxid_a',name:'不应出现'}]});
  assert.match(h.nodes['id-choices-users'].html,/最近发言者/);
  assert.doesNotMatch(h.nodes['id-choices-users'].html,/@chatroom|重复/);
  assert.match(h.nodes['id-choices-groups'].html,/测试群/);
  h.ctx.renderMasterEditor({persona:{master:{wxids:['wxid_a'],labels:[{id:'wxid_a',name:'保存的备注'}]}}});
  const row=h.nodes['al-masters'].children[0],id=row.querySelector('.al-id'),name=row.querySelector('.al-name');
  assert.equal(id.role,'combobox');assert.equal(name.value,'保存的备注');
  id.onchange();assert.equal(name.value,'保存的备注');
  id.value='wxid_a';id.oninput();id.onchange();assert.equal(name.value,'最近发言者');
  id.value='wxid_manual';id.oninput();id.onchange();assert.equal(id.value,'wxid_manual');assert.equal(name.value,'');
  const lookup=id.onblur();h.complete({ok:true,results:[{found:true,name:'手填对象'}]});await lookup;assert.equal(name.value,'手填对象');
  row.querySelector('.al-remove').onclick();assert.equal(row.isConnected,false);
});

test('会话搜索匹配名称与ID片段；鼠标选择和键盘选择均写入真实ID',async()=>{
  const h=ui();h.ctx.updateIdChoices({users:[{id:'wxid_A1',name:'张小明'},{id:'wxid_B2',name:'Alice'}],groups:[{id:'456@chatroom',name:'同学群'}]});
  h.ctx.serverChoices=vm.runInContext('({...ID_CHOICES,account:ID_CHOICES_ACCOUNT})',h.ctx);
  assert.equal(h.ctx.filterIdChoices('masters','小明')[0].id,'wxid_A1');
  assert.equal(h.ctx.filterIdChoices('users','WXID_b')[0].name,'Alice');
  assert.equal(h.ctx.filterIdChoices('users','alice')[0].id,'wxid_B2');
  assert.equal(h.ctx.filterIdChoices('groups','同学')[0].id,'456@chatroom');
  assert.equal(h.ctx.filterIdChoices('users','同学').length,0);
  const id=h.row.querySelector('.al-id'),name=h.row.querySelector('.al-name');
  id.value='小明';id.oninput();const options=h.row.children[0];
  assert.equal(options.children[0].textContent,'张小明 · wxid_A1');await options.children[0].onclick();
  assert.equal(id.value,'wxid_A1');assert.equal(name.value,'张小明');assert.equal(options.hidden,true);
  id.value='alice';id.oninput();id.onkeydown({key:'ArrowDown',preventDefault(){}});await id.onkeydown({key:'Enter',preventDefault(){}});
  assert.equal(id.value,'wxid_B2');assert.equal(name.value,'Alice');
});


test('选择旧账号候选前再次核对账号，切换后不带入旧号身份',async()=>{
  const h=ui();h.ctx.updateIdChoices({account:'wxid_bot_demo_A',users:[{id:'wxid_only_A',name:'A的好友'}],groups:[]});
  h.ctx.serverChoices={account:'wxid_bot_demo_B',users:[{id:'wxid_only_B',name:'B的好友'}],groups:[]};
  const id=h.row.querySelector('.al-id'),name=h.row.querySelector('.al-name');id.value='A的好友';id.oninput();
  await h.row.children[0].children[0].onclick();
  assert.equal(id.value,'A的好友');assert.equal(name.value,'');
  assert.match(h.row.querySelector('.al-state').textContent,/账号或目录已变化/);
  assert.equal(h.ctx.filterIdChoices('users','A的好友').length,0);
  assert.equal(h.ctx.filterIdChoices('users','B的好友')[0].id,'wxid_only_B');
});


test('账号目录请求乱序完成时，不允许旧账号覆盖新账号候选',async()=>{
  const h=ui(), pending=[];
  h.ctx.fetch=()=>new Promise(resolve=>pending.push(resolve));
  const first=h.ctx.refreshIdChoices();const second=h.ctx.refreshIdChoices();
  pending[1]({ok:true,json:async()=>({ok:true,account:'wxid_bot_demo_B',users:[{id:'wxid_B',name:'B好友'}],groups:[]})});
  await second;
  pending[0]({ok:true,json:async()=>({ok:true,account:'wxid_bot_demo_A',users:[{id:'wxid_A',name:'A好友'}],groups:[]})});
  await first;
  assert.equal(h.ctx.filterIdChoices('users','A好友').length,0);assert.equal(h.ctx.filterIdChoices('users','B好友').length,1);
});
