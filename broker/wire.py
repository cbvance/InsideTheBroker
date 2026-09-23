"""MQTT 3.1.1 wire format: packet framing and field types.

Every MQTT packet is one fixed-header byte (type and flags),
a Remaining Length varint, and exactly that many body bytes.
The broker and the edge node client both use this module.
"""

CONNECT, CONNACK, PUBLISH, PUBACK = 1, 2, 3, 4
PUBREC, PUBREL, PUBCOMP = 5, 6, 7
SUBSCRIBE, SUBACK = 8, 9
UNSUBSCRIBE, UNSUBACK = 10, 11
PINGREQ, PINGRESP, DISCONNECT = 12, 13, 14

NAMES = {
    1: "CONNECT", 2: "CONNACK", 3: "PUBLISH", 4: "PUBACK",
    5: "PUBREC", 6: "PUBREL", 7: "PUBCOMP", 8: "SUBSCRIBE",
    9: "SUBACK", 10: "UNSUBSCRIBE", 11: "UNSUBACK",
    12: "PINGREQ", 13: "PINGRESP", 14: "DISCONNECT",
}

# Fixed flags each packet type must carry. PUBLISH is the
# only type whose flags carry meaning; it is checked apart.
FLAGS = {PUBREL: 0b0010, SUBSCRIBE: 0b0010,
         UNSUBSCRIBE: 0b0010}

MAX_LENGTH = 268_435_455      # four varint bytes, all 7 bits


class ProtocolError(Exception):
    """A peer broke a rule of the MQTT specification."""


def encode_varint(n):
    """Encode a Remaining Length, 7 bits per byte, LSB first."""
    if not 0 <= n <= MAX_LENGTH:
        raise ValueError(f"length {n} out of range")
    out = bytearray()
    while True:
        byte = n % 128
        n //= 128
        if n:
            byte |= 0x80           # continuation bit
        out.append(byte)
        if not n:
            return bytes(out)


def decode_varint(data, pos=0):
    """Decode a Remaining Length from bytes.

    Returns (value, bytes_used).
    """
    value, mult = 0, 1
    for i in range(4):
        if pos + i >= len(data):
            raise ProtocolError("Remaining Length truncated")
        b = data[pos + i]
        value += (b & 0x7F) * mult
        if not b & 0x80:
            return value, i + 1
        mult *= 128
    raise ProtocolError("Remaining Length exceeds 4 bytes")


async def read_varint(reader):
    value, mult = 0, 1
    for _ in range(4):
        b = (await reader.readexactly(1))[0]
        value += (b & 0x7F) * mult
        if not b & 0x80:
            return value
        mult *= 128
    raise ProtocolError("Remaining Length exceeds 4 bytes")


def check_flags(ptype, flags):
    if ptype not in NAMES:
        raise ProtocolError(f"reserved packet type {ptype}")
    if ptype == PUBLISH:
        if (flags >> 1) & 3 == 3:
            raise ProtocolError("PUBLISH with QoS 3")
    elif flags != FLAGS.get(ptype, 0):
        name = NAMES[ptype]
        raise ProtocolError(f"{name} flags {flags:04b}")


async def read_packet(reader):
    """Read one packet. Returns (type, flags, body)."""
    b0 = (await reader.readexactly(1))[0]
    ptype, flags = b0 >> 4, b0 & 0x0F
    check_flags(ptype, flags)
    length = await read_varint(reader)
    body = await reader.readexactly(length)
    return ptype, flags, body


def build_packet(ptype, flags=0, body=b""):
    head = bytes([(ptype << 4) | flags])
    return head + encode_varint(len(body)) + body


def split_packet(pkt):
    """Split built packet bytes into (type, flags, body)."""
    length, used = decode_varint(pkt, 1)
    body = pkt[1 + used:1 + used + length]
    return pkt[0] >> 4, pkt[0] & 0x0F, body


def u16(n):
    return n.to_bytes(2, "big")


def mqtt_bin(b):
    if len(b) > 0xFFFF:
        raise ValueError("field longer than 65535 bytes")
    return u16(len(b)) + b


def mqtt_str(s):
    return mqtt_bin(s.encode("utf-8"))


class Buf:
    """Bounds-checked reader over one packet body."""

    def __init__(self, data):
        self.d, self.i = data, 0

    def take(self, n):
        if self.i + n > len(self.d):
            raise ProtocolError("field runs past end of packet")
        v = self.d[self.i:self.i + n]
        self.i += n
        return v

    def u8(self):
        return self.take(1)[0]

    def u16(self):
        return int.from_bytes(self.take(2), "big")

    def bin(self):
        return self.take(self.u16())

    def str(self):
        raw = self.bin()
        try:
            s = raw.decode("utf-8")
        except UnicodeDecodeError:
            raise ProtocolError("string is not UTF-8") from None
        if "\x00" in s:
            raise ProtocolError("string contains U+0000")
        return s

    def rest(self):
        return self.take(len(self.d) - self.i)

    def done(self):
        return self.i >= len(self.d)
