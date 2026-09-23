# labs/

Helpers for the book's labs. Book: Chapters 12 and 19.

| File | What it does |
|------|--------------|
| `modbus_sim.py` | A tiny Modbus TCP server with four holding registers: temperature, pressure, running, setpoint. FC3 and FC6 only. |

```
python -m labs.modbus_sim --port 1502
python -m edge --modbus 127.0.0.1:1502
```
