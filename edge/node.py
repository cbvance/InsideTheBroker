"""The study edge node: Sparkplug B from connect to death.

One task scans the devices; another owns the MQTT
connection. Values that change while the node is not
born are kept and sent later as historical data.
"""
import asyncio
import json
import time

from broker.wire import ProtocolError
from tap import sparkplug as sp
from tap.sparkplug import Metric, Payload
from tap.tracker import REBIRTH

from .client import Client, MqttError


def now_ms():
    return int(time.time() * 1000)


def changed(prev, new, pt):
    """Report by exception: has this value moved enough?"""
    if prev is None:
        return True
    numeric = isinstance(new, (int, float)) and \
        not isinstance(new, bool)
    if numeric and pt.deadband:
        return abs(new - prev) > pt.deadband
    return new != prev


class EdgeNode:
    def __init__(self, group, node, devices,
                 host="127.0.0.1", port=1884, keepalive=10,
                 primary_host=None, scan=1.0, aliases=False,
                 state_file=None, trace=None, retry=2.0,
                 buffer_limit=10000):
        self.group, self.node = group, node
        self.devices = {d.name: d for d in devices}
        self.host, self.port = host, port
        self.keepalive = keepalive
        self.primary_host = primary_host
        self.scan, self.retry = scan, retry
        self.trace = trace
        self.client_id = f"{group}-{node}"
        self.state_file = state_file or \
            f".edge-{group}-{node}.json"
        self.buffer, self.buffer_limit = [], buffer_limit
        self.lock = asyncio.Lock()
        self.client = None
        self.live = False          # connected and born
        self.running = False
        self.bdseq = None
        self.seq = 0
        self.last = {n: {} for n in self.devices}
        self.dev_ok = {n: True for n in self.devices}
        self.dev_live = {n: False for n in self.devices}
        self.host_online = asyncio.Event()
        self.host_ts = 0
        self.alias = {}            # (device, name) -> alias
        self.by_alias = {}         # alias -> (device, name)
        if aliases:
            self._assign_aliases()
        self._tasks = set()

    # ---- identity that survives restarts -------------------

    def _next_bdseq(self):
        """bdSeq goes up by one on every connect attempt."""
        last = -1
        try:
            with open(self.state_file) as f:
                last = json.load(f)["bdSeq"]
        except (OSError, ValueError, KeyError):
            pass
        nxt = (last + 1) % 256
        with open(self.state_file, "w") as f:
            json.dump({"bdSeq": nxt}, f)
        return nxt

    def _assign_aliases(self):
        keys = [(None, "bdSeq"), (None, REBIRTH)]
        for d in self.devices.values():
            keys += [(d.name, n) for n in d.points]
        for i, k in enumerate(keys, start=1):
            self.alias[k] = i
            self.by_alias[i] = k

    def _next_seq(self):
        s, self.seq = self.seq, (self.seq + 1) % 256
        return s

    def _topic(self, mtype, device=None):
        return sp.topic(self.group, mtype, self.node, device)

    def _log(self, what, detail=""):
        if self.trace:
            self.trace.event(self.client_id, what, detail)

    def _metric(self, dev, name, dtype, value, ts,
                birth=False, hist=False):
        a = self.alias.get((dev, name))
        use_name = birth or a is None
        return Metric(name if use_name else None, a, ts,
                      dtype, value, value is None, hist)

    async def _pub(self, mtype, payload, device=None, qos=0):
        await self.client.publish(
            self._topic(mtype, device), sp.encode(payload), qos)

    def _death_payload(self):
        m = self._metric(None, "bdSeq", sp.INT64, self.bdseq,
                         now_ms(), birth=True)
        return sp.encode(Payload(now_ms(), None, [m]))

    # ---- the connection loop -------------------------------

    async def run(self):
        self.running = True
        scanner = asyncio.create_task(self._scanner())
        try:
            while self.running:
                try:
                    await self._session()
                except (OSError, MqttError, ProtocolError,
                        TimeoutError) as e:
                    self._log("CONNECT FAIL", str(e) or
                              type(e).__name__)
                self._went_dark()
                if self.running:
                    await asyncio.sleep(self.retry)
        finally:
            scanner.cancel()

    async def _session(self):
        self.bdseq = self._next_bdseq()
        will = {"topic": self._topic("NDEATH"), "qos": 1,
                "payload": self._death_payload(),
                "retain": False}
        c = Client(self.client_id, self.keepalive, will,
                   True, self.trace, self._on_message)
        self.client = c
        self._log("CONNECTING", f"bdSeq={self.bdseq}")
        await c.connect(self.host, self.port)
        subs = [(self._topic("NCMD"), 0),
                (self._topic("DCMD", "+"), 0)]
        if self.primary_host:
            self.host_online.clear()
            subs.append((sp.state_topic(self.primary_host), 1))
        await c.subscribe(subs)
        if self.primary_host:
            self._log("WAITING", f"for {self.primary_host}")
            await self._first(self.host_online.wait(),
                              c.closed.wait())
        if c.closed.is_set():
            return
        async with self.lock:
            await self._birth()
        await self._flush_buffer()
        await c.closed.wait()
        self._log("DISCONNECTED", c.reason)

    @staticmethod
    async def _first(*coros):
        tasks = [asyncio.ensure_future(c) for c in coros]
        done, rest = await asyncio.wait(
            tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in rest:
            t.cancel()

    def _went_dark(self):
        self.live = False
        for n in self.dev_live:
            self.dev_live[n] = False

    async def stop(self):
        """Leave on purpose: NDEATH first, then DISCONNECT."""
        self.running = False
        c = self.client
        if c and not c.closed.is_set():
            if self.live:
                self.live = False
                await c.publish(self._topic("NDEATH"),
                                self._death_payload(), 1)
                self._log("NDEATH", "sent before DISCONNECT")
            await c.disconnect()

    # ---- births --------------------------------------------

    async def _birth(self):
        self.seq = 0
        ts = now_ms()
        ms = [self._metric(None, "bdSeq", sp.INT64,
                           self.bdseq, ts, birth=True),
              self._metric(None, REBIRTH, sp.BOOLEAN, False,
                           ts, birth=True)]
        await self._pub("NBIRTH",
                        Payload(ts, self._next_seq(), ms))
        self.live = True
        for dev in self.devices.values():
            if self.dev_ok[dev.name]:
                await self._dbirth(dev)

    async def _dbirth(self, dev):
        try:
            vals = await dev.read()
        except Exception as e:
            self._fault(dev, e)
            return
        ts = now_ms()
        ms = [self._metric(dev.name, n, dev.points[n].datatype,
                           v, ts, birth=True)
              for n, v in vals.items()]
        await self._pub("DBIRTH",
                        Payload(ts, self._next_seq(), ms),
                        dev.name)
        self.last[dev.name] = dict(vals)
        self.dev_live[dev.name] = True

    # ---- scanning and report by exception ------------------

    async def _scanner(self):
        while True:
            for dev in self.devices.values():
                await self._report(dev)
            await asyncio.sleep(self.scan)

    async def _report(self, dev):
        try:
            vals = await dev.read()
        except Exception as e:
            await self._device_down(dev, e)
            return
        if not self.dev_ok[dev.name]:
            self.dev_ok[dev.name] = True
            self._log("DEVICE OK", dev.name)
            if self.live:
                async with self.lock:
                    await self._dbirth(dev)
            return
        last = self.last[dev.name]
        if not last:
            last.update(vals)     # first sample: nothing moved
            return
        moved = [n for n, v in vals.items()
                 if changed(last.get(n), v, dev.points[n])]
        if not moved:
            return
        ts = now_ms()
        for n in moved:
            last[n] = vals[n]
        if self.live and self.dev_live[dev.name]:
            pts = dev.points
            ms = [self._metric(dev.name, n, pts[n].datatype,
                               vals[n], ts) for n in moved]
            async with self.lock:
                await self._pub("DDATA", Payload(
                    ts, self._next_seq(), ms), dev.name)
        elif not self.live:
            for n in moved:
                if len(self.buffer) >= self.buffer_limit:
                    self.buffer.pop(0)
                self.buffer.append((dev.name, n, vals[n], ts))

    def _fault(self, dev, e):
        if self.dev_ok[dev.name]:
            self._log("DEVICE FAULT", f"{dev.name}: {e}")
        self.dev_ok[dev.name] = False

    async def _device_down(self, dev, e):
        was_live = self.dev_live[dev.name]
        self._fault(dev, e)
        self.dev_live[dev.name] = False
        if self.live and was_live:
            p = Payload(now_ms(), None, [])
            async with self.lock:
                p.seq = self._next_seq()
                await self._pub("DDEATH", p, dev.name)

    async def _flush_buffer(self):
        """Store and forward: send what was kept, marked old."""
        if not self.buffer:
            return
        kept, self.buffer = self.buffer, []
        self._log("FORWARD", f"{len(kept)} historical values")
        for i in range(0, len(kept), 100):
            by_dev = {}
            for d, n, v, ts in kept[i:i + 100]:
                if self.dev_live.get(d):
                    dt = self.devices[d].points[n].datatype
                    m = self._metric(d, n, dt, v, ts,
                                     hist=True)
                    by_dev.setdefault(d, []).append(m)
            for d, ms in by_dev.items():
                async with self.lock:
                    await self._pub("DDATA", Payload(
                        now_ms(), self._next_seq(), ms), d)

    # ---- commands and host state ---------------------------

    def _on_message(self, topic, payload):
        if topic == sp.state_topic(self.primary_host or ""):
            self._on_state(payload)
            return
        self._spawn(self._command(topic, payload))

    def _spawn(self, coro):
        """Run a command handler; log, never lose, errors."""
        async def guarded():
            try:
                await coro
            except (MqttError, OSError, TimeoutError) as e:
                self._log("CMD FAILED", str(e))
        t = asyncio.create_task(guarded())
        self._tasks.add(t)
        t.add_done_callback(self._tasks.discard)

    def _on_state(self, payload):
        try:
            s = json.loads(payload)
            online, ts = bool(s["online"]), s["timestamp"]
        except (ValueError, KeyError, TypeError):
            self._log("BAD STATE", repr(payload[:40]))
            return
        if ts < self.host_ts:
            self._log("STATE", "older timestamp ignored")
            return
        self.host_ts = ts
        if online:
            self.host_online.set()
            return
        self.host_online.clear()
        self._log("HOST OFFLINE", self.primary_host)
        if self.live:
            self._spawn(self._leave_for_host())

    async def _leave_for_host(self):
        """Primary host gone: publish NDEATH, disconnect."""
        c = self.client
        self._went_dark()
        await c.publish(self._topic("NDEATH"),
                        self._death_payload(), 1)
        await c.disconnect()

    async def _command(self, topic, payload):
        parts = topic.split("/")
        try:
            p = sp.decode(payload)
        except sp.CodecError as e:
            self._log("BAD CMD", str(e))
            return
        if parts[2] == "NCMD":
            for m in p.metrics:
                name = m.name or self.by_alias.get(
                    m.alias, (None, None))[1]
                if name == REBIRTH and m.value:
                    self._log("REBIRTH", "requested by host")
                    async with self.lock:
                        await self._birth()
            return
        dev = self.devices.get(parts[4])
        if dev is None:
            self._log("BAD CMD", f"no device {parts[4]}")
            return
        for m in p.metrics:
            name = m.name or self.by_alias.get(
                m.alias, (None, None))[1]
            pt = dev.points.get(name)
            if pt is None or not pt.writable:
                self._log("REJECTED", f"{dev.name}/{name}")
                continue
            self._log("WRITE", f"{dev.name}/{name}={m.value}")
            await dev.write(name, m.value)
        await self._report(dev)
