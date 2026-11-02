#!/usr/bin/env node
'use strict';
const path=require('node:path');
const fs=require('node:fs');
const maintenance=require('../src/memoryMaintenance');
const args=process.argv.slice(2);
const option=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const root=path.resolve(option('--root') || path.join(__dirname,'..'));
try {
  const accounts=option('--accounts') ? JSON.parse(fs.readFileSync(path.resolve(option('--accounts')),'utf8').replace(/^\uFEFF/,'')) : {};
  if(!accounts || Array.isArray(accounts) || typeof accounts!=='object' || Object.values(accounts).some(x=>typeof x!=='string'||!x.trim()))throw Error('账号映射必须为旧会话键到来源账号的 JSON 对象');
  if(!['inspect','migrate','rollback','restore'].includes(args[0]))throw Error('用法：node scripts/memory-v2.js inspect|migrate|rollback|restore [--bundle 备份文件] [--accounts 本机映射.json] [--root 项目目录]');
  const input=args[0]==='restore' ? JSON.parse(fs.readFileSync(path.resolve(option('--bundle') || ''),'utf8').replace(/^\uFEFF/,'')) : accounts;
  console.log(JSON.stringify(maintenance[args[0]](root,input),null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
