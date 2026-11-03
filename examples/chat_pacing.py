"""消息间的打字节奏：首条立即发送，后续消息按长度短暂停顿。"""

def bubble_delay_seconds(text):
    return min(0.8, max(0.5, 0.45 + len(str(text or "").strip()) / 100.0))
