'use strict';
const $=id=>document.getElementById(id),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b),lf=s=>String(s||'').replace(/\r\n?/g,'\n');
const paramKeys=['privateMaxChars','groupMaxChars','discussionMaxChars','maxBubbles','emojiChance','historyTurns','groupHistoryTurns','emoji'];
let base,parameterBase,params,selected=null,choices=null,accountChanged=false;
const rows=new Map(),changes=new Map(),locks={parameters:false,card:false,bindings:false};
async function api(path,body){const r=await fetch('/api/persona-library/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||!d.ok)throw Error(d.error||'操作失败');return d;}
const message=(id,text)=>$(id).textContent=text;
function identityValues(){return {name:$('name').value,age:Number($('age').value),job:$('job').value,aliases:$('aliases').value.split(/[\r\n,，、]/).map(x=>x.trim()).filter(Boolean)};}
function identityDirty(){return parameterBase&&!same(identityValues(),parameterBase.identity);}
function parameterDirty(){return parameterBase&&(identityDirty()||!same(params,parameterBase.params));}
function cardDirty(){return selected?lf($('content').value)!==lf(selected.content)||$('cardName').value!==selected.name:Boolean($('content').value||$('cardName').value);}
function unpublished(){return selected&&!selected.builtin&&base.loaded[selected.id]?.revision!==selected.revision;}
const platform=()=>$('platform').value;
const scope=row=>JSON.stringify([row.platform,row.platform==='wechat'?base.account:'',row.chatType,row.chatId]);
const nameOf=id=>base.cards.find(x=>x.id===id)?.name||base.loaded[id]?.name||id;
const platformChanges=()=>[...changes.values()].filter(x=>x.platform===platform());
function update(){
 if(!base)return;
 $('htVal').textContent=params.historyTurns;$('ghtVal').textContent=params.groupHistoryTurns;
 const level=params.emoji,rate=level==='关'?0:params.emojiChance>0?params.emojiChance:({少:.12,正常:.3,多:.65}[level]||0);
 $('emojiHint').textContent='当前自动补充概率：'+Math.round(rate*100)+'%。'+(level==='关'?'“关”为硬关闭。':params.emojiChance>0?'使用显式概率；设为 0 则跟随档位。':'跟随档位：少 12%／正常 30%／多 65%。');
 const count=paramKeys.filter(k=>params[k]!==parameterBase.params[k]).length+['name','age','job','aliases'].filter(k=>!same(identityValues()[k],parameterBase.identity[k])).length;
 $('impact').textContent=count?'本区域有 '+count+' 项未保存修改。':'本区域没有未保存修改。';
 $('apply').textContent=count?'保存修改（'+count+' 项）':'保存修改';$('apply').disabled=locks.parameters||!parameterDirty();$('revert').disabled=locks.parameters||!parameterDirty();$('fetch').disabled=locks.parameters;
 const edited=cardDirty();$('saveCard').disabled=locks.card||Boolean(selected?.builtin)||(!edited&&!unpublished());
 $('copy').disabled=locks.card||!$('cardName').value.trim()||!$('content').value.trim();$('export').disabled=locks.card||!selected;$('delete').disabled=locks.card||!selected||selected.builtin;
 $('setDefault').disabled=locks.card||!selected||selected.id===base.defaultId;$('restore').disabled=locks.card||(!edited&&!$('fileName').textContent);
 $('saveCard').textContent=locks.card?'正在整理并保存…':'保存卡片';$('active').textContent='当前默认人格：'+nameOf(base.defaultId);
 $('cardState').textContent=selected?(edited?'存在未保存编辑；聊天继续使用已生效版本。':unpublished()?'历史待发布草稿：点击“保存卡片”整理并发布；目前仍使用先前生效版本。':'与已保存内容一致。'):'新卡片：保存前不会影响聊天。';
 if(selected?.builtin)$('cardState').textContent+=' 内置模板请另存为本地卡。';
 $('saveBindings').disabled=locks.bindings||accountChanged||!platformChanges().length;$('revertBindings').disabled=locks.bindings||!platformChanges().length;
 $('saveBindings').textContent=platformChanges().length?'保存所选（'+platformChanges().length+' 项）':'保存所选';
}
function fillParameters(state){
 parameterBase={identity:structuredClone(state.identity),params:structuredClone(state.params),parameterRevision:state.parameterRevision};params=structuredClone(state.params);
 for(const k of ['name','age','job'])$(k).value=state.identity[k];$('aliases').value=state.identity.aliases.join('、');for(const k of paramKeys)$(k).value=params[k];update();
}
function choose(id){selected=base.cards.find(x=>x.id===id)||null;$('cards').value=selected?.id||'';$('cardName').value=selected?.name||'';$('content').value=lf(selected?.content);$('fileName').textContent='';update();}
function cardOptions(){$('cards').replaceChildren(...base.cards.map(x=>new Option(x.name+(x.builtin?'（内置）':''),x.id)));if(selected)$('cards').value=selected.id;else $('cards').selectedIndex=-1;}
function acceptLibrary(state){for(const k of ['cards','loaded','defaultId','defaultRevision'])base[k]=state[k];cardOptions();renderRows();update();}
function publishIdentity(){localStorage.setItem('identity-updated',Date.now());window.dispatchEvent(new Event('identity-updated'));}
async function action(region,status,fn){
 if(locks[region])return;locks[region]=true;
 const container=$(region==='parameters'?'parameters':region==='card'?'library':'conversations'),controls=[...container.querySelectorAll('input,select,textarea,button')];controls.forEach(x=>x.disabled=true);update();
 try{await fn();}catch(e){message(status,e.message);}finally{locks[region]=false;container.querySelectorAll('input,select,textarea,button').forEach(x=>x.disabled=false);update();}
}
async function saveCard(copy){
 const body={id:copy?undefined:selected?.id,editRevision:copy?undefined:selected?.editRevision,name:$('cardName').value,content:$('content').value};
 message('cardMessage','正在使用当前聊天模型整理 Markdown 与身份参数…');const result=await api('card',body);acceptLibrary(result);choose(result.card.id);message('cardMessage','卡片已保存；使用这张卡的聊天已更新。');
}
async function refreshChoices(){
 const next=await api('choices');if(next.account!==base.account){accountChanged=true;message('bindingMessage','微信账号已变化，原账号选择已保留；请切回原账号并重新核对，或重新打开页面。');update();return false;}const recovered=accountChanged;choices=next;accountChanged=false;if(recovered)message('bindingMessage','已回到原账号，请核对保留的选择后保存。');update();return true;
}
function candidates(type){if(!choices)return [];return platform()==='wechat'?choices[type==='group'?'groups':'users'].map(x=>({platform:'wechat',chatType:type,chatId:x.id,name:x.name})):choices.web.filter(x=>x.chatType===type);}
function addExisting(){
 for(const key of Object.keys(base.bindings)){
  const [p,a,type,id]=JSON.parse(key);if(p==='wechat'&&a!==base.account)continue;
  const candidate=(p==='wechat'?(type==='group'?choices?.groups:choices?.users):choices?.web)?.find(x=>(x.id||x.chatId)===id);
  if(!rows.has(key))rows.set(key,{platform:p,chatType:type,chatId:id,name:candidate?.name||id});
 }
}
function renderRows(appendOnly=false){
 const host=$('conversationRows');if(!appendOnly)host.replaceChildren();else host.querySelector(':scope > .hint')?.remove();
 for(const [key,row] of rows){
  if(row.platform!==platform()||row.chatType!==$('conversationType').value)continue;
  if(appendOnly&&[...host.children].some(x=>x.dataset.rowKey===key))continue;
  const binding=base.bindings[key],value=changes.has(key)?changes.get(key).id:binding?.id||'',div=document.createElement('div');div.className='binding-row';div.dataset.chatId=row.chatId;div.dataset.rowKey=key;
  const info=document.createElement('div'),title=document.createElement('p'),id=document.createElement('p'),state=document.createElement('p');
  title.className='binding-title';title.textContent=row.name+' · '+row.chatId;id.className='binding-id';id.textContent=row.chatId;state.className='binding-state';
  state.textContent='当前生效：'+nameOf(binding?.id||base.defaultId)+(binding?'':'（跟随默认）')+(changes.has(key)?' · 待保存':'');if(changes.has(key))state.classList.add('pending');const input=document.createElement('input'),options=document.createElement('div');
  info.className='combo';input.id='chat-'+Math.random().toString(36).slice(2);options.id=input.id+'-options';options.className='options';options.hidden=true;options.setAttribute('role','listbox');
  input.value=row.chatId?(row.name+' · '+row.chatId):'';input.placeholder='输入名称或 ID，从候选中选择';input.setAttribute('aria-label','选择聊天');input.setAttribute('role','combobox');input.setAttribute('aria-controls',options.id);input.setAttribute('aria-autocomplete','list');input.setAttribute('aria-expanded','false');input.autocomplete='off';input.disabled=locks.bindings;
  info.append(input,options,state);if(!row.chatId)state.textContent='请先选择会话';
  wireCombo(input,options,row.chatType,chosen=>{
   const nextKey=scope(chosen);if(nextKey!==key&&rows.has(nextKey)){message('bindingMessage','该会话已在列表中。');renderRows();return;}
   if(nextKey!==key){if(binding)changes.set(key,{...row,id:''});else changes.delete(key);rows.delete(key);}
   rows.set(nextKey,chosen);if(value!==(base.bindings[nextKey]?.id||''))changes.set(nextKey,{...chosen,id:value});
   renderRows();update();
  });
  const label=document.createElement('label'),select=document.createElement('select');label.textContent='本聊天人格';select.setAttribute('aria-label',row.name+'的人格');
  select.replaceChildren(new Option('跟随默认',''),...base.cards.map(x=>new Option(x.name,x.id)));select.value=value;select.disabled=locks.bindings||!row.chatId;
  select.onchange=()=>{if(select.value===(base.bindings[key]?.id||''))changes.delete(key);else changes.set(key,{...row,id:select.value});renderRows();update();};label.append(select);
  const remove=document.createElement('button');remove.type='button';remove.textContent='移除';remove.title=binding?'解除独立绑定，保存所选后生效':'移除尚未保存的会话选择';remove.disabled=locks.bindings;
  remove.onclick=()=>{if(binding)changes.set(key,{...row,id:''});else changes.delete(key);rows.delete(key);renderRows();update();};div.append(info,label,remove);host.append(div);
 }
 if(!host.children.length){const hint=document.createElement('p');hint.className='hint';hint.textContent='尚未添加聊天。点击“添加一行”选择会话。';host.append(hint);}
}
function wireCombo(input,list,type,onSelect){
 const listId=list.id;let opened=false,version=0,active=-1,shown=[];
 function close(){opened=false;version++;list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');active=-1;}
 function select(row){close();onSelect(row);}
 function show(){
  if(!input.isConnected||!opened||document.activeElement!==input||accountChanged)return;
  const needle=(input.value.includes(' · ')?'':input.value.trim()).toLocaleLowerCase();shown=candidates(type).filter(x=>(x.name+' '+x.chatId).toLocaleLowerCase().includes(needle)).slice(0,50);active=-1;
  list.replaceChildren();list.hidden=false;input.setAttribute('aria-expanded','true');
  for(const [i,row] of shown.entries()){
   const button=document.createElement('button');button.type='button';button.id=listId+'-'+i;button.setAttribute('role','option');button.setAttribute('aria-selected','false');button.tabIndex=-1;
   button.textContent=(row.name||'未备注')+' · '+row.chatId;button.onmousedown=e=>e.preventDefault();button.onclick=()=>select(row);list.append(button);
  }
  if(!shown.length){const hint=document.createElement('p');hint.className='hint';hint.textContent='暂无匹配会话；请先启动桥接并让会话产生消息，或选择网页模拟。';list.append(hint);}
 }
 input.onfocus=async()=>{opened=true;const current=++version;try{if(await refreshChoices()&&current===version)show();}catch(e){if(current===version)message('bindingMessage',e.message);}};
 input.oninput=()=>{opened=true;show();};input.onblur=close;
 input.onkeydown=e=>{
  if(e.key==='Escape'){e.preventDefault();close();return;}
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){
   e.preventDefault();if(!opened){opened=true;show();}if(!shown.length)return;active=Math.max(0,Math.min(shown.length-1,active+(e.key==='ArrowDown'?1:-1)));
   [...list.querySelectorAll('button')].forEach((x,i)=>x.setAttribute('aria-selected',String(i===active)));input.setAttribute('aria-activedescendant',listId+'-'+active);const option=list.children[active];if(option){if(option.offsetTop<list.scrollTop)list.scrollTop=option.offsetTop;else if(option.offsetTop+option.offsetHeight>list.scrollTop+list.clientHeight)list.scrollTop=option.offsetTop+option.offsetHeight-list.clientHeight;}
  }else if(e.key==='Enter'&&opened){e.preventDefault();if(shown[active>=0?active:0])select(shown[active>=0?active:0]);}
 };
 return close;
}
$('addConversation').onclick=()=>{
 const key='draft-'+Math.random().toString(36).slice(2);rows.set(key,{platform:platform(),chatType:$('conversationType').value,chatId:'',name:''});renderRows(true);
};
$('conversationType').onchange=()=>{renderRows();update();};
$('platform').onchange=()=>{renderRows();update();};
$('apply').onclick=()=>action('parameters','message',async()=>{const result=await api('parameters',{parameterRevision:parameterBase.parameterRevision,identity:identityValues(),params});fillParameters(result);publishIdentity();message('message','人格参数已保存。');});
$('revert').onclick=()=>{fillParameters(parameterBase);message('message','已撤销本区域未保存的改动。');};
$('fetch').onclick=()=>action('parameters','message',async()=>{fillParameters(await api('state'));message('message','已重新读取人格参数。');});
$('saveCard').onclick=()=>action('card','cardMessage',()=>saveCard(false));$('copy').onclick=()=>action('card','cardMessage',()=>saveCard(true));
$('restore').onclick=()=>{choose(selected?.id);message('cardMessage','已恢复已保存内容；其他区域未改变。');};
$('new').onclick=()=>{if(cardDirty()&&!confirm('放弃当前未保存的卡片编辑？'))return;choose('');message('cardMessage','');};
$('cards').onchange=()=>{const id=$('cards').value;if(cardDirty()&&!confirm('放弃当前未保存的卡片编辑？')){$('cards').value=selected?.id||'';return;}choose(id);message('cardMessage','');};
$('setDefault').onclick=()=>action('card','cardMessage',async()=>{acceptLibrary(await api('default',{id:selected.id,defaultRevision:base.defaultRevision}));message('cardMessage','默认人格已更新，使用已保存的生效版本；编辑草稿未提交。');});
$('delete').onclick=()=>action('card','cardMessage',async()=>{if(!confirm('删除这张本地人格卡？'))return;await api('delete',{id:selected.id,revision:selected.revision,editRevision:selected.editRevision});acceptLibrary(await api('state'));choose(base.defaultId);message('cardMessage','卡片已删除。');});
$('export').onclick=()=>{location.href='/api/persona-library/export?id='+encodeURIComponent(selected.id);};$('import').onclick=()=>$('file').click();
$('file').onchange=async()=>{try{
 const file=$('file').files[0];if(!file)return;const limit=base.limits?.cardBytes||262144;if(file.size>limit)throw Error('文件最多'+Math.round(limit/1024)+' KB');if(cardDirty()&&!confirm('放弃当前卡片编辑并导入？'))return;
 const raw=new Uint8Array(await file.arrayBuffer());let content=new TextDecoder(raw[0]===255&&raw[1]===254?'utf-16le':raw[0]===254&&raw[1]===255?'utf-16be':'utf-8',{fatal:true}).decode(raw),name=file.name.replace(/\.(md|markdown|json)$/i,'');
 if(/\.json$/i.test(file.name)){const json=JSON.parse(content);content=String(json.customPrompt||'');name=json.name||name;}
 choose('');$('cardName').value=name;$('content').value=lf(content);$('fileName').textContent=file.name;message('cardMessage','已导入编辑区；保存时由当前模型按“只做必要适配，尽量保留原味”整理并发布，不导入运行参数。');update();
 }catch(e){message('cardMessage',e.message);}finally{$('file').value='';}};
$('saveBindings').onclick=()=>action('bindings','bindingMessage',async()=>{
 const p=platform(),state=await api('bindings',{platform:p,account:base.account,bindingRevision:base.bindingRevisions[p],changes:platformChanges()});
 // Do not overwrite the other platform's baseline or pending choices.
 for(const key of Object.keys(base.bindings)){const [kind,a]=JSON.parse(key);if(kind===p&&(kind!=='wechat'||a===base.account))delete base.bindings[key];}
 for(const [key,value] of Object.entries(state.bindings)){const [kind,a]=JSON.parse(key);if(kind===p&&(kind!=='wechat'||a===base.account))base.bindings[key]=value;}
 base.bindingRevisions[p]=state.bindingRevisions[p];for(const [key,x] of changes)if(x.platform===p)changes.delete(key);acceptLibrary(state);message('bindingMessage','本平台所选人格已保存并生效。');
});
$('revertBindings').onclick=()=>{const p=platform();for(const [key,row] of rows)if(row.platform===p&&!base.bindings[key])rows.delete(key);for(const [key,x] of changes)if(x.platform===p)changes.delete(key);addExisting();renderRows();update();message('bindingMessage','已撤销本平台未保存的改动。');};
for(const key of paramKeys)$(key).oninput=()=>{params[key]=key==='emoji'?$(key).value:Number($(key).value);update();};for(const key of ['name','age','job','aliases','cardName','content'])$(key).oninput=update;
window.addEventListener('beforeunload',e=>{if(base&&(parameterDirty()||cardDirty()||changes.size)){e.preventDefault();e.returnValue='';}});
async function syncIdentity(){
 if(!base||locks.parameters)return;try{const next=await api('state');if(same(next.identity,parameterBase.identity))return;
 if(identityDirty()||!same(next.params,parameterBase.params)){message('message','其他页面已修改参数；当前草稿保留，请重新读取后核对。');return;}
 const current=structuredClone(params);fillParameters(next);params=current;for(const k of paramKeys)$(k).value=params[k];update();
 }catch(e){message('message',e.message);}
}
window.addEventListener('storage',e=>{if(e.key==='identity-updated')syncIdentity();});window.addEventListener('focus',()=>{syncIdentity();if(base)refreshChoices().catch(e=>message('bindingMessage',e.message));});
async function load(){base=await api('state');fillParameters(base);cardOptions();choose(base.defaultId);$('account').textContent='当前微信账号：'+(base.account||'尚未识别');await refreshChoices();addExisting();renderRows();update();}
load().catch(e=>message('message',e.message));
