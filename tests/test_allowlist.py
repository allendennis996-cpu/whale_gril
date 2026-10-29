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

    def test_uia_rechecks_after_opening_chat_and_before_retry(self):
        import contextlib
        import time
        source = Path(__file__).resolve().parents[1] / 'examples/wechatauto_bridge.py'
        main = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        definition = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == 'uia_send')
        for revoke_during in ('open', 'retry'):
            permitted = [True]
            engine = Mock()
            engine.current_chat.return_value = ''
            def revoke(*args):
                permitted[0] = False
                return True
            if revoke_during == 'open':
                engine.open_chat.side_effect = revoke
            else:
                def open_target(keyword):
                    engine.current_chat.return_value = keyword
                    return True
                engine.open_chat.side_effect = open_target
                engine.send_text.return_value = False
                engine.back_to_chat_tab.side_effect = revoke
            gui = Mock()
            gui._get_uia.return_value = engine
            scope = {'allowlisted': lambda *_: permitted[0], 'CONFIG_PATH': 'fake-config',
                     'account_send_allowed': lambda *_: True, 'wechat_window_alive': lambda: True,
                     'gui_lock': contextlib.nullcontext(), 'gui': gui, 'UIA_CACHE': {'u': engine},
                     'BACKGROUND_SEND': False, 'aliases_for': lambda *_: ['fake-chat'],
                     'open_cache': {}, 'time': time, 'log': Mock(), 'press_enter': Mock()}
            exec(compile(ast.Module(body=[definition], type_ignores=[]), '<isolated send>', 'exec'), scope)
            self.assertFalse(scope['uia_send']('TEST_BODY', 'fake-chat', 'wxid_demo'))
            self.assertEqual(engine.send_text.call_count, 0 if revoke_during == 'open' else 1)
            scope['press_enter'].assert_not_called()

    def test_uia_rejects_wrong_chat_and_poisoned_cache_and_searches_strings(self):
        import contextlib
        import time
        source = Path(__file__).resolve().parents[1] / 'examples/wechatauto_bridge.py'
        main = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(node, ast.FunctionDef) and node.name == 'main')
        definition = next(node for node in main.body if isinstance(node, ast.FunctionDef) and node.name == 'uia_send')
        for destination in ('Demo', 'Demo_owner'):
            engine = Mock()
            engine.current_chat.return_value = 'Demo'
            def open_target(keyword):
                self.assertIsInstance(keyword, str)
                self.assertEqual(keyword, 'Demo_owner')
                engine.current_chat.return_value = destination
                return True  # 库声称打开成功不代表对象正确。
            engine.open_chat.side_effect = open_target
            gui = Mock()
            gui._get_uia.return_value = engine
            scope = {'allowlisted': lambda *_: True, 'CONFIG_PATH': 'fake-config',
                     'account_send_allowed': lambda *_: True, 'wechat_window_alive': lambda: True,
                     'gui_lock': contextlib.nullcontext(), 'gui': gui, 'UIA_CACHE': {'u': engine},
                     'BACKGROUND_SEND': False, 'aliases_for': lambda *_: ['Demo_owner'],
                     'open_cache': {'wxid_demo_owner': 'Demo'}, 'time': time,
                     'log': Mock(), 'press_enter': Mock()}
            exec(compile(ast.Module(body=[definition], type_ignores=[]), '<isolated send>', 'exec'), scope)
            result = scope['uia_send']('TEST_BODY', 'Demo_owner', 'wxid_demo_owner')
            self.assertEqual(result, destination == 'Demo_owner')
            if destination == 'Demo':
                engine.send_text.assert_not_called()
                scope['press_enter'].assert_not_called()
                self.assertNotIn('wxid_demo_owner', scope['open_cache'])
            else:
                engine.send_text.assert_called_once_with('TEST_BODY')

    def test_account_directories_are_separate_and_persistent(self):
        with tempfile.TemporaryDirectory() as directory:
            a = IdentityRegistry.for_account(directory, 'wxid_bot_demo_A')
            b = IdentityRegistry.for_account(directory, 'wxid_bot_demo_B')
            a.observe([{'id': 'wxid_shared', 'name': 'A的备注'}])
            b.observe([{'id': 'wxid_shared', 'name': 'B的备注'}])
            self.assertNotEqual(a.file, b.file)
            self.assertEqual(IdentityRegistry.for_account(directory, 'wxid_bot_demo_A').rows['wxid_shared']['name'], 'A的备注')
            self.assertEqual(IdentityRegistry.for_account(directory, 'wxid_bot_demo_B').rows['wxid_shared']['name'], 'B的备注')
            # 文件被放错命名空间也不采信其内容。
            b.file.write_text(a.file.read_text(encoding='utf-8'), encoding='utf-8')
            self.assertEqual(IdentityRegistry.for_account(directory, 'wxid_bot_demo_B').rows, {})
            with self.assertRaises(ValueError):
                IdentityRegistry.for_account(directory, '')

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

    def test_account_profile_persists_without_server_and_preserves_names(self):
        with tempfile.TemporaryDirectory() as directory:
            a = IdentityRegistry.for_account(directory, 'wxid_bot_demo_A')
            b = IdentityRegistry.for_account(directory, 'wxid_bot_demo_B')
            a.remember_account('wxid_bot_demo_A', '账号甲', 'fake-db')
            b.remember_account('wxid_bot_demo_B', '账号乙', 'fake-db')
            reopened = IdentityRegistry.for_account(directory, 'wxid_bot_demo_A')
            reopened.remember_account('', '', '')
            record = json.loads((reopened.file.parent / 'account.bridge.json').read_text(encoding='utf-8'))
            self.assertEqual(record['account'], 'wxid_bot_demo_A')
            self.assertEqual(record['nick'], '账号甲')
            self.assertEqual(record['wxid'], 'wxid_bot_demo_A')
            self.assertEqual(record['dbDir'], 'fake-db')
            self.assertEqual(set(record), {'version', 'account', 'wxid', 'nick', 'dbDir', 'lastActive'})
            reopened.remember_account('wxid_bot_demo_A', '甲的新昵称', 'fake-db')
            self.assertEqual(json.loads((reopened.file.parent / 'account.bridge.json').read_text(encoding='utf-8'))['nick'], '甲的新昵称')
            self.assertEqual(json.loads((b.file.parent / 'account.bridge.json').read_text(encoding='utf-8'))['nick'], '账号乙')

    def test_account_refresh_cannot_erase_saved_nickname_when_database_offline(self):
        import contextlib
        import io
        import os
        import time
        source = Path(__file__).resolve().parents[1] / 'examples/wechatauto_bridge.py'
        definition = next(node for node in ast.parse(source.read_text(encoding='utf-8')).body if isinstance(node, ast.FunctionDef) and node.name == 'list_accounts_cli')
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory) / 'data/accounts.json'
            cache.parent.mkdir()
            cache.write_text(json.dumps({'accounts': [{'account': 'wxid_bot_demo_A', 'nick': '账号甲'}]}), encoding='utf-8')
            scope = {'ROOT': directory, 'os': os, 'json': json, 'time': time, 'log': Mock(), 'resolve_db_dir': lambda: directory, 'find_account_dirs': lambda _: ['wxid_bot_demo_A'], 'account_wxid': lambda value: value}
            exec(compile(ast.Module(body=[definition], type_ignores=[]), str(source), 'exec'), scope)
            with patch.dict(sys.modules, {'wechatauto': SimpleNamespace(WeChatDB=Mock(side_effect=RuntimeError('offline')))}), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(scope['list_accounts_cli'](), 0)
            self.assertEqual(json.loads(cache.read_text(encoding='utf-8'))['accounts'][0]['nick'], '账号甲')


if __name__ == '__main__':
    unittest.main()
