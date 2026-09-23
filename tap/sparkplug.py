"""Sparkplug B payload codec, hand-built from protobuf rules.

Encodes and decodes the Payload and Metric messages of
sparkplug_b.proto without the protobuf library, so every
byte can be read. DataSet, Template, metadata, and
properties are skipped on decode and never encoded.
"""
import struct
from dataclasses import dataclass, field

# Metric datatypes (Sparkplug B)
INT8, INT16, INT32, INT64 = 1, 2, 3, 4
UINT8, UINT16, UINT32, UINT64 = 5, 6, 7, 8
FLOAT, DOUBLE, BOOLEAN, STRING = 9, 10, 11, 12
DATETIME, TEXT, UUID, DATASET = 13, 14, 15, 16
BYTES, FILE, TEMPLATE = 17, 18, 19

TYPE_NAMES = {
    1: "Int8", 2: "Int16", 3: "Int32", 4: "Int64",
    5: "UInt8", 6: "UInt16", 7: "UInt32", 8: "UInt64",
    9: "Float", 10: "Double", 11: "Boolean", 12: "String",
    13: "DateTime", 14: "Text", 15: "UUID", 16: "DataSet",
    17: "Bytes", 18: "File", 19: "Template",
}

SIGNED_BITS = {INT8: 8, INT16: 16, INT32: 32, INT64: 64}
INT_FIELD = {INT8, INT16, INT32, UINT8, UINT16, UINT32}
LONG_FIELD = {INT64, UINT64, DATETIME}
STR_FIELD = {STRING, TEXT, UUID}
BYTES_FIELD = {BYTES, FILE}

# protobuf wire types
VARINT, I64, LEN, I32 = 0, 1, 2, 5


class CodecError(Exception):
    """A payload is not a valid Sparkplug B protobuf."""


@dataclass
class Metric:
    name: str = None
    alias: int = None
    timestamp: int = None
    datatype: int = None
    value: object = None
    is_null: bool = False
    is_historical: bool = False
    is_transient: bool = False


@dataclass
class Payload:
    timestamp: int = None
    seq: int = None
    metrics: list = field(default_factory=list)
    uuid: str = None
    body: bytes = None


# ---- protobuf primitives -----------------------------------

def put_varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def get_varint(data, i):
    shift = value = 0
    while True:
        if i >= len(data):
            raise CodecError("varint truncated")
        b = data[i]
        i += 1
        value |= (b & 0x7F) << shift
        if not b & 0x80:
            return value, i
        shift += 7
        if shift > 63:
            raise CodecError("varint too long")


def tag(num, wire):
    return put_varint(num << 3 | wire)


def fields(data):
    """Yield (field number, wire type, raw value)."""
    i = 0
    while i < len(data):
        key, i = get_varint(data, i)
        num, wire = key >> 3, key & 7
        if wire == VARINT:
            v, i = get_varint(data, i)
        elif wire == I64:
            v, i = data[i:i + 8], i + 8
        elif wire == I32:
            v, i = data[i:i + 4], i + 4
        elif wire == LEN:
            n, i = get_varint(data, i)
            v, i = data[i:i + n], i + n
        else:
            raise CodecError(f"wire type {wire}")
        if i > len(data):
            raise CodecError("field truncated")
        yield num, wire, v


# ---- signed values in unsigned fields ----------------------

def to_unsigned(value, dtype):
    bits = SIGNED_BITS.get(dtype)
    if bits and value < 0:
        return value + (1 << bits)
    return value


def to_signed(raw, dtype):
    bits = SIGNED_BITS.get(dtype)
    if not bits:
        return raw
    if raw >= 1 << 31 and bits < 32:
        raw -= 1 << 32          # 32-bit two's complement form
    elif raw >= 1 << (bits - 1):
        raw -= 1 << bits
    return raw


# ---- encode ------------------------------------------------

