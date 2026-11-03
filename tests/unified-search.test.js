'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const http=require('node:http');
const router=require('../src/searchRouter');
const web=require('../src/websearch');
const hot=require('../src/hotBoards');
const {fetchPage,isPrivateHost,publicLookup}=require('../src/publicWeb');
const now=new Date('2026-11-03T15:00:00+08:00');
const url='https://example.com/report';
const llm=(intent)=>({complete:async()=>JSON.stringify(intent)});
const opts={now,config:{timeoutMs:500}};
const date='2026-11-03T09:00:00+08:00';
const article={url,title:'星河公司今天新闻',body:'星河公司今天公布研发进展，详细介绍了新产品测试情况。',publishedAt:date};
function client(items=[{url,title:article.title,snippet:article.body}]) {
 const calls=[];
 return {calls,search:async(q,o)=>{calls.push({kind:'search',q,o});return items;},readPage:async(u,o)=>{calls.push({kind:'page',u,o});return article;}};
}

test('显式搜索直接执行、不改写年份；品牌写作和闲聊不查询',async()=>{
 const search=client();let used=0;const model={complete:async()=>{used++;return '{"need":false}';}};
 const r=await router.lookup(model,'帮我查一下星河公司今天新闻',{...opts,search});
 assert.equal(used,0);assert.match(r.queries[0],/星河公司今天新闻/);assert.doesNotMatch(r.queries[0],/2026/);
 assert.equal(r.status,'success');assert.equal(search.calls.filter(c=>c.kind==='page').length,1);
 for(const text of ['帮我写一个苹果手机广告','晚安','为什么会下雨','天气是什么意思','我今天好累','今天天气真好']) {
  assert.equal((await router.lookup(null,text,{...opts,search})).status,'not_needed',text);
 }
});

test('语义失败使用保守兜底，品牌词本身不触发；明确总开关关闭不调用模型',async()=>{
 const search=client();let used=0;const model={complete:async()=>{used++;throw Error('offline');}};
 assert.equal((await router.lookup(model,'我用的是苹果手机',{...opts,search})).status,'not_needed');
 assert.equal((await router.lookup(model,'查一下星河公司今天新闻',{...opts,config:{enabled:false},search})).status,'disabled');
 assert.equal(used,1);assert.equal(search.calls.length,0);
});

test('指代必须补全；群聊仅传当前发言人或明确引用的历史',async()=>{
 const search=client();const history=[{role:'user',uid:'fiction-b',name:'乙',text:'机型错误99'},
  {role:'assistant',text:'其他人的型号'}, {role:'user',uid:'fiction-a',name:'甲',text:'星河X99多少钱',addressedToBot:true}];
 let captured;
 const model={complete:async request=>{captured=JSON.parse(request.turns[0].content);return JSON.stringify({need:true,query:'星河X99现在多少钱',target:'星河X99',requiresBody:true});}};
 await router.lookup(model,'帮我查一下它现在多少钱',{...opts,search,history,context:{isGroup:true,senderId:'fiction-a'}});
 assert.equal(captured.history.length,1);assert.equal(captured.history[0].speaker,'甲');
 assert.ok(!JSON.stringify(captured).includes('机型错误99'));
 const r=await router.lookup(null,'帮我查一下它现在多少钱',{...opts,search});
 assert.equal(r.status,'clarify');
 assert.equal((await router.lookup(llm({need:false}),'帮我查一下它现在多少钱',{...opts,search})).status,'clarify');
 assert.equal((await router.lookup(null,'现在多少钱',{...opts,search})).status,'clarify');
 assert.equal(router.relevantHistory(history,{isGroup:true,senderId:'fiction-a',replyToUserId:'fiction-b'}).length,2);
});

test('当前显式城市覆盖上下文，缺少地点才使用常用城市',async()=>{
 const search=client([]);
 await router.lookup(llm({need:true,kind:'weather',query:'上海天气',place:'上海'}),'广东阳江天气如何',{...opts,config:{city:'北京'},search});
 assert.equal(search.calls[0].q,'广东阳江天气');
 search.calls.length=0;
 await router.lookup(llm({need:true,kind:'weather',query:'上海天气',place:'上海'}),'等会儿天气如何',{...opts,config:{city:'北京'},search});
 assert.equal(search.calls[0].q,'上海天气');
 assert.equal((await router.lookup(null,'今天天气如何',{...opts,search})).status,'clarify');
});

