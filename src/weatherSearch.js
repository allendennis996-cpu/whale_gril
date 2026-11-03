'use strict';

// 天气始终先搜索 Bing，再读取命中的天气网页；不做地名转坐标或 IP 定位。
const WEATHER = /天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量/;
const PROVINCE = /^(?:内蒙古|黑龙江|新疆|西藏|广西|宁夏|香港|澳门|北京|天津|上海|重庆|河北|山西|辽宁|吉林|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾)(?:壮族自治区|回族自治区|维吾尔自治区|自治区|特别行政区|省|市)?/;
const textOnly = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const chinaDate = now => new Date(+now + 8 * 3600000).toISOString().slice(0, 10);

function resolvePlace(text, fallback = '') {
  const place = String(text || '')
    .replace(/(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]|\d{4}-\d{2}-\d{2}/g, '')
    .replace(/(?:\d+|[一二两三四五六七八九十]+)\s*(?:个)?小时(?:以)?后|\d{1,2}[:：]\d{2}|(?:上午|下午|晚上)?[\d一二两三四五六七八九十]+点(?:钟)?/g, '')
    .replace(/天气|下雨|下雪|气温|多少度|冷不冷|热不热|台风|雾霾|空气质量/g, '')
    .replace(/帮我|麻烦|请问|请|你觉得|你看|查一下|查一查|查查|搜索|搜一下|看看|查询|预报|实时|温度|今天|明天|后天|今早|今晚|现在|目前|等会儿?|一会儿?|稍后|之后|以后|小时|如何|怎么样|怎样|怎么|是否|会不会|有没有|会有|我这里|我这边|这边|当地|这里|外面|那里|一下/g, '')
    .replace(/[的了呢吗呀啊\s，。！？、,.!?]/g, '').replace(/(?:会有|会|有)$/, '').trim();
  return (place || String(fallback || '').trim()).slice(0, 40);
}

function placeQueries(place) {
  const short = place.replace(PROVINCE, '') || place;
  const district = short.match(/市(.+(?:区|县))$/)?.[1] || short;
  const tail = /[区县]$/.test(district) && district.length >= 5 ? [district.slice(-3), district.slice(-4)] : [];
  return [...new Set([place, short, district, ...tail, district.replace(/[市区县]$/, '')])].filter(Boolean);
}

function isWeatherUrl(url) {
  try {
    const u = new URL(url);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname === 'www.weather.com.cn'
      && !u.username && !u.password && !u.port && /^\/weather\/\d{9}\.shtml$/.test(u.pathname);
  } catch { return false; }
}

