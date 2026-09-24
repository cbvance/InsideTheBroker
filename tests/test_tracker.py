"""The tracker's rules, one message at a time."""
from tap import sparkplug as sp
from tap.sparkplug import Metric, Payload
from tap.tracker import REBIRTH, Tracker

N = "spBv1.0/Lab/{}/Edge1"
D = "spBv1.0/Lab/{}/Edge1/PLC1"


def pay(seq, *metrics):
    return sp.encode(Payload(1, seq, list(metrics)))


def m(name, dt, v, alias=None):
    return Metric(name, alias, 1, dt, v)


def born(t=None, bd=0):
    t = t or Tracker()
    t.feed(N.format("NBIRTH"), pay(
        0, m("bdSeq", sp.INT64, bd),
        m(REBIRTH, sp.BOOLEAN, False)))
    t.feed(D.format("DBIRTH"), pay(
        1, m("T", sp.DOUBLE, 1.0, alias=7),
        m("Run", sp.BOOLEAN, True)))
    return t


def kinds(ev):
    return [e.kind for e in ev]


def test_clean_birth_and_data():
    t = born()
    ev = t.feed(D.format("DDATA"),
                pay(2, m("T", sp.DOUBLE, 2.0)))
    assert kinds(ev) == ["DATA"]
    assert t.nodes[("Lab", "Edge1")].devices["PLC1"] \
        .metrics["T"][1] == 2.0


def test_alias_resolves():
    t = born()
    ev = t.feed(D.format("DDATA"),
                pay(2, Metric(None, 7, 1, sp.DOUBLE, 3.5)))
    assert kinds(ev) == ["DATA"] and "T=3.5" in ev[0].text


def test_never_born_metric_asks_rebirth():
    t = born()
    ev = t.feed(D.format("DDATA"), pay(2, m("X", sp.INT32, 1)))
    assert "VIOLATION" in kinds(ev)
    assert any(e.rebirth for e in ev)


def test_datatype_change_flagged():
    t = born()
    ev = t.feed(D.format("DDATA"),
                pay(2, m("T", sp.INT32, 5)))
    assert any("type changed" in e.text for e in ev)


def test_seq_wraps_without_gap():
    t = born()
    n = t.nodes[("Lab", "Edge1")]
    n.seq = 254
    ev1 = t.feed(D.format("DDATA"),
                 pay(255, m("T", sp.DOUBLE, 1.0)))
    ev2 = t.feed(D.format("DDATA"),
                 pay(0, m("T", sp.DOUBLE, 2.0)))
    assert "GAP" not in kinds(ev1) + kinds(ev2)


def test_birth_rules():
    t = Tracker()
    ev = t.feed(N.format("NBIRTH"), pay(3, m("bdSeq", sp.INT64,
                                             0)))
    text = " ".join(e.text for e in ev)
    assert "seq=3, expected 0" in text
    assert REBIRTH in text


def test_device_death_then_data():
    t = born()
    t.feed(D.format("DDEATH"), pay(2))
    ev = t.feed(D.format("DDATA"),
                pay(3, m("T", sp.DOUBLE, 1.0)))
    assert "NO_BIRTH" in kinds(ev)


def test_state_must_be_json():
    t = Tracker()
    ev = t.feed("spBv1.0/STATE/SCADA1", b"online")
    assert kinds(ev) == ["VIOLATION"]
    ev = t.feed("spBv1.0/STATE/SCADA1",
                b'{"online": true, "timestamp": 1}')
    assert kinds(ev) == ["STATE"]
