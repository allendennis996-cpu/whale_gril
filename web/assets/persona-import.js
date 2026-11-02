/* Import validation shared by browser and tests. */
'use strict';
(function(root){
 function parse(filename,text){
  const ext=String(filename).split('.').pop().toLowerCase();
  if(!['json','md','markdown','txt'].includes(ext))throw Error('不支持的文件格式，请选择 JSON、Markdown 或 TXT');
  let name=filename.replace(/\.(json|md|markdown|txt)$/i,''),content=text.replace(/^\uFEFF/,'');
  if(typeof content!=='string'||!content.trim()||content.includes('\0'))throw Error('人格正文为空或无效，未导入');
  if(typeof name!=='string'||!name.trim()||name.trim().length>80)throw Error('人格卡名称无效，须为 1–80 字');
  return {name:name.trim(),content:content.replace(/\r\n?/g,'\n')};
 }
 if(typeof module==='object'&&module.exports)module.exports={parse};else root.PersonaImport={parse};
})(globalThis);
