import asyncio

import pytest

from broker import packets as P
from broker.wire import (ProtocolError, decode_varint,
                         encode_varint, read_packet,
                         split_packet)

EDGES = [0, 127, 128, 16383, 16384, 2097151, 2097152,
         268435455]


@pytest.mark.parametrize("n", EDGES)
def test_varint_round_trip(n):
    enc = encode_varint(n)
    assert decode_varint(enc) == (n, len(enc))


def test_varint_sizes():
    sizes = [len(encode_varint(n)) for n in EDGES]
    assert sizes == [1, 1, 2, 2, 3, 3, 4, 4]


def test_varint_fifth_byte_rejected():
    with pytest.raises(ProtocolError):
        decode_varint(b"\xff\xff\xff\xff\x01")


def read(data):
    async def go():
        r = asyncio.StreamReader()
        r.feed_data(data)
        r.feed_eof()
        return await read_packet(r)
    return asyncio.run(go())


def test_connect_round_trip():
    will = {"topic": "a/death", "payload": b"\x00\x01",
            "qos": 1, "retain": True}
    pkt = P.build_connect("c1", 30, False, will, "u", b"pw")
    t, flags, body = split_packet(pkt)
    c = P.parse_connect(body)
    assert (c["client_id"], c["keepalive"]) == ("c1", 30)
    assert c["clean"] is False and c["will"] == will
    assert (c["username"], c["password"]) == ("u", b"pw")


def test_reserved_connect_flag():
    pkt = bytearray(P.build_connect("c1", 30))
    pkt[9] |= 0x01               # connect flags byte
    with pytest.raises(ProtocolError):
        P.parse_connect(split_packet(bytes(pkt))[2])


def test_publish_round_trip():
    pkt = P.build_publish("x/y", b"hi", 2, True, True, 7)
    t, flags, body = read(pkt)
    m = P.parse_publish(flags, body)
    assert m == {"topic": "x/y", "qos": 2, "retain": True,
                 "dup": True, "pid": 7, "payload": b"hi"}


def test_bad_subscribe_flags():
    pkt = bytearray(P.build_subscribe(1, [("a", 0)]))
    pkt[0] = (8 << 4)            # flags 0000, must be 0010
    with pytest.raises(ProtocolError):
        read(bytes(pkt))


def test_publish_qos3_rejected():
    with pytest.raises(ProtocolError):
        read(b"\x36\x00")
