"""An MQTT 3.1.1 client built from the broker's wire module.

No library hides the CONNECT: every packet this client
sends is built by broker.packets and can be traced.
"""
import asyncio
import time

from broker import packets as P
from broker.wire import NAMES, ProtocolError, read_packet


class MqttError(Exception):
    pass


class Client:
    def __init__(self, client_id, keepalive=10, will=None,
                 clean=True, trace=None, on_message=None):
        self.client_id = client_id
        self.keepalive = keepalive
        self.will = will
        self.clean = clean
        self.trace = trace
        self.on_message = on_message    # fn(topic, payload)
        self.reader = self.writer = None
        self.pending = {}               # pid -> Future
        self.qos2_in = set()
        self.closed = asyncio.Event()
        self.reason = None
        self.session_present = False
        self._pid = 0
        self._last_send = 0.0
        self._tasks = []

    # ---- connect and close ---------------------------------

    async def connect(self, host, port, timeout=10):
        self.reader, self.writer = \
            await asyncio.open_connection(host, port)
        self.send(P.build_connect(
            self.client_id, self.keepalive, self.clean,
            self.will))
        t, flags, body = await asyncio.wait_for(
            read_packet(self.reader), timeout)
        self._log("IN", t, flags, body)
        if t != P.CONNACK:
            raise ProtocolError("expected CONNACK")
        self.session_present, rc = P.parse_connack(body)
        if rc != P.ACCEPTED:
            self.writer.close()
            raise MqttError(f"CONNACK refused, code {rc}")
        self._tasks = [asyncio.create_task(self._read_loop()),
                       asyncio.create_task(self._ping_loop())]

    async def disconnect(self):
        """Graceful: DISCONNECT, so the will is discarded."""
        if not self.closed.is_set():
            self.send(P.DISCONNECT_PKT)
            await self._drain()
            self._close("DISCONNECT sent")

    def abort(self):
        """Die without a word, like a power failure."""
        if self.writer:
            self.writer.transport.abort()
        self._close("aborted")

    def _close(self, reason):
        if self.closed.is_set():
            return
        self.reason = reason
        self.closed.set()
        for t in self._tasks:
            if t is not asyncio.current_task():
                t.cancel()
        for f in self.pending.values():
            if not f.done():
                f.set_exception(MqttError(reason))
        if self.writer and not self.writer.is_closing():
            self.writer.close()

    # ---- sending -------------------------------------------

    def send(self, pkt):
        if self.trace:
            self.trace.out(self.client_id, pkt)
        self.writer.write(pkt)
        self._last_send = time.monotonic()

    async def _drain(self):
        try:
            await self.writer.drain()
        except ConnectionError:
            pass

    def _next_pid(self):
        while True:
            self._pid = self._pid % 65535 + 1
            if self._pid not in self.pending:
                return self._pid

    def _expect(self, pid):
        f = asyncio.get_running_loop().create_future()
        self.pending[pid] = f
        return f

    async def publish(self, topic, payload, qos=0,
                      retain=False, timeout=10):
        if self.closed.is_set():
            raise MqttError(self.reason)
        if qos == 0:
            self.send(P.build_publish(topic, payload, 0,
                                      retain))
            await self._drain()
            return
        pid = self._next_pid()
        done = self._expect(pid)
        self.send(P.build_publish(topic, payload, qos, retain,
                                  False, pid))
        await asyncio.wait_for(done, timeout)

    async def subscribe(self, pairs, timeout=10):
        pid = self._next_pid()
        done = self._expect(pid)
        self.send(P.build_subscribe(pid, pairs))
        return await asyncio.wait_for(done, timeout)

    # ---- receiving -----------------------------------------

    async def _read_loop(self):
        try:
            while True:
                t, flags, body = await read_packet(self.reader)
                self._log("IN", t, flags, body)
                await self._handle(t, flags, body)
        except (asyncio.IncompleteReadError, ConnectionError):
            self._close("connection lost")
        except ProtocolError as e:
            self._close(f"protocol violation: {e}")

    async def _handle(self, t, flags, body):
        if t == P.PUBLISH:
            m = P.parse_publish(flags, body)
            pid = m["pid"]
            if m["qos"] == 2:
                if pid not in self.qos2_in:
                    self.qos2_in.add(pid)
                    self._deliver(m)
                self.send(P.build_ack(P.PUBREC, pid))
                return
            self._deliver(m)
            if m["qos"] == 1:
                self.send(P.build_ack(P.PUBACK, pid))
        elif t == P.PUBREL:
            pid = P.parse_pid(body)
            self.qos2_in.discard(pid)
            self.send(P.build_ack(P.PUBCOMP, pid))
        elif t == P.PUBREC:
            pid = P.parse_pid(body)
            self.send(P.build_ack(P.PUBREL, pid))
        elif t in (P.PUBACK, P.PUBCOMP, P.UNSUBACK):
            self._finish(P.parse_pid(body), True)
        elif t == P.SUBACK:
            pid, codes = P.parse_suback(body)
            self._finish(pid, codes)
        elif t == P.PINGRESP:
            self._ping_ok = True
        else:
            raise ProtocolError(f"{NAMES[t]} from broker")

    def _finish(self, pid, result):
        f = self.pending.pop(pid, None)
        if f and not f.done():
            f.set_result(result)

    def _deliver(self, m):
        if self.on_message:
            self.on_message(m["topic"], m["payload"])

    async def _ping_loop(self):
        """Keep the promise made in CONNECT's keepalive."""
        if not self.keepalive:
            return
        while not self.closed.is_set():
            idle = time.monotonic() - self._last_send
            wait = self.keepalive - idle
            if wait > 0:
                await asyncio.sleep(wait)
                continue
            self._ping_ok = False
            self.send(P.PINGREQ_PKT)
            await asyncio.sleep(self.keepalive)
            if not self._ping_ok:
                self._close("no PINGRESP")
                self.writer.transport.abort()

    def _log(self, d, t, flags, body):
        if self.trace:
            self.trace.packet(d, self.client_id, t, flags, body)
