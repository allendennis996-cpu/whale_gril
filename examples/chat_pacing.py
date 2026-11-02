"""消息间的打字节奏：首条延迟一秒发送，后续消息按长度短暂停顿。"""

def bubble_delay_seconds(text):
    return min(1.2, max(0.8, 0.7 + len(str(text or "").strip()) / 60.0))
