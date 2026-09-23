import asyncio
import contextlib

from broker.faults import Faults
from edge.device import ModbusDevice, Point, SimDevice
from edge.node import EdgeNode, changed
from edge.__main__ import MODBUS_MAP
from host.host import Host
from labs.modbus_sim import serve
from tap import sparkplug as sp
from tap.sparkplug import Metric, Payload
from tap.tracker import REBIRTH, Tracker
from helpers import running_broker


def run(coro):
    asyncio.run(asyncio.wait_for(coro, 30))


async def until(pred, timeout=5):
    t = asyncio.get_running_loop().time() + timeout
    while not pred():
        if asyncio.get_running_loop().time() > t:
            raise AssertionError("condition never met")
        await asyncio.sleep(0.05)


def kinds(events):
    return [e.kind for e in events]


@contextlib.asynccontextmanager
async def system(tmp_path, primary=True, aliases=False,
                 faults=None, device=None, retry=0.3):
    kw = {"faults": faults} if faults else {}
    async with running_broker(**kw) as (b, port, tr):
        host = Host("SCADA1", port=port, trace=tr)
        ht = asyncio.create_task(host.run())
        await until(lambda: host.client is not None and
                    "SCADA1" in b.retained.__repr__())
        node = EdgeNode(
            "Lab", "Edge1", [device or SimDevice(seed=1)],
            port=port, keepalive=2, scan=0.1,
            primary_host="SCADA1" if primary else None,
            aliases=aliases, trace=tr, retry=retry,
            state_file=str(tmp_path / "bd.json"))
        nt = asyncio.create_task(node.run())
        try:
            yield b, host, node, tr
        finally:
            await node.stop()
            await host.stop()
            nt.cancel()
            ht.cancel()


def test_report_by_exception_deadband():
    pt = Point("T", sp.DOUBLE, deadband=0.5)
    assert changed(None, 1.0, pt)
    assert not changed(72.0, 72.4, pt)
    assert changed(72.0, 72.6, pt)
    assert changed(True, False, Point("R", sp.BOOLEAN))


def test_stale_death_ignored():
    t = Tracker()
    def pay(bd, seq=None, extra=()):
        ms = [Metric("bdSeq", None, 1, sp.INT64, bd)]
        ms += list(extra)
        return sp.encode(Payload(1, seq, ms))
    reb = Metric(REBIRTH, None, 1, sp.BOOLEAN, False)
    base = "spBv1.0/Lab/{}/Edge1"
    t.feed(base.format("NBIRTH"), pay(1, 0, [reb]))
    ev = t.feed(base.format("NDEATH"), pay(0))
    assert kinds(ev) == ["STALE"]
    ev = t.feed(base.format("NDEATH"), pay(1))
    assert kinds(ev) == ["DEATH"]


def test_full_session_write_rebirth_death(tmp_path):
    async def go():
        async with system(tmp_path) as (b, host, node, tr):
            ev = host.events
            await until(lambda: "DATA" in kinds(ev))
            bad = [e for e in b.tap.events
                   if e.kind in ("VIOLATION", "GAP")]
            assert not bad, bad
            await host.write("Lab", "Edge1", "PLC1",
                             "Setpoint", "60")
            dev = node.devices["PLC1"]
            await until(
                lambda: dev.points["Setpoint"].value == 60.0)
            n = host.tracker.nodes[("Lab", "Edge1")]
            await until(lambda: n.devices["PLC1"]
                        .metrics["Setpoint"][1] == 60.0)
            births = kinds(ev).count("BIRTH")
            await host.request_rebirth("Lab/Edge1")
            await until(
                lambda: kinds(ev).count("BIRTH") > births)
            node.retry = 30
            bd = node.bdseq
            node.client.abort()
            await until(lambda: "DEATH" in kinds(ev))
            death = [e for e in ev if e.kind == "DEATH"][0]
            assert f"bdSeq={bd}" in death.text
    run(go())


def test_host_offline_store_and_forward(tmp_path):
    async def go():
        async with system(tmp_path) as (b, host, node, tr):
            await until(lambda: "DATA" in kinds(host.events))
            bd = node.bdseq
            await host.stop()
            await until(lambda: "DEATH" in kinds(b.tap.events))
            await until(lambda: len(node.buffer) > 3)
            host2 = Host("SCADA1", port=host.port, trace=tr)
            t = asyncio.create_task(host2.run())
            await until(lambda: any(
                "(hist)" in e.text for e in host2.events))
            assert node.bdseq == bd + 1
            await host2.stop()
            t.cancel()
    run(go())


def test_gap_triggers_rebirth(tmp_path):
    async def go():
        f = Faults(drop_every=4,
                   drop_filter="spBv1.0/+/DDATA/#")
        async with system(tmp_path, faults=f) as \
                (b, host, node, tr):
            await until(lambda: "GAP" in kinds(host.events))
            await until(
                lambda: kinds(host.events).count("BIRTH") >= 2)
            assert any(e.kind == "CMD" and "NCMD" in e.text
                       for e in b.tap.events)
    run(go())


def test_aliases_resolve(tmp_path):
    async def go():
        async with system(tmp_path, aliases=True) as \
                (b, host, node, tr):
            await until(lambda: any(
                e.kind == "DATA" and "Temperature" in e.text
                for e in host.events))
            bad = [e for e in b.tap.events
                   if e.kind in ("VIOLATION", "GAP")]
            assert not bad, bad
    run(go())


def test_modbus_device(tmp_path):
    async def go():
        sim, server = await serve("127.0.0.1", 0)
        mport = server.sockets[0].getsockname()[1]
        dev = ModbusDevice("PLC1", "127.0.0.1", mport,
                           regmap=MODBUS_MAP)
        async with system(tmp_path, device=dev) as \
                (b, host, node, tr):
            await until(lambda: "DBIRTH" in kinds(host.events))
            await host.write("Lab", "Edge1", "PLC1",
                             "Setpoint", "61.5")
            await until(lambda: sim.regs[3] == 615)
        server.close()
    run(go())