function inlineJson(html, name) {
  const raw = String(html).match(new RegExp('var\\s+' + name + '\\s*=\\s*(\\{[^\\r\\n]*\\})'))?.[1];
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function parseWeatherPage(html, place, now = new Date()) {
  const title = textOnly(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1]);
  const leaf = (place.replace(PROVINCE, '') || place).split('市').filter(Boolean).at(-1) || place;
  let name = leaf.replace(/[市区县]$/, '');
  const navigation = textOnly(html.match(/<div class="crumbs fl">([\s\S]*?)<\/div>/)?.[1]);
  const pageName = title.split('天气')[0].trim();
  if (pageName && name.endsWith(pageName) && name !== pageName) {
    const parent = name.slice(0, -pageName.length);
    if (!navigation.includes(parent)) return null;
    name = pageName;
  }
  // 至少核对目标名称；有明确省/市限定时也必须在页面中找到对应的行政导航。
  if (!name || !title.includes(name)) return null;
  const province = place.match(PROVINCE)?.[0]?.replace(/省$|市$/, '');
  if (province && !navigation.includes(province)) return null;
  const parentCity = (place.replace(PROVINCE, '') || place).match(/^(.+?)市.+[区县]$/)?.[1];
  if (parentCity && !navigation.includes(parentCity)) return null;
  const today = chinaDate(now);
  const observed = inlineJson(html, 'observe24h_data')?.od;
  const stamp = String(observed?.od0 || '');
  if (!/^\d{12}$/.test(stamp)) return null;
  const observedAt = new Date(`${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)}T${stamp.slice(8,10)}:${stamp.slice(10,12)}:00+08:00`);
  if (!Number.isFinite(+observedAt) || +now - observedAt > 36 * 3600000 || observedAt - now > 15 * 60000) return null;
  const blocks = [...html.matchAll(/<li class="sky[^\"]*">([\s\S]*?)<\/li>/g)];
  const daily = blocks.slice(0, 3).map(m => ({
    label: textOnly(m[1].match(/<h1>([\s\S]*?)<\/h1>/)?.[1]),
    condition: textOnly(m[1].match(/<p[^>]*class="wea"[^>]*>([\s\S]*?)<\/p>/)?.[1]),
    temperature: textOnly(m[1].match(/<p class="tem">([\s\S]*?)<\/p>/)?.[1]),
  }));
  if (!daily[0]?.label.startsWith(`${Number(today.slice(-2))}日`) || !daily[0].temperature.includes('℃')) return null;
  const hours = inlineJson(html, 'hour3data');
  const hourly = [...new Set((hours?.['7d'] || []).slice(0, 3).flat()
    .concat(hours?.['1d'] || []))].flatMap(s => {
    const fields = String(s).split(',');
    const m = fields[0].match(/^(\d{2})日(\d{2})时$/);
    if (!m || !/^-?\d+(?:\.\d+)?℃$/.test(fields[3])) return [];
    const date = new Date(today + 'T00:00:00+08:00');
    // 从今天向前一天至后七天匹配日期，跨月时不凭字符串补月份。
    for (let delta = -1; delta <= 7; delta++) {
      const d = new Date(+date + delta * 86400000);
      const day = chinaDate(d);
      if (Number(day.slice(-2)) === +m[1]) return [{time: new Date(`${day}T${m[2]}:00:00+08:00`).getTime(), label: `${day} ${m[2]}:00`, condition: fields[2], temperature: fields[3], wind: fields.slice(4, 6).join(' ')}];
    }
    return [];
  }).sort((a,b) => a.time-b.time);
  const first = observed?.od2?.[0];
  const current = first && Number(first.od21) === Number(stamp.slice(8,10)) && +now-observedAt <= 3*3600000
    && /^-?\d+(?:\.\d+)?$/.test(first.od22) && Number(first.od22) >= -90 && Number(first.od22) <= 60
    ? `${stamp.slice(0,4)}-${stamp.slice(4,6)}-${stamp.slice(6,8)} ${stamp.slice(8,10)}:${stamp.slice(10,12)}，${first.od22}℃` : '';
  return {title, today, daily, hourly, current};
}

function targetTime(text, now) {
  const n = String(text).match(/(\d+|[一二两三四五六七八九十])\s*(?:个)?小时(?:以)?后/);
  const numbers = {一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10};
  return n ? +now + (Number(n[1]) || numbers[n[1]] || 0) * 3600000 : null;
}

function formatWeather(data, text, place, url, now) {
  const lines = [`【${place} 网页天气】日期：${data.today}；时区：北京时间。`, `页面：${data.title}`, `来源：${url}`];
  const target = targetTime(text, now);
  if (target !== null) {
    const base = new Date(+now+8*3600000).toISOString().slice(0,16).replace('T',' ');
    const label = new Date(target+8*3600000).toISOString().slice(0,16).replace('T',' ');
    lines.push(`查询基准时间：${base}；用户目标时间：${label}（北京时间，程序已计算小时偏移，不得再次累加）。`);
    const near = data.hourly.filter(h => Math.abs(h.time-target) <= 3*3600000);
    if (!near.some(h => h.time === target)) lines.push('没有目标时刻的精确记录；以下是邻近时刻预报，不得改写成目标时刻的精确值或自行插值。');
    lines.push(...near.slice(0,3).map(h => `${h.label} 预报：${h.condition}，${h.temperature}，${h.wind}`));
    if (!near.length) lines.push('未取得该目标时段的分时预报，请明确说明。');
  } else {
    if (data.current) lines.push(`最近实况：${data.current}；并非此刻的新观测。`);
    const future = data.hourly.filter(h => h.time >= +now).slice(0,4);
    lines.push(...future.map(h => `${h.label} 预报：${h.condition}，${h.temperature}`));
  }
  lines.push(...data.daily.map(d => `${d.label} 全天预报：${d.condition}，${d.temperature.includes('/')?'最高/最低温 ':'页面列出温度（未提供完整高低温）'}${d.temperature}`));
  lines.push('全天温度范围不是当前气温；分时预报不等于实测，不得补造缺失数值。');
  return lines.join('\n');
}

module.exports = {isWeatherQuery: text => WEATHER.test(String(text || '')), resolvePlace, placeQueries, isWeatherUrl, parseWeatherPage, targetTime, formatWeather};
