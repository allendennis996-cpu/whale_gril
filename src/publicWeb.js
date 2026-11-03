'use strict';
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const net = require('node:net');

function isPrivateHost(input) {
  const host = String(input || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (net.isIPv6(host)) {
    // Only global unicast IPv6 is eligible; IPv4-mapped and translation ranges are excluded.
    return !/^[23][0-9a-f]{0,3}:/.test(host) || /^2001:(?:db8|0):/.test(host) || host.startsWith('2002:');
  }
  if (!net.isIPv4(host)) return false;
  const [a,b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0,168].includes(b))
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19,51].includes(b))
    || (a === 203 && b === 0);
}

// Resolve at connection time and use only the validated address (including every redirect).
function publicLookup(host, options, callback) {
  dns.lookup(host, {all:true, verbatim:true}, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(a => isPrivateHost(a.address))) return callback(Error('private_host'));
    const chosen = options.family ? addresses.filter(a => a.family === options.family) : addresses;
    if (!chosen.length) return callback(Error('no_address'));
    if (options.all) callback(null, chosen);
    else callback(null, chosen[0].address, chosen[0].family);
  });
}

async function fetchPage(url, {timeoutMs=5000, signal, maxBytes=1024*1024, redirects=4, allowPrivate=false, allowUrl, proxyEnv}={}) {
  // Proxy use is restricted to callers with a fixed destination allowlist (Bing search).
  if(proxyEnv && !allowUrl) throw Error('proxy_requires_allowlist');
  if(proxyEnv) {
    const [major,minor]=process.versions.node.split('.').map(Number);
    if(!(major>=25 || major===24&&minor>=5 || major===22&&minor>=21)) throw Error('proxy_requires_node_22_21_or_24_5');
  }
  const agents=proxyEnv?{ 'http:':new http.Agent({proxyEnv}), 'https:':new https.Agent({proxyEnv}) }:null;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(() => controller.abort(Error('timeout')), Math.max(1,timeoutMs));
  async function visit(target, remaining) {
    const u = new URL(target);
    if (!['http:','https:'].includes(u.protocol) || u.username || u.password || (allowUrl && !allowUrl(u.href))) throw Error('bad_url');
    if (!allowPrivate && isPrivateHost(u.hostname)) throw Error('private_host');
    return new Promise((resolve,reject) => {
      const req = (u.protocol === 'https:' ? https : http).get(u, {
        signal:controller.signal, lookup:allowPrivate||proxyEnv ? undefined : publicLookup,
        agent:agents?.[u.protocol],
        headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
          'Accept-Language':'zh-CN,zh;q=0.9', Accept:'text/html,application/json,*/*', Referer:u.origin+'/'},
      }, res => {
        res.on('error',reject);
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.destroy();
          if (remaining <= 0) return reject(Error('redirect_limit'));
          try {visit(new URL(res.headers.location,u).href,remaining-1).then(resolve,reject);}
          catch(error) {reject(error);} return;
        }
        if (res.statusCode !== 200) {res.destroy();reject(Error('HTTP '+res.statusCode));return;}
        const chunks=[]; let size=0;
        res.on('data', chunk => {
          size+=chunk.length;
          if (size>maxBytes) {reject(Error('too_large'));res.destroy();return;}
          chunks.push(chunk);
        });
        res.on('aborted',()=>reject(Error('read_aborted')));
        res.on('end',()=>resolve({body:Buffer.concat(chunks).toString('utf8'),finalUrl:u.href,
          contentType:String(res.headers['content-type']||''),status:res.statusCode}));
      });
      req.on('error',reject);
    });
  }
  try { return await visit(url,redirects); }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);if(agents) Object.values(agents).forEach(agent=>agent.destroy());}
}
module.exports = {isPrivateHost, publicLookup, fetchPage};
