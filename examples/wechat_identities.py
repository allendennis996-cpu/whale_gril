"""仅登记身份元数据；不接收或持久化正文、媒体与聊天历史。"""
import json
import hashlib
import os
import re
import threading
import time
from pathlib import Path

class IdentityRegistry:
    @classmethod
    def for_account(cls, data_dir, account):
        if not isinstance(account, str) or not account.strip():
            raise ValueError("身份目录必须明确所属微信账号")
        account = account.strip()
        key = hashlib.sha256(account.encode("utf-8")).hexdigest()
        return cls(Path(data_dir) / "wechat-identities" / key / "bridge.json", account)

    def __init__(self, file, account=""):
        self.file = Path(file)
        self.account = account
        self.lock = threading.RLock()
        self.account_saved_at = 0
        try:
            data = json.loads(self.file.read_text(encoding="utf-8"))
            rows = data.get("rows", []) if data.get("version") == 2 and data.get("account") == self.account else []
        except Exception:
            rows = []
        self.rows = {}
        for row in rows if isinstance(rows, list) else []:
            item = self.clean(row)
            if item:
                self.rows[item["id"]] = item

    @staticmethod
    def clean(row):
        if not isinstance(row, dict):
            return None
        uid = row.get("id")
        if not isinstance(uid, str) or not re.fullmatch(r"[A-Za-z0-9_.@-]+", uid) or uid == "unknown":
            return None
        kind = "groups" if uid.endswith("@chatroom") else "users"
        if row.get("type", kind) != kind:
            return None
        if (not re.fullmatch(r"[A-Za-z0-9_.-]+@chatroom", uid)) if kind == "groups" else ("@" in uid):
            return None
        try:
            last_seen = int(row.get("lastSeen") or 0)
        except (TypeError, ValueError):
            last_seen = 0
        return {"id": uid, "type": kind, "name": row["name"][:200] if isinstance(row.get("name"), str) else "", "lastSeen": last_seen}

    def remember_account(self, wxid, name, db_dir):
        """桥接独立保存自身账号资料，主服务未运行时也可保留。"""
        if not self.account:
            return
        with self.lock:
            now = int(time.time() * 1000)
            self.file.parent.mkdir(parents=True, exist_ok=True)
            file = self.file.parent / "account.bridge.json"
            record = {"version": 1, "account": self.account, "wxid": str(wxid or ""), "nick": str(name or ""), "dbDir": str(db_dir or ""), "lastActive": now}
            try:
                old = json.loads(file.read_text(encoding="utf-8"))
                if old.get("version") != 1 or old.get("account") != self.account:
                    old = {}
            except Exception:
                old = {}
            for key in ("wxid", "nick", "dbDir"):
                record[key] = record[key] or old.get(key) or ""
            if now - self.account_saved_at < 60000 and all(record[key] == old.get(key) for key in ("wxid", "nick", "dbDir")):
                return
            temp = file.with_suffix(".tmp")
            temp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
            os.replace(temp, file)
            self.account_saved_at = now

    def observe(self, rows):
        with self.lock:
            dirty = False
            for row in rows:
                item = self.clean(row)
                if not item:
                    continue
                item["lastSeen"] = int(time.time() * 1000)
                old = self.rows.get(item["id"])
                if old and not item["name"]:
                    item["name"] = old["name"]
                if not old or item["name"] != old["name"] or item["lastSeen"] - old["lastSeen"] >= 60000:
                    self.rows[item["id"]] = item
                    dirty = True
            if dirty:
                ordered = sorted(self.rows.values(), key=lambda item: item["lastSeen"], reverse=True)[:10000]
                self.rows = {item["id"]: item for item in ordered}
                self.file.parent.mkdir(parents=True, exist_ok=True)
                temp = self.file.with_suffix(".tmp")
                temp.write_text(json.dumps({"version": 2, "account": self.account, "rows": ordered}, ensure_ascii=False), encoding="utf-8")
                os.replace(temp, self.file)
