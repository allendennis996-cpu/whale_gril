"""微信 @ 路由：优先读取真实目标账号，显示名称仅在元数据缺失时兜底。"""
import re
import xml.etree.ElementTree as ET


def mention_targets(source):
    if isinstance(source, bytes):
        source = source.decode('utf-8', errors='replace')
    if not isinstance(source, str) or '<atuserlist' not in source.lower():
        return None
    try:
        root = ET.fromstring(source)
    except ET.ParseError:
        return None
    node = root if root.tag.lower() == 'atuserlist' else next((n for n in root.iter() if n.tag.lower() == 'atuserlist'), None)
    if node is None:
        return None
    return {s.strip() for s in re.split(r'[,;\s]+', node.text or '') if s.strip()}


def resolve_mentions(db, msg, chat, me, self_name, content, aliases):
    text = content.replace('\u2005', ' ')
    names = [str(a) for a in [*aliases, self_name] if a]
    targets = mention_targets(msg.get('source'))
    # 普通监听记录不带 source；用分片和 local_id 精确回读，不能跨分片猜测。
    if targets is None and '@' in text and msg.get('shard') and msg.get('local_id') is not None:
        try:
            row = db.get_message_row(chat, msg['local_id'], shard=msg['shard']) or {}
            targets = mention_targets(row.get('source'))
        except Exception:
            pass
    pattern = r'@\s*(?:' + '|'.join(re.escape(n) for n in sorted(names, key=len, reverse=True)) + r')(?=$|[\s，,：:！!~～…?？。\-—])'
    addressed = me in targets if targets is not None else bool(names and re.search(pattern, text, re.I))
    if addressed and targets == {me}:
        # 仅 @ 自己时，实际群名片可以和人格别名完全不同。
        labels = re.findall(r'@([^@]+?)(?=\u2005|$)', content) if '\u2005' in content else re.findall(r'@([^@]+?)(?=\s|$)', text)
        if len(labels) == 1:
            names.append(labels[0].strip())
    remainder = re.sub(r'^[A-Za-z0-9_\-]{4,}:\s*', '', text).strip()
    for name in names:
        remainder = re.sub(r'@\s*' + re.escape(name) + r'(?=$|[\s，,：:！!~～…?？。\-—])', ' ', remainder, flags=re.I)
    bare = not remainder.strip(' \t\r\n，,。.!！?？…~～')
    others = []
    for name in re.findall(r'@\s*([^\s@，,：:！!~～…?？。—]+)', remainder):
        if name.casefold() not in {n.casefold() for n in names} and name not in others:
            others.append(name)
    return addressed, bare, others, remainder.strip()
