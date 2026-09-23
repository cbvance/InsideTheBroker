"""Minimal primary host: STATE, tag model, rebirth, writes."""
import asyncio
import json
import time

from tap import sparkplug as sp
from tap.sparkplug import Metric, Payload
from tap.tracker import REBIRTH, Tracker
from edge.client import Client, MqttError


def now_ms():
    return int(time.time() * 1000)


def parse_value(text, dtype):
    if dtype == sp.BOOLEAN:
        return text.strip().lower() in ("1", "true", "on")
    if dtype in sp.INT_FIELD or dtype in sp.LONG_FIELD:
        return int(text)
    if dtype in (sp.FLOAT, sp.DOUBLE):
        return float(text)
    return text


class Host:
    """Subscribes to everything, keeps a tag model, and asks
    for a rebirth whenever the model cannot be trusted."""

    def __init__(self, host_id, host="127.0.0.1", port=1884,
                 keepalive=10, trace=None, writes=()):
        self.host_id = host_id
        self.host, self.port = host, port
        self.keepalive = keepalive
        self.trace = trace
        self.tracker = Tracker()
        self.events = []
        self.writes = list(writes)   # ("G/N/D/metric", text)
        self.asked = {}              # node key -> last ask
        self.client = None
        self.ts = None
        self._tasks = set()

    def _state(self, online):
        return json.dumps({"online": online,
                           "timestamp": self.ts}).encode()

    async def run(self):
        self.ts = now_ms()
        topic = sp.state_topic(self.host_id)
        will = {"topic": topic, "payload": self._state(False),
                "qos": 1, "retain": True}
        c = Client(f"host-{self.host_id}", self.keepalive,
                   will, True, self.trace, self._on_message)
        self.client = c
        await c.connect(self.host, self.port)
        await c.subscribe([(f"{sp.NAMESPACE}/#", 0)])
        await c.publish(topic, self._state(True), 1, True)
        await c.closed.wait()

    async def stop(self):
        c = self.client
        if c and not c.closed.is_set():
            await c.publish(sp.state_topic(self.host_id),
                            self._state(False), 1, True)
            await c.disconnect()

    def _on_message(self, topic, payload):
        for e in self.tracker.feed(topic, payload):
            self.events.append(e)
            if self.trace:
                self.trace.emit("HOST", e.key, e.kind, e.text)
            if e.rebirth:
                self._spawn(self.request_rebirth(e.key))
            if e.kind == "DBIRTH":
                self._spawn(self._pending_writes(e.key))

    def _spawn(self, coro):
        async def guarded():
            try:
                await coro
            except (KeyError, OSError, TimeoutError,
                    ValueError, MqttError) as e:
                if self.trace:
                    self.trace.event(self.host_id, "FAILED",
                                     str(e))
        t = asyncio.create_task(guarded())
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    async def request_rebirth(self, key, hold=5.0):
        group, node = key.split("/")[:2]
        k = f"{group}/{node}"
        if time.monotonic() - self.asked.get(k, -hold) < hold:
            return
        self.asked[k] = time.monotonic()
        m = Metric(REBIRTH, None, now_ms(), sp.BOOLEAN, True)
        await self.client.publish(
            sp.topic(group, "NCMD", node),
            sp.encode(Payload(now_ms(), None, [m])))

    async def write(self, group, node, device, name, value):
        n = self.tracker.nodes.get((group, node))
        d = n.devices.get(device) if n else None
        if d is None or name not in d.metrics:
            raise KeyError(f"{group}/{node}/{device}/{name}")
        dtype = d.metrics[name][0]
        if isinstance(value, str):
            value = parse_value(value, dtype)
        m = Metric(name, None, now_ms(), dtype, value)
        await self.client.publish(
            sp.topic(group, "DCMD", node, device),
            sp.encode(Payload(now_ms(), None, [m])))

    async def _pending_writes(self, key):
        for path, text in list(self.writes):
            g, n, d, name = path.split("/", 3)
            if f"{g}/{n}/{d}" == key:
                self.writes.remove((path, text))
                await self.write(g, n, d, name, text)
