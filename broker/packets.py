"""Parse and build each MQTT 3.1.1 packet type."""
from .wire import (
    CONNECT, CONNACK, PUBLISH, PUBACK, PUBREC, PUBREL,
    PUBCOMP, SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK,
    PINGREQ, PINGRESP, DISCONNECT,
    Buf, ProtocolError, build_packet, mqtt_bin, mqtt_str,
    u16,
)

PROTOCOL_LEVEL = 4            # MQTT 3.1.1

# CONNACK return codes
ACCEPTED = 0
BAD_PROTOCOL = 1
BAD_CLIENT_ID = 2
UNAVAILABLE = 3
BAD_LOGIN = 4
NOT_AUTHORIZED = 5
SUB_FAILURE = 0x80


def parse_connect(body):
    b = Buf(body)
    name = b.str()
    if name not in ("MQTT", "MQIsdp"):
        raise ProtocolError(f"protocol name {name!r}")
    level, flags, keepalive = b.u8(), b.u8(), b.u16()
    if flags & 0x01:
        raise ProtocolError("reserved connect flag set")
    c = {"name": name, "level": level, "keepalive": keepalive,
         "clean": bool(flags & 0x02), "will": None,
         "username": None, "password": None}
    if level != PROTOCOL_LEVEL:
        return c                  # caller answers code 1
    c["client_id"] = b.str()
    wqos = (flags >> 3) & 3
    if flags & 0x04:
        if wqos == 3:
            raise ProtocolError("will QoS 3")
        c["will"] = {"topic": b.str(), "payload": b.bin(),
                     "qos": wqos, "retain": bool(flags & 0x20)}
    elif flags & 0x38:
        raise ProtocolError("will QoS/retain without will")
    if flags & 0x80:
        c["username"] = b.str()
    if flags & 0x40:
        if not flags & 0x80:
            raise ProtocolError("password without username")
        c["password"] = b.bin()
    if not b.done():
        raise ProtocolError("extra bytes after CONNECT")
    return c


def build_connect(client_id, keepalive, clean=True,
                  will=None, username=None, password=None):
    flags = 0x02 if clean else 0
    tail = mqtt_str(client_id)
    if will:
        flags |= 0x04 | (will["qos"] << 3)
        if will.get("retain"):
            flags |= 0x20
        tail += mqtt_str(will["topic"])
        tail += mqtt_bin(will["payload"])
    if username is not None:
        flags |= 0x80
        tail += mqtt_str(username)
    if password is not None:
        flags |= 0x40
        tail += mqtt_bin(password)
    head = mqtt_str("MQTT") + bytes([PROTOCOL_LEVEL, flags])
    body = head + u16(keepalive) + tail
    return build_packet(CONNECT, 0, body)


def build_connack(session_present, code):
    return build_packet(CONNACK, 0,
                        bytes([int(session_present), code]))


def parse_connack(body):
    if len(body) != 2:
        raise ProtocolError("CONNACK length")
    return bool(body[0] & 1), body[1]


def parse_publish(flags, body):
    b = Buf(body)
    qos = (flags >> 1) & 3
    m = {"topic": b.str(), "qos": qos,
         "retain": bool(flags & 1), "dup": bool(flags & 8),
         "pid": None}
    if qos:
        m["pid"] = b.u16()
        if m["pid"] == 0:
            raise ProtocolError("packet identifier 0")
    elif m["dup"]:
        raise ProtocolError("DUP set on QoS 0 PUBLISH")
    m["payload"] = b.rest()
    return m


def build_publish(topic, payload, qos=0, retain=False,
                  dup=False, pid=None):
    flags = (qos << 1) | int(retain) | (8 if dup else 0)
    body = mqtt_str(topic)
    if qos:
        body += u16(pid)
    return build_packet(PUBLISH, flags, body + payload)


def build_ack(ptype, pid):
    """PUBACK, PUBREC, PUBREL, PUBCOMP, or UNSUBACK."""
    flags = 0b0010 if ptype == PUBREL else 0
    return build_packet(ptype, flags, u16(pid))


def parse_pid(body):
    if len(body) != 2:
        raise ProtocolError("acknowledgement length")
    return int.from_bytes(body, "big")


def parse_subscribe(body):
    b = Buf(body)
    pid, pairs = b.u16(), []
    while not b.done():
        f, q = b.str(), b.u8()
        if q > 2:
            raise ProtocolError(f"requested QoS byte {q}")
        pairs.append((f, q))
    if not pairs:
        raise ProtocolError("SUBSCRIBE with no filters")
    return pid, pairs


def build_subscribe(pid, pairs):
    body = u16(pid)
    for f, q in pairs:
        body += mqtt_str(f) + bytes([q])
    return build_packet(SUBSCRIBE, 0b0010, body)


def build_suback(pid, codes):
    return build_packet(SUBACK, 0, u16(pid) + bytes(codes))


def parse_suback(body):
    b = Buf(body)
    return b.u16(), list(b.rest())


def parse_unsubscribe(body):
    b = Buf(body)
    pid, filters = b.u16(), []
    while not b.done():
        filters.append(b.str())
    if not filters:
        raise ProtocolError("UNSUBSCRIBE with no filters")
    return pid, filters


def build_unsubscribe(pid, filters):
    body = u16(pid) + b"".join(mqtt_str(f) for f in filters)
    return build_packet(UNSUBSCRIBE, 0b0010, body)


PINGREQ_PKT = build_packet(PINGREQ)
PINGRESP_PKT = build_packet(PINGRESP)
DISCONNECT_PKT = build_packet(DISCONNECT)
ACK_TYPES = (PUBACK, PUBREC, PUBREL, PUBCOMP, UNSUBACK)
