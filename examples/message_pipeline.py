"""有界会话队列。只在内存中排队；同会话串行，跨会话并发。"""
from collections import deque
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
import threading
import re


class LockedDatabase:
    """同一个数据库实例的所有调用共用可重入锁。"""
    def __init__(self, database):
        self._database = database
        self._lock = threading.RLock()

    def __getattr__(self, name):
        with self._lock:
            value = getattr(self._database, name)
        if not callable(value):
            return value
        def invoke(*args, **kwargs):
            with self._lock:
                result = value(*args, **kwargs)
                return list(result) if isinstance(result, Iterator) else result
        return invoke


def plain(message):
    text = str(message.get('content') or '').strip()
    return (message.get('type') == '文本' and text and len(text) <= 2000
            and not re.search(r'[/@<>\n]|记住|忘掉|闭嘴|静音|恢复|重置|主人|管理员|引用', text)
            and not any(message.get(k) for k in ('at_me', 'reply_to', 'quote', 'refermsg', 'reply_to_bot')))


def identity(message):
    return '%s:%s:%s' % (message.get('username', ''), message.get('shard') or '', message.get('local_id'))


class MessagePipeline:
    def __init__(self, process, allowed, workers=4, per_chat=64, total=512, log=None):
        self.process, self.allowed = process, allowed
        self.per_chat, self.total = per_chat, total
        self.log = log or (lambda *_: None)
        self.pool = ThreadPoolExecutor(max_workers=min(4, max(1, workers)))
        self.lock = threading.RLock()
        self.queues, self.running, self.count = {}, set(), 0
        self.closed = False

    def submit(self, key, message, listener=None):
        with self.lock:
            if self.closed or not self.allowed(key):
                return False
            q = self.queues.setdefault(key, deque())
            if len(q) >= self.per_chat or self.count >= self.total:
                self.log('消息队列满，拒绝新任务')
                return False
            q.append((dict(message), listener))
            self.count += 1
            if key not in self.running:
                self.running.add(key)
                self.pool.submit(self._drain, key)
            return True

    def _drain(self, key):
        while True:
            with self.lock:
                q = self.queues.get(key)
                if self.closed or not q:
                    self.running.discard(key)
                    self.queues.pop(key, None)
                    return
                message, listener = q.popleft()
                batch = [message]
                if plain(message):
                    while q and len(batch) < 8:
                        candidate = q[0][0]
                        if not plain(candidate) or candidate.get('sender_username') != message.get('sender_username'):
                            break
                        if sum(len(str(m.get('content') or '')) for m in batch) + len(candidate['content']) + len(batch) > 2000:
                            break
                        batch.append(q.popleft()[0])
                self.count -= len(batch)
            try:
                if self.allowed(key):
                    message['_accepted'] = True
                    message['_source_ids'] = [identity(m) for m in batch]
                    message['content'] = '\n'.join(str(m.get('content') or '') for m in batch)
                    self.process(message, listener)
            except Exception:
                self.log('消息队列任务失败')

    def cancel_invalid(self):
        with self.lock:
            for key, q in list(self.queues.items()):
                if not self.allowed(key):
                    self.count -= len(q)
                    q.clear()

    def close(self):
        with self.lock:
            self.closed = True
            for q in self.queues.values():
                q.clear()
            self.count = 0
        self.pool.shutdown(wait=False, cancel_futures=True)


class ThreadLocalHTTP:
    def __init__(self, factory):
        self.factory, self.local = factory, threading.local()

    def __getattr__(self, name):
        if not hasattr(self.local, 'session'):
            self.local.session = self.factory()
            self.local.session.trust_env = False
        return getattr(self.local.session, name)
