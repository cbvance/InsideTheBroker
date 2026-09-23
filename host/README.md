# host/

A minimal Sparkplug B primary host application. Book:
Chapter 18.

`host.py` publishes STATE with a will, subscribes to the
whole Sparkplug namespace, keeps a tag model through the
shared tracker, requests a rebirth whenever the model can't
be trusted, and sends DCMD writes.

```
python -m host --help
python -m host --id SCADA1
python -m host --write Lab/Edge1/PLC1/Setpoint=58
```
