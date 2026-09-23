"""Topic names, topic filters, and wildcard matching."""
from .wire import ProtocolError


def validate_topic(name):
    """A PUBLISH topic: non-empty, no wildcards."""
    if not name:
        raise ProtocolError("empty topic name")
    if "+" in name or "#" in name:
        raise ProtocolError(f"wildcard in topic {name!r}")


def valid_filter(f):
    """True if f is a legal SUBSCRIBE topic filter."""
    if not f:
        return False
    levels = f.split("/")
    for i, lvl in enumerate(levels):
        if "#" in lvl and (lvl != "#" or i != len(levels) - 1):
            return False
        if "+" in lvl and lvl != "+":
            return False
    return True


def matches(f, topic):
    """Does topic filter f match topic name topic?"""
    if topic.startswith("$") and f[:1] in ("#", "+"):
        return False
    fl, tl = f.split("/"), topic.split("/")
    for i, part in enumerate(fl):
        if part == "#":
            return True
        if i >= len(tl):
            return False
        if part != "+" and part != tl[i]:
            return False
    return len(fl) == len(tl)
