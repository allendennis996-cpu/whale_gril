/* Shared conversation picker. Pages own draft data and right-hand controls. */
'use strict';
const ConversationPicker={
 append(host,row){host.append(row);},
 bind({input,list,items,refresh=async()=>true,account=()=>'',choose,onInput=()=>{},onBlur=()=>{},query=()=>input.value,empty='暂无匹配记录',changed=()=>{}}){
 let active=-1,shown=[],epoch=0,opened=false,displayedAccount='';
 const close=()=>{opened=false;epoch++;list.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
 const show=()=>{
  opened=true;const needle=query().trim().toLocaleLowerCase();shown=items().filter(x=>((x.name||'')+' '+(x.id||x.chatId)).toLocaleLowerCase().includes(needle)).slice(0,50);displayedAccount=account();active=-1;list.innerHTML='';list.hidden=false;input.setAttribute('aria-expanded','true');
  for(const [i,item] of shown.entries()){const b=document.createElement('button');b.type='button';b.id=list.id+'-'+i;b.setAttribute('role','option');b.textContent=(item.name||'未备注')+' · '+(item.id||item.chatId);b.onmousedown=e=>e.preventDefault();b.onclick=()=>select(item);list.append(b);}
  if(!shown.length){const hint=document.createElement('p');hint.textContent=empty;list.append(hint);}
 };
 const select=async item=>{const token=++epoch,typed=input.value,a=displayedAccount;const ok=await refresh();if(token!==epoch||typed!==input.value||!input.isConnected)return;const current=items().find(x=>(x.id||x.chatId)===(item.id||item.chatId));if(!ok||a!==account()||!current){close();changed();return;}close();choose(current);};
 input.setAttribute('role','combobox');input.setAttribute('aria-expanded','false');input.setAttribute('aria-autocomplete','list');input.setAttribute('autocomplete','off');
 input.onfocus=async()=>{opened=true;list.hidden=false;const token=++epoch;list.innerHTML='';if(await refresh()&&opened&&input.isConnected)show();};
 input.oninput=()=>{epoch++;onInput();show();};input.onblur=()=>{close();return onBlur();};
 input.onkeydown=e=>{if(e.key==='Escape'){close();return;}if(!['ArrowDown','ArrowUp','Enter'].includes(e.key))return;if(list.hidden){if(e.key!=='Enter'){e.preventDefault();show();}return;}if(e.key==='Enter'){if(active>=0&&shown[active]){e.preventDefault();return select(shown[active]);}return;}e.preventDefault();active=Math.max(0,Math.min(shown.length-1,active+(e.key==='ArrowDown'?1:-1)));[...list.children].forEach((b,i)=>b.setAttribute('aria-selected',String(i===active)));const b=list.children[active];if(b){input.setAttribute('aria-activedescendant',b.id);if(b.offsetTop<list.scrollTop)list.scrollTop=b.offsetTop;else if(b.offsetTop+b.offsetHeight>list.scrollTop+list.clientHeight)list.scrollTop=b.offsetTop+b.offsetHeight-list.clientHeight;}};
 return {close};
 }
};
