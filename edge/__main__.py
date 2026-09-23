"""Run the study edge node: python -m edge --help"""
import argparse
import asyncio

from broker.trace import Trace
from tap import sparkplug as sp

from .device import ModbusDevice, SimDevice
from .node import EdgeNode

# register, datatype, scale, writable, deadband
MODBUS_MAP = [
    ("Temperature", 0, sp.FLOAT, 0.1, False, 0.5),
    ("Pressure", 1, sp.FLOAT, 0.1, False, 0.25),
    ("Running", 2, sp.BOOLEAN, 1, True, 0),
    ("Setpoint", 3, sp.FLOAT, 0.1, True, 0),
]


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="edge", description="Sparkplug B study edge node")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1884)
    a.add_argument("--group", default="Lab")
    a.add_argument("--node", default="Edge1")
    a.add_argument("--device", default="PLC1")
    a.add_argument("--keepalive", type=int, default=10)
    a.add_argument("--scan", type=float, default=1.0)
    a.add_argument("--primary-host",
                   help="wait for this host's STATE")
    a.add_argument("--aliases", action="store_true")
    a.add_argument("--modbus", metavar="HOST[:PORT]",
                   help="read a Modbus TCP device")
    a.add_argument("--trace", help="also write trace to file")
    a.add_argument("--quiet", action="store_true")
    return a.parse_args(argv)


def make_device(args):
    if not args.modbus:
        return SimDevice(args.device)
    host, _, port = args.modbus.partition(":")
    return ModbusDevice(args.device, host,
                        int(port or 502), regmap=MODBUS_MAP)


async def main(argv=None):
    args = parse_args(argv)
    trace = Trace(args.trace, echo=not args.quiet)
    node = EdgeNode(args.group, args.node, [make_device(args)],
                    args.host, args.port, args.keepalive,
                    args.primary_host, args.scan, args.aliases,
                    trace=trace)
    try:
        await node.run()
    finally:
        await node.stop()
        trace.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
