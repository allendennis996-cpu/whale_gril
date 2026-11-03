'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const weather = require('../src/weatherSearch');
const websearch = require('../src/websearch');
const router=require('../src/searchRouter');
async function lookup(text,options) {return router.toPrompt(await router.lookup(null,text,options));}
const {DEFAULT_CONFIG} = require('../src/config');
const now = new Date('2026-11-03T15:00:00+08:00');
const url = 'https://www.weather.com.cn/weather/101281801.shtml';
function page({name='阳江',province='广东',stamp='202611031400',day='3',hours}={}) {
  return `<title>${name}天气预报</title><div class="crumbs fl">${province} 阳江</div>
<li class="sky skyid"><h1>${day}日（今天）</h1><p class="wea">晴转小雨</p><p class="tem"><span>30</span>/<i>24℃</i></p></li>
<script>var observe24h_data = ${JSON.stringify({od:{od0:stamp,od2:[{od21:stamp.slice(8,10),od22:'29.4'}]}})};
var hour3data=${JSON.stringify({'1d':hours||['03日17时,d00,晴,28℃,东风,<3级,2','03日20时,n00,晴,26℃,东风,<3级,0']})};</script>`;
}
function client(html=page()) {
  const calls=[];
  return {calls,search:async q=>{calls.push(['bing',q]);return [{url,title:'天气'}];},readPage:async u=>{calls.push(['page',u]);return {url:u,title:'天气',html,body:''};}};
}

test('天气地点提取保留省市、显式地点覆盖常用城市、不再依赖城市白名单',()=>{
  for(const [input,expected] of [['今天天气如何？','北京'],['广东阳江的天气如何？','广东阳江'],['阳江市天气如何','阳江市'],['帮我查一下佛山南海区明天的天气','佛山南海区'],['上海2个小时后会不会下雨？','上海'],['等会儿3小时后的天气怎么样？','北京']]) assert.equal(weather.resolvePlace(input,'北京'),expected,input);
  assert.equal(weather.resolvePlace('今天天气如何？'), '');
  assert.equal(weather.resolvePlace('会理县明天会下雨吗？'), '会理县');
});

test('Bing 先查完整地点；无目标页后再用短写，不绕过省份核对',async()=>{
  const search=client();
  search.search=async q=>{search.calls.push(['bing',q]);return q==='广东阳江天气'?[]:[{url}];};
  const text=await lookup('广东阳江今天天气如何？',{config:{city:'上海'},search,now});
  assert.deepEqual(search.calls.filter(c=>c[0]==='bing').map(c=>c[1]),['广东阳江天气','阳江天气']);
  assert.match(text,/广东阳江 网页天气/);assert.match(text,/29.4℃/);assert.match(text,/30 \/ 24℃/);
  assert.ok(text.includes(url));
});

test('省市区组合只接受行政导航相符的目标页，重搜仍保留地点约束',async()=>{
  const html=page({name:'南海'}).replace('广东 阳江','广东 佛山 南海');
  assert.ok(weather.parseWeatherPage(html,'广东省佛山市南海区',now));
  assert.ok(weather.parseWeatherPage(html,'佛山南海区',now));
  assert.equal(weather.parseWeatherPage(html,'江苏省佛山市南海区',now),null);
  assert.equal(weather.parseWeatherPage(html.replace('广东 佛山 南海','广东 广州 南海'),'佛山南海区',now),null);
  const api=client(html);api.search=async q=>{api.calls.push(['bing',q]);return q==='南海区天气'?[{url}]:[];};
  const result=await lookup('佛山南海区天气如何？',{search:api,now});
  assert.match(result,/佛山南海区 网页天气/);
  assert.deepEqual(api.calls.filter(c=>c[0]==='bing').map(c=>c[1]),['佛山南海区天气','南海区天气']);
});

test('没有城市时不搜索；失败、错省、过期网页不注入摘要数值',async()=>{
  const missing=client();assert.match(await lookup('今天天气如何？',{search:missing,now}),/缺少查询地点/);assert.equal(missing.calls.length,0);
  for(const html of [page({province:'江苏'}),page({stamp:'202610301400'}),page({day:'2'}),'<title>阳江天气预报</title>江苏 9999℃']) {
    assert.match(await lookup('广东阳江天气',{search:client(html),now}),/未取得/);
  }
});

