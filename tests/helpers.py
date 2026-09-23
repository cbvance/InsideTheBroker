import asyncio
import contextlib

from broker.broker import Broker
from broker.faults import Faults
from broker.trace import Trace
from edge.client import Client
from tap.tap import SparkplugTap


@contextlib.asynccontextmanager
async def running_broker(**kw):
    trace = Trace(echo=False)
    tap = SparkplugTap(trace)
    faults = kw.pop("faults", Faults())
    b = Broker(trace, tap=tap, faults=faults, **kw)
    port = await b.start("127.0.0.1", 0)
    try:
        yield b, port, trace
    finally:
        await b.stop()


async def client(port, cid, inbox=None, **kw):
    box = inbox if inbox is not None else []
    c = Client(cid, on_message=lambda t, p: box.append((t, p)),
               **kw)
    await c.connect("127.0.0.1", port)
    c.inbox = box
    return c


async def settle(t=0.15):
    await asyncio.sleep(t)


def has(trace, *words):
    return any(all(w in ln for w in words)
               for ln in trace.lines)
