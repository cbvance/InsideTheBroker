# labs/

Helpers for the book's labs. Book: Chapters 4, 5, 9, 12, and 19.

| File | What it does |
|------|--------------|
| `modbus_sim.py` | A tiny Modbus TCP server with four holding registers: temperature, pressure, running, setpoint. FC3 and FC6 only. |
| `silent.py` | A client that ends its connection on purpose, five ways: `disconnect`, `close`, `silence`, `violation`, `ping`. Chapter 4. |
| `mq.py` | A tiny publish and subscribe client built on the edge node's MQTT client, so the labs need no Mosquitto install. Chapter 5. |
| `spdump.py` | Subscribes to the Sparkplug namespace and prints every message decoded, with its bytes in hex. Chapter 9. |

```
python -m labs.modbus_sim --port 1502
python -m edge --modbus 127.0.0.1:1502

python -m labs.silent --end silence --keepalive 4
python -m labs.silent --end close

python -m labs.mq sub "lab/#" --qos 1
python -m labs.mq pub lab/temp 72.4 --qos 1 --retain

python -m labs.spdump --hex 0
```