test('两小时后的目标时间命中17点，三小时后缺18点时明确报告邻近预报',async()=>{
  const two=await lookup('2小时后天气如何？',{config:{city:'阳江'},search:client(),now});
  assert.match(two,/目标时间：2026-11-03 17:00/);assert.match(two,/17:00 预报：晴，28℃/);assert.doesNotMatch(two,/没有目标时刻/);
  const three=await lookup('3小时后天气如何？',{config:{city:'阳江'},search:client(),now});
  assert.match(three,/目标时间：2026-11-03 18:00/);assert.match(three,/没有目标时刻的精确记录/);assert.doesNotMatch(three,/18:00 预报/);
  assert.match(three,/查询基准时间：2026-11-03 15:00/);assert.match(three,/不得再次累加/);
  const result=await router.lookup(null,'3小时后天气如何？',{config:{city:'阳江'},search:client(),now});
  assert.equal(result.status,'partial');assert.equal(result.queries.length,1);
  assert.match(result.evidence[0].warnings.join(''),/未取得目标时刻/);
});

test('跨月分时记录使用正确日期，过去观测不当作未来预报',()=>{
  const at=new Date('2026-12-31T23:00:00+08:00');
  const data=weather.parseWeatherPage(page({stamp:'202612312200',day:'31',hours:['01日02时,n00,晴,20℃,东风,<3级,0']}),'阳江',at);
  assert.equal(data.hourly[0].label,'2027-01-01 02:00');
});

test('完整省市县补查缩短到县名，读取时仍校验原始省市约束',async()=>{
  const calls=[];const html=page({name:'阳西'});
  const search={search:async(q,o)=>{calls.push({q,o});return q==='阳西县天气如何？'?[{url,title:'阳西天气'}]:[{url:'https://example.com/county',title:'阳西县百科'}];},
    readPage:async u=>({url:u,html,title:'阳西天气'})};
  const r=await router.lookup(null,'广东省阳江市阳西县2小时后天气如何？',{search,now});
  assert.equal(r.status,'success');
  assert.deepEqual(calls.map(c=>c.q),['广东省阳江市阳西县天气','阳西县天气如何？']);
  assert.equal(calls[1].o.browserRoute,true);
  assert.match(router.toPrompt(r),/广东省阳江市阳西县 网页天气/);
  assert.match(router.toPrompt(r),/2026-11-03 17:00/);
  assert.equal(weather.parseWeatherPage(html,'江苏省阳江市阳西县',now),null);
});

test('晚间页面仅列一个温度时，不冒充完整的全天最高最低温',()=>{
  const html=page().replace('<span>30</span>/<i>24℃</i>','<i>24℃</i>');
  const data=weather.parseWeatherPage(html,'阳江',now);
  const text=weather.formatWeather(data,'天气如何？','阳江',url,now);
  assert.match(text,/未提供完整高低温.*24℃/);
  assert.doesNotMatch(text,/最高\/最低温 24℃/);
});

test('天气网页只允许受支持的公开天气地址',()=>{
  assert.ok(weather.isWeatherUrl(url));
  for(const u of ['https://www.weather.com.cn.evil.test/weather/101281801.shtml','http://127.0.0.1/weather/101281801.shtml','https://www.weather.com.cn:123/weather/101281801.shtml','file:///tmp/a']) assert.equal(weather.isWeatherUrl(u),false);
});

test('机器人两种搜索模式都走 Bing 天气，并把资料传入模型提示词；关闭开关不查询',async t=>{
  const {Bot}=require('../src/bot');const {Store}=require('../src/memory');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-weather-'));
  const original={search:websearch.search,readPage:websearch.readPage};
  const api=client();Object.assign(websearch,{search:api.search,readPage:api.readPage});
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.websearch.city='阳江';
  const store=new Store({file:path.join(dir,'store.json'),limits:cfg.memory});
  t.after(()=>{Object.assign(websearch,original);store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const bot=new Bot({config:cfg,store,llm:{isMock:false,complete:async()=>{throw Error('天气不应调用辅助模型');}},logger:null,now:()=>now});
  for(const semantic of [false,true]) {
    cfg.features.semanticSearch=semantic;
    const d=await bot.decide({platform:'web',chatId:'fictional-'+semantic,chatType:'private',senderId:'fictional-weather-user',text:'今天天气如何？'});
    assert.match(d.msg.webText,/网页天气/);assert.ok(d.system.includes(d.msg.webText));
  }
  const count=api.calls.length;cfg.websearch.enabled=false;
  const d=await bot.decide({platform:'web',chatId:'fictional-off',chatType:'private',senderId:'fictional-weather-user',text:'今天天气如何？'});
  assert.equal(api.calls.length,count);assert.equal(d.msg.webText,'');
});

test('默认人设也接收联网资料',()=>{
  const cfg=structuredClone(DEFAULT_CONFIG);cfg.persona.customPrompt='';
  const system=require('../src/persona').buildSystem({config:cfg,msg:{chatType:'private',text:'天气如何',webText:'网页天气：29.4℃'},now});
  assert.match(system,/29.4℃/);
});
