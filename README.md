# Inside the Broker

Companion source for *Inside the Broker: Building a Study Broker and Edge
Node to Master MQTT and Sparkplug B* by Charles Vance (LearnSCADA, 2026).

The book builds two teaching programs in Python on one shared wire module:

- **Study broker** (`broker/`): an MQTT 3.1.1 broker that decodes every
  packet, names the reason every connection ends, and fails loudly on
  protocol violations.
- **Sparkplug tap** (`tap/`): a read-only observer that checks Sparkplug B
  rules (seq, bdSeq, births, deaths) the way a host application would.
- **Study edge node** (`edge/`): a Sparkplug B edge node with its own MQTT
  client built from the broker's wire module.

Code is added chapter by chapter as the book is written. Lines are kept to
64 characters so the repository matches the printed listings.

## Warning

This is a teaching instrument. It has no TLS, authentication, or access
control. Run it on an isolated bench. Never connect it to a plant network.

## Requirements

- Python 3.11 or later
- `protobuf` (Sparkplug payloads), `paho-mqtt` (independent test client)
- Optional: Mosquitto clients (`mosquitto_pub`, `mosquitto_sub`), Wireshark

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\Activate.ps1
pip install protobuf paho-mqtt pytest
pytest -v tests/
python -m broker --port 1884 --trace trace.log
```

The broker listens on port 1884 so it never collides with a real broker
on 1883.

## License

MIT. See `LICENSE`.