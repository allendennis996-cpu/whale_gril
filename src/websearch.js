'use strict';

/**
 * 简易联网检索：抓 Bing 网页结果（标题 / 链接 / 摘要）。
 * 单次请求，不在此处隐式重搜；失败交给统一入口区分处理。
 */
const {fetchPage} = require('./publicWeb');
const {getProxyConfig} = require('./searchProxy');

function stripTags(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return ''; }
    });
}

function parseBing(html) {
  const out = [];
  const blocks = String(html || '').split(/<li class="b_algo"/).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<h2[^>]*>[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let url = decodeEntities(linkMatch[1]);
    try {
      const redirect=new URL(url,'https://www.bing.com');
      if(['www.bing.com','cn.bing.com'].includes(redirect.hostname)&&redirect.pathname==='/ck/a') {
        const encoded=redirect.searchParams.get('u')||'';
        const target=new URL(encoded.startsWith('a1')?Buffer.from(encoded.slice(2),'base64url').toString('utf8'):encoded);
        if(['https:','http:'].includes(target.protocol)&&!target.username&&!target.password) url=target.href;
      }
    } catch { /* Keep the original link; public destination validation still applies. */ }
    const title = stripTags(linkMatch[2]);
    const pMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = pMatch ? stripTags(pMatch[1]) : '';
    if (title || snippet) out.push({ title, url, snippet });
    if (out.length >= 8) break;
  }
  return out;
}

const STOP_WORDS = /(帮我|请问|请|一下|查查|查一查|搜搜|搜索|看看|我想知道|谁是|是谁|这个|那个|什么|怎么|为什么|是不是|有没有|最新|现在|目前|当前|今天|多少钱|什么价|价格是|怎么样|如何|的|吗|呢|啊|呀|吧|了|嘛|呗)/gi;

/** 把口语问句拆成可判定相关性的词块（英文词 + 中文二字组）。 */
// 检索式写成 iPhone、原句写的是「苹果」时也要算命中。
const TOKEN_ALIASES = { '苹果': ['iphone', 'apple', 'mac'], iphone: ['苹果'], mac: ['苹果', 'macbook'] };

// 这些二字组太泛，几乎任何页面都能命中（「谁」「这个」「时候」…），
// 用它们判相关性等于没判，会把字典页、歌词页当成有效资料。
const GENERIC_TOKENS = new Set([
  '谁是', '是谁', '这个', '那个', '一个', '什么', '怎么', '为什', '什们', '时候', '东西',
  '事情', '问题', '方法', '我们', '你们', '他们', '自己', '可以', '不是', '就是', '还是',
  '如果', '但是', '所以', '因为', '这样', '那样', '知道', '觉得', '应该', '需要', '很多',
  '非常', '真的', '一直', '已经', '开始', '结束', '现在', '今天', '明天', '如何', '哪些',
]);

function queryTokens(query) {
  const text = String(query || '').replace(STOP_WORDS, ' ');
  const latin = (text.match(/[a-z0-9][a-z0-9+.\-]{1,}/gi) || []).map((w) => w.toLowerCase());
  const cjkRuns = text.match(/[\u4e00-\u9fa5]{2,}/g) || [];
  const bigrams = [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) bigrams.push(run.slice(i, i + 2));
  }
  for (const run of cjkRuns) if (run.length <= 4) bigrams.push(run);
  return [...new Set([...latin, ...bigrams])]
    .filter((t) => t.length >= 2 && (!GENERIC_TOKENS.has(t) || /^[a-z0-9]/.test(t)));
}

/**
 * 相关性过滤。现场问题：「最新 iPhone 多少钱」经 Bing 中国站返回的是 Yandex 官网，
 * 「显卡行情」返回「帮」字字典页——垃圾结果照样喂给模型，她只能回答「我记的是旧的」。
 * 判据：标题或摘要里至少命中一个查询词块。
 */
function keepRelevant(query, results) {
  const tokens = queryTokens(query);
  // 现场问题：问「苹果最新的机器」时命中「苹果（蔷薇科植物）」百科，
  // 提示词里塞进水果条目，她只能答非所问。
  const phoneContext = /(手机|机器|机型|型号|出到|几代|第几|新机|iphone)/i.test(String(query || ''));
  const fruitPage = /(蔷薇科|苹果属|Malus|水果|落叶乔木|栽培苹果|果树)/i;
  if (!tokens.length) return results;
  const kept = [];
  for (const item of results) {
    const hay = `${item.title || ''} ${item.snippet || ''}`.toLowerCase();
    if (phoneContext && fruitPage.test(hay)) continue;
    if (tokens.some((t) => hay.includes(t)
      || (TOKEN_ALIASES[t] || []).some((alias) => hay.includes(alias)))) kept.push(item);
  }
  return kept;
}

/** 去掉口语填充词后的检索式，供第一次结果跑题时重搜。 */
function cleanQuery(query) {
  // Remove conversational framing, but preserve entities, time and scope.
  return String(query || '')
    .replace(/^\s*(?:帮我|请问|请|你|麻烦)?\s*(?:查一下|查一查|查查|搜一下|搜搜|搜索|查询|找一下)/, '')
    .replace(/有什么|有哪些|有啥/g, ' ')
    .replace(/多少钱|什么价/g, '价格')
    .replace(/(?:是什么|怎么样|如何|吗|呢|啊|呀)?[？?！!。]*$/, '')
    .replace(/[，,]/g, ' ').replace(/\s+/g, ' ').trim();
}

// One Bing request only. The router owns relevance, retries and the shared deadline.
async function search(query, {limit=8, timeoutMs=5000, signal,browserRoute=false}={}) {
  const q=String(query||'').trim().slice(0,500);
  if (!q) return [];
  const started=Date.now();
  const proxyEnv=browserRoute?await getProxyConfig({signal,timeoutMs:Math.min(500,timeoutMs)}):null;
  const remaining=timeoutMs-(Date.now()-started);
  if(remaining<=0) throw Error('timeout');
  const url=browserRoute?'https://www.bing.com/search?q='+encodeURIComponent(q)+'&cc=cn'
    :'https://cn.bing.com/search?q='+encodeURIComponent(q)+'&setlang=zh-CN&count=10';
  const page=await fetchPage(url,{timeoutMs:remaining,signal,maxBytes:2*1024*1024,proxyEnv,
    allowUrl:value=>{try {const u=new URL(value);return u.protocol==='https:'&&['cn.bing.com','www.bing.com','bing.com'].includes(u.hostname)&&!u.port;}catch{return false;}}});
  return parseBing(page.body).slice(0,limit);
}

async function readPage(url, options={}) {
  const page=await fetchPage(url,options);
  if (!/text\/html|application\/xhtml/i.test(page.contentType)) throw Error('unsupported_content');
  const links=require('./links');
  const info=links.parsePage(page.body,page.finalUrl);
  const raw=page.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>/gi,' ');
  const main=(raw.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i)||[])[1]||raw;
  const paragraphs=[...main.matchAll(/<(?:p|td|h[1-6])[^>]*>([\s\S]*?)<\/(?:p|td|h[1-6])>/gi)]
    .map(m=>stripTags(m[1])).filter(t=>t.length>=8);
  const date=page.body.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished|pubdate|publishdate)["'][^>]+content=["']([^"']+)/i)?.[1]
    || page.body.match(/"datePublished"\s*:\s*"([^"]+)"/i)?.[1] || '';
  return {...info,html:page.body,body:paragraphs.join('\n').slice(0,16000)||info.article,publishedAt:date};
}
module.exports={queryTokens,keepRelevant,cleanQuery,parseBing,search,readPage};