test('整体榜单和具体对象新闻分流，台风及空气质量不进入普通天气解析',()=>{
 for(const text of ['今天有哪些热点','今日头条热榜','微博热搜','最近有什么新闻','查一下今日头条热榜']) assert.equal(router.isHeadlines(text),true,text);
 for(const text of ['星河公司今天有什么新闻','上海今天有哪些热点','科技行业最新热点','热搜上的这件事怎么回事']) assert.equal(router.isHeadlines(text),false,text);
 assert.equal(router.fallback('阳江台风最新动态').kind,'general');assert.equal(router.fallback('广州空气质量').kind,'general');
});

test('正文优先核对对象、型号及具体事实，摘要不能替无关正文背书',async()=>{
 const search=client([{url,title:'星河X99价格',snippet:'星河X99现价1999元'}]);
 search.readPage=async()=>({url,title:'星河X98价格',body:'星河X98现价999元',publishedAt:date});
 const r=await router.lookup(llm({need:true,query:'星河X99价格',target:'星河X99',fresh:'strict',requiresBody:true}),'现在星河X99价格是多少',{...opts,search});
 assert.equal(r.status,'partial');assert.ok(r.evidence.every(e=>e.kind==='snippet'&&!e.checked));
 assert.ok(!router.toPrompt(r).includes('现价999元'));
 const missing=router.assess({title:'星河X99价格',url,body:'星河X99报价请咨询门店',publishedAt:date},{query:'星河X99价格',target:'星河X99',requiresBody:true,fresh:'strict'},now);
 assert.equal(missing.checked,false);assert.match(missing.warnings.join(''),/没有明确报价/);
});

test('过期资料拒绝；无日期和历史发布价不得标为最新现价',()=>{
 const intent={query:'星河X99价格',target:'星河X99',requiresBody:true,fresh:'strict'};
 const item={title:'星河X99价格',url,body:'星河X99价格为1999元'};
 assert.equal(router.assess({...item,publishedAt:'2023-01-01'},intent,now),null);
 assert.equal(router.assess(item,intent,now).checked,false);
 assert.match(router.assess({...item,body:'星河X99发布价为1999元',publishedAt:date},intent,now).warnings.join(''),/历史发布价/);
});

test('最新版本必须读正文，较旧的社区摘要不能直接认定为当前版本',async()=>{
 const search=client([{url,title:'星河最新版本',snippet:'2026年8月13日，星河版本9上线。'}]);
 search.readPage=async()=>{search.calls.push({kind:'page'});return {url,title:'星河最新版本',body:'星河版本9上线。',publishedAt:'2026-08-13'};};
 const r=await router.lookup(null,'查一下星河最新版本',{...opts,search});
 assert.ok(search.calls.some(c=>c.kind==='page'));
 assert.equal(r.status,'no_results');assert.equal(r.evidence.length,0);
});

test('最多一次补查且最多两篇网页；冲突保留差异不强选数值',async()=>{
 const search=client([{url,title:'星河X99价格'},{url:url+'2',title:'星河X99价格'}]);
 search.readPage=async u=>{search.calls.push({kind:'page'});return {url:u,title:'星河X99价格',body:'星河X99现价'+(u.endsWith('2')?'2999':'1999')+'元',publishedAt:date};};
 const r=await router.lookup(null,'查一下星河X99价格',{...opts,search});
 assert.equal(search.calls.filter(c=>c.kind==='search').length,2);assert.equal(search.calls.filter(c=>c.kind==='page').length,2);
 assert.equal(r.status,'partial');assert.match(router.toPrompt(r),/数值存在差异/);
});

test('明确对象完整时只读必要资料；简单摘要足够便不读正文',async()=>{
 const search=client([{url,title:'星河公司成立时间',snippet:'星河公司成立于2001年。'}]);
 const r=await router.lookup(null,'查一下星河公司成立时间',{...opts,search});
 assert.equal(r.status,'success');assert.equal(search.calls.length,1);
});

