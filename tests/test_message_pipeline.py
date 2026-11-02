import sys
from pathlib import Path
import threading
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'examples'))
from message_pipeline import MessagePipeline, LockedDatabase

class PipelineTests(unittest.TestCase):
    def test_serial_parallel_merge_and_capacity(self):
        entered, release, other, finished = (threading.Event() for _ in range(4))
        seen=[]
        def process(m, _):
            seen.append(m)
            if m['content']=='hold':
                entered.set(); self.assertTrue(release.wait(5))
            elif m['content']=='other': other.set()
            else: finished.set()
        p=MessagePipeline(process, lambda _:True, per_chat=2)
        try:
            msg=lambda text,i:{'type':'文本','content':text,'sender_username':'demo','username':'peer','local_id':i}
            self.assertTrue(p.submit('a',msg('hold',1)))
            self.assertTrue(entered.wait(5))
            self.assertTrue(p.submit('a',msg('second',2)))
            self.assertTrue(p.submit('a',msg('third',3)))
            self.assertFalse(p.submit('a',msg('overflow',4)))
            self.assertTrue(p.submit('b',msg('other',5)))
            self.assertTrue(other.wait(5))
            self.assertFalse(finished.is_set())
            release.set(); self.assertTrue(finished.wait(5))
            merged=next(m for m in seen if m['content']=='second\nthird')
            self.assertEqual(merged['_source_ids'],['peer::2','peer::3'])
        finally: release.set(); p.close()

    def test_revocation_and_close_cancel_pending(self):
        entered, release, done=threading.Event(),threading.Event(),threading.Event()
        allowed=[True]; seen=[]
        def run(m,_):
            seen.append(m['content']); entered.set(); release.wait(5); done.set()
        p=MessagePipeline(run,lambda _:allowed[0])
        p.submit('a',{'content':'first'}); self.assertTrue(entered.wait(5))
        p.submit('a',{'content':'second'}); allowed[0]=False; p.cancel_invalid()
        self.assertEqual(p.count,0); p.close(); release.set(); self.assertTrue(done.wait(5))
        self.assertEqual(seen,['first']); self.assertFalse(p.submit('a',{}))

    def test_database_iterator_is_materialized_under_lock(self):
        class DB:
            def rows(self): yield 1; yield 2
        self.assertEqual(LockedDatabase(DB()).rows(),[1,2])

if __name__=='__main__': unittest.main()
