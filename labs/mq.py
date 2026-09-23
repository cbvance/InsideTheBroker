"""A tiny publish and subscribe client for the labs.

Built on the study edge node's MQTT client, so it needs no
Mosquitto install. Run: python -m labs.mq --help
"""
import argparse
import asyncio

from edge.client import Client


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="mq", description="publish or subscribe")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1884)
    a.add_argument("--id", default=None)
    sub = a.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("sub", help="subscribe and print")
    s.add_argument("filters", nargs="+")
    s.add_argument("--qos", type=int, default=0,
                   choices=(0, 1, 2))
    p = sub.add_parser("pub", help="publish one message")
    p.add_argument("topic")
    p.add_argument("message")
    p.add_argument("--qos", type=int, default=0,
                   choices=(0, 1, 2))
    p.add_argument("--retain", action="store_true")
    return a.parse_args(argv)


def show(topic, payload):
    try:
        text = payload.decode("utf-8")
    except UnicodeDecodeError:
        text = f"<{len(payload)} bytes binary>"
    print(f"{topic}  {text}", flush=True)


async def main(argv=None):
    args = parse_args(argv)
    cid = args.id or f"lab-{args.cmd}"
    c = Client(cid, keepalive=30, on_message=show)
    try:
        await c.connect(args.host, args.port)
    except ConnectionRefusedError:
        where = f"{args.host}:{args.port}"
        raise SystemExit(f"no broker on {where}; start one "
                         "with: python -m broker")
    if args.cmd == "sub":
        pairs = [(f, args.qos) for f in args.filters]
        granted = await c.subscribe(pairs)
        for (f, _), g in zip(pairs, granted):
            got = "rejected" if g == 0x80 else f"QoS {g}"
            print(f"subscribed {f}: {got}", flush=True)
        await c.closed.wait()
    else:
        await c.publish(args.topic, args.message.encode(),
                        args.qos, args.retain)
        await c.disconnect()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
