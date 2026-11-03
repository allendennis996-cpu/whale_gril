'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const path=require('node:path'),{spawnSync}=require('node:child_process');
test('微信桥接识别真实 @ 账号；昵称不同仍有效，英文大小写兼容，不误认其他账号',()=>{
 const script=String.raw`
import sys, ast
from pathlib import Path
sys.path.insert(0,'examples')
from wechat_mentions import resolve_mentions, mention_targets
ast.parse(Path('examples/wechatauto_bridge.py').read_text(encoding='utf-8-sig'))
class DB:
    source = None
    def get_message_row(self, chat, local_id, shard):
        assert chat=='fiction-group@chatroom' and local_id==7 and shard=='fiction-shard'
        return {'source':self.source}
db=DB()
def call(text, source=None):
    db.source=source
    return resolve_mentions(db, {'local_id':7,'shard':'fiction-shard'},'fiction-group@chatroom','fiction-bot','微信昵称',text,['deepseek'])
for name in ['deepseek','DEEPSEEK','DeepSeek','dEePsEeK']:
    r=call('@'+name+'\u2005')
    assert r[0] and r[1] and r[2]==[],r
    r=call('@'+name+' @Other 你好')
    assert r[0] and r[2]==['Other'],r
assert not call('@DEEPSEEKER')[0]
source='<msgsource><atuserlist><![CDATA[fiction-bot]]></atuserlist></msgsource>'
r=call('@群名片\u2005你好',source)
assert r[0] and not r[1] and r[2]==[] and r[3]=='你好',r
assert call('@群名片\u2005',source)[1]
r=call('@群 内 名\u2005你好',source)
assert r[0] and r[3]=='你好' and r[2]==[],r
assert call('@微信昵称\u2005你好')[0]
assert not call('@deepseek 你好','<msgsource><atuserlist>fiction-other</atuserlist></msgsource>')[0]
assert not call('@所有人','<msgsource><atuserlist>notify@all</atuserlist></msgsource>')[0]
assert mention_targets(b'<msgsource><atuserlist>fiction-a,fiction-b</atuserlist></msgsource>')=={'fiction-a','fiction-b'}
`;
 const result=spawnSync('python',['-B','-c',script],{cwd:path.join(__dirname,'..'),encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);
});