test('榜单解析过滤广告、不混入置顶，双榜交替并保留重复事件的全部来源',()=>{
 const toutiao=hot.parseBoard('toutiao',{data:[{Title:'广告',Url:url,is_ad:1},{Title:'共同事件！',Url:url},{Title:'头条事件',Url:url+'t'}],fixed_top_data:[{Title:'置顶'}]},date);
 const weibo=hot.parseBoard('weibo',{data:{hotgov:{word:'置顶'},realtime:[{word:'共同事件',num:999},{word:'微博事件',num:1}]}},date);
 const merged=hot.mergeBoards([{platform:'toutiao',items:toutiao},{platform:'weibo',items:weibo}]);
 assert.deepEqual(merged.map(x=>x.title),['共同事件！','头条事件','微博事件']);
 assert.equal(merged[0].sources.length,2);assert.equal(merged[0].sources[0].rank,2);
 assert.ok(!JSON.stringify(merged).includes('999'));assert.ok(!JSON.stringify(merged).includes('置顶'));
});

test('热榜成功缓存两分钟，保留真实获取时间；失败不缓存',async()=>{
 let count=0,fail=false;
 const api=hot.createClient({fetch:async()=>{count++;if(fail)throw Error('offline');return {body:JSON.stringify({data:[{Title:'事件',Url:url}]})};}});
 const a=await api.getBoard('toutiao',{now:+now});const b=await api.getBoard('toutiao',{now:+now+60000});
 assert.equal(count,1);assert.equal(b.cached,true);assert.equal(a.fetchedAt,b.fetchedAt);
 fail=true;await assert.rejects(api.getBoard('toutiao',{now:+now+120001}));
 fail=false;await api.getBoard('toutiao',{now:+now+120002});assert.equal(count,3);
});

test('双榜并行获取；指定平台只查指定平台；具体公司不查榜单',async()=>{
 const calls=[];let release;const gate=new Promise(r=>release=r);
 const api={...hot,getBoard:async platform=>{calls.push(platform);if(calls.length===2)release();await gate;return {platform,items:[{title:platform,platform,rank:1,url,fetchedAt:date}]};}};
 const r=await router.lookup(null,'今天有哪些热点',{...opts,hot:api});assert.equal(r.status,'success');assert.deepEqual(calls,['toutiao','weibo']);
 calls.length=0;
 await router.lookup(null,'微博热搜',{...opts,hot:api});assert.deepEqual(calls,['weibo']);
 const search=client();calls.length=0;
 await router.lookup(null,'星河公司今天有什么新闻',{...opts,hot:api,search});assert.equal(calls.length,0);assert.ok(search.calls.length);
});

test('榜单单源失败返回另一来源并标注；双源失败用 Bing 且不冒充实时榜单',async()=>{
 const api={...hot,getBoard:async p=>{if(p==='weibo')throw Error('login');return {platform:p,items:[{title:'事件',platform:p,rank:1,url,fetchedAt:date}]};}};
 const r=await router.lookup(null,'今天有哪些热点',{...opts,hot:api});assert.equal(r.status,'partial');assert.match(router.toPrompt(r),/未取得平台：微博/);
 api.getBoard=async()=>{throw Error('offline');};
 const search=client([{url,title:'今日热点新闻',snippet:'今日热点新闻，星河公司发布新产品。'}]);
 const all=await router.lookup(null,'今天有哪些热点',{...opts,hot:api,search});
 assert.ok(search.calls.length);assert.match(router.toPrompt(all),/未取得实时热榜/);
});

test('整轮超时取消未完成请求，同时保留已取得的有效榜单',async()=>{
 let aborted=false;
 const api={...hot,getBoard:async(p,{signal})=>{
  if(p==='toutiao')return {platform:p,items:[{title:'已取得事件',platform:p,rank:1,url,fetchedAt:date}]};
  return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('aborted'));},{once:true}));
 }};
 const r=await router.lookup(null,'今天有哪些热点',{...opts,config:{timeoutMs:40},hot:api});
 assert.equal(aborted,true);assert.equal(r.status,'partial');assert.equal(r.evidence.length,1);assert.ok(r.elapsedMs<250);
});

test('错误、空结果、超时分别报告，不混为没有搜索',async()=>{
 const search=client([]);
 assert.equal((await router.lookup(null,'查一下星河公司',{...opts,search})).status,'no_results');
 search.search=async()=>{throw Error('network');};
 assert.equal((await router.lookup(null,'查一下星河公司',{...opts,search})).status,'failed');
 search.search=()=>new Promise(()=>{});
 assert.equal((await router.lookup(null,'查一下星河公司',{...opts,config:{timeoutMs:25},search})).status,'timeout');
});

