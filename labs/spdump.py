"""Print every Sparkplug B message, decoded, with its bytes.

Run: python -m labs.spdump --help
"""
import argparse
import asyncio

from edge.client import Client
from tap import sparkplug as sp


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="spdump", description="decode Sparkplug traffic")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1884)
    a.add_argument("--filter", default="spBv1.0/#")
    a.add_argument("--hex", type=int, default=32,
                   help="hex bytes to show, 0 for all")
    return a.parse_args(argv)


def hexdump(data, limit):
    shown = data if not limit else data[:limit]
    rows = [shown[i:i + 16].hex(" ")
            for i in range(0, len(shown), 16)]
    if limit and len(data) > limit:
        rows.append(f"... {len(data) - limit} more bytes")
    return rows


def describe(m):
    name = m.name if m.name is not None else f"alias {m.alias}"
    tname = sp.TYPE_NAMES.get(m.datatype, "?")
    val = "null" if m.is_null else repr(m.value)
    hist = " historical" if m.is_historical else ""
    return f"{name} ({tname}) = {val}{hist}"


def dump(topic, payload, limit):
    print(f"\n{topic}  ({len(payload)} bytes)")
    for row in hexdump(payload, limit):
        print(f"  {row}")
    if "/STATE/" in topic:
        print(f"  STATE {payload.decode(errors='replace')}")
        return
    try:
        p = sp.decode(payload)
    except sp.CodecError as e:
        print(f"  not a Sparkplug payload: {e}")
        return
    print(f"  seq={p.seq} timestamp={p.timestamp}")
    for m in p.metrics:
        print(f"  {describe(m)}")


async def main(argv=None):
    args = parse_args(argv)
    c = Client("lab-spdump", keepalive=30,
               on_message=lambda t, p: dump(t, p, args.hex))
    try:
        await c.connect(args.host, args.port)
    except ConnectionRefusedError:
        where = f"{args.host}:{args.port}"
        raise SystemExit(f"no broker on {where}; start one "
                         "with: python -m broker")
    await c.subscribe([(args.filter, 0)])
    print(f"watching {args.filter}", flush=True)
    await c.closed.wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
