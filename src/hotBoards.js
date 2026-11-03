'use strict';
const {fetchPage} = require('./publicWeb');
const URLS = {
  toutiao:'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc',
  weibo:'https://weibo.com/ajax/side/hotSearch',
};
const LABELS={toutiao:'今日头条',weibo:'微博'};
function eventUrl(value) {
  try {const u=new URL(value);if(!['http:','https:'].includes(u.protocol))return '';
    if(u.hostname==='www.toutiao.com') {u.search='';u.hash='';}
    return u.href;
  } catch {return '';}
}
function parseBoard(platform, data, fetchedAt) {
  const list=platform==='toutiao' ? data.data : data.data?.realtime;
  if (!Array.isArray(list)) throw Error('invalid_board');
  return list.map((item,i)=>({item,rank:i+1})).filter(({item})=>!item.is_ad && !item.isAd
    && !/广告|推广/.test(String(item.Label||'')+' '+String(item.label_name||'')))
    .slice(0,10).map(({item,rank})=>({
      title:String(platform==='toutiao' ? item.Title||'' : item.word||item.note||'').trim(),
      platform,rank,fetchedAt,
      url:platform==='toutiao' ? eventUrl(item.Url||'') : 'https://s.weibo.com/weibo?q='+encodeURIComponent(item.word||item.note||''),
    })).filter(item=>item.title && /^https?:\/\//.test(item.url));
}
function createClient({fetch=fetchPage,cache=new Map()}={}) {
async function getBoard(platform,{signal,timeoutMs=5000,now=Date.now()}={}) {
  const key=platform;
  const hit=cache.get(key);
  if (hit && now-hit.at>=0 && now-hit.at<120000) return {...hit.board,cached:true};
  const response=await fetch(URLS[platform],{signal,timeoutMs});
  const fetchedAt=new Date(now).toISOString();
  const items=parseBoard(platform,JSON.parse(response.body),fetchedAt);
  if (!items.length) throw Error('empty_board');
  const board={platform,items,fetchedAt,cached:false};
  cache.set(key,{at:now,board});
  return board;
}
return {getBoard,mergeBoards};
}
function mergeBoards(boards,limit=8) {
  const all=[];const seen=new Map();
  for(let i=0;i<10;i++) for(const board of boards) {
    const item=board.items[i];if(!item) continue;
    const key=item.title.toLowerCase().replace(/[\s\p{P}\p{S}]/gu,'');
    const source={platform:item.platform,label:LABELS[item.platform],rank:item.rank,url:item.url,fetchedAt:item.fetchedAt,cached:board.cached};
    if(seen.has(key)) seen.get(key).sources.push(source);
    else {const entry={title:item.title,sources:[source]};seen.set(key,entry);all.push(entry);}
  }
  return all.slice(0,limit);
}
module.exports={URLS,LABELS,parseBoard,createClient,...createClient(),mergeBoards};
