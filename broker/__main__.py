"""Run the study broker: python -m broker --help"""
import argparse
import asyncio

from .broker import Broker
from .faults import Faults
from .trace import Trace


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="broker", description="MQTT 3.1.1 study broker")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1884)
    a.add_argument("--trace", help="also write trace to file")
    a.add_argument("--quiet", action="store_true",
                   help="do not echo the trace to console")
    a.add_argument("--no-tap", action="store_true",
                   help="disable the Sparkplug tap")
    a.add_argument("--no-will-on-takeover",
                   action="store_true",
                   help="treat takeover as graceful")
    a.add_argument("--drop-every", type=int, default=0,
                   help="drop every Nth matching PUBLISH")
    a.add_argument("--drop-filter", default="spBv1.0/#",
                   help="topic filter for --drop-every")
    return a.parse_args(argv)


async def main(argv=None):
    args = parse_args(argv)
    trace = Trace(args.trace, echo=not args.quiet)
    tap = None
    if not args.no_tap:
        from tap.tap import SparkplugTap
        tap = SparkplugTap(trace)
    faults = Faults(args.drop_every, args.drop_filter)
    b = Broker(trace, tap=tap, faults=faults,
               will_on_takeover=not args.no_will_on_takeover)
    await b.start(args.host, args.port)
    try:
        await asyncio.Event().wait()
    finally:
        await b.stop()
        trace.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
