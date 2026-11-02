"""消息间的打字节奏：首条直接发送，后续消息按长度短暂停顿。"""

def bubble_delay_seconds(text):
    return min(1.2, max(0.3, 0.2 + len(str(text or "").strip()) / 60.0))
