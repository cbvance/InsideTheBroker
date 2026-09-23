"""Sparkplug B session state, as a host application sees it.

The tracker reads Sparkplug messages and reports what a
host must notice: births, deaths, stale deaths, sequence
gaps, data before birth, and metrics never born. The tap
logs these; the host application acts on them.
"""
import json
from dataclasses import dataclass

from . import sparkplug as sp

REBIRTH = "Node Control/Rebirth"


@dataclass
class Event:
    kind: str          # BIRTH, DEATH, DATA, GAP, ...
    key: str           # "group/node" or "group/node/device"
    text: str
    rebirth: bool = False   # a host should request rebirth


class Device:
    def __init__(self):
        self.online = False
        self.metrics = {}     # name -> [datatype, value]
        self.aliases = {}     # alias -> name

    def born(self, metrics):
        self.online = True
        self.metrics, self.aliases = {}, {}
        for m in metrics:
            self.metrics[m.name] = [m.datatype, m.value]
            if m.alias is not None:
                self.aliases[m.alias] = m.name

    def resolve(self, m):
        name = m.name
        if name is None and m.alias is not None:
            name = self.aliases.get(m.alias)
        return name


class Node(Device):
    def __init__(self):
        super().__init__()
        self.seq = None
        self.bdseq = None
        self.devices = {}     # device id -> Device


def bdseq_of(p):
    for m in p.metrics:
        if m.name == "bdSeq":
            return m.value
    return None


class Tracker:
    def __init__(self):
        self.nodes = {}       # (group, node) -> Node
        self.hosts = {}       # host id -> STATE dict

    def feed(self, topic, payload):
        parts = topic.split("/")
        if parts[0] != sp.NAMESPACE:
            return []
        if len(parts) == 3 and parts[1] == "STATE":
            return self._state(parts[2], payload)
        if len(parts) not in (4, 5):
            return [Event("VIOLATION", topic,
                          "malformed Sparkplug topic")]
        group, mtype, node = parts[1], parts[2], parts[3]
        dev = parts[4] if len(parts) == 5 else None
        key = f"{group}/{node}"
        if (mtype in sp.NODE_TYPES) == (dev is not None) \
                or mtype not in sp.NODE_TYPES + \
                sp.DEVICE_TYPES:
            return [Event("VIOLATION", topic,
                          f"bad message type {mtype}")]
        try:
            p = sp.decode(payload)
        except sp.CodecError as e:
            return [Event("VIOLATION", key,
                          f"{mtype} payload undecodable: {e}")]
        n = self.nodes.setdefault((group, node), Node())
        if mtype == "NBIRTH":
            return self._nbirth(n, key, p)
        if mtype == "NDEATH":
            return self._ndeath(n, key, p)
        if mtype in ("NCMD", "DCMD"):
            names = ", ".join(str(m.name or m.alias)
                              for m in p.metrics)
            where = f"{key}/{dev}" if dev else key
            return [Event("CMD", where, f"{mtype} [{names}]")]
        return self._after_birth(n, key, mtype, dev, p)

    def _state(self, host, payload):
        try:
            s = json.loads(payload)
            online = bool(s["online"])
        except (ValueError, KeyError, TypeError):
            return [Event("VIOLATION", host,
                          "STATE payload is not valid JSON")]
        self.hosts[host] = s
        word = "online" if online else "offline"
        return [Event("STATE", host, f"host {word}")]

    def _nbirth(self, n, key, p):
        ev = []
        n.born(p.metrics)
        n.seq, n.bdseq = p.seq, bdseq_of(p)
        n.devices = {}
        if p.seq != 0:
            ev.append(Event("VIOLATION", key,
                            f"NBIRTH seq={p.seq}, expected 0"))
        if n.bdseq is None:
            ev.append(Event("VIOLATION", key,
                            "NBIRTH has no bdSeq metric"))
        if REBIRTH not in n.metrics:
            ev.append(Event("VIOLATION", key,
                            f"NBIRTH lacks {REBIRTH}"))
        for m in p.metrics:
            if m.name is None or m.datatype is None:
                ev.append(Event("VIOLATION", key,
                                "birth metric lacks name/type"))
        ev.insert(0, Event("BIRTH", key,
                           f"bdSeq={n.bdseq} "
                           f"metrics={len(p.metrics)}"))
        return ev

    def _ndeath(self, n, key, p):
        bd = bdseq_of(p)
        if n.online and bd == n.bdseq:
            n.online = False
            for d in n.devices.values():
                d.online = False
            return [Event("DEATH", key,
                          f"bdSeq={bd} matches birth")]
        return [Event("STALE", key,
                      f"NDEATH bdSeq={bd} != birth "
                      f"{n.bdseq}; ignored")]

    def _after_birth(self, n, key, mtype, dev, p):
        where = f"{key}/{dev}" if dev else key
        if not n.online:
            return [Event("NO_BIRTH", where,
                          f"{mtype} before NBIRTH", True)]
        ev = []
        expect = (n.seq + 1) % 256
        if p.seq != expect:
            ev.append(Event("GAP", where,
                            f"{mtype} seq={p.seq}, "
                            f"expected {expect}", True))
        n.seq = p.seq
        if mtype == "DBIRTH":
            d = n.devices.setdefault(dev, Device())
            d.born(p.metrics)
            ev.append(Event("DBIRTH", where,
                            f"metrics={len(p.metrics)}"))
            return ev
        target = n if dev is None else n.devices.get(dev)
        if target is None or not target.online:
            ev.append(Event("NO_BIRTH", where,
                            f"{mtype} before DBIRTH", True))
            return ev
        if mtype == "DDEATH":
            target.online = False
            ev.append(Event("DDEATH", where, "device offline"))
            return ev
        changed = []
        for m in p.metrics:
            name = target.resolve(m)
            if name not in target.metrics:
                ev.append(Event("VIOLATION", where,
                                f"metric {m.name or m.alias}"
                                " never born", True))
                continue
            born_type = target.metrics[name][0]
            if m.datatype not in (None, born_type):
                ev.append(Event("VIOLATION", where,
                                f"{name} type changed"))
            target.metrics[name][1] = m.value
            hist = " (hist)" if m.is_historical else ""
            v = m.value
            if isinstance(v, float):
                v = f"{v:.7g}"
            changed.append(f"{name}={v}{hist}")
        ev.append(Event("DATA", where, " ".join(changed)))
        return ev
