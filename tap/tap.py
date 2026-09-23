"""The Sparkplug tap: observes routed messages, logs rules."""
from .tracker import Tracker


class SparkplugTap:
    """Read-only observer the broker calls for each message.

    It never alters or blocks delivery. It reports what a
    Sparkplug host application would notice.
    """

    def __init__(self, trace):
        self.trace = trace
        self.tracker = Tracker()
        self.events = []

    def on_publish(self, sender, topic, payload, qos, retain):
        for e in self.tracker.feed(topic, payload):
            self.events.append(e)
            note = " -> host requests rebirth" \
                if e.rebirth else ""
            self.trace.emit("TAP", e.key, e.kind,
                            e.text + note)
