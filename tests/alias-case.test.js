'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path');
const {spawnSync}=require('node:child_process');

test('微信桥接不区分英文别名大小写；裸 @ 和其他成员识别一致',()=>{
 const script=String.raw`
import re, ast, textwrap
from pathlib import Path
source=Path('examples/wechatauto_bridge.py').read_text(encoding='utf-8-sig')
ast.parse(source)
start=source.index('            addressed = any(')
end=source.index('            # 群里先说话',start)
mention_start=source.index('            _mentioned_names = []',end)
mention_end=source.index('            log("收到"',mention_start)
for name in ['deepseek','DEEPSEEK','DeepSeek','dEePsEeK']:
    scope={'_mention_re':re,'aliases':['deepseek'],'_at_text':'@'+name}
    exec(textwrap.dedent(source[start:end]),scope)
    assert scope['addressed'] and scope['_bare_mention'], name
    scope.update(is_group=True,_at_text='@'+name+' @Other 你好')
    exec(textwrap.dedent(source[mention_start:mention_end]),scope)
    assert scope['_mentioned_names']==['Other'],scope['_mentioned_names']
scope={'_mention_re':re,'aliases':['deepseek'],'_at_text':'@DEEPSEEKER'}
exec(textwrap.dedent(source[start:end]),scope)
assert not scope['addressed'] and not scope['_bare_mention']
`;
 const result=spawnSync('python',['-B','-c',script],{cwd:path.join(__dirname,'..'),encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
});
