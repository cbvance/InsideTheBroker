import math

import pytest

from tap import sparkplug as sp
from tap.sparkplug import Metric, Payload

VALUES = [
    (sp.INT8, -5), (sp.INT16, -300), (sp.INT32, -70000),
    (sp.INT64, -(2 ** 40)), (sp.UINT8, 250),
    (sp.UINT32, 4_000_000_000), (sp.UINT64, 2 ** 63),
    (sp.FLOAT, 1.5), (sp.DOUBLE, math.pi),
    (sp.BOOLEAN, True), (sp.BOOLEAN, False),
    (sp.STRING, "AUTO"), (sp.DATETIME, 1_790_000_000_000),
    (sp.BYTES, b"\x00\xff"),
]


@pytest.mark.parametrize("dt,v", VALUES)
def test_metric_round_trip(dt, v):
    p = Payload(123, 7, [Metric("m", 3, 99, dt, v)])
    q = sp.decode(sp.encode(p))
    m = q.metrics[0]
    assert (q.timestamp, q.seq) == (123, 7)
    assert (m.name, m.alias, m.datatype) == ("m", 3, dt)
    assert m.value == v


def test_null_and_flags():
    m = Metric("x", None, 1, sp.DOUBLE, None, True, True)
    got = sp.decode(sp.encode(Payload(1, 0, [m]))).metrics[0]
    assert got.is_null and got.is_historical
    assert got.value is None


def test_32bit_twos_complement_accepted():
    # some encoders put Int8 -1 in all 32 bits
    raw = 0xFFFFFFFF
    assert sp.to_signed(raw, sp.INT8) == -1


def test_garbage_rejected():
    with pytest.raises(sp.CodecError):
        sp.decode(b"\x0a\xff\xff")


def test_matches_official_protobuf():
    """Cross-check against Google's protobuf runtime."""
    pytest.importorskip("google.protobuf")
    from google.protobuf import descriptor_pb2
    from google.protobuf import descriptor_pool
    from google.protobuf import message_factory
    F = descriptor_pb2.FieldDescriptorProto
    fdp = descriptor_pb2.FileDescriptorProto(
        name="spb_test.proto", package="spbt",
        syntax="proto2")
    met = fdp.message_type.add(name="Metric")
    spec = [("name", 1, F.TYPE_STRING),
            ("alias", 2, F.TYPE_UINT64),
            ("timestamp", 3, F.TYPE_UINT64),
            ("datatype", 4, F.TYPE_UINT32),
            ("is_historical", 5, F.TYPE_BOOL),
            ("is_null", 7, F.TYPE_BOOL),
            ("int_value", 10, F.TYPE_UINT32),
            ("long_value", 11, F.TYPE_UINT64),
            ("float_value", 12, F.TYPE_FLOAT),
            ("double_value", 13, F.TYPE_DOUBLE),
            ("boolean_value", 14, F.TYPE_BOOL),
            ("string_value", 15, F.TYPE_STRING)]
    for n, num, t in spec:
        met.field.add(name=n, number=num, type=t,
                      label=F.LABEL_OPTIONAL)
    pay = fdp.message_type.add(name="Payload")
    pay.field.add(name="timestamp", number=1,
                  type=F.TYPE_UINT64, label=F.LABEL_OPTIONAL)
    pay.field.add(name="metrics", number=2,
                  type=F.TYPE_MESSAGE, type_name=".spbt.Metric",
                  label=F.LABEL_REPEATED)
    pay.field.add(name="seq", number=3, type=F.TYPE_UINT64,
                  label=F.LABEL_OPTIONAL)
    pool = descriptor_pool.DescriptorPool()
    pool.Add(fdp)
    cls = message_factory.GetMessageClass(
        pool.FindMessageTypeByName("spbt.Payload"))
    ours = Payload(1000, 5, [
        Metric("bdSeq", None, 1000, sp.INT64, 3),
        Metric("T", 4, 1000, sp.DOUBLE, 72.25),
        Metric("On", None, 1000, sp.BOOLEAN, True),
        Metric("Mode", None, 1000, sp.STRING, "AUTO"),
        Metric("I", None, 1000, sp.INT32, 1234),
    ])
    theirs = cls()
    theirs.ParseFromString(sp.encode(ours))
    assert theirs.seq == 5 and len(theirs.metrics) == 5
    assert theirs.metrics[1].double_value == 72.25
    assert theirs.metrics[1].alias == 4
    assert theirs.metrics[3].string_value == "AUTO"
    back = sp.decode(theirs.SerializeToString())
    assert back == ours
