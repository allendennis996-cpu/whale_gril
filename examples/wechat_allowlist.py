"""微信权限检查：只使用真实会话 ID，读取失败默认拒绝。"""
import json
import re
import time
_last_warning = 0

def normalize(value):
    if not isinstance(value, dict):
        raise ValueError("invalid allowlist")
    result = {}
    for kind in ("users", "groups"):
        rows = value.get(kind)
        if not isinstance(rows, list):
            raise ValueError("invalid list")
        ids = set()
        for row in rows:
            if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not isinstance(row.get("name"), str):
                raise ValueError("invalid row")
            uid, name = row["id"].strip(), row["name"].strip()
            if not uid and not name:
                continue
            valid = re.fullmatch(r"[A-Za-z0-9_.@-]+", uid) and uid != "unknown"
            valid = valid and (re.fullmatch(r"[A-Za-z0-9_.-]+@chatroom", uid) if kind == "groups" else "@" not in uid)
            if not valid or uid in ids:
                raise ValueError("invalid id")
            ids.add(uid)
        result[kind] = ids
    return result

def allowed(path, uid):
    try:
        with open(path, encoding="utf-8-sig") as file:
            config = json.load(file)
        lists = normalize(config.get("wechat", {}).get("allowlist", {"users": [], "groups": []}))
        masters = config.get("persona", {}).get("master", {}).get("wxids", [])
        if isinstance(masters, list):
            lists["users"].update(value.strip() for value in masters if isinstance(value, str) and re.fullmatch(r"wxid_[A-Za-z0-9_-]+", value.strip()))
        return bool(uid) and uid in lists["groups" if uid.endswith("@chatroom") else "users"]
    except Exception:
        global _last_warning
        if time.monotonic() - _last_warning > 60:
            _last_warning = time.monotonic()
            print("白名单配置不可用：微信处理已暂停", flush=True)
        return False
