import asyncio

import pytest

from broker import packets as P
from broker.wire import read_packet
from helpers import client, has, running_broker, settle


def run(coro):
    asyncio.run(asyncio.wait_for(coro, 20))


def test_publish_subscribe_qos0():
    async def go():
        async with running_broker() as (b, port, tr):
            sub = await client(port, "sub")
            await sub.subscribe([("lab/#", 0)])
            pub = await client(port, "pub")
            await pub.publish("lab/temp", b"72.4")
            await settle()
            assert sub.inbox == [("lab/temp", b"72.4")]
    run(go())


def test_retained_delivered_and_cleared():
    async def go():
        async with running_broker() as (b, port, tr):
            pub = await client(port, "pub")
            await pub.publish("lab/sp", b"50", retain=True)
            await settle()
            s1 = await client(port, "s1")
            await s1.subscribe([("lab/#", 0)])
            await settle()
            assert s1.inbox == [("lab/sp", b"50")]
            assert has(tr, "OUT", "s1", "PUBLISH", "r=1")
            await pub.publish("lab/sp", b"", retain=True)
            await settle()
            s2 = await client(port, "s2")
            await s2.subscribe([("lab/#", 0)])
            await settle()
            assert s2.inbox == []
    run(go())


def test_will_fires_on_abort_not_on_disconnect():
    async def go():
        async with running_broker() as (b, port, tr):
            watch = await client(port, "watch")
            await watch.subscribe([("lab/death/#", 0)])
            will = {"topic": "lab/death/a", "payload": b"x",
                    "qos": 0, "retain": False}
            a = await client(port, "a", will=will)
            await a.disconnect()
            await settle()
            assert watch.inbox == []
            will["topic"] = "lab/death/b"
            c = await client(port, "b", will=will)
            c.abort()
            await settle()
            assert watch.inbox == [("lab/death/b", b"x")]
            assert has(tr, "b", "ENDED", "socket closed")
    run(go())


def test_keepalive_expiry_fires_will():
    async def go():
        async with running_broker() as (b, port, tr):
            watch = await client(port, "watch")
            await watch.subscribe([("lab/#", 0)])
            r, w = await asyncio.open_connection(
                "127.0.0.1", port)
            will = {"topic": "lab/dead", "payload": b"",
                    "qos": 0, "retain": False}
            w.write(P.build_connect("silent", 1, will=will))
            await read_packet(r)           # CONNACK
            t0 = asyncio.get_running_loop().time()
            while not watch.inbox:
                await asyncio.sleep(0.05)
            waited = asyncio.get_running_loop().time() - t0
            assert 1.3 < waited < 2.5      # 1.5 x keepalive
            assert has(tr, "silent", "keepalive expired")
            w.close()
    run(go())


def test_qos1_and_qos2_exactly_once():
    async def go():
        async with running_broker() as (b, port, tr):
            sub = await client(port, "sub")
            await sub.subscribe([("q/#", 2)])
            pub = await client(port, "pub")
            await pub.publish("q/1", b"one", qos=1)
            await pub.publish("q/2", b"two", qos=2)
            await settle()
            assert sub.inbox == [("q/1", b"one"),
                                 ("q/2", b"two")]
            assert has(tr, "OUT", "sub", "PUBREL")
            assert not b.sessions["sub"].inflight
    run(go())


def test_qos2_duplicate_not_rerouted():
    async def go():
        async with running_broker() as (b, port, tr):
            sub = await client(port, "sub")
            await sub.subscribe([("d/#", 0)])
            r, w = await asyncio.open_connection(
                "127.0.0.1", port)
            w.write(P.build_connect("raw", 30))
            await read_packet(r)
            pkt = P.build_publish("d/x", b"1", 2, pid=9)
            dup = P.build_publish("d/x", b"1", 2, dup=True,
                                  pid=9)
            w.write(pkt)
            w.write(dup)
            await settle()
            assert sub.inbox == [("d/x", b"1")]
            assert has(tr, "DUPLICATE", "id 9")
            w.close()
    run(go())


def test_persistent_session_queues_qos1():
    async def go():
        async with running_broker() as (b, port, tr):
            s = await client(port, "p", clean=False)
            await s.subscribe([("q/#", 1)])
            await s.disconnect()
            pub = await client(port, "pub")
            for i in range(3):
                await pub.publish("q/n", str(i).encode(), 1)
            await pub.publish("q/n", b"qos0", 0)
            box = []
            s2 = await client(port, "p", box, clean=False)
            await settle()
            assert s2.session_present
            assert [p for _, p in box] == [b"0", b"1", b"2"]
    run(go())


def test_takeover_ends_first_connection():
    async def go():
        async with running_broker() as (b, port, tr):
            first = await client(port, "dup")
            second = await client(port, "dup")
            await settle()
            assert first.closed.is_set()
            assert not second.closed.is_set()
            assert has(tr, "dup", "TAKEOVER")
    run(go())


@pytest.mark.parametrize("pkt,why", [
    (P.build_publish("x", b""), "first packet not CONNECT"),
    (P.build_connect("a", 5) + P.build_connect("a", 5),
     "second CONNECT"),
    (P.build_connect("w", 5) + P.build_publish("a/+", b""),
     "wildcard in topic"),
])
def test_protocol_violations(pkt, why):
    async def go():
        async with running_broker() as (b, port, tr):
            r, w = await asyncio.open_connection(
                "127.0.0.1", port)
            w.write(pkt)
            await asyncio.wait_for(r.read(), 3)   # closed
            assert has(tr, "protocol violation", why)
    run(go())


def test_wrong_protocol_level_refused():
    async def go():
        async with running_broker() as (b, port, tr):
            r, w = await asyncio.open_connection(
                "127.0.0.1", port)
            pkt = bytearray(P.build_connect("old", 5))
            pkt[8] = 3                     # level byte
            w.write(bytes(pkt))
            t, f, body = await read_packet(r)
            assert P.parse_connack(body) == (False, 1)
    run(go())


def test_paho_interop():
    mqtt = pytest.importorskip("paho.mqtt.client")

    async def go():
        async with running_broker() as (b, port, tr):
            got = []
            c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                            client_id="paho")
            c.on_message = lambda cl, u, m: got.append(
                (m.topic, m.payload))
            c.connect("127.0.0.1", port, 10)
            c.loop_start()
            await asyncio.sleep(0.3)
            c.subscribe("lab/#", 1)
            await asyncio.sleep(0.3)
            pub = await client(port, "ours")
            await pub.publish("lab/x", b"hello", 1)
            await asyncio.sleep(0.5)
            c.loop_stop()
            c.disconnect()
            assert got == [("lab/x", b"hello")]
    run(go())
