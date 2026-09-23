# labs/

Helpers for the book's labs. Book: Chapters 4, 12, and 19.

| File | What it does |
|------|--------------|
| `modbus_sim.py` | A tiny Modbus TCP server with four holding registers: temperature, pressure, running, setpoint. FC3 and FC6 only. |
| `silent.py` | A client that ends its connection on purpose, five ways: `disconnect`, `close`, `silence`, `violation`, `ping`. Chapter 4. |

```
python -m labs.modbus_sim --port 1502
python -m edge --modbus 127.0.0.1:1502

python -m labs.silent --end silence --keepalive 4
python -m labs.silent --end close
```
