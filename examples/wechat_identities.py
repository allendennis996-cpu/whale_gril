"""仅登记身份元数据；不接收或持久化正文、媒体与聊天历史。"""
import json
import os
import re
import threading
import time
from pathlib import Path

class IdentityRegistry:
    def __init__(self, file):
        self.file = Path(file)
        self.lock = threading.RLock()
        try:
            rows = json.loads(self.file.read_text(encoding="utf-8")).get("rows", [])
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
                temp.write_text(json.dumps({"version": 1, "rows": ordered}, ensure_ascii=False), encoding="utf-8")
                os.replace(temp, self.file)
