"""Per-client state that can outlive one TCP connection."""
from collections import deque


class Connection:
    """One live TCP connection."""

    def __init__(self, writer, peer):
        self.writer = writer
        self.peer = peer
        self.client_id = None

    def write(self, data):
        if not self.writer.is_closing():
            self.writer.write(data)

    def close(self):
        if not self.writer.is_closing():
            self.writer.close()


class Session:
    """Subscriptions, in-flight messages, and the queue.

    A clean session lives as long as its connection. A
    persistent session (clean session 0) survives
    disconnects and is resumed by the same client ID.
    """

    def __init__(self, client_id, clean, queue_limit=1000):
        self.client_id = client_id
        self.clean = clean
        self.subs = {}            # filter -> granted QoS
        self.will = None
        self.conn = None          # live Connection or None
        self.inflight = {}        # pid -> outbound entry
        self.qos2_in = set()      # inbound QoS 2 ids held
        self.offline = deque()    # queued while offline
        self.queue_limit = queue_limit
        self.dropped = 0
        self._pid = 0

    def next_pid(self):
        """Next free packet identifier, 1 to 65535."""
        for _ in range(65535):
            self._pid = self._pid % 65535 + 1
            if self._pid not in self.inflight:
                return self._pid
        raise RuntimeError("all 65535 packet ids in flight")

    def granted_qos(self, topic, matches):
        """Highest granted QoS among matching filters."""
        best = None
        for f, q in self.subs.items():
            if matches(f, topic) and (best is None or q > best):
                best = q
        return best
