"""Run the minimal host: python -m host --help"""
import argparse
import asyncio

from broker.trace import Trace

from .host import Host


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="host", description="minimal Sparkplug host")
    a.add_argument("--id", default="SCADA1",
                   help="primary host id for STATE")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1884)
    a.add_argument("--write", action="append", default=[],
                   metavar="G/N/D/METRIC=VALUE",
                   help="write once the device is born")
    a.add_argument("--trace", help="also write trace to file")
    a.add_argument("--quiet", action="store_true")
    return a.parse_args(argv)


async def main(argv=None):
    args = parse_args(argv)
    trace = Trace(args.trace, echo=not args.quiet)
    writes = [tuple(w.split("=", 1)) for w in args.write]
    h = Host(args.id, args.host, args.port, trace=trace,
             writes=writes)
    try:
        await h.run()
    finally:
        await h.stop()
        trace.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
