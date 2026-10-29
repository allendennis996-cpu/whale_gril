"""只查询身份元数据，不启动桥接、不读取消息。"""
import contextlib
import json
import sys

def resolve(request):
    import wechatauto_bridge as bridge
    from wechatauto import WeChatDB
    folder = bridge.resolve_db_dir()
    accounts = bridge.find_account_dirs(folder) if folder else []
    wanted = str(request.get("account") or "")
    account = bridge.resolve_account_dir(folder, wanted) if wanted else (accounts[0] if len(accounts) == 1 else "")
    if not account:
        raise ValueError("无法确定微信账号，请先选择已登录账号")
    db = WeChatDB(db_dir=folder, account=account)
    if db.account != account:
        raise ValueError("微信账号不匹配")
    rows = []
    for uid in request["ids"]:
        name = db.group_id_to_name(uid) if request["type"] == "groups" else db.get_nickname(uid)
        name = str(name or "").strip()
        if name == uid:
            name = ""
        rows.append({"id": uid, "name": name, "found": bool(name), "reason": "" if name else "未识别，可手动填写"})
    return {"ok": True, "account": account, "results": rows}

if __name__ == "__main__":
    try:
        request = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            result = resolve(request)
    except Exception:
        result = {"ok": False, "error": "微信未登录、账号不明确或身份数据库不可访问，可手动填写名称"}
    print(json.dumps(result, ensure_ascii=False))
