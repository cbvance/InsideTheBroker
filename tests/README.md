# tests/

The test suite: 76 tests that start real brokers on free
ports and connect real clients.

| File | What it checks |
|------|----------------|
| `test_wire.py` | Remaining Length edges, packet round trips, bad flags. |
| `test_topics.py` | Wildcard matching and filter validation. |
| `test_broker.py` | Routing, retained messages, wills, keepalive expiry, QoS 1 and 2, persistent sessions, takeover, protocol violations, Paho interop. |
| `test_sparkplug.py` | Codec round trips for every datatype, and a cross-check against Google's protobuf runtime. |
| `test_edge.py` | Full sessions: births, writes, rebirth, death, stale death, store and forward, gap-triggered rebirth, aliases, Modbus. |

```
python -m pytest -v
python -m pytest -v tests/test_wire.py
```
