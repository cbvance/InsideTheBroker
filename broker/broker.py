"""The study broker: connections, sessions, and routing."""
import asyncio
import secrets

from . import packets as P
from .session import Connection, Session
from .topics import matches, valid_filter, validate_topic
from .wire import NAMES, ProtocolError, read_packet


class Broker:
    """An MQTT 3.1.1 broker that explains itself.

    Routing never opens a payload. The optional tap observes
    every routed message and cannot change delivery.
    """

    def __init__(self, trace, tap=None, faults=None,
                 will_on_takeover=True, connect_timeout=10.0,
                 queue_limit=1000):
        self.trace = trace
        self.tap = tap
        self.faults = faults
        self.will_on_takeover = will_on_takeover
        self.connect_timeout = connect_timeout
        self.queue_limit = queue_limit
        self.sessions = {}        # client id -> Session
        self.retained = {}        # topic -> (payload, qos)
        self.server = None

    async def start(self, host="127.0.0.1", port=1884):
        self.server = await asyncio.start_server(
            self.handle, host, port)
        addr = self.server.sockets[0].getsockname()
        self.trace.event("broker", "LISTENING",
                         f"{addr[0]}:{addr[1]}")
        return addr[1]

    async def stop(self):
        """Stop listening and drop every live connection."""
        if self.server:
            self.server.close()
            for sess in list(self.sessions.values()):
                if sess.conn is not None:
                    sess.conn.close()
            await self.server.wait_closed()

    # ---- one TCP connection, start to finish ----------------

    async def handle(self, reader, writer):
        host, port = writer.get_extra_info("peername")[:2]
        conn = Connection(writer, f"{host}:{port}")
        sess, graceful, reason = None, False, "closed"
        try:
            t, flags, body = await asyncio.wait_for(
                read_packet(reader), self.connect_timeout)
            self.trace.packet("IN", conn.peer, t, flags, body)
            if t != P.CONNECT:
                raise ProtocolError("first packet not CONNECT")
            c = P.parse_connect(body)
            sess = self.accept(c, conn)
            if sess is None:
                return
            ka = c["keepalive"]
            timeout = ka * 1.5 if ka else None
            while True:
                t, flags, body = await asyncio.wait_for(
                    read_packet(reader), timeout)
                who = sess.client_id
                self.trace.packet("IN", who, t, flags, body)
                if t == P.CONNECT:
                    raise ProtocolError("second CONNECT")
                if t == P.DISCONNECT:
                    graceful = True
                    reason = "DISCONNECT received"
                    break
                self.dispatch(sess, t, flags, body)
        except TimeoutError:
            reason = ("keepalive expired (1.5x)" if sess
                      else "no CONNECT in time")
        except (asyncio.IncompleteReadError, ConnectionError):
            reason = "socket closed without DISCONNECT"
        except ProtocolError as e:
            reason = f"protocol violation: {e}"
        finally:
            if sess is not None and sess.conn is conn:
                self.end_session(sess, graceful, reason)
            elif sess is None:
                self.trace.event(conn.peer, "ENDED", reason)
            conn.close()

    # ---- CONNECT -------------------------------------------

    def accept(self, c, conn):
        if c["level"] != P.PROTOCOL_LEVEL:
            self.refuse(conn, P.BAD_PROTOCOL)
            return None
        cid = c["client_id"]
        if not cid:
            if not c["clean"]:
                self.refuse(conn, P.BAD_CLIENT_ID)
                return None
            cid = "auto-" + secrets.token_hex(4)
        old = self.sessions.get(cid)
        if old is not None and old.conn is not None:
            self.takeover(old)
            old = self.sessions.get(cid)
        present = False
        if c["clean"] or old is None:
            sess = Session(cid, c["clean"], self.queue_limit)
            self.sessions[cid] = sess
        else:
            sess, present = old, True
        sess.will = c["will"]
        sess.conn = conn
        conn.client_id = cid
        self.send(sess, P.build_connack(present, P.ACCEPTED))
        if present:
            self.resume(sess)
        return sess

    def refuse(self, conn, code):
        pkt = P.build_connack(False, code)
        self.trace.out(conn.peer, pkt)
        conn.write(pkt)

    def takeover(self, old):
        """A second CONNECT with an ID already connected."""
        self.trace.event(old.client_id, "TAKEOVER",
                         "new connection, same client id")
        conn = old.conn
        self.end_session(old, not self.will_on_takeover,
                         "taken over by a new connection")
        conn.close()

    # ---- the end of a connection ---------------------------

    def end_session(self, sess, graceful, reason):
        cid = sess.client_id
        self.trace.event(cid, "ENDED", reason)
        will, sess.will, sess.conn = sess.will, None, None
        if will and not graceful:
            self.trace.event(cid, "WILL", f"-> {will['topic']}")
            self.publish(cid, will["topic"], will["payload"],
                         will["qos"], will["retain"])
        elif will:
            self.trace.event(cid, "WILL", "discarded")
        if sess.clean and self.sessions.get(cid) is sess:
            del self.sessions[cid]

    # ---- packets after CONNECT -----------------------------

    def dispatch(self, sess, t, flags, body):
        if t == P.PUBLISH:
            self.on_publish(sess, flags, body)
        elif t == P.PUBACK:
            self.on_ack(sess, P.parse_pid(body), P.PUBACK)
        elif t == P.PUBREC:
            pid = P.parse_pid(body)
            if self.on_ack(sess, pid, P.PUBREC):
                self.send(sess, P.build_ack(P.PUBREL, pid))
        elif t == P.PUBREL:
            pid = P.parse_pid(body)
            sess.qos2_in.discard(pid)
            self.send(sess, P.build_ack(P.PUBCOMP, pid))
        elif t == P.PUBCOMP:
            self.on_ack(sess, P.parse_pid(body), P.PUBCOMP)
        elif t == P.SUBSCRIBE:
            self.on_subscribe(sess, body)
        elif t == P.UNSUBSCRIBE:
            pid, filters = P.parse_unsubscribe(body)
            for f in filters:
                sess.subs.pop(f, None)
            self.send(sess, P.build_ack(P.UNSUBACK, pid))
        elif t == P.PINGREQ:
            self.send(sess, P.PINGRESP_PKT)
        else:
            raise ProtocolError(f"{NAMES[t]} from a client")

    def on_publish(self, sess, flags, body):
        m = P.parse_publish(flags, body)
        validate_topic(m["topic"])
        q, pid = m["qos"], m["pid"]
        args = (sess.client_id, m["topic"], m["payload"],
                q, m["retain"])
        if q == 0:
            self.publish(*args)
        elif q == 1:
            self.publish(*args)
            self.send(sess, P.build_ack(P.PUBACK, pid))
        else:
            if pid in sess.qos2_in:
                self.trace.event(
                    sess.client_id, "DUPLICATE",
                    f"QoS 2 id {pid} not re-routed")
            else:
                sess.qos2_in.add(pid)
                self.publish(*args)
            self.send(sess, P.build_ack(P.PUBREC, pid))

    def on_ack(self, sess, pid, kind):
        """Advance an outbound QoS 1/2 flow. True if known."""
        entry = sess.inflight.get(pid)
        if entry is None or entry["wait"] != kind:
            self.trace.event(sess.client_id, "STRAY",
                             f"{NAMES[kind]} id {pid}")
            return False
        if kind == P.PUBREC:
            entry["wait"] = P.PUBCOMP
        else:
            del sess.inflight[pid]
        return True

    def on_subscribe(self, sess, body):
        pid, pairs = P.parse_subscribe(body)
        codes, granted = [], []
        for f, q in pairs:
            if valid_filter(f):
                sess.subs[f] = q
                codes.append(q)
                granted.append((f, q))
            else:
                self.trace.event(sess.client_id, "REJECTED",
                                 f"bad filter {f!r}")
                codes.append(P.SUB_FAILURE)
        self.send(sess, P.build_suback(pid, codes))
        for f, q in granted:
            for topic, (payload, rq) in self.retained.items():
                if matches(f, topic):
                    self.deliver(sess, topic, payload,
                                 min(q, rq), retain=True)

    # ---- routing -------------------------------------------

    def publish(self, sender, topic, payload, qos, retain):
        """Route one message from a client or a will."""
        if self.faults and self.faults.should_drop(topic):
            self.trace.event(sender, "DROPPED",
                             f"fault injection: {topic}")
            return
        if retain:
            if payload:
                self.retained[topic] = (payload, qos)
            else:
                self.retained.pop(topic, None)
        if self.tap:
            self.tap.on_publish(sender, topic, payload, qos,
                                retain)
        for sess in list(self.sessions.values()):
            g = sess.granted_qos(topic, matches)
            if g is not None:
                self.deliver(sess, topic, payload, min(qos, g))

    def deliver(self, sess, topic, payload, qos, retain=False):
        if sess.conn is None:
            if qos == 0:
                return            # QoS 0 is not queued
            if len(sess.offline) >= sess.queue_limit:
                sess.offline.popleft()
                sess.dropped += 1
                self.trace.event(sess.client_id, "QUEUE FULL",
                                 "oldest message dropped")
            sess.offline.append((topic, payload, qos))
            return
        pid = None
        if qos:
            pid = sess.next_pid()
            wait = P.PUBACK if qos == 1 else P.PUBREC
            sess.inflight[pid] = {"topic": topic, "qos": qos,
                                  "payload": payload,
                                  "wait": wait}
        self.send(sess, P.build_publish(
            topic, payload, qos, retain, False, pid))

    def resume(self, sess):
        """Resend unfinished flows, then drain the queue."""
        for pid, e in list(sess.inflight.items()):
            if e["wait"] == P.PUBCOMP:
                self.send(sess, P.build_ack(P.PUBREL, pid))
            else:
                self.send(sess, P.build_publish(
                    e["topic"], e["payload"], e["qos"],
                    False, True, pid))
        n = len(sess.offline)
        if n:
            self.trace.event(sess.client_id, "RESUME",
                             f"delivering {n} queued")
        while sess.offline and sess.conn is not None:
            self.deliver(sess, *sess.offline.popleft())

    def send(self, sess, pkt):
        self.trace.out(sess.client_id, pkt)
        sess.conn.write(pkt)
