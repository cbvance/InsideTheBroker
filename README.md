# Inside the Broker

Companion source for *Inside the Broker: Building a Study
Broker and Edge Node to Master MQTT and Sparkplug B* by
Charles Vance (LearnSCADA, 2026).

Four small programs, one shared wire module, standard
library only:

| Package   | What it is                                         |
|-----------|----------------------------------------------------|
| `broker/` | MQTT 3.1.1 study broker. Decodes every packet, names every disconnect reason, fails loudly on protocol violations, injects faults on command. |
| `tap/`    | Hand-built Sparkplug B protobuf codec and a read-only tap that checks seq, bdSeq, births, and deaths the way a host would. |
| `edge/`   | Sparkplug B study edge node with its own MQTT client built from `broker/wire.py`. Simulated or Modbus TCP device, report by exception, commands, rebirth, primary host STATE, store and forward. |
| `host/`   | Minimal primary host application: STATE, tag model, rebirth requests, and writes. |
| `labs/`   | Lab helpers, including a tiny Modbus TCP simulator. |

Lines are kept to 64 characters so the repository matches
the printed listings in the book.

## Warning

This is a teaching instrument. It has no TLS,
authentication, or access control. Run it on an isolated
bench. Never connect it to a plant network.

## Requirements

Python 3.11 or later. Nothing else is needed to run the
programs. The tests use `pytest`, and cross-check against
`paho-mqtt` and Google's `protobuf` when installed.

## Set up and test

Windows (Command Prompt):

```
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements-dev.txt
python -m pytest -v
```

Linux or macOS:

```
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
python -m pytest -v
```

## Run a full Sparkplug session

Open three terminals in the repository folder, activate
the virtual environment in each, then:

```
python -m broker --trace trace.log
python -m host --id SCADA1
python -m edge --primary-host SCADA1
```

The broker listens on 127.0.0.1:1884 so it never collides
with a real broker on 1883. Press Ctrl+C in the edge
terminal and the node sends its own NDEATH before
DISCONNECT. Close the window instead and the broker
publishes the NDEATH will.

## Labs at a glance

```
# write a setpoint once the device is born
python -m host --write Lab/Edge1/PLC1/Setpoint=58

# drop every 4th DDATA; watch the host request rebirth
python -m broker --drop-every 4 --drop-filter "spBv1.0/+/DDATA/#"

# aliases in data messages
python -m edge --aliases

# a Modbus TCP device instead of the simulator
python -m labs.modbus_sim --port 1502
python -m edge --modbus 127.0.0.1:1502

# watch with any MQTT client
mosquitto_sub -h 127.0.0.1 -p 1884 -t "#" -v
```

Every program takes `--help`.

## License

MIT. See `LICENSE`.
