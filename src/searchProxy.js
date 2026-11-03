'use strict';
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const run=promisify(execFile);
let cached;
async function windowsProxy({signal,timeoutMs=500}={}) {
  const key='HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  const query=async name=>(await run('reg.exe',['query',key,'/v',name],{encoding:'utf8',windowsHide:true,timeout:Math.max(1,timeoutMs),signal})).stdout;
  if(!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(await query('ProxyEnable'))) return '';
  return (await query('ProxyServer')).match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1]?.trim()||'';
}
function proxyConfig({env=process.env,platform=process.platform,readWindows=()=>''}={}) {
  let proxy=env.https_proxy||env.HTTPS_PROXY||env.all_proxy||env.ALL_PROXY;
  if(!proxy && platform==='win32') {
    try {
      const setting=readWindows();
      proxy=setting.includes('=')?setting.match(/(?:^|;)https=([^;]+)/i)?.[1]:setting;
    } catch {return null;}
  }
  if(!proxy) return null;
  try {
    const url=new URL(proxy.includes('://')?proxy:'http://'+proxy);
    if(!['http:','https:'].includes(url.protocol)) return null;
    return {HTTPS_PROXY:url.href,HTTP_PROXY:url.href,NO_PROXY:env.no_proxy||env.NO_PROXY||''};
  } catch {return null;}
}
async function getProxyConfig(options={}) {
  if(cached&&Date.now()-cached.at<=30000) return cached.value;
  let setting='';
  if(process.platform==='win32'&&!(process.env.https_proxy||process.env.HTTPS_PROXY||process.env.all_proxy||process.env.ALL_PROXY)) {
    try {setting=await windowsProxy(options);}
    catch(error) {if(options.signal?.aborted) throw error;}
  }
  cached={at:Date.now(),value:proxyConfig({readWindows:()=>setting})};
  return cached.value;
}
module.exports={proxyConfig,getProxyConfig};
