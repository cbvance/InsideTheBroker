"""A tiny Modbus TCP server with four holding registers.

Registers: 0 temperature x10, 1 pressure x10,
2 running (0/1), 3 setpoint x10. FC3 and FC6 only.
Run: python -m labs.modbus_sim --port 1502
"""
import argparse
import asyncio
import random
import struct


class ModbusSim:
    def __init__(self):
        self.regs = [720, 550, 1, 500]

    def tick(self):
        if self.regs[2]:
            sp = self.regs[3]
            self.regs[0] = sp + 220 + random.randint(-8, 8)
            self.regs[1] = 550 + random.randint(-4, 4)
        else:
            self.regs[1] = 0

    def execute(self, pdu):
        fc = pdu[0]
        if fc == 3:
            start, count = struct.unpack(">HH", pdu[1:5])
            if start + count > len(self.regs):
                return bytes([0x83, 2])
            vals = self.regs[start:start + count]
            body = struct.pack(f">{count}h", *vals)
            return bytes([3, len(body)]) + body
        if fc == 6:
            reg, val = struct.unpack(">Hh", pdu[1:5])
            if reg >= len(self.regs):
                return bytes([0x86, 2])
            self.regs[reg] = val
            return pdu[:5]
        return bytes([fc | 0x80, 1])

    async def handle(self, reader, writer):
        try:
            while True:
                head = await reader.readexactly(7)
                tid, _, length, unit = struct.unpack(
                    ">HHHB", head)
                pdu = await reader.readexactly(length - 1)
                self.tick()
                reply = self.execute(pdu)
                writer.write(struct.pack(
                    ">HHHB", tid, 0, len(reply) + 1, unit)
                    + reply)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            writer.close()


async def serve(host="127.0.0.1", port=1502):
    sim = ModbusSim()
    server = await asyncio.start_server(sim.handle, host, port)
    return sim, server


async def main():
    a = argparse.ArgumentParser(prog="modbus_sim")
    a.add_argument("--host", default="127.0.0.1")
    a.add_argument("--port", type=int, default=1502)
    args = a.parse_args()
    _, server = await serve(args.host, args.port)
    print(f"Modbus sim on {args.host}:{args.port}")
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
