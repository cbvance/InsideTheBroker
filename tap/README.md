# tap/

Sparkplug B, read by hand. Book: Part IV (Chapters 9 to 11).

| File | What it does |
|------|--------------|
| `sparkplug.py` | Protobuf codec for the Sparkplug `Payload` and `Metric` messages, written without the protobuf library. Datatypes and topic helpers. |
| `tracker.py` | Sparkplug session state as a host sees it: births, deaths, stale deaths, seq gaps, data before birth, metrics never born. Shared with the host. |
| `tap.py` | Read-only observer the broker calls for each routed message. Never changes delivery. |

The tap runs inside the broker by default. Turn it off with
`python -m broker --no-tap`.