def encode_metric(m):
    out = bytearray()
    if m.name is not None:
        out += tag(1, LEN) + _len(m.name.encode("utf-8"))
    if m.alias is not None:
        out += tag(2, VARINT) + put_varint(m.alias)
    if m.timestamp is not None:
        out += tag(3, VARINT) + put_varint(m.timestamp)
    if m.datatype is not None:
        out += tag(4, VARINT) + put_varint(m.datatype)
    for num, flag in ((5, m.is_historical),
                      (6, m.is_transient), (7, m.is_null)):
        if flag:
            out += tag(num, VARINT) + b"\x01"
    if not m.is_null and m.value is not None:
        out += _value(m.datatype, m.value)
    return bytes(out)


def _len(b):
    return put_varint(len(b)) + b


def _value(dt, v):
    if dt in INT_FIELD:
        return tag(10, VARINT) + put_varint(to_unsigned(v, dt))
    if dt in LONG_FIELD:
        return tag(11, VARINT) + put_varint(to_unsigned(v, dt))
    if dt == FLOAT:
        return tag(12, I32) + struct.pack("<f", v)
    if dt == DOUBLE:
        return tag(13, I64) + struct.pack("<d", v)
    if dt == BOOLEAN:
        return tag(14, VARINT) + (b"\x01" if v else b"\x00")
    if dt in STR_FIELD:
        return tag(15, LEN) + _len(str(v).encode("utf-8"))
    if dt in BYTES_FIELD:
        return tag(16, LEN) + _len(bytes(v))
    raise CodecError(f"cannot encode datatype {dt}")


def encode(p):
    out = bytearray()
    if p.timestamp is not None:
        out += tag(1, VARINT) + put_varint(p.timestamp)
    for m in p.metrics:
        out += tag(2, LEN) + _len(encode_metric(m))
    if p.seq is not None:
        out += tag(3, VARINT) + put_varint(p.seq)
    if p.uuid is not None:
        out += tag(4, LEN) + _len(p.uuid.encode("utf-8"))
    if p.body is not None:
        out += tag(5, LEN) + _len(p.body)
    return bytes(out)


# ---- decode ------------------------------------------------

def decode_metric(data):
    m, raw = Metric(), {}
    for num, wire, v in fields(data):
        if num == 1:
            m.name = bytes(v).decode("utf-8")
        elif num == 2:
            m.alias = v
        elif num == 3:
            m.timestamp = v
        elif num == 4:
            m.datatype = v
        elif num == 5:
            m.is_historical = bool(v)
        elif num == 6:
            m.is_transient = bool(v)
        elif num == 7:
            m.is_null = bool(v)
        elif 10 <= num <= 16:
            raw[num] = v
    for num, v in raw.items():
        if num in (10, 11):
            m.value = to_signed(v, m.datatype)
        elif num == 12:
            m.value = struct.unpack("<f", v)[0]
        elif num == 13:
            m.value = struct.unpack("<d", v)[0]
        elif num == 14:
            m.value = bool(v)
        elif num == 15:
            m.value = bytes(v).decode("utf-8")
        elif num == 16:
            m.value = bytes(v)
    return m


def decode(data):
    p = Payload()
    try:
        for num, wire, v in fields(data):
            if num == 1:
                p.timestamp = v
            elif num == 2:
                p.metrics.append(decode_metric(v))
            elif num == 3:
                p.seq = v
            elif num == 4:
                p.uuid = bytes(v).decode("utf-8")
            elif num == 5:
                p.body = bytes(v)
    except (CodecError, UnicodeDecodeError,
            struct.error, TypeError) as e:
        raise CodecError(str(e)) from None
    return p


# ---- topics ------------------------------------------------

NAMESPACE = "spBv1.0"
NODE_TYPES = ("NBIRTH", "NDEATH", "NDATA", "NCMD")
DEVICE_TYPES = ("DBIRTH", "DDEATH", "DDATA", "DCMD")


def topic(group, mtype, node, device=None):
    t = f"{NAMESPACE}/{group}/{mtype}/{node}"
    return f"{t}/{device}" if device else t


def state_topic(host_id):
    return f"{NAMESPACE}/STATE/{host_id}"
