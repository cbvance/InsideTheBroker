"""A client that ends its connection on purpose.

Each --end choice produces one of the broker's disconnect
reasons. Watch the broker's trace while it runs.
Run: python -m labs.silent --help
"""
import argparse
import socket
import time

from broker import packets as P

ENDINGS = ["disconnect", "close", "silence", "violation",
           "ping"]


def parse_args(argv=None):
    a = argparse.ArgumentParser(
        prog="silent",
        description="end a connection on purpose")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1884)
    a.add_argument("--id", default="lab-silent")
    a.add_argument("--keepalive", type=int, default=5)
    a.add_argument("--end", choices=ENDINGS, default="silence")
    a.add_argument("--hold", type=float, default=2.0,
                   help="seconds to stay connected first "
                        "(not used by --end ping)")
    return a.parse_args(argv)


def main(argv=None):
    args = parse_args(argv)
    ka = args.keepalive
    will = {"topic": f"lab/will/{args.id}", "payload": b"gone",
            "qos": 0, "retain": False}
    try:
        s = socket.create_connection((args.host, args.port))
    except ConnectionRefusedError:
        where = f"{args.host}:{args.port}"
        raise SystemExit(f"no broker on {where}; start one "
                         "with: python -m broker")
    s.sendall(P.build_connect(args.id, ka, will=will))
    print("CONNACK", s.recv(4).hex(" "))
    if args.end == "ping":
        ping(s, ka)
        return
    time.sleep(args.hold)
    if args.end == "disconnect":
        s.sendall(P.DISCONNECT_PKT)
        print("sent DISCONNECT: the will should be discarded")
    elif args.end == "close":
        print("closing the socket without DISCONNECT")
    elif args.end == "violation":
        s.sendall(P.build_connect(args.id, ka))
        print("sent a second CONNECT: a protocol violation")
        time.sleep(1)
    elif args.end == "silence":
        wait = ka * 1.5
        print(f"going silent: expect the broker to end this "
              f"about {wait:g} s after the CONNECT")
        time.sleep(wait + 2)
    s.close()


def ping(s, ka):
    """Keep the keepalive promise: never idle longer than ka.

    Idle time counts from the last packet sent, which here is
    the CONNECT, so the first PINGREQ goes out ka seconds
    after it, not ka seconds after some other wait.
    """
    for n in range(3):
        time.sleep(ka)
        s.sendall(P.PINGREQ_PKT)
        print(f"PINGREQ {n + 1}, reply", s.recv(2).hex(" "))
    s.sendall(P.DISCONNECT_PKT)
    print("sent DISCONNECT: the will should be discarded")
    s.close()


if __name__ == "__main__":
    main()
