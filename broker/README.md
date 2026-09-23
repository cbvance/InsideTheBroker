# broker/

The MQTT 3.1.1 study broker. Book: Parts II and III
(Chapters 3 to 8).

| File | What it does |
|------|--------------|
| `wire.py` | Packet framing, Remaining Length, strings, `Buf` reader. Shared with the edge node. |
| `packets.py` | Parse and build every packet type. Shared with the edge node. |
| `topics.py` | Topic validation and wildcard matching. |
| `session.py` | Connections and sessions: subscriptions, in-flight messages, offline queue. |
| `broker.py` | The broker: CONNECT, keepalive, disconnect reasons, routing, retained messages, wills, QoS 1 and 2, takeover. |
| `trace.py` | The decoded packet trace. |
| `faults.py` | Fault injection for labs. |

```
python -m broker --help
python -m broker --trace trace.log
```
