"""The packet trace: every packet, decoded, one line each."""
import sys
import time

from . import packets as P
from .wire import NAMES, split_packet


def describe(ptype, flags, body):
    """Human-readable summary of one packet's fields."""
    try:
        return _describe(ptype, flags, body)
    except Exception as e:           # trace must never crash
        return f"(unparsed: {e})"


def _describe(t, flags, body):
    if t == P.CONNECT:
        c = P.parse_connect(body)
        if c["level"] != P.PROTOCOL_LEVEL:
            return f"level={c['level']} (unsupported)"
        s = (f"id={c['client_id']} level={c['level']} "
             f"clean={int(c['clean'])} ka={c['keepalive']}")
        w = c["will"]
        if w:
            s += (f" will={w['topic']} wq={w['qos']}"
                  f" wr={int(w['retain'])}")
        if c["username"] is not None:
            s += f" user={c['username']}"
        return s
    if t == P.CONNACK:
        sp, rc = P.parse_connack(body)
        return f"sp={int(sp)} rc={rc}"
    if t == P.PUBLISH:
        m = P.parse_publish(flags, body)
        pid = f" id={m['pid']}" if m["pid"] else ""
        return (f"q={m['qos']} r={int(m['retain'])} "
                f"d={int(m['dup'])}{pid} {m['topic']} "
                f"({len(m['payload'])} B)")
    if t in P.ACK_TYPES:
        return f"id={P.parse_pid(body)}"
    if t == P.SUBSCRIBE:
        pid, pairs = P.parse_subscribe(body)
        fs = " ".join(f"{f}@q{q}" for f, q in pairs)
        return f"id={pid} {fs}"
    if t == P.SUBACK:
        pid, codes = P.parse_suback(body)
        cs = ",".join(hex(c) if c > 2 else str(c)
                      for c in codes)
        return f"id={pid} granted={cs}"
    if t == P.UNSUBSCRIBE:
        pid, fs = P.parse_unsubscribe(body)
        return f"id={pid} {' '.join(fs)}"
    return ""


class Trace:
    """Writes decoded packet and event lines."""

    def __init__(self, path=None, echo=True):
        self.echo = echo
        self.file = open(path, "a", encoding="utf-8") \
            if path else None
        self.lines = []           # kept for tests and labs

    def emit(self, tag, who, what, detail=""):
        now = time.time()
        stamp = time.strftime("%H:%M:%S", time.localtime(now))
        ms = int(now * 1000) % 1000
        line = (f"{stamp}.{ms:03d}  {tag:<4} {who:<16} "
                f"{what:<11} {detail}").rstrip()
        self.lines.append(line)
        if self.echo:
            print(line, file=sys.stdout, flush=True)
        if self.file:
            self.file.write(line + "\n")
            self.file.flush()

    def packet(self, direction, who, ptype, flags, body):
        name = NAMES.get(ptype, f"TYPE{ptype}")
        self.emit(direction, who, name,
                  describe(ptype, flags, body))

    def out(self, who, pkt):
        self.packet("OUT", who, *split_packet(pkt))

    def event(self, who, what, detail=""):
        self.emit("--", who, what, detail)

    def close(self):
        if self.file:
            self.file.close()
