
from collections import deque

class MemoryModule:
    def __init__(self, max_len=1000):
        self.memory = deque(maxlen=max_len)

    def append(self, observation: str):
        self.memory.append(observation)

    def get_recent(self, n=5):
        return list(self.memory)[-n:]

    def summarize(self) -> str:
        return " | ".join(self.get_recent(10))
