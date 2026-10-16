/* StudyBroker mockup: a simulated study broker that runs in the browser.
   It imitates the book's broker closely enough to try the dashboard: sessions, routing, retained
   messages, wills, QoS 1 acks, keepalive pings, the Sparkplug tap, the fault knobs, member sign-in
   and guards, and the lab programs (edge node, host, connection endings, pub/sub client, Sparkplug
   dump). Trace lines use the book's format (broker/trace.py). Nothing here talks to a real broker. */
'use strict';
window.Sim = (() => {
  const now = () => Date.now();
  const pad = (s, n) => String(s).padEnd(n);
  const ts = t => { const d = new Date(t); return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0'); };
  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---- traffic classes (DESIGN.md 3.1) ----
  const CLASSES = [
    ['session', 'Session', 'CONNECT CONNACK DISCONNECT SUBSCRIBE SUBACK UNSUBSCRIBE UNSUBACK'],
    ['birth', 'Birth', 'NBIRTH DBIRTH'], ['data', 'Data', 'NDATA DDATA'], ['death', 'Death', 'NDEATH DDEATH'],
    ['host', 'Host', 'NCMD DCMD STATE'], ['qos', 'QoS handshake', 'PUBACK PUBREC PUBREL PUBCOMP'],
    ['other', 'Other publish', 'non-Sparkplug PUBLISH'], ['ping', 'Keepalive', 'PINGREQ PINGRESP']];
  function classify(type, topic) {
    if (type === 'PUBLISH') {
      const p = String(topic || '').split('/');
      if (p[0] !== 'spBv1.0') return 'other';
      if (p[1] === 'STATE') return 'host';
      const t = p[2] || '';
      return /BIRTH/.test(t) ? 'birth' : /DATA/.test(t) ? 'data' : /DEATH/.test(t) ? 'death' : /CMD/.test(t) ? 'host' : 'other';
    }
    if (/^PUB(ACK|REC|REL|COMP)$/.test(type)) return 'qos';
    if (/^PING/.test(type)) return 'ping';
    return 'session';
  }

  // ---- topics (broker/topics.py) ----
  function matches(filter, topic) {
    const f = filter.split('/'), t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true;
      if (i >= t.length) return false;
      if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
  }
  function validFilter(f) {
    if (!f) return false;
    const p = f.split('/');
    return p.every((x, i) => (x === '#' ? i === p.length - 1 : x === '+' || !/[#+]/.test(x)));
  }

  // ---- state ----
  const S = {
    started: now(), up: true, trace: [], packets: [], buckets: new Map(), tapEvents: [],
    sessions: new Map(), retained: new Map(), ended: [], refused: [], bans: new Set(), changelog: [],
    faults: { dropEvery: 0, dropFilter: 'spBv1.0/#', willOnTakeover: true, tap: true, count: 0, dropped: 0 },
    settings: { listen: '10.88.0.1:1884, 127.0.0.1:1884', connectTimeout: 10, queueLimit: 1000, traceDays: 14 },
    pending: {},
    members: { open: true, maxPacketKB: 64, perMember: 5, rate: 20, offlineDays: 7, reserved: 'spBv1.0/Lab/#, spBv1.0/STATE/SCADA1', listSynced: now() },
    sp: { node: null, device: null, hosts: new Map() },
    clients: new Map(),   // per-client cumulative counters
    sizes: new Map(),     // class -> recent payload sizes
    programs: new Map(), notebook: [], runActive: null,
  };
  const subs = new Set();
  const emit = (kind, data) => subs.forEach(fn => { try { fn(kind, data); } catch (e) { console.error(e); } });

  // ---- trace and counters ----
  function line(tag, who, what, detail = '', rec = null) {
    const t = now();
    const text = `${ts(t)}  ${pad(tag, 4)} ${pad(who, 16)} ${pad(what, 11)} ${detail}`.trimEnd();
    const L = { t, tag, who, what, detail, text, cls: rec ? rec.cls : null, rec, id: ++line.n };
    S.trace.push(L); if (S.trace.length > 5000) S.trace.shift();
    if (rec) { rec.line = L; S.packets.push(rec); if (S.packets.length > 400) S.packets.shift(); count(rec); }
    emit('line', L);
    return L;
  }
  line.n = 0;
  const event = (who, what, detail) => line('--', who, what, detail);
  function count(rec) {
    const sec = Math.floor(rec.t / 1000);
    let b = S.buckets.get(sec);
    if (!b) { b = { in: {}, out: {}, bin: {}, bout: {} }; S.buckets.set(sec, b); if (S.buckets.size > 960) S.buckets.delete(S.buckets.keys().next().value); }
    const d = rec.dir === 'IN' ? 'in' : 'out', bd = rec.dir === 'IN' ? 'bin' : 'bout';
    b[d][rec.cls] = (b[d][rec.cls] || 0) + 1; b[bd][rec.cls] = (b[bd][rec.cls] || 0) + rec.bytes;
    const c = S.clients.get(rec.client) || { in: 0, out: 0, bytes: 0, mix: {} };
    c[d]++; c.bytes += rec.bytes; c.mix[rec.cls] = (c.mix[rec.cls] || 0) + 1; S.clients.set(rec.client, c);
    if (rec.type === 'PUBLISH' && rec.dir === 'IN') {
      const a = S.sizes.get(rec.cls) || []; a.push(rec.payload); if (a.length > 200) a.shift(); S.sizes.set(rec.cls, a);
    }
  }

  function describe(type, f) {
    switch (type) {
      case 'CONNECT': return `id=${f.id} level=4 clean=${f.clean ? 1 : 0} ka=${f.ka}` + (f.will ? ` will=${f.will.topic} wq=${f.will.qos} wr=${f.will.retain ? 1 : 0}` : '') + (f.user ? ` user=${f.user}` : '');
      case 'CONNACK': return `sp=${f.sp ? 1 : 0} rc=${f.rc}`;
      case 'PUBLISH': return `q=${f.qos} r=${f.retain ? 1 : 0} d=${f.dup ? 1 : 0}${f.pid ? ' id=' + f.pid : ''} ${f.topic} (${f.payload} B)`;
      case 'PUBACK': case 'PUBREC': case 'PUBREL': case 'PUBCOMP': case 'UNSUBACK': return `id=${f.pid}`;
      case 'SUBSCRIBE': return `id=${f.pid} ${f.filters.map(([x, q]) => x + '@q' + q).join(' ')}`;
      case 'SUBACK': return `id=${f.pid} granted=${f.codes.join(',')}`;
      default: return '';
    }
  }
  const HEAD = { CONNECT: 12, CONNACK: 4, PUBLISH: 4, PUBACK: 4, SUBSCRIBE: 5, SUBACK: 5, PINGREQ: 2, PINGRESP: 2, DISCONNECT: 2 };
  function pkt(dir, who, client, type, f = {}) {
    const topic = f.topic || '', payload = f.payload || 0;
    const bytes = (HEAD[type] || 4) + (type === 'PUBLISH' ? topic.length + 2 + payload : type === 'CONNECT' ? String(f.id || '').length + (f.will ? f.will.topic.length + 20 : 0) : type === 'SUBSCRIBE' ? f.filters.reduce((s, [x]) => s + x.length + 3, 0) : 0);
    const rec = { t: now(), dir, type, client, cls: classify(type, topic), topic, bytes, payload, qos: f.qos || 0, retain: !!f.retain, will: !!f.isWill, dropped: false };
    line(dir, who, type, describe(type, f), rec);
    return rec;
  }

  // ---- sessions ----
  class Session {
    constructor(id, o) {
      Object.assign(this, { id, peer: o.peer, origin: o.origin, member: o.member || null, clean: o.clean !== false, ka: o.ka || 10, will: o.will || null,
        subs: new Map(), connected: now(), lastIn: now(), online: true, inflight: new Map(), offline: [], dropped: 0, pid: 0, owner: o.owner || null, rate: [] });
    }
    nextPid() { this.pid = this.pid % 65535 + 1; return this.pid; }
  }
  const online = () => [...S.sessions.values()].filter(s => s.online);

  function connect(spec) {
    if (!S.up) return null;
    const peer = spec.peer;
    pkt('IN', peer, spec.id, 'CONNECT', { id: spec.id, clean: spec.clean !== false, ka: spec.ka, will: spec.will, user: spec.member || null });
    if (spec.origin === 'member') {
      const refuse = (rc, why) => {
        pkt('OUT', peer, spec.id, 'CONNACK', { rc });
        event(spec.id, 'POLICY', why);
        event(peer, 'ENDED', `refused, return code ${rc}`);
        S.refused.unshift({ t: now(), id: spec.id, member: spec.member, peer, rc, why }); S.refused.length = Math.min(S.refused.length, 20);
        emit('refused');
        return null;
      };
      if (!S.members.open) { event(peer, 'ENDED', 'member listener closed (connection refused)'); return null; }
      if (spec.badToken) return refuse(4, 'bad username or password: token signature invalid');
      if (S.bans.has(spec.member)) return refuse(5, `not authorized: ${spec.member} is banned`);
      const other = S.sessions.get(spec.id);
      if (other && other.online && other.member && other.member !== spec.member) return refuse(2, 'identifier rejected: client id held by another member');
    }
    const old = S.sessions.get(spec.id);
    if (old && old.online) {
      event(spec.id, 'TAKEOVER', 'new connection, same client id');
      endSession(old, !S.faults.willOnTakeover, 'taken over by a new connection', true);
    }
    let sess, present = false;
    if (spec.clean === false && old && !old.clean) { sess = old; present = true; Object.assign(sess, { online: true, peer, connected: now(), lastIn: now(), will: spec.will || null, owner: spec.owner }); }
    else { sess = new Session(spec.id, spec); }
    S.sessions.set(spec.id, sess);
    pkt('OUT', spec.id, spec.id, 'CONNACK', { sp: present, rc: 0 });
    if (present && sess.offline.length) {
      event(spec.id, 'RESUME', `delivering ${sess.offline.length} queued`);
      sess.offline.splice(0).forEach(m => deliver(sess, m.topic, m.payload, m.qos, false, m.meta));
    }
    emit('sessions');
    return sess;
  }

  function endSession(sess, graceful, reason, quietSocket) {
    if (!sess.online) return;
    sess.online = false;
    event(sess.id, 'ENDED', reason);
    S.ended.unshift({ t: now(), id: sess.id, peer: sess.peer, origin: sess.origin, member: sess.member, reason }); S.ended.length = Math.min(S.ended.length, 20);
    const will = sess.will; sess.will = null;
    if (will && !graceful) {
      event(sess.id, 'WILL', `-> ${will.topic}`);
      route(sess.id, will.topic, will.payload, will.qos, will.retain, Object.assign({ isWill: true }, will.meta || {}), null);
    } else if (will) event(sess.id, 'WILL', 'discarded');
    if (sess.clean && S.sessions.get(sess.id) === sess) S.sessions.delete(sess.id);
    if (sess.owner && sess.owner.onEnded) setTimeout(() => sess.owner.onEnded(reason), 0);
    emit('sessions');
  }

  function disconnect(sess) {
    if (!sess || !sess.online) return;
    pkt('IN', sess.id, sess.id, 'DISCONNECT');
    endSession(sess, true, 'DISCONNECT received');
  }

  function subscribe(sess, filters) {
    const pid = sess.nextPid();
    pkt('IN', sess.id, sess.id, 'SUBSCRIBE', { pid, filters });
    const codes = filters.map(([f, q]) => (validFilter(f) ? (sess.subs.set(f, q), q) : '0x80'));
    pkt('OUT', sess.id, sess.id, 'SUBACK', { pid, codes });
    sess.lastIn = now();
    filters.forEach(([f, q]) => { if (!validFilter(f)) return; S.retained.forEach((m, topic) => { if (matches(f, topic)) deliver(sess, topic, m.payload, Math.min(q, m.qos), true, m.meta); }); });
  }

  // a client publishes
  function publish(sess, topic, payload, qos = 0, retain = false, meta = {}) {
    if (!sess || !sess.online || !S.up) return;
    const pid = qos ? sess.nextPid() : null;
    const rec = pkt('IN', sess.id, sess.id, 'PUBLISH', { topic, payload, qos, retain, pid });
    sess.lastIn = now();
    if (sess.origin === 'member') {                       // guards G1, G3, G6 (MEMBER-ACCESS.md)
      if (payload > S.members.maxPacketKB * 1024) { event(sess.id, 'POLICY', `packet over ${S.members.maxPacketKB} KB`); endSession(sess, false, 'protocol violation: policy: packet size'); return; }
      sess.rate = sess.rate.filter(t => now() - t < 1000); sess.rate.push(now());
      if (sess.rate.length > S.members.rate) { event(sess.id, 'POLICY', `publish rate over ${S.members.rate}/s`); endSession(sess, false, 'protocol violation: policy: publish rate'); return; }
      const res = S.members.reserved.split(',').map(x => x.trim()).filter(Boolean);
      if (res.some(f => validFilter(f) && matches(f, topic))) { event(sess.id, 'POLICY', `reserved topic ${topic}`); endSession(sess, false, 'protocol violation: policy: reserved topic'); return; }
    }
    route(sess.id, topic, payload, qos, retain, meta, rec);
    if (qos === 1 && sess.online) pkt('OUT', sess.id, sess.id, 'PUBACK', { pid });
  }

  // routing (Broker.publish): faults first, then retained, tap, delivery
  function route(sender, topic, payload, qos, retain, meta, inRec) {
    const F = S.faults;
    if (F.dropEvery && validFilter(F.dropFilter) && matches(F.dropFilter, topic)) {
      F.count++;
      if (F.count % F.dropEvery === 0) { F.dropped++; if (inRec) inRec.dropped = true; event(sender, 'DROPPED', `fault injection: ${topic}`); emit('drop'); return; }
    }
    if (retain) { if (payload) S.retained.set(topic, { payload, qos, meta, t: now(), sender }); else S.retained.delete(topic); }
    if (F.tap) tap(topic, meta);
    online().forEach(s => {
      let g = null;
      s.subs.forEach((q, f) => { if (matches(f, topic) && (g === null || q > g)) g = q; });
      if (g !== null) deliver(s, topic, payload, Math.min(qos, g), false, meta);
    });
    [...S.sessions.values()].filter(s => !s.online && !s.clean).forEach(s => {
      let g = null; s.subs.forEach((q, f) => { if (matches(f, topic)) g = Math.max(g ?? 0, q); });
      if (g !== null && Math.min(qos, g) > 0) {
        if (s.offline.length >= S.settings.queueLimit) { s.offline.shift(); s.dropped++; event(s.id, 'QUEUE FULL', 'oldest message dropped'); }
        s.offline.push({ topic, payload, qos: Math.min(qos, g), meta });
      }
    });
  }

  function deliver(sess, topic, payload, qos, retain, meta) {
    const pid = qos ? sess.nextPid() : null;
    const rec = pkt('OUT', sess.id, sess.id, 'PUBLISH', { topic, payload, qos, retain, pid });
    if (meta && meta.isWill) rec.will = true;
    if (qos) { sess.inflight.set(pid, { topic, qos, wait: 'PUBACK', t: now() }); setTimeout(() => { if (sess.online && sess.inflight.delete(pid)) pkt('IN', sess.id, sess.id, 'PUBACK', { pid }); }, rnd(15, 60)); }
    if (sess.owner && sess.owner.onMessage) setTimeout(() => sess.owner.onMessage(topic, meta || {}), 1);
  }

  function ping(sess) {
    if (!sess || !sess.online) return;
    pkt('IN', sess.id, sess.id, 'PINGREQ'); pkt('OUT', sess.id, sess.id, 'PINGRESP'); sess.lastIn = now();
  }

  // ---- the Sparkplug tap (tap/tracker.py, simplified) ----
  function tapLine(kind, key, text, rebirth = false) {
    const ev = { t: now(), kind, key, text, rebirth };
    S.tapEvents.unshift(ev); if (S.tapEvents.length > 300) S.tapEvents.pop();
    line('TAP', key, kind, text + (rebirth ? ' -> host requests rebirth' : ''));
    if (rebirth) emit('rebirth', ev);
  }
  function tap(topic, m) {
    const p = topic.split('/');
    if (p[0] !== 'spBv1.0') return;
    if (p[1] === 'STATE') { const on = !!m.online; S.sp.hosts.set(p[2], { online: on, t: now() }); tapLine('STATE', p[2], `host ${on ? 'online' : 'offline'}`); return; }
    const group = p[1], type = p[2], node = p[3], dev = p[4], key = `${group}/${node}`, where = dev ? `${key}/${dev}` : key;
    if (group !== 'Lab') { tapLine(type.includes('DATA') ? 'DATA' : type, where, `${type} seq=${m.seq ?? '?'}`); return; }
    const N = S.sp.node || (S.sp.node = { online: false, bdSeq: null, seq: null, born: null, died: null });
    const D = S.sp.device || (S.sp.device = { online: false, metrics: {}, born: null, lostBirths: 0 });
    if (type === 'NBIRTH') { Object.assign(N, { online: true, bdSeq: m.bdSeq, seq: 0, born: now() }); D.online = false; tapLine('BIRTH', key, `bdSeq=${m.bdSeq} metrics=2`); return; }
    if (type === 'NDEATH') {
      if (!N.online || m.bdSeq !== N.bdSeq) { tapLine('STALE', key, `NDEATH bdSeq=${m.bdSeq} != birth ${N.bdSeq}; ignored`); return; }
      Object.assign(N, { online: false, died: now(), how: m.isWill ? 'will' : 'NDEATH' }); D.online = false;
      tapLine('DEATH', key, `bdSeq=${m.bdSeq} matches birth`); return;
    }
    if (type === 'NCMD' || type === 'DCMD') { tapLine('CMD', where, `${type} [${m.names || 'Node Control/Rebirth'}]`); return; }
    if (!N.online) { tapLine('NO_BIRTH', where, `${type} before NBIRTH`, true); return; }
    const expect = (N.seq + 1) % 256;
    if (m.seq !== undefined && m.seq !== expect) tapLine('GAP', where, `${type} seq=${m.seq}, expected ${expect}`, true);
    if (m.seq !== undefined) N.seq = m.seq;
    if (type === 'DBIRTH') { D.online = true; D.born = now(); D.metrics = JSON.parse(JSON.stringify(m.metrics || {})); tapLine('DBIRTH', where, `metrics=${Object.keys(D.metrics).length}`); return; }
    if (!D.online) { tapLine('NO_BIRTH', where, `${type} before DBIRTH`, true); return; }
    if (type === 'DDEATH') { D.online = false; tapLine('DDEATH', where, 'device offline'); return; }
    const ch = m.changed || {};
    Object.entries(ch).forEach(([k, v]) => { if (D.metrics[k]) { D.metrics[k].value = v; D.metrics[k].t = now(); } });
    tapLine('DATA', where, Object.entries(ch).map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : v}`).join(' '));
  }

  // ---- lab programs ----
  const progs = S.programs;
  class Program {
    constructor(kind, id, opts) { Object.assign(this, { kind, id, opts, state: 'stopped', console: [], sess: null, timers: [], started: null }); }
    log(s) { this.console.push(`${ts(now())}  ${s}`); if (this.console.length > 200) this.console.shift(); emit('program', this); }
    every(ms, fn) { this.timers.push(setInterval(fn, ms)); }
    after(ms, fn) { this.timers.push(setTimeout(fn, ms)); }
    clear() { this.timers.forEach(t => { clearInterval(t); clearTimeout(t); }); this.timers = []; }
    start() { this.state = 'running'; this.started = now(); this.log(`$ ${this.cmd()}`); this.run(); emit('program', this); }
    stop() { this.clear(); this.goodbye(); this.state = 'stopped'; this.log('stopped (Ctrl+C)'); emit('program', this); }
    kill() { this.clear(); if (this.sess && this.sess.online) endSession(this.sess, false, 'socket closed without DISCONNECT'); this.state = 'stopped'; this.log('killed: no goodbye'); emit('program', this); }
    goodbye() { if (this.sess) disconnect(this.sess); }
    onEnded(reason) { if (this.state !== 'running') return; this.log(`connection ended: ${reason}`); if (this.reconnect) { this.log('reconnecting in 2 s'); this.clear(); this.after(2000, () => this.state === 'running' && this.run()); } else { this.clear(); this.state = 'stopped'; emit('program', this); } }
  }

  class Edge extends Program {
    constructor(id = 'edge', o = {}) { super('edge', id, Object.assign({ group: 'Lab', node: 'Edge1', device: 'PLC1', ka: 10, scan: 1.0, host: 'SCADA1', aliases: false }, o)); this.reconnect = true; this.bdSeq = -1; }
    cmd() { const o = this.opts; return `python -m edge --primary-host ${o.host}${o.scan !== 1 ? ' --scan ' + o.scan : ''}${o.aliases ? ' --aliases' : ''}`; }
    get cid() { return `${this.opts.group}-${this.opts.node}`; }
    t(type, dev) { const o = this.opts; return `spBv1.0/${o.group}/${type}/${o.node}${dev ? '/' + o.device : ''}`; }
    run() {
      this.bdSeq = (this.bdSeq + 1) % 256; this.seq = 0; this.born = false;
      this.m = this.m || { Temperature: { type: 'Double', value: 72 }, Pressure: { type: 'Float', value: 55 }, Running: { type: 'Boolean', value: true }, Starts: { type: 'Int32', value: 0 }, Setpoint: { type: 'Double', value: 50 }, Mode: { type: 'String', value: 'AUTO' } };
      this.sess = connect({ id: this.cid, peer: '127.0.0.1:' + Math.floor(rnd(50000, 60000)), origin: 'bench', ka: this.opts.ka, owner: this,
        will: { topic: this.t('NDEATH'), payload: 18, qos: 1, retain: false, meta: { bdSeq: this.bdSeq } } });
      if (!this.sess) { this.log('broker not reachable; retrying in 2 s'); this.after(2000, () => this.run()); return; }
      subscribe(this.sess, [[this.t('NCMD'), 0], [`spBv1.0/${this.opts.group}/DCMD/${this.opts.node}/+`, 0], [`spBv1.0/STATE/${this.opts.host}`, 1]]);
      const h = S.sp.hosts.get(this.opts.host);
      if (!h || !h.online) this.log(`waiting for primary host ${this.opts.host} to be online`);
      this.every(this.opts.scan * 1000, () => this.scan());
      this.every(1000, () => { if (this.sess && this.sess.online && now() - this.sess.lastIn > this.opts.ka * 1000) ping(this.sess); });
    }
    birth() {
      if (!this.sess || !this.sess.online) return;
      this.seq = 0;
      publish(this.sess, this.t('NBIRTH'), 96, 0, false, { bdSeq: this.bdSeq, seq: 0 });
      this.seq = 1;
      publish(this.sess, this.t('DBIRTH', true), 188, 0, false, { seq: 1, metrics: this.m });
      this.born = true; this.log(`born: NBIRTH bdSeq=${this.bdSeq}, DBIRTH with ${Object.keys(this.m).length} metrics`);
    }
    scan() {
      if (!this.sess || !this.sess.online) return;
      const h = S.sp.hosts.get(this.opts.host);
      if (!this.born) { if (h && h.online) this.birth(); return; }
      const m = this.m, ch = {};
      const w = Math.sin(now() / 9000) * 1.5;
      const temp = +(m.Setpoint.value + 22 + w + rnd(-0.3, 0.3)).toFixed(2);
      if (Math.abs(temp - m.Temperature.value) >= 0.5) { m.Temperature.value = temp; ch.Temperature = temp; }
      const pr = +(55 + w * 2 + rnd(-0.2, 0.2)).toFixed(2);
      if (Math.abs(pr - m.Pressure.value) >= 0.25) { m.Pressure.value = pr; ch.Pressure = pr; }
      if (!Object.keys(ch).length) return;
      this.seq = (this.seq + 1) % 256;
      publish(this.sess, this.t('DDATA', true), 14 + Object.keys(ch).length * (this.opts.aliases ? 9 : 19), 0, false, { seq: this.seq, changed: ch });
    }
    onMessage(topic, meta) {
      if (topic.includes('/STATE/') && meta.online && !this.born) { this.log(`primary host ${this.opts.host} online`); this.after(5, () => { if (!this.born) this.birth(); }); }
      else if (topic.includes('/NCMD/')) { this.log('NCMD: Node Control/Rebirth'); this.after(2, () => this.birth()); }
      else if (topic.includes('/DCMD/') && meta.write) { const [k, v] = meta.write; if (this.m[k]) { this.m[k].value = v; this.log(`DCMD: write ${k}=${v}`); this.seq = (this.seq + 1) % 256; publish(this.sess, this.t('DDATA', true), 33, 0, false, { seq: this.seq, changed: { [k]: v } }); } }
    }
    goodbye() { if (this.sess && this.sess.online) { this.seq = (this.seq + 1) % 256; publish(this.sess, this.t('NDEATH'), 18, 1, false, { bdSeq: this.bdSeq }); disconnect(this.sess); } }
  }

  class Host extends Program {
    constructor(id = 'host', o = {}) { super('host', id, Object.assign({ hostId: 'SCADA1', ka: 10 }, o)); this.reconnect = true; this.lastRebirth = 0; }
    cmd() { return `python -m host --id ${this.opts.hostId}`; }
    run() {
      const st = `spBv1.0/STATE/${this.opts.hostId}`;
      this.sess = connect({ id: `host-${this.opts.hostId}`, peer: '127.0.0.1:' + Math.floor(rnd(50000, 60000)), origin: 'bench', ka: this.opts.ka, owner: this,
        will: { topic: st, payload: 42, qos: 1, retain: true, meta: { online: false } } });
      if (!this.sess) { this.after(2000, () => this.run()); return; }
      subscribe(this.sess, [['spBv1.0/#', 0]]);
      publish(this.sess, st, 41, 1, true, { online: true });
      this.log(`STATE online at ${st}`);
      this.every(1000, () => { if (this.sess && this.sess.online && now() - this.sess.lastIn > this.opts.ka * 1000) ping(this.sess); });
    }
    rebirth(ev) {
      if (this.state !== 'running' || !this.sess || !this.sess.online) return;
      if (now() - this.lastRebirth < 5000) return;              // the host rate-limits rebirth requests
      this.lastRebirth = now();
      const node = ev.key.split('/').slice(0, 2);
      this.log(`REBIRTH ${node.join('/')}: trust lost (${ev.kind})`);
      publish(this.sess, `spBv1.0/${node[0]}/NCMD/${node[1]}`, 37, 0, false, { names: 'Node Control/Rebirth' });
    }
    write(metric, value) {
      if (!this.sess || !this.sess.online) return false;
      publish(this.sess, 'spBv1.0/Lab/DCMD/Edge1/PLC1', 34, 0, false, { names: metric, write: [metric, value] });
      this.log(`write ${metric}=${value}`); return true;
    }
    goodbye() { if (this.sess && this.sess.online) { publish(this.sess, `spBv1.0/STATE/${this.opts.hostId}`, 42, 1, true, { online: false }); disconnect(this.sess); } }
  }

  class Silent extends Program {
    constructor(id = 'silent', o = {}) { super('silent', id, Object.assign({ end: 'silence', ka: 5, willRetain: false, hold: 2 }, o)); }
    cmd() { return `python -m labs.silent --end ${this.opts.end} --keepalive ${this.opts.ka}${this.opts.willRetain ? ' --will-retain' : ''}`; }
    run() {
      this.sess = connect({ id: 'lab-silent', peer: '127.0.0.1:' + Math.floor(rnd(50000, 60000)), origin: 'bench', ka: this.opts.ka, owner: this,
        will: { topic: 'lab/silent/will', payload: 12, qos: 0, retain: this.opts.willRetain } });
      if (!this.sess) return;
      const e = this.opts.end, s = this.sess;
      this.log(`connected; ending by "${e}" after ${this.opts.hold} s`);
      if (e === 'ping') this.every(this.opts.ka * 1000, () => ping(s));
      this.after(this.opts.hold * 1000, () => {
        if (e === 'disconnect') { disconnect(s); this.state = 'stopped'; emit('program', this); }
        else if (e === 'close') { endSession(s, false, 'socket closed without DISCONNECT'); }
        else if (e === 'violation') { pkt('IN', s.id, s.id, 'CONNECT', { id: s.id, clean: true, ka: this.opts.ka }); endSession(s, false, 'protocol violation: second CONNECT'); }
        else if (e === 'silence') { this.log('silent: sending nothing'); this.after(this.opts.ka * 1500, () => endSession(s, false, 'keepalive expired (1.5x)')); }
      });
    }
  }

  class MQ extends Program {
    constructor(id = 'mq', o = {}) { super('mq', id, Object.assign({ mode: 'sub', filters: 'lab/#', qos: 0, topic: 'lab/hello', message: 'hello', retain: false, persist: false }, o)); }
    cmd() { const o = this.opts; return o.mode === 'sub' ? `python -m labs.mq sub ${o.filters} --qos ${o.qos}${o.persist ? ' --persist' : ''}` : `python -m labs.mq pub ${o.topic} "${o.message}" --qos ${o.qos}${o.retain ? ' --retain' : ''}`; }
    run() {
      const o = this.opts;
      this.sess = connect({ id: 'mq-' + Math.random().toString(16).slice(2, 6), peer: '127.0.0.1:' + Math.floor(rnd(50000, 60000)), origin: 'bench', ka: 60, owner: this, clean: !o.persist });
      if (!this.sess) return;
      if (o.mode === 'sub') { subscribe(this.sess, o.filters.split(/\s+/).filter(Boolean).map(f => [f, +o.qos])); this.reconnect = false; }
      else { publish(this.sess, o.topic, o.message.length, +o.qos, o.retain, {}); this.after(100, () => { disconnect(this.sess); this.state = 'stopped'; this.log('published; disconnected'); emit('program', this); }); }
    }
    onMessage(topic) { this.log(`${topic}`); }
  }

  class Dump extends Program {
    constructor(id = 'spdump', o = {}) { super('spdump', id, Object.assign({ filter: 'spBv1.0/#' }, o)); this.reconnect = true; }
    cmd() { return `python -m labs.spdump --filter ${this.opts.filter}`; }
    run() { this.sess = connect({ id: 'spdump', peer: '127.0.0.1:' + Math.floor(rnd(50000, 60000)), origin: 'bench', ka: 60, owner: this }); if (this.sess) subscribe(this.sess, [[this.opts.filter, 0]]); }
    onMessage(topic, m) { this.log(`${topic} seq=${m.seq ?? '-'}${m.changed ? ' ' + Object.keys(m.changed).join(',') : ''}${m.metrics ? ' metrics=' + Object.keys(m.metrics).length : ''}`); }
  }

  // a member's MQTT client on the TLS member listener
  class MemberClient extends Program {
    constructor() { super('member', 'member', {}); this.reconnect = true; }
    cmd() { return 'MQTT.fx on 203.0.113.48 (member m_4b1e09c2a7d3f581)'; }
    run() {
      this.sess = connect({ id: 'MQTT_FX_Client', peer: '203.0.113.48:' + Math.floor(rnd(50000, 60000)), origin: 'member', member: 'm_4b1e09c2a7d3f581', ka: 60, owner: this });
      if (!this.sess) { this.after(15000, () => this.state === 'running' && this.run()); return; }
      subscribe(this.sess, [['spBv1.0/Lab/#', 0], ['members/#', 0]]);
      this.every(5000, () => publish(this.sess, 'members/m_4b1e09c2a7d3f581/room-temp', 5, 0, false, {}));
      this.every(1000, () => { if (this.sess && this.sess.online && now() - this.sess.lastIn > 60000) ping(this.sess); });
    }
    onEnded(reason) { if (this.state !== 'running') return; this.clear(); this.after(15000, () => this.state === 'running' && this.run()); }
  }

  // ---- background: a stranger with a bad token tries now and then ----
  setInterval(() => { if (S.up) connect({ id: 'test-client', peer: '198.51.100.7:' + Math.floor(rnd(40000, 50000)), origin: 'member', member: 'm_77c2e5b1d09a4f36', badToken: true, ka: 30 }); }, 45000);
  // the host reacts to the tap's rebirth flags
  subs.add((k, ev) => { if (k === 'rebirth') setTimeout(() => progs.forEach(p => p.kind === 'host' && p.rebirth(ev)), 2); });

  // ---- actions the dashboard can take ----
  const A = {
    setFaults(f) {
      const F = S.faults;
      [['dropEvery', 'drop_every'], ['dropFilter', 'drop_filter'], ['willOnTakeover', 'will_on_takeover'], ['tap', 'tap']].forEach(([k, name]) => {
        if (f[k] === undefined || f[k] === F[k]) return;
        S.changelog.unshift({ t: now(), name, old: String(F[k]), new: String(f[k]), applied: 'live' });
        event('dashboard', 'FAULT', `${name} ${F[k]} -> ${f[k]}`);
        F[k] = f[k];
      });
      F.count = 0; emit('config');
    },
    saveSettings(n) {
      Object.entries(n).forEach(([k, v]) => {
        if (String(S.settings[k]) === String(v) && S.pending[k] === undefined) return;
        if (String(S.settings[k]) === String(v)) { delete S.pending[k]; return; }
        S.pending[k] = v; S.changelog.unshift({ t: now(), name: k, old: String(S.settings[k]), new: String(v), applied: 'waiting for restart' });
      });
      emit('config');
    },
    restart() {
      event('dashboard', 'RESTART', 'broker stopping');
      online().forEach(s => endSession(s, false, 'broker stopped'));
      S.up = false; S.sessions.clear(); S.retained.clear(); S.sp.node = null; S.sp.device = null; S.sp.hosts.clear();
      emit('sessions');
      setTimeout(() => {
        Object.assign(S.settings, S.pending); S.changelog.forEach(c => { if (c.applied === 'waiting for restart') c.applied = 'restart'; }); S.pending = {};
        S.up = true; S.started = now();
        event('broker', 'LISTENING', S.settings.listen.split(',')[0].trim() + (S.members.open ? ', member TLS 8883' : ''));
        emit('config'); emit('sessions');
      }, 1200);
    },
    kick(id) {
      const s = S.sessions.get(id); if (!s || !s.online) return;
      event('dashboard', 'KICK', id);
      endSession(s, false, 'socket closed without DISCONNECT');
    },
    ban(member) { S.bans.add(member); event('dashboard', 'BAN', member); online().filter(s => s.member === member).forEach(s => endSession(s, false, 'banned by the operator')); emit('sessions'); },
    unban(member) { S.bans.delete(member); event('dashboard', 'UNBAN', member); emit('sessions'); },
    dashPublish(topic, payloadText, qos, retain) {
      const len = payloadText.length;
      event('dashboard', 'PUBLISH', `${topic} q=${qos} r=${retain ? 1 : 0} (${len} B)`);
      route('dashboard', topic, len, +qos, !!retain, { text: payloadText }, null);
    },
    clearRetained(topic) { event('dashboard', 'PUBLISH', `${topic} q=0 r=1 (0 B) clear retained`); route('dashboard', topic, 0, 0, true, {}, null); emit('sessions'); },
    setMembers(o) {
      const was = S.members.open;
      Object.entries(o).forEach(([k, v]) => { if (String(S.members[k]) !== String(v)) { S.changelog.unshift({ t: now(), name: 'members.' + k, old: String(S.members[k]), new: String(v), applied: 'live' }); S.members[k] = v; } });
      if (was && !S.members.open) { event('dashboard', 'MEMBERS', 'member listener closed'); online().filter(s => s.origin === 'member').forEach(s => endSession(s, false, 'member listener closed by the operator')); }
      if (!was && S.members.open) event('dashboard', 'MEMBERS', 'member listener open on 8883');
      emit('config');
    },
    syncAccess() { S.members.listSynced = now(); event('dashboard', 'ACCESS', 'access list synced from learnscada.com: 1,248 members'); emit('config'); },
    program(kind, opts, id) {
      const C = { edge: Edge, host: Host, silent: Silent, mq: MQ, spdump: Dump }[kind];
      const key = id || kind;
      let p = progs.get(key);
      if (p && p.state === 'running') return p;
      p = new C(key, opts); if (p.kind === 'edge' && progs.get(key)) p.bdSeq = progs.get(key).bdSeq;
      progs.set(key, p); p.start(); return p;
    },
    stop(id) { const p = progs.get(id); if (p && p.state === 'running') p.stop(); },
    kill(id) { const p = progs.get(id); if (p && p.state === 'running') p.kill(); },
    preset(n) {
      const all = () => [...progs.values()].filter(p => p.state === 'running' && p.kind !== 'member');
      all().forEach(p => p.stop());
      const lab = {
        1: { dropEvery: 1, dropFilter: 'spBv1.0/+/DBIRTH/#' },
        2: { dropEvery: 1, dropFilter: 'spBv1.0/+/NDEATH/#' },
        3: { dropEvery: 0, dropFilter: 'spBv1.0/#' },
        4: { dropEvery: 10, dropFilter: 'spBv1.0/#' },
      }[n];
      A.setFaults(lab);
      event('dashboard', 'LAB', `preset Lab ${n}`);
      setTimeout(() => {
        A.program('host');
        setTimeout(() => {
          A.program('edge', n === 4 ? { scan: 0.5 } : {});
          if (n === 3) setTimeout(() => A.program('edge', {}, 'edge-2'), 1500);
        }, 600);
      }, 400);
    },
    hostWrite(metric, value) { const h = [...progs.values()].find(p => p.kind === 'host' && p.state === 'running'); return h ? h.write(metric, value) : false; },
  };

  // ---- start the bench as it would be in the middle of a session ----
  event('broker', 'LISTENING', '10.88.0.1:1884, 127.0.0.1:1884, member TLS 8883');
  setTimeout(() => A.program('host'), 300);
  setTimeout(() => A.program('edge'), 1200);
  setTimeout(() => { const m = new MemberClient(); progs.set('member', m); m.start(); }, 2500);

  return { S, A, CLASSES, classify, matches, validFilter, subscribe: fn => subs.add(fn), ts, now };
})();
