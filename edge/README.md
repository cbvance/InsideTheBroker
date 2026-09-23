# edge/

The Sparkplug B study edge node. Book: Part V
(Chapters 12 to 17).

| File | What it does |
|------|--------------|
| `client.py` | MQTT client built from `broker/wire.py` and `broker/packets.py`. Keepalive, QoS 1 and 2, graceful and abrupt disconnect. |
| `device.py` | The device layer: a simulated pump skid and a Modbus TCP device (FC3 read, FC6 write). |
| `node.py` | The edge node: bdSeq, births, report by exception, DCMD writes, NCMD rebirth, primary host STATE, store and forward. |

```
python -m edge --help
python -m edge --primary-host SCADA1
python -m edge --aliases
python -m edge --modbus 127.0.0.1:1502
```
