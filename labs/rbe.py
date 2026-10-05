"""Count what report by exception saves.

Runs the simulated pump skid for a number of scans, as fast
as possible, and counts the metrics and messages that three
reporting rules would send.
Run: python -m labs.rbe --help
"""
import argparse
import asyncio
import time

from edge.device import SimDevice
from edge.node import changed

RULES = ["every scan", "every change", "deadband"]


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="rbe", description="compare reporting rules")
    a.add_argument("--scans", type=int, default=600)
    a.add_argument("--scan", type=float, default=1.0,
                   help="simulated seconds per scan")
    a.add_argument("--seed", type=int, default=1)
    return a.parse_args(argv)


async def run(scans, scan, seed):
    dev = SimDevice(seed=seed)
    metrics = dict.fromkeys(RULES, 0)
    messages = dict.fromkeys(RULES, 0)
    last = {r: {} for r in RULES}
    for i in range(scans):
        dev.t0 = time.monotonic() - i * scan   # simulated time
        vals = await dev.read()
        for rule in RULES:
            sent = 0
            for name, v in vals.items():
                prev = last[rule].get(name)
                if rule == "every scan":
                    hit = True
                elif rule == "every change":
                    hit = prev != v
                else:
                    hit = changed(prev, v, dev.points[name])
                if hit:
                    last[rule][name] = v
                    sent += 1
            metrics[rule] += sent
            messages[rule] += 1 if sent else 0
    return metrics, messages


def main(argv=None):
    args = parse_args(argv)
    metrics, messages = asyncio.run(
        run(args.scans, args.scan, args.seed))
    print(f"{args.scans} scans of {args.scan:g} s, six points")
    print(f"{'rule':<14}{'metrics':>10}{'messages':>10}")
    for r in RULES:
        print(f"{r:<14}{metrics[r]:>10}{messages[r]:>10}")


if __name__ == "__main__":
    main()
