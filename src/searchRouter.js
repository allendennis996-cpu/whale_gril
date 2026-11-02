'use strict';

// 辅助判断只返回检索意图；不能执行指令或修改主模型设置。
const SYSTEM = `判断最后一句是否需要查询当前或具体事实。闲聊、倾诉、翻译、写作和稳定常识不查。
只输出 JSON：{"need":true,"query":"保留用户专名与型号的检索词","site":"bilibili|weibo|toutiao|","city":"用户提到的城市或空","fresh":"strict|normal|any"}，不查输出 {"need":false}。
价格、型号、最新情况用 strict；一般事实 normal；历史定义 any。地点保留用户原文，不猜测城市。`;

function parseRoute(raw) {
  try {
    const o = JSON.parse((String(raw).match(/\{[\s\S]*\}/) || [])[0]);
    if (!o || typeof o.need !== 'boolean') return null;
    if (o.need && (typeof o.query !== 'string' || !o.query.trim())) return null;
    return { need: o.need, query: String(o.query || '').trim().slice(0, 100),
      site: ['bilibili', 'weibo', 'toutiao'].includes(o.site) ? o.site : '',
      city: typeof o.city === 'string' ? o.city.trim().slice(0, 40) : '',
      fresh: ['strict', 'normal', 'any'].includes(o.fresh) ? o.fresh : 'normal' };
  } catch { return null; }
}

async function route(llm, text, { history = [], timeoutMs = 2000 } = {}) {
  if (!llm || llm.isMock || typeof llm.complete !== 'function') return { failed: true };
  const controller = new AbortController();
  let timer;
  try {
    const raw = await Promise.race([
      llm.complete({ system: SYSTEM, turns: [{role:'user', content:
        `最近对话：${history.slice(-4).join('\n').slice(-1200)}\n最后一句：${String(text).slice(0, 2000)}`}],
        maxTokens: 160, signal: controller.signal, retries: 0, auxiliary: true }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Error('timeout')); }, timeoutMs); }),
    ]);
    return parseRoute(raw) || {failed:true};
  } catch { return {failed:true}; }
  finally { clearTimeout(timer); controller.abort(); }
}

async function lookup(llm, text, {config = {}, history = [], search = require('./websearch')} = {}) {
  const weather = /天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量/.test(text);
  const explicit = /查一下|查查|搜一下|搜搜|帮我查|搜索|查一查/.test(text);
  const site = /B站|哔哩哔哩/i.test(text) ? 'bilibili' : /微博/.test(text) ? 'weibo' : '';
  let intent = await route(llm, text, {history});
  if (intent.failed || weather || explicit) {
    const need = weather || explicit || /最新|热搜|新闻|多少钱|价格|什么时候|是谁|谁是|出到|几代|型号|版本|今年|去年|苹果|iphone|华为|显卡|发布会/i.test(text);
    intent = {need, query:text.slice(0, 100), city:intent.city || '', site:intent.site || site, fresh: /最新|现在|价格|多少钱|今天|型号/.test(text) ? 'strict' : 'normal'};
  }
  if (!intent.need) return '';
  const timeoutMs = Number(config.timeoutMs) || 8000;
  try {
    if (weather) {
      const hit = text.match(/北京|上海|天津|重庆|广州|深圳|杭州|南京|成都|武汉|西安|苏州|长沙|郑州|青岛|[\u4e00-\u9fff]{2,4}市/);
      const city = intent.city || hit?.[0] || config.city || await search.ipCity(timeoutMs);
      if (city) {
        const result = await search.weatherText(city, {timeoutMs});
        if (result) return result;
        intent.query = `${city} 天气`;
      }
    }
    const chosenSite = site || intent.site;
    if (!chosenSite && /新闻|热点|热搜|头条|大事件/.test(text)) {
      const hot = await search.hotNewsText(8);
      if (hot) return hot;
    }
    const domain = {bilibili:'bilibili.com', weibo:'weibo.com', toutiao:'toutiao.com'}[chosenSite];
    const query = (domain ? `site:${domain} ` : '') + intent.query;
    return await search.searchText(query, {limit:4, timeoutMs, fresh:intent.fresh});
  } catch { return ''; }
}

module.exports = { route, parseRoute, lookup };
