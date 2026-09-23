import pytest

from broker.topics import matches, valid_filter

CASES = [
    ("sport/#", "sport", True),
    ("sport/#", "sport/tennis/p1", True),
    ("sport/+", "sport/", True),
    ("sport/+", "sport", False),
    ("+/+", "/finance", True),
    ("/+", "/finance", True),
    ("+", "/finance", False),
    ("#", "$SYS/uptime", False),
    ("$SYS/#", "$SYS/uptime", True),
    ("spBv1.0/+/NDATA/#", "spBv1.0/Lab/NDATA/Edge1", True),
    ("spBv1.0/+/NDATA/#", "spBv1.0/Lab/NDATA/E1/PLC1", True),
    ("spBv1.0/+/DDATA/+", "spBv1.0/Lab/NDATA/E1", False),
    ("a/b", "a/b/c", False),
]


@pytest.mark.parametrize("f,topic,want", CASES)
def test_matches(f, topic, want):
    assert matches(f, topic) is want


@pytest.mark.parametrize("f", ["a/#/b", "a#", "a/b+",
                               "", "sport+"])
def test_invalid_filters(f):
    assert not valid_filter(f)


@pytest.mark.parametrize("f", ["#", "+", "a/+/c", "+/#",
                               "a//b"])
def test_valid_filters(f):
    assert valid_filter(f)
