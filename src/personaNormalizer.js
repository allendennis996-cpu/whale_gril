'use strict';

const { MAX_CARD_BYTES: LIMIT, CARD_LIMIT_LABEL } = require('./personaLimits');
const IDENTITY = '<!-- agent-identity -->\n# 身份参数\n姓名：{{name}}\n年龄：{{age}}\n生日：{{birthday}}\n职业：{{job}}\n别名／外号：{{aliases}}\n主人称呼：{{ownerName}}\n<!-- /agent-identity -->\n\n';
const withoutIdentity=text=>text.replace(/<!-- agent-identity -->[\s\S]*?<!-- \/agent-identity -->\s*/g,'');

function normalizedMarkdown(raw) {
  if (typeof raw !== 'string') throw Error('模型返回内容无效，未保存卡片');
  let text=withoutIdentity(raw.replace(/\r\n?/g,'\n')).trim();
  const fence=text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if(fence)text=fence[1].trim();
  if(!text||text.includes('\0')||Buffer.byteLength(text)>LIMIT)throw Error('整理结果为空或超过'+CARD_LIMIT_LABEL+'，未保存卡片');
  if(!/^#{1,6}\s+\S/m.test(text))text='## 角色设定\n'+text;
  const content=IDENTITY+text+'\n';
  if(Buffer.byteLength(content)>LIMIT)throw Error('整理后的完整卡片超过'+CARD_LIMIT_LABEL+'，未保存卡片');
  return content;
}

async function normalize(llm, content) {
  if(typeof content!=='string'||!content.trim()||content.includes('\0')||Buffer.byteLength(content)>LIMIT)throw Error('人格正文无效，最多'+CARD_LIMIT_LABEL);
  return normalizedMarkdown(await llm.normalizePersona(withoutIdentity(content)));
}

module.exports={normalize,normalizedMarkdown};
