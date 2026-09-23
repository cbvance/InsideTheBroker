"""Deliberate faults, injected on command for labs."""
from .topics import matches


class Faults:
    """Drop every Nth PUBLISH whose topic matches a filter.

    A dropped message is treated as lost on the wire: it is
    not retained, not seen by the tap, not delivered.
    """

    def __init__(self, drop_every=0, drop_filter="#"):
        self.drop_every = drop_every
        self.drop_filter = drop_filter
        self.count = 0

    def should_drop(self, topic):
        if not self.drop_every:
            return False
        if not matches(self.drop_filter, topic):
            return False
        self.count += 1
        return self.count % self.drop_every == 0
