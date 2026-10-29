"""白名单默认拒绝与身份查询回归；不连接微信。"""
import ast
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'examples'))
from wechat_allowlist import allowed
from wechat_identities import IdentityRegistry
from resolve_wechat_names import resolve


class AllowlistTest(unittest.TestCase):
    def test_disk_updates_and_failure_close(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'config.json'
            self.assertFalse(allowed(file, 'peer'))
            for value in ({}, {'wechat': {'allowlist': {'users': 'invalid', 'groups': []}}}):
                file.write_text(json.dumps(value), encoding='utf-8')
                self.assertFalse(allowed(file, 'peer'))
            file.write_text(json.dumps({'wechat': {'allowlist': {'users': [{'id': 'peer', 'name': '备注'}], 'groups': []}}}), encoding='utf-8')
            self.assertTrue(allowed(file, 'peer'))
            self.assertFalse(allowed(file, '备注'))
            file.write_text('{}', encoding='utf-8')
            self.assertFalse(allowed(file, 'peer'))

    def test_bridge_denies_before_media_logging_and_queue_submission(self):
        source = Path(__file__).resolve().parents[1] / 'examples/wechatauto_bridge.py'
        tree = ast.parse(source.read_text(encoding='utf-8'))
        main = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        functions = [node for node in main.body if isinstance(node, ast.FunctionDef) and node.name in ('on_message_inner', 'on_message')]
        scope = {'allowlisted': lambda file, uid: False, 'CONFIG_PATH': 'unavailable', 'discover_identity': Mock(), 'prune_allowlist_queues': Mock(), 'executor': Mock(), 'describe_image': Mock(), 'log': Mock()}
        exec(compile(ast.Module(body=functions, type_ignores=[]), '<isolated bridge>', 'exec'), scope)
        for kind in ('图片', '语音', '文本'):
            message = {'username': 'outsider', 'type': kind, 'content': 'private content'}
            scope['on_message_inner'](message, None)
            scope['on_message'](message, None)
        scope['log'].assert_not_called()
        scope['describe_image'].assert_not_called()
        scope['executor'].submit.assert_not_called()

    def test_discovery_before_filter_records_only_ids_and_names(self):
        source = Path(__file__).resolve().parents[1] / 'examples/wechatauto_bridge.py'
        main = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        definition = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == 'discover_identity')
        import time
        with tempfile.TemporaryDirectory() as folder:
            file = Path(folder) / 'identities.json'
            registry = IdentityRegistry(file)
            db = Mock()
            db.group_id_to_name.return_value = '测试群'
            db.get_nickname.return_value = '小新'
            scope = {'identity_registry': registry, 'identity_names': {}, 'time': time, 'db': db, 'me': 'wxid_self', 'log_throttled': Mock()}
            exec(compile(ast.Module(body=[definition], type_ignores=[]), '<isolated identity discovery>', 'exec'), scope)
            scope['discover_identity']({'username': '456@chatroom', 'sender_username': 'wxid_new', 'content': 'SECRET_BODY', 'media': 'SECRET_MEDIA'})
            rows = IdentityRegistry(file).rows
            self.assertEqual(rows['456@chatroom']['name'], '测试群')
            self.assertEqual(rows['wxid_new']['name'], '小新')
            self.assertNotIn('SECRET', file.read_text(encoding='utf-8'))
            for row in rows.values():
                self.assertEqual(set(row), {'id', 'type', 'name', 'lastSeen'})
            db.get_messages.assert_not_called()
            db.get_new_messages.assert_not_called()

    def test_name_lookup_reads_only_identity_and_correct_account(self):
        database = Mock(account='account-a')
        database.get_nickname.return_value = '用户甲'
        database.group_id_to_name.return_value = ''
        bridge = SimpleNamespace(resolve_db_dir=lambda: 'folder', find_account_dirs=lambda _: ['account-a'], resolve_account_dir=lambda folder, account: account)
        library = SimpleNamespace(WeChatDB=Mock(return_value=database))
        with patch.dict(sys.modules, {'wechatauto_bridge': bridge, 'wechatauto': library}):
            result = resolve({'type': 'users', 'ids': ['peer'], 'account': 'account-a'})
            self.assertEqual(result['results'][0]['name'], '用户甲')
            result = resolve({'type': 'groups', 'ids': ['123@chatroom'], 'account': 'account-a'})
            self.assertFalse(result['results'][0]['found'])
            database.get_messages.assert_not_called()
            database.get_sessions.assert_not_called()
            bridge.find_account_dirs = lambda _: ['account-a', 'account-b']
            with self.assertRaises(ValueError):
                resolve({'type': 'users', 'ids': ['peer'], 'account': ''})


if __name__ == '__main__':
    unittest.main()
