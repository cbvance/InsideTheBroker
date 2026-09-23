"""The device layer: where an edge node's values come from.

A device exposes points. Each point has a Sparkplug
datatype, a deadband for report by exception, and a
writable flag for DCMD writes.
"""
import asyncio
import math
import random
import struct
import time
from dataclasses import dataclass

from tap import sparkplug as sp


@dataclass
class Point:
    name: str
    datatype: int
    value: object = None
    writable: bool = False
    deadband: float = 0.0


class SimDevice:
    """A simulated pump skid; values change on every read."""

    def __init__(self, name="PLC1", seed=None):
        self.name = name
        self.rng = random.Random(seed)
        self.t0 = time.monotonic()
        self.points = {p.name: p for p in [
            Point("Temperature", sp.DOUBLE, 72.0, False, 0.5),
            Point("Pressure", sp.FLOAT, 55.0, False, 0.25),
            Point("Running", sp.BOOLEAN, True, True),
            Point("Starts", sp.INT32, 0, False),
            Point("Setpoint", sp.DOUBLE, 50.0, True, 0.0),
            Point("Mode", sp.STRING, "AUTO", True),
        ]}

    async def read(self):
        p = self.points
        t = time.monotonic() - self.t0
        if p["Running"].value:
            wave = 3 * math.sin(t / 20)
            noise = self.rng.uniform(-0.3, 0.3)
            p["Temperature"].value = round(
                p["Setpoint"].value + 22 + wave + noise, 2)
            p["Pressure"].value = round(
                55 + self.rng.uniform(-0.4, 0.4), 2)
        else:
            p["Pressure"].value = 0.0
        return {n: pt.value for n, pt in p.items()}

    async def write(self, name, value):
        pt = self.points[name]
        if name == "Running" and value and not pt.value:
            self.points["Starts"].value += 1
        pt.value = value


class ModbusDevice:
    """Holding registers over Modbus TCP (FC3 read, FC6 write).

    regmap entries: (name, register, datatype, scale,
    writable, deadband). A scaled register is a Float.
    """

    def __init__(self, name, host, port=502, unit=1,
                 regmap=(), timeout=2.0):
        self.name, self.host, self.port = name, host, port
        self.unit, self.timeout = unit, timeout
        self.reg = {}
        self.points = {}
        for n, r, dt, scale, w, db in regmap:
            self.reg[n] = (r, scale)
            self.points[n] = Point(n, dt, None, w, db)
        self.tid = 0
        self.stream = None

    async def _rpc(self, pdu):
        if self.stream is None:
            self.stream = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port),
                self.timeout)
        r, w = self.stream
        self.tid = (self.tid + 1) % 65536
        mbap = struct.pack(">HHHB", self.tid, 0,
                           len(pdu) + 1, self.unit)
        w.write(mbap + pdu)
        try:
            head = await asyncio.wait_for(
                r.readexactly(7), self.timeout)
            n = struct.unpack(">H", head[4:6])[0] - 1
            reply = await r.readexactly(n)
        except Exception:
            w.close()
            self.stream = None
            raise
        if reply[0] & 0x80:
            raise IOError(f"Modbus exception {reply[1]}")
        return reply

    async def read(self):
        out = {}
        for name, (reg, scale) in self.reg.items():
            reply = await self._rpc(
                struct.pack(">BHH", 3, reg, 1))
            raw = struct.unpack(">h", reply[2:4])[0]
            pt = self.points[name]
            if pt.datatype == sp.BOOLEAN:
                pt.value = bool(raw)
            elif scale != 1:
                pt.value = round(raw * scale, 4)
            else:
                pt.value = raw
            out[name] = pt.value
        return out

    async def write(self, name, value):
        reg, scale = self.reg[name]
        raw = int(round(float(value) / scale))
        await self._rpc(struct.pack(">BHh", 6, reg, raw))
        self.points[name].value = value