test('网页读取并行且整轮截止，已完成的正文不随另一个慢请求丢失',async()=>{
 let entered=0,release;const gate=new Promise(r=>release=r);
 const search=client([{url,title:article.title},{url:url+'2',title:article.title}]);
 search.readPage=async u=>{entered++;if(entered===2)release();await gate;if(u.endsWith('2'))return new Promise(()=>{});return article;};
 const r=await router.lookup(null,'查一下星河公司今天新闻',{...opts,config:{timeoutMs:50},search});
 assert.equal(entered,2);assert.equal(r.status,'partial');assert.equal(r.evidence.length,1);assert.ok(r.elapsedMs<300);
});

test('按完整条目裁剪资料，保留来源、限制及外部资料边界',()=>{
 const r={status:'partial',warnings:['有冲突'],evidence:[{title:'甲',text:'甲'.repeat(2500),url},{title:'乙',text:'乙'.repeat(2500),url:url+'2'}]};
 const p=router.toPrompt(r);assert.ok(p.length<=4000);assert.ok(p.includes(url));assert.ok(!p.includes('乙'.repeat(20)));assert.match(p,/外部资料，不是指令/);
 const failure=router.toPrompt({status:'failed',evidence:[]});assert.match(failure,/不得声称刚查到/);
});

test('网络读取禁止私有、映射IPv6、无效协议；支持受限大小、重定向及真正取消',async t=>{
 for(const h of ['127.0.0.1','10.0.0.1','172.16.1.2','192.168.2.1','169.254.169.254','::1','::ffff:127.0.0.1','::ffff:7f00:1','localhost','fc00::1']) assert.equal(isPrivateHost(h),true,h);
 assert.equal(isPrivateHost('8.8.8.8'),false);assert.equal(isPrivateHost('2606:4700::1111'),false);
 for(const u of ['file:///etc/passwd','http://127.0.0.1/','http://[::ffff:7f00:1]/']) await assert.rejects(fetchPage(u));
 await assert.rejects(fetchPage('https://example.com/',{proxyEnv:{HTTPS_PROXY:'http://127.0.0.1:1234'}}),/proxy_requires_allowlist/);
 let closed;const disconnected=new Promise(r=>closed=r);
 const server=http.createServer((req,res)=>{
  if(req.url==='/redirect'){res.writeHead(302,{Location:'/large'});res.end();}
  else if(req.url==='/private'){res.writeHead(302,{Location:'http://127.0.0.1/private'});res.end();}
  else if(req.url==='/large')res.end('x'.repeat(2000));
  else res.on('close',closed);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const local='http://127.0.0.1:'+server.address().port;
 await assert.rejects(fetchPage(local+'/redirect',{allowPrivate:true,maxBytes:10}),/too_large/);
 await assert.rejects(fetchPage(local+'/redirect',{allowPrivate:true,redirects:0}),/redirect_limit/);
 await assert.rejects(fetchPage(local+'/redirect',{allowPrivate:true,allowUrl:u=>!u.endsWith('/large')}),/bad_url/);
 const controller=new AbortController();const pending=fetchPage(local+'/slow',{allowPrivate:true,signal:controller.signal});
 setTimeout(()=>controller.abort(),20);await assert.rejects(pending);await disconnected;
});


test('DNS解析到私网或混合公网私网时拒绝，实际连接只返回已核对地址',async t=>{
 const dns=require('node:dns');let addresses=[{address:'127.0.0.1',family:4}];
 t.mock.method(dns,'lookup',(_host,_options,callback)=>callback(null,addresses));
 const lookup=()=>new Promise((resolve,reject)=>publicLookup('public.example.test',{},(error,address,family)=>error?reject(error):resolve({address,family})));
 await assert.rejects(lookup(),/private_host/);
 addresses=[{address:'8.8.8.8',family:4},{address:'192.168.1.1',family:4}];await assert.rejects(lookup(),/private_host/);
 addresses=[{address:'8.8.8.8',family:4}];assert.deepEqual(await lookup(),{address:'8.8.8.8',family:4});
});

test('新默认配置移除语义开关，旧值不影响统一入口，资料预算为5000毫秒',()=>{
 const {DEFAULT_CONFIG}=require('../src/config');const features=require('../src/features');
 assert.equal(DEFAULT_CONFIG.websearch.timeoutMs,5000);assert.ok(!Object.hasOwn(DEFAULT_CONFIG.features,'semanticSearch'));
 assert.ok(!features.list(DEFAULT_CONFIG).some(f=>f.key==='semanticSearch'));
 const fs=require('node:fs'),path=require('node:path');
 const example=JSON.parse(fs.readFileSync(path.join(__dirname,'../config.example.json'),'utf8'));
 assert.equal(example.websearch.timeoutMs,5000);assert.ok(!Object.hasOwn(example.features,'semanticSearch'));
});


test('阳西县百科结果不能当天气；仅一次补查保留原问句并启用浏览器网络路径',async()=>{
 const calls=[];const search={search:async(q,options)=>{calls.push({q,options});return [{title:'阳西县百度百科',url:'https://example.com/county'}];},readPage:async()=>{throw Error('不该读取百科');}};
 const result=await router.lookup(null,'阳西县天气如何？',{...opts,search});
 assert.equal(result.status,'no_results');assert.equal(calls.length,2);
 assert.equal(calls[0].q,'阳西县天气');assert.equal(calls[0].options.browserRoute,false);
 assert.equal(calls[1].q,'阳西县天气如何？');assert.equal(calls[1].options.browserRoute,true);
});

test('Bing跳转链接解码后能识别真实天气页面，非法目标不解码',()=>{
 const target='https://www.weather.com.cn/weather/101281804.shtml';
 const link='https://www.bing.com/ck/a?u=a1'+Buffer.from(target).toString('base64url');
 const result=web.parseBing('<li class="b_algo"><h2><a href="'+link+'">阳西天气</a></h2><p>天气预报</p></li>');
 assert.equal(result[0].url,target);
 const invalid='https://www.bing.com/ck/a?u=a1'+Buffer.from('file:///tmp/private').toString('base64url');
 assert.equal(web.parseBing('<li class="b_algo"><h2><a href="'+invalid+'">天气</a></h2></li>')[0].url,invalid);
 const foreign=link.replace('www.bing.com','example.com');
 assert.equal(web.parseBing('<li class="b_algo"><h2><a href="'+foreign+'">天气</a></h2></li>')[0].url,foreign);
});

test('搜索代理复用已有配置，支持按协议设置，不写入系统或引入硬编码代理',()=>{
 const {proxyConfig}=require('../src/searchProxy');
 assert.equal(proxyConfig({env:{},platform:'linux'}),null);
 const system=proxyConfig({env:{},platform:'win32',readWindows:()=> 'http=127.0.0.1:1234;https=127.0.0.1:5678'});
 assert.equal(system.HTTPS_PROXY,'http://127.0.0.1:5678/');
 const explicit=proxyConfig({env:{HTTPS_PROXY:'http://127.0.0.1:4321'},platform:'win32',readWindows:()=>{throw Error('不该读取');}});
 assert.equal(explicit.HTTPS_PROXY,'http://127.0.0.1:4321/');
 assert.equal(proxyConfig({env:{},platform:'win32',readWindows:()=>{throw Error('未配置');}}),null);
});

test('代理实际转发搜索请求，重定向仍不能越过目标域名限制',async t=>{
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(!(major>=25||major===24&&minor>=5||major===22&&minor>=21)) {t.skip('当前 Node 不支持 proxyEnv');return;}
 const requests=[];
 const proxy=http.createServer((req,res)=>{
  requests.push(req.url);
  if(req.url.endsWith('/redirect')) {res.writeHead(302,{Location:'http://127.0.0.1/private'});res.end();}
  else res.end('public search result');
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 t.after(()=>{proxy.closeAllConnections();proxy.close();});
 const options={proxyEnv:{HTTP_PROXY:'http://127.0.0.1:'+proxy.address().port},allowUrl:value=>new URL(value).hostname==='public-search.example.test'};
 const page=await fetchPage('http://public-search.example.test/report',options);
 assert.equal(page.body,'public search result');
 assert.equal(requests[0],'http://public-search.example.test/report');
 await assert.rejects(fetchPage('http://public-search.example.test/redirect',options),/bad_url/);
 assert.equal(requests.length,2);
});
