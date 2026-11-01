(() => {
 const originals=new WeakMap();
 function sync(){
  const walk=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  while(walk.nextNode()){
   const node=walk.currentNode,parent=node.parentElement;
   if(!parent||parent.closest('[data-persona-content],.bubble-text,.msg.user,textarea,input,script,style,#previewText,#previewActive,#previewDraft,#content,#cards,#chatCard,#options,#target,#impact,#cardState,#bindings,#active,#message,.msg .body .bubble'))continue;
   if(!originals.has(node)&&node.nodeValue.includes('鲸鲸'))originals.set(node,node.nodeValue);
   if(originals.has(node)){const text=identityText(originals.get(node));if(node.nodeValue!==text)node.nodeValue=text;}
  }
  document.querySelectorAll('.msg.bot .name').forEach(el=>{if(el.textContent!==agentName)el.textContent=agentName;});
  for(const el of document.querySelectorAll('[placeholder],[title],[aria-label],img[alt]')){
   for(const attr of ['placeholder','title','aria-label','alt']){if(!el.hasAttribute(attr))continue;const key='identity'+attr.replace('-','');if(!el.dataset[key]&&el.getAttribute(attr).includes('鲸鲸'))el.dataset[key]=el.getAttribute(attr);if(el.dataset[key])el.setAttribute(attr,identityText(el.dataset[key]));}
  }
 }
 async function update(){try{const r=await fetch('/api/status');const d=await r.json();if(!d.persona?.name)return;window.agentName=d.persona.name;document.title=agentName+' · '+(location.pathname==='/persona'?'调教台':location.pathname==='/debug'?'调试台':'聊天');sync();}catch{}}
 const observer=new MutationObserver(()=>sync());observer.observe(document.body,{childList:true,subtree:true});
 window.addEventListener('focus',update);window.addEventListener('storage',e=>{if(e.key==='identity-updated')update();});window.addEventListener('identity-updated',update);update();
})();
