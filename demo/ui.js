/* StudyBroker mockup: the dashboard, drawn from the simulated broker in sim.js (DESIGN.md). */
'use strict';
(() => {
  const { S, A, CLASSES, matches, validFilter, ts, now } = Sim;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dur = ms => { const s = Math.max(0, Math.floor(ms / 1000)); if (s < 60) return s + 's'; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`; const h = Math.floor(m / 60); return `${h}h ${String(m % 60).padStart(2, '0')}m`; };
  const COLOR = Object.fromEntries(CLASSES.map(([k]) => [k, getComputedStyle(document.documentElement).getPropertyValue('--c-' + k).trim()]));
  const LABEL = Object.fromEntries(CLASSES.map(([k, l]) => [k, l]));
  const ORDER = CLASSES.map(c => c[0]);
  const head = (title, chips, acts = '') => `<div class="head"><h1>${title}</h1>${chips ? `<span class="chip">Book: ${chips}</span>` : ''}<div class="acts">${acts}</div></div>`;
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const keyHtml = () => `<div class="key" aria-label="Traffic color key">${CLASSES.map(([k, l, p]) => `<span class="k"><span class="sw" style="background:${COLOR[k]}"></span><b>${l}</b><span class="pk">${p}</span></span>`).join('')}</div>`;
  const download = (name, text) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); };

  // our own confirm box (resolves on the button click itself)
  function confirmBox(title, body, ok = 'OK') {
    const d = $('#confirmDlg'); $('#confirmTitle').textContent = title; $('#confirmBody').innerHTML = body; $('#confirmYes').textContent = ok;
    return new Promise(res => {
      const h = e => { const b = e.target.closest('button'); if (!b) return; e.preventDefault(); d.removeEventListener('click', h); d.close(); res(b.value === 'yes'); };
      d.addEventListener('click', h); d.showModal();
    });
  }

  // ---- traffic helpers ----
  function rate(sec = 5) {
    const end = Math.floor(now() / 1000); let i = 0, o = 0;
    for (let s = end - sec; s < end; s++) { const b = S.buckets.get(s); if (b) { Object.values(b.in).forEach(v => i += v); Object.values(b.out).forEach(v => o += v); } }
    return [i / sec, o / sec];
  }
  const sessionsOnline = () => [...S.sessions.values()].filter(s => s.online);
  const tapAlerts = (ms = 3600000) => S.tapEvents.filter(e => now() - e.t < ms && ['GAP', 'NO_BIRTH', 'STALE', 'VIOLATION'].includes(e.kind));

  // ---- status bar ----
  function statusBar() {
    const [ri, ro] = rate(), on = sessionsOnline(), mem = on.filter(s => s.origin === 'member').length, F = S.faults;
    const banners = [];
    if (F.dropEvery) banners.push(`<span class="banner"><b>FAULT</b> drop every ${F.dropEvery} · <span class="mono">${esc(F.dropFilter)}</span></span>`);
    if (!F.tap) banners.push('<span class="banner"><b>TAP OFF</b></span>');
    if (!F.willOnTakeover) banners.push('<span class="banner"><b>FAULT</b> takeover is graceful</span>');
    $('#statusBar').innerHTML = `<span class="brand">STUDYBROKER</span>
      ${S.up ? '<span class="pill"><span class="dot"></span> Broker running</span>' : '<span class="pill a"><span class="dot alarm"></span> Broker stopped</span>'}
      <span class="pill mono">bench ${esc(S.settings.listen.split(',')[0])}</span>
      <span class="pill">${S.members.open ? '<span class="dot"></span>' : '<span class="dot off"></span>'} Members <span class="mono">8883</span> · ${S.members.open ? mem + ' connected' : 'closed'}</span>
      <span class="pill">up ${dur(now() - S.started)}</span><span class="pill">${pl(on.length, 'client', 'clients')}</span>
      <span class="pill">${ri.toFixed(1)} msg/s in · ${ro.toFixed(1)} out</span>
      <span class="banners">${banners.join('')}</span>`;
  }

  // ---- navigation ----
  let cur = null;
  const screens = {};
  function show(id) {
    if (!screens[id]) id = 'overview';
    cur = id;
    $$('#nav button[data-s]').forEach(b => b.classList.toggle('on', b.dataset.s === id));
    $$('section.scr').forEach(s => s.classList.toggle('on', s.id === id));
    if (!screens[id].built) { screens[id].build($('#' + id)); screens[id].built = true; }
    screens[id].render && screens[id].render();
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  }
  $('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-s]'); if (b) show(b.dataset.s); });
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));

  const traceLine = L => `<div class="${L.tag === 'TAP' ? (['GAP', 'NO_BIRTH', 'STALE'].includes(L.what) ? 'tapw' : L.what === 'VIOLATION' ? 'tapa' : '') : L.what === 'DROPPED' ? 'drop' : L.what === 'POLICY' ? 'tapw' : L.tag === '--' ? 'ev' : ''}" data-id="${L.id}" title="${L.cls ? LABEL[L.cls] : ''}"><span class="cs" style="background:${L.cls ? COLOR[L.cls] : 'transparent'}"></span>${esc(L.text)}</div>`;

  // ================= Overview =================
  screens.overview = {
    build(el) {
      el.innerHTML = head('Overview', 'Ch 1, 2') + `<div class="grid tiles" id="ovTiles"></div>
        <div class="grid two"><div class="panel"><h2>Now</h2><div class="trace" style="height:300px" id="ovNow"></div></div>
        <div class="grid" style="gap:.9rem;align-content:start"><div class="panel"><h2>Alerts</h2><div id="ovAlerts"></div></div>
        <div class="panel"><h2>Lab programs</h2><div id="ovProgs"></div></div></div></div>`;
      el.addEventListener('click', e => { const b = e.target.closest('[data-stop]'); if (b) A.stop(b.dataset.stop); const g = e.target.closest('[data-go]'); if (g) show(g.dataset.go); });
    },
    render() {
      const on = sessionsOnline(), held = [...S.sessions.values()].filter(s => !s.online && !s.clean).length, [ri, ro] = rate();
      const N = S.sp.node, D = S.sp.device, alerts = tapAlerts();
      const spark = (() => { const end = Math.floor(now() / 1000); const v = []; for (let s = end - 60; s < end; s++) { const b = S.buckets.get(s); v.push(b ? Object.values(b.in).reduce((a, c) => a + c, 0) : 0); } const mx = Math.max(1, ...v); return `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-label="Messages in per second, last minute"><polyline fill="none" stroke="#4a4c52" stroke-width="1.5" points="${v.map((x, i) => `${i * 100 / 59},${26 - x / mx * 22}`).join(' ')}"/></svg>`; })();
      const kinds = {}; alerts.forEach(a => kinds[a.kind] = (kinds[a.kind] || 0) + 1);
      $('#ovTiles').innerHTML = `
        <div class="panel tile"><div class="lbl">Clients connected</div><div class="val">${on.length}</div><div class="sub">${esc(on.map(s => s.id).join(', ') || 'none')}</div></div>
        <div class="panel tile"><div class="lbl">Members connected</div><div class="val">${on.filter(s => s.origin === 'member').length}</div><div class="sub">listener ${S.members.open ? 'open on 8883' : 'closed'}</div></div>
        <div class="panel tile"><div class="lbl">Messages / s in</div><div class="val">${ri.toFixed(1)}</div>${spark}</div>
        <div class="panel tile"><div class="lbl">Retained topics</div><div class="val">${S.retained.size}</div><div class="sub">${held} persistent sessions offline</div></div>
        <div class="panel tile"><div class="lbl">Sparkplug</div><div class="val">${N && N.online ? 1 : 0} / ${N ? 1 : 0}</div><div class="sub">${N && N.online ? (D && D.online ? 'node and device born' : '<span class="a">device not born</span>') : 'no node online'}</div></div>
        <div class="panel tile ${alerts.length ? 'warn' : ''}"><div class="lbl">Tap alerts, last hour</div><div class="val">${alerts.length}</div><div class="sub">${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(' · ') || 'none'}</div></div>`;
      $('#ovNow').innerHTML = S.trace.slice(-14).map(traceLine).join('');
      const al = [];
      if (!S.up) al.push(['alarm', 'Broker stopped', 'Restarting.', 'faults']);
      if (N && N.online && D && !D.online) al.push(['alarm', 'Lab/Edge1/PLC1 not born', 'Data arrives for a device with no birth.', 'sparkplug']);
      if (S.faults.dropEvery) al.push(['warn', 'Fault knob on', `Drop every ${S.faults.dropEvery} matching <span class="mono">${esc(S.faults.dropFilter)}</span>.`, 'faults']);
      if (!S.members.open) al.push(['warn', 'Closed to members', 'The member listener is off.', 'faults']);
      if (S.refused.length && now() - S.refused[0].t < 300000) al.push(['warn', 'Refused sign-in', `${esc(S.refused[0].id)}: return code ${S.refused[0].rc}.`, 'clients']);
      $('#ovAlerts').innerHTML = al.length ? `<table><tbody>${al.map(([k, t, d, go]) => `<tr><td><span class="dot ${k}"></span></td><td><b>${t}</b><br><span class="note">${d} <a href="#${go}" data-go="${go}">Open</a></span></td></tr>`).join('')}</tbody></table>` : '<p class="note">No alerts.</p>';
      const ps = [...S.programs.values()].filter(p => p.state === 'running');
      $('#ovProgs').innerHTML = ps.length ? `<table><tbody>${ps.map(p => `<tr><td><span class="dot"></span> ${esc(p.kind === 'member' ? 'Member client' : p.id)} <span class="mono note">${esc(p.cmd())}</span></td><td class="num note">${dur(now() - p.started)}</td><td class="num">${p.kind === 'member' ? '' : `<button class="btn sm" data-stop="${p.id}">Stop</button>`}</td></tr>`).join('')}</tbody></table>` : '<p class="note">Nothing running. Start a program on the Labs screen.</p>';
    },
  };

  // ================= Clients =================
  let selClient = null;
  screens.clients = {
    build(el) {
      el.innerHTML = head('Clients and sessions', 'Ch 4, 7, 8', '<span class="note">Click a row for its detail.</span>') +
        `<div class="split" id="clSplit"><div class="panel" style="overflow:auto"><table><thead><tr><th>State</th><th>Client id</th><th>Origin</th><th>Member</th><th>Peer</th><th class="num">Clean</th><th>Keepalive</th><th>Connected</th><th class="num">Subs</th><th class="num">In flight</th><th class="num">Queue</th><th class="num">Dropped</th><th>Will</th></tr></thead><tbody id="clRows"></tbody></table>
         <h3>Bans</h3><div id="clBans" class="note"></div></div>
         <aside class="panel drawer" id="clDrawer" aria-label="Session detail"></aside></div>`;
      el.addEventListener('click', async e => {
        const tr = e.target.closest('tr[data-id]'); if (tr) { selClient = tr.dataset.id; this.render(); return; }
        if (e.target.closest('#clClose')) { selClient = null; this.render(); return; }
        const k = e.target.closest('[data-kick]');
        if (k && await confirmBox(`Kick ${k.dataset.kick}?`, 'The socket is closed without DISCONNECT. The broker ends the session as a lost connection and publishes the will. A lab program reconnects after 2 seconds.', 'Kick')) A.kick(k.dataset.kick);
        const bn = e.target.closest('[data-ban]');
        if (bn && await confirmBox(`Ban ${bn.dataset.ban}?`, 'Their sessions end now, and every new sign-in from this member is refused with return code 5 until you lift the ban.', 'Ban')) A.ban(bn.dataset.ban);
        const ub = e.target.closest('[data-unban]'); if (ub) A.unban(ub.dataset.unban);
      });
    },
    render() {
      const rows = [];
      [...S.sessions.values()].forEach(s => {
        const since = (now() - s.lastIn) / 1000, frac = Math.min(1, since / (s.ka * 1.5));
        rows.push(`<tr class="click ${selClient === s.id ? 'sel' : ''} ${s.online ? '' : 'ended'}" data-id="${esc(s.id)}"><td>${s.online ? '<span class="dot"></span> online' : '<span class="dot off"></span> offline'}</td>
          <td class="mono">${esc(s.id)}</td><td>${s.origin}${s.origin === 'member' ? ' <span class="tag">TLS</span>' : ''}</td><td class="mono">${esc(s.member || '-')}</td><td class="mono">${esc(s.peer)}</td>
          <td class="num">${s.clean ? 1 : 0}</td><td class="mono">${s.ka} s <span class="kbar ${frac > .75 ? 'warn' : ''}"><i style="width:${s.online ? frac * 100 : 0}%"></i></span></td><td>${dur(now() - s.connected)}</td>
          <td class="num">${s.subs.size}</td><td class="num">${s.inflight.size}</td><td class="num">${s.offline.length} / ${s.origin === 'member' ? 100 : S.settings.queueLimit}</td><td class="num">${s.dropped}</td><td class="mono">${esc(s.will ? s.will.topic : '-')}</td></tr>`);
      });
      S.ended.filter(x => now() - x.t < 300000 && !(S.sessions.get(x.id) || {}).online).slice(0, 6).forEach(x => rows.push(`<tr class="ended"><td><span class="dot off"></span> ended</td><td class="mono">${esc(x.id)}</td><td>${x.origin}</td><td class="mono">${esc(x.member || '-')}</td><td class="mono">${esc(x.peer)}</td><td colspan="8">ended ${dur(now() - x.t)} ago: ${esc(x.reason)}</td></tr>`));
      S.refused.filter(x => now() - x.t < 3600000).slice(0, 5).forEach(x => rows.push(`<tr class="ended"><td><span class="dot alarm"></span> refused</td><td class="mono">${esc(x.id)}</td><td>member</td><td class="mono">${esc(x.member || '-')}</td><td class="mono">${esc(x.peer)}</td><td colspan="8">CONNACK return code ${x.rc}: ${esc(x.why)}, ${dur(now() - x.t)} ago</td></tr>`));
      $('#clRows').innerHTML = rows.join('');
      $('#clBans').innerHTML = S.bans.size ? [...S.bans].map(m => `<span class="mono">${esc(m)}</span> <button class="btn sm" data-unban="${esc(m)}">Lift</button>`).join(' ') : 'None.';
      const s = selClient && S.sessions.get(selClient);
      $('#clSplit').classList.toggle('open', !!s);
      if (!s) return;
      const lines = S.trace.filter(L => L.who === s.id || (L.rec && L.rec.client === s.id)).slice(-10);
      $('#clDrawer').innerHTML = `<div style="display:flex;align-items:center;gap:.5rem"><h2 style="margin:0">Session</h2><span class="mono"><b>${esc(s.id)}</b></span><button class="btn sm" style="margin-left:auto" id="clClose">Close</button></div>
        <dl class="kv" style="margin-top:.7rem"><dt>Peer</dt><dd class="mono">${esc(s.peer)}</dd><dt>Origin</dt><dd>${s.origin}${s.member ? ', member <span class="mono">' + esc(s.member) + '</span>' : ''}</dd>
        <dt>Clean session</dt><dd>${s.clean ? '1 (ends with the connection)' : '0 (persistent: kept while offline)'}</dd><dt>Keepalive</dt><dd>${s.ka} s; last packet ${((now() - s.lastIn) / 1000).toFixed(1)} s ago; expires at ${s.ka * 1.5} s</dd>
        <dt>Will</dt><dd class="mono">${s.will ? `${esc(s.will.topic)} · q=${s.will.qos} r=${s.will.retain ? 1 : 0} · ${s.will.payload} B` : 'none'}</dd></dl>
        <h3>Subscriptions</h3>${s.subs.size ? `<table><tbody>${[...s.subs].map(([f, q]) => `<tr><td class="mono">${esc(f)}</td><td class="num">QoS ${q}</td></tr>`).join('')}</tbody></table>` : '<p class="note">None.</p>'}
        <h3>In flight</h3>${s.inflight.size ? `<table><tbody>${[...s.inflight].map(([p, f]) => `<tr><td class="mono">id=${p}</td><td class="mono">${esc(f.topic)}</td><td>waits ${f.wait}</td></tr>`).join('')}</tbody></table>` : '<p class="note">None. Every outbound QoS 1 flow is complete.</p>'}
        <h3>Offline queue</h3><p class="note">${s.offline.length ? s.offline.length + ' queued' : 'Empty (only persistent sessions queue while offline).'}</p>
        <h3>Last trace lines</h3><div class="trace" style="height:170px">${lines.map(traceLine).join('')}</div>
        ${s.online ? `<div style="display:flex;gap:.5rem;margin-top:.7rem;flex-wrap:wrap"><button class="btn danger" data-kick="${esc(s.id)}">Kick (no DISCONNECT)</button>${s.member ? `<button class="btn danger" data-ban="${esc(s.member)}">Ban member</button>` : ''}</div>` : ''}`;
    },
  };

  // ================= Topics =================
  const topicStats = new Map();
  Sim.subscribe((k, L) => {
    if (k !== 'line') return;
    let topic = null, size = 0;
    if (L.rec && L.rec.type === 'PUBLISH' && L.rec.dir === 'IN') { topic = L.rec.topic; size = L.rec.payload; }
    else if (L.what === 'WILL' && L.detail.startsWith('-> ')) topic = L.detail.slice(3);
    else if (L.who === 'dashboard' && L.what === 'PUBLISH') topic = L.detail.split(' ')[0];
    if (!topic) return;
    const s = topicStats.get(topic) || { n: 0, t: 0, size: 0 }; s.n++; s.t = L.t; s.size = size || s.size; topicStats.set(topic, s);
  });
  let selTopic = 'spBv1.0/Lab/DDATA/Edge1/PLC1', open = new Set(['spBv1.0', 'spBv1.0/Lab']);
  screens.topics = {
    build(el) {
      el.innerHTML = head('Topics', 'Ch 5, 6', '<button class="btn" id="tpPubBtn">Publish...</button>') + `
        <div class="grid two" style="margin-top:0"><div class="panel"><h2>Topic tree</h2>
          <div class="filters"><input type="text" id="tpFilter" placeholder="Test a filter, e.g. spBv1.0/+/DDATA/#" style="width:100%"></div><p class="note" id="tpFilterNote"></p>
          <div class="tree" id="tpTree"></div></div>
        <div class="grid" style="gap:.9rem;align-content:start"><div class="panel" id="tpDetail"></div>
        <div class="panel" id="tpPub" hidden><h2>Publish as "dashboard"</h2><div class="form" style="grid-template-columns:6rem 1fr">
          <label for="pT">Topic</label><input id="pT" type="text" class="mono" value="lab/hello"><label for="pP">Payload</label><input id="pP" type="text" value="hello from the dashboard">
          <label for="pQ">QoS</label><select id="pQ"><option>0</option><option>1</option></select><label for="pR">Retain</label><input id="pR" type="checkbox"></div>
          <div style="margin-top:.7rem;display:flex;gap:.5rem"><button class="btn primary" id="pGo">Publish</button><span class="note" id="pNote"></span></div></div></div></div>`;
      el.addEventListener('click', async e => {
        const n = e.target.closest('[data-node]'); if (n) { const p = n.dataset.node; open.has(p) ? open.delete(p) : open.add(p); selTopic = n.dataset.leaf ? p : selTopic; if (n.dataset.leaf) selTopic = p; this.render(); return; }
        if (e.target.closest('#tpPubBtn')) { $('#tpPub').hidden = !$('#tpPub').hidden; return; }
        if (e.target.closest('#pGo')) { const t = $('#pT').value.trim(); if (!t || /[#+]/.test(t)) { $('#pNote').textContent = 'A topic name, without wildcards.'; return; } A.dashPublish(t, $('#pP').value, $('#pQ').value, $('#pR').checked); $('#pNote').textContent = 'Published and traced.'; selTopic = t; this.render(); return; }
        const c = e.target.closest('[data-clear]');
        if (c && await confirmBox('Clear the retained message?', `Publishes an empty retained message to <span class="mono">${esc(c.dataset.clear)}</span>. New subscribers will no longer get one.`, 'Clear')) { A.clearRetained(c.dataset.clear); this.render(); }
      });
      $('#tpFilter').addEventListener('input', () => this.render());
    },
    render() {
      const f = $('#tpFilter').value.trim(), fv = f && validFilter(f);
      $('#tpFilterNote').textContent = f ? (fv ? `${[...topicStats.keys()].filter(t => matches(f, t)).length} topics match.` : 'Not a valid filter (# only at the end, + only as a whole level).') : 'Type a filter to see what it matches, using the broker\'s own matching.';
      const topics = [...new Set([...topicStats.keys(), ...S.retained.keys()])].sort();
      const tree = {};
      topics.forEach(t => { let n = tree; t.split('/').forEach(p => { n = n[p] = n[p] || {}; }); });
      const walk = (n, path, depth) => Object.keys(n).sort().map(k => {
        const p = path ? path + '/' + k : k, leaf = topicStats.has(p) || S.retained.has(p), kids = Object.keys(n[k]).length, st = topicStats.get(p);
        const hit = fv && leaf && matches(f, p);
        return `<div class="n ${selTopic === p ? 'sel' : ''} ${hit ? 'hit' : ''}" style="padding-left:${0.4 + depth * 1.1}rem" data-node="${esc(p)}" ${leaf ? 'data-leaf="1"' : ''}>${kids ? (open.has(p) ? '▾' : '▸') : '·'} <span class="mono">${esc(k)}</span>${S.retained.has(p) ? ' <span class="tag">R</span>' : ''}<span class="meta">${st ? `${st.n} msgs · ${dur(now() - st.t)} ago` : ''}</span></div>` + (kids && (open.has(p) || fv) ? walk(n[k], p, depth + 1) : '');
      }).join('');
      $('#tpTree').innerHTML = walk(tree, '', 0) || '<p class="note">No messages yet.</p>';
      const st = topicStats.get(selTopic), r = S.retained.get(selTopic);
      const subsM = []; [...S.sessions.values()].filter(s => s.online).forEach(s => s.subs.forEach((q, fl) => { if (matches(fl, selTopic)) subsM.push([s.id, fl, q]); }));
      const recent = S.packets.filter(p => p.type === 'PUBLISH' && p.dir === 'IN' && p.topic === selTopic).slice(-8).reverse();
      $('#tpDetail').innerHTML = `<h2>Topic</h2><p class="mono" style="margin:.2rem 0 .6rem;word-break:break-all"><b>${esc(selTopic)}</b></p>
        <dl class="kv"><dt>Messages</dt><dd>${st ? st.n : 0}${st ? `, last ${dur(now() - st.t)} ago` : ''}</dd><dt>Class</dt><dd><span class="sw" style="display:inline-block;width:10px;height:10px;background:${COLOR[Sim.classify('PUBLISH', selTopic)]}"></span> ${LABEL[Sim.classify('PUBLISH', selTopic)]}</dd>
        <dt>Retained</dt><dd>${r ? `${r.payload} B, QoS ${r.qos}, from ${esc(r.sender)} <button class="btn sm danger" data-clear="${esc(selTopic)}">Clear retained</button>` : 'no'}</dd></dl>
        <h3>Matching subscriptions</h3>${subsM.length ? `<table><tbody>${subsM.map(([c, fl, q]) => `<tr><td class="mono">${esc(c)}</td><td class="mono">${esc(fl)}</td><td class="num">QoS ${q}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No subscriber matches this topic right now.</p>'}
        <h3>Recent messages</h3>${recent.length ? `<table><tbody>${recent.map(p => `<tr><td class="mono">${ts(p.t)}</td><td class="mono">${esc(p.client)}</td><td class="num">${p.payload} B</td><td class="num">q${p.qos}${p.dropped ? ' <span class="w">DROPPED</span>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="note">None in the buffer.</p>'}`;
    },
  };

  // ================= Sparkplug =================
  screens.sparkplug = {
    build(el) { el.innerHTML = head('Sparkplug', 'Ch 9 to 11, 14, 15, 18') + '<div class="panel" id="spHosts" style="margin-bottom:.9rem"></div><div class="grid two" style="margin-top:0"><div class="panel" id="spTree"></div><div class="panel"><h2>Tap events</h2><div style="max-height:520px;overflow:auto"><table><thead><tr><th>Time</th><th>Kind</th><th>Where</th><th>Detail</th></tr></thead><tbody id="spEvents"></tbody></table></div></div></div>'; },
    render() {
      const hosts = [...S.sp.hosts];
      $('#spHosts').innerHTML = `<div style="display:flex;gap:2rem;flex-wrap:wrap"><div><span class="note">Primary hosts (Sparkplug 3.0 STATE)</span><br>${hosts.length ? hosts.map(([h, v]) => `<span class="mono"><b>${esc(h)}</b></span> ${v.online ? '<span class="dot"></span> online' : '<span class="dot off"></span> offline'} <span class="note">since ${ts(v.t).slice(0, 8)}</span>`).join(' &nbsp; ') : '<span class="note">none seen</span>'}</div>
        <div><span class="note">Tap</span><br>${S.faults.tap ? 'on' : '<span class="w">off</span>'} · sees what the broker routed; a message dropped by a fault knob never reaches it (Chapter 19)</div></div>`;
      const N = S.sp.node, D = S.sp.device;
      const m = D ? D.metrics : {};
      $('#spTree').innerHTML = `<h2>Groups, nodes and devices</h2>${N ? `<div class="tree"><div class="n"><b>Lab</b><span class="meta">group</span></div>
        <div class="n" style="padding-left:1.4rem">${N.online ? '<span class="dot"></span>' : '<span class="dot off"></span>'} Edge1 <span class="meta mono">bdSeq ${N.bdSeq ?? '-'} · seq ${N.seq ?? '-'}${N.online ? '' : ' · offline (' + (N.how || 'never born') + ')'}</span></div>
        <div class="n sel" style="padding-left:2.8rem">${D && D.online ? '<span class="dot"></span> PLC1' : '<span class="dot alarm"></span> PLC1 <span class="unborn">NOT BORN</span>'}<span class="meta">${D && D.born ? 'born ' + ts(D.born).slice(0, 8) : ''}</span></div></div>
        <h3 style="margin-top:1rem">PLC1 metrics</h3>${D && D.online ? `<table><thead><tr><th>Name</th><th>Type</th><th class="num">Value</th><th>Changed</th></tr></thead><tbody>${Object.entries(m).map(([k, v]) => `<tr><td class="mono">${k}</td><td>${v.type}</td><td class="num mono">${typeof v.value === 'number' && !Number.isInteger(v.value) ? v.value.toFixed(2) : v.value}</td><td class="note">${v.t ? dur(now() - v.t) + ' ago' : 'at birth'}</td></tr>`).join('')}</tbody></table>` : '<p class="note">No device birth has arrived, so a host has no metric model for PLC1. Its data is flagged NO_BIRTH and its tags stay unborn so nobody trusts them.</p>'}` : '<p class="note">No Sparkplug node seen yet. Start the edge node on the Labs screen.</p>'}`;
      $('#spEvents').innerHTML = S.tapEvents.slice(0, 80).map(e => `<tr><td class="mono">${ts(e.t).slice(0, 8)}</td><td class="${['NO_BIRTH', 'VIOLATION'].includes(e.kind) ? 'a' : ['GAP', 'STALE'].includes(e.kind) ? 'w' : ''}">${e.kind}</td><td class="mono">${esc(e.key)}</td><td>${esc(e.text)}${e.rebirth ? ' <span class="tag">rebirth</span>' : ''}</td></tr>`).join('');
    },
  };

  // ================= Trace =================
  let paused = false, pausedNew = 0, traceSel = null;
  const tf = { IN: true, OUT: true, '--': true, TAP: true, client: '', type: '', topic: '' };
  const passes = L => tf[L.tag] !== false && (!tf.client || L.who.includes(tf.client) || (L.rec && L.rec.client.includes(tf.client))) && (!tf.type || L.what.includes(tf.type.toUpperCase())) && (!tf.topic || L.detail.includes(tf.topic));
  screens.trace = {
    build(el) {
      el.innerHTML = head('Trace', 'Ch 2, 3, App. A', '<label class="note" style="display:inline-flex;gap:.3rem;align-items:center"><input type="checkbox" id="trStripes" checked> Class stripes</label><button class="btn" id="trPause">Pause</button><button class="btn" id="trDl">Download view</button>') +
        `<div class="filters"><label><input type="checkbox" data-tag="IN" checked> IN</label><label><input type="checkbox" data-tag="OUT" checked> OUT</label><label><input type="checkbox" data-tag="--" checked> Events</label><label><input type="checkbox" data-tag="TAP" checked> TAP</label>
        <input type="text" id="trClient" placeholder="Client id"><input type="text" id="trType" placeholder="Packet type, e.g. PUBLISH"><input type="text" id="trTopic" placeholder="Topic contains"><span class="note" id="trCount"></span></div>
        <div class="trace" id="trBox" style="height:470px"></div><div class="panel" id="trDetail" style="margin-top:.7rem" hidden></div>`;
      const rebuild = () => { const box = $('#trBox'); box.innerHTML = S.trace.filter(passes).slice(-1500).map(traceLine).join(''); box.scrollTop = box.scrollHeight; this.count(); };
      this.rebuild = rebuild;
      el.addEventListener('change', e => { if (e.target.dataset.tag) { tf[e.target.dataset.tag] = e.target.checked; rebuild(); } if (e.target.id === 'trStripes') $('#trBox').classList.toggle('nostripes', !e.target.checked); });
      [['trClient', 'client'], ['trType', 'type'], ['trTopic', 'topic']].forEach(([id, k]) => $('#' + id).addEventListener('input', e => { tf[k] = e.target.value.trim(); rebuild(); }));
      $('#trPause').addEventListener('click', () => { paused = !paused; pausedNew = 0; if (!paused) rebuild(); this.count(); });
      $('#trDl').addEventListener('click', () => download(`trace-${new Date().toISOString().slice(0, 19).replace(/:/g, '')}.log`, S.trace.filter(passes).map(L => L.text).join('\n') + '\n'));
      $('#trBox').addEventListener('click', e => { const d = e.target.closest('div[data-id]'); if (!d) return; traceSel = S.trace.find(L => L.id === +d.dataset.id); this.detail(); });
      rebuild();
    },
    count() { $('#trPause').textContent = paused ? `Paused, ${pausedNew} new lines` : 'Pause'; $('#trCount').textContent = `${S.trace.filter(passes).length} lines in view · click a line for its fields`; },
    append(lines) {
      if (paused) { pausedNew += lines.filter(passes).length; this.count(); return; }
      const box = $('#trBox'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
      box.insertAdjacentHTML('beforeend', lines.filter(passes).map(traceLine).join(''));
      while (box.childElementCount > 1500) box.firstElementChild.remove();
      if (atBottom) box.scrollTop = box.scrollHeight;
    },
    detail() {
      const L = traceSel, d = $('#trDetail'); if (!L) { d.hidden = true; return; }
      const r = L.rec;
      d.hidden = false;
      d.innerHTML = `<h2>Line ${L.id}</h2><dl class="kv"><dt>Time</dt><dd class="mono">${ts(L.t)}</dd><dt>Direction</dt><dd>${{ IN: 'IN (client to broker)', OUT: 'OUT (broker to client)', '--': 'event', TAP: 'Sparkplug tap' }[L.tag]}</dd><dt>Who</dt><dd class="mono">${esc(L.who)}</dd><dt>What</dt><dd>${esc(L.what)}</dd>
        ${r ? `<dt>Traffic class</dt><dd><span class="sw" style="display:inline-block;width:10px;height:10px;background:${COLOR[r.cls]}"></span> ${LABEL[r.cls]}</dd><dt>Bytes on the wire</dt><dd>${r.bytes}</dd>${r.topic ? `<dt>Topic</dt><dd class="mono">${esc(r.topic)}</dd><dt>QoS / retain</dt><dd>${r.qos} / ${r.retain ? 1 : 0}</dd>` : ''}${r.dropped ? '<dt>Fault</dt><dd class="w">dropped by the fault knob: not retained, not routed, not seen by the tap</dd>' : ''}` : ''}
        <dt>Fields</dt><dd class="mono">${esc(L.detail) || '(none)'}</dd></dl><p class="note">In the live dashboard a PUBLISH also shows its payload in hex and, under spBv1.0, the decoded Sparkplug payload.</p>`;
    },
  };
  let pendingLines = [];
  Sim.subscribe((k, L) => { if (k === 'line') pendingLines.push(L); });
  setInterval(() => { if (!pendingLines.length) return; const l = pendingLines; pendingLines = []; if (screens.trace.built) screens.trace.append(l); }, 250);

  // ================= Diagnostics =================
  const dg = { win: 300, dir: 'all', measure: 'pk', client: '', paused: false };
  screens.diags = {
    build(el) {
      el.innerHTML = head('Diagnostics', 'Ch 3, 7, 10, 16, 19', '<button class="btn" id="dgPause">Pause</button>') + `<div class="filters" id="dgCtl">
        <span class="seg" data-k="win"><button data-v="60">1 min</button><button data-v="300" class="on">5 min</button><button data-v="900">15 min</button></span>
        <span class="seg" data-k="dir"><button data-v="all" class="on">All</button><button data-v="in">In</button><button data-v="out">Out</button></span>
        <span class="seg" data-k="measure"><button data-v="pk" class="on">Packets/s</button><button data-v="by">Bytes/s</button></span>
        <select id="dgClient" aria-label="Client"><option value="">All clients</option></select></div>${keyHtml()}
        <div class="health" id="dgHealth"></div>
        <div class="dgrid"><div class="panel"><h2>Traffic over time <span class="note" id="dgUnit" style="text-transform:none;letter-spacing:0"></span></h2><div class="chartwrap" id="dgWrap"><svg id="dgArea" viewBox="0 0 640 220" preserveAspectRatio="none" role="img" aria-label="Traffic by class over time"></svg><div class="tip" id="dgTip"></div></div><p class="note" style="margin:.4rem 0 0">Hollow ticks on the axis: packets dropped by the fault knob.</p></div>
        <div class="panel"><h2>Class totals <span class="note" id="dgWinLbl" style="text-transform:none;letter-spacing:0"></span></h2><div class="bars" id="dgBars"></div></div></div>
        <div class="dgrid" style="margin-top:.9rem"><div class="panel"><h2>Wire view <span class="note" style="text-transform:none;letter-spacing:0">last packets, newest at the bottom; click one to open it in the Trace</span></h2><div class="ladder" id="dgLadder"></div></div>
        <div class="grid" style="gap:.9rem;align-content:start"><div class="panel"><h2>By client</h2><table><thead><tr><th>Client</th><th>Mix</th><th class="num">In</th><th class="num">Out</th><th class="num">Bytes</th></tr></thead><tbody id="dgClients"></tbody></table></div>
        <div class="panel"><h2>Payload sizes <span class="note" style="text-transform:none;letter-spacing:0">PUBLISH, bytes</span></h2><div class="bars" id="dgSizes"></div><p class="note" style="margin:.4rem 0 0">Births carry the whole metric model; data carries only what changed (Chapters 15, 16).</p></div></div></div>`;
      $('#dgCtl').addEventListener('click', e => { const b = e.target.closest('.seg button'); if (!b) return; const seg = b.parentElement; $$('button', seg).forEach(x => x.classList.toggle('on', x === b)); dg[seg.dataset.k] = seg.dataset.k === 'win' ? +b.dataset.v : b.dataset.v; this.render(); });
      $('#dgClient').addEventListener('change', e => { dg.client = e.target.value; this.render(); });
      $('#dgPause').addEventListener('click', e => { dg.paused = !dg.paused; e.target.textContent = dg.paused ? 'Paused' : 'Pause'; });
      $('#dgLadder').addEventListener('click', e => { const a = e.target.closest('[data-line]'); if (!a) return; traceSel = S.trace.find(L => L.id === +a.dataset.line); show('trace'); screens.trace.detail(); });
      const wrap = $('#dgWrap');
      wrap.addEventListener('mousemove', e => this.hover(e)); wrap.addEventListener('mouseleave', () => { $('#dgTip').style.display = 'none'; const x = $('#dgXh'); if (x) x.setAttribute('visibility', 'hidden'); });
    },
    series() {
      const N = 60, step = dg.win / N, end = Math.floor(now() / 1000), out = ORDER.map(() => new Array(N).fill(0)), drops = new Array(N).fill(0);
      const useCl = dg.client;
      if (useCl) {   // per-client view from the packet buffer
        S.packets.filter(p => p.client === useCl && p.t / 1000 > end - dg.win && (dg.dir === 'all' || p.dir.toLowerCase() === dg.dir)).forEach(p => { const i = Math.min(N - 1, Math.floor((p.t / 1000 - (end - dg.win)) / step)); out[ORDER.indexOf(p.cls)][i] += (dg.measure === 'pk' ? 1 : p.bytes) / step; });
      } else for (let i = 0; i < N; i++) for (let s = Math.floor(end - dg.win + i * step); s < end - dg.win + (i + 1) * step; s++) {
        const b = S.buckets.get(s); if (!b) continue;
        ORDER.forEach((k, j) => { const src = dg.measure === 'pk' ? [b.in, b.out] : [b.bin, b.bout]; const v = (dg.dir !== 'out' ? src[0][k] || 0 : 0) + (dg.dir !== 'in' ? src[1][k] || 0 : 0); out[j][i] += v / step; });
      }
      S.trace.filter(L => L.what === 'DROPPED' && L.t / 1000 > end - dg.win).forEach(L => { drops[Math.min(N - 1, Math.floor((L.t / 1000 - (end - dg.win)) / step))]++; });
      return { out, drops, N };
    },
    hover(e) {
      if (!this.last) return;
      const { out, drops, N } = this.last, W = 640, P = { l: 34, r: 8 }, r = $('#dgArea').getBoundingClientRect(), px = (e.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(N - 1, Math.round((px - P.l) / ((W - P.l - P.r) / (N - 1)))));
      const x = P.l + i * (W - P.l - P.r) / (N - 1), xh = $('#dgXh'); xh.setAttribute('x1', x); xh.setAttribute('x2', x); xh.setAttribute('visibility', 'visible');
      const ago = Math.round((N - 1 - i) * dg.win / N), u = dg.measure === 'pk' ? '/s' : ' B/s', tip = $('#dgTip');
      tip.innerHTML = `<b>${ago ? ago + ' s ago' : 'now'}</b>` + ORDER.slice().reverse().map(k => `<div class="r"><span class="sw" style="width:10px;height:10px;border-radius:2px;background:${COLOR[k]}"></span>${LABEL[k]}<b>${out[ORDER.indexOf(k)][i].toFixed(dg.measure === 'pk' ? 2 : 0)}${u}</b></div>`).join('') + (drops[i] ? `<div class="r" style="color:#7a5408">DROPPED: ${drops[i]}</div>` : '');
      tip.style.display = 'block'; const wrap = $('#dgWrap'), left = e.clientX - wrap.getBoundingClientRect().left;
      tip.style.left = (left > wrap.clientWidth / 2 ? left - tip.offsetWidth - 12 : left + 12) + 'px'; tip.style.top = '8px';
    },
    render() {
      const on = sessionsOnline();
      const sel = $('#dgClient'), ids = [...new Set([...S.clients.keys()])].filter(Boolean).sort();
      if (sel.options.length - 1 !== ids.length) sel.innerHTML = '<option value="">All clients</option>' + ids.map(i => `<option ${i === dg.client ? 'selected' : ''}>${esc(i)}</option>`).join('');
      const waiting = on.reduce((a, s) => a + s.inflight.size, 0), dropsWin = S.trace.filter(L => L.what === 'DROPPED' && now() - L.t < dg.win * 1000).length, maxQ = Math.max(0, ...[...S.sessions.values()].map(s => s.offline.length)), al = tapAlerts(dg.win * 1000), pol = S.trace.filter(L => L.what === 'POLICY' && now() - L.t < dg.win * 1000).length;
      $('#dgHealth').innerHTML = [[waiting ? 'warn' : 'ok', `${waiting} waiting`, 'QoS flows awaiting an ack'], [dropsWin ? 'warn' : 'ok', `${dropsWin} dropped`, 'by the fault knob in the window'], [maxQ > 50 ? 'warn' : 'ok', `${maxQ} queued`, 'fullest offline queue'], [al.length ? 'alarm' : 'ok', pl(al.length, 'tap alert', 'tap alerts'), 'GAP, NO_BIRTH, STALE, VIOLATION'], [pol ? 'warn' : 'ok', pl(pol, 'guard action', 'guard actions'), 'member POLICY events']]
        .map(([k, b, n]) => `<div class="panel"><span class="ic ${k}" aria-hidden="true">${k === 'ok' ? '&#10003;' : '!'}</span><div><b>${b}</b><span class="note">${n}</span></div></div>`).join('');
      if (dg.paused) return;
      const { out, drops, N } = this.last = this.series(), W = 640, H = 220, P = { l: 34, r: 8, t: 8, b: 22 };
      const tot = [...Array(N).keys()].map(i => out.reduce((s, a) => s + a[i], 0)), raw = Math.max(1, ...tot);
      const mag = Math.pow(10, Math.floor(Math.log10(raw))), ymax = Math.ceil(raw / mag) * mag;
      const x = i => P.l + i * (W - P.l - P.r) / (N - 1), y = v => H - P.b - v * (H - P.t - P.b) / ymax;
      let g = '';
      for (let k = 0; k <= 4; k++) { const v = ymax * k / 4; g += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#d4d4d0"/><text x="${P.l - 5}" y="${y(v) + 3}" font-size="10" fill="#6d6f75" text-anchor="end">${v >= 1000 ? (v / 1000).toFixed(1) + 'k' : +v.toFixed(1)}</text>`; }
      const base = new Array(N).fill(0);
      ORDER.forEach((k, j) => { const top = base.map((b, i) => b + out[j][i]); if (out[j].some(v => v > 0)) g += `<polygon points="${top.map((v, i) => `${x(i)},${y(v)}`).join(' ')} ${base.map((v, i) => `${x(i)},${y(v)}`).reverse().join(' ')}" fill="${COLOR[k]}" stroke="#ececea" stroke-width="1"/>`; top.forEach((v, i) => base[i] = v); });
      drops.forEach((d, i) => { if (d) g += `<rect x="${x(i) - 3}" y="${H - P.b + 5}" width="6" height="6" fill="none" stroke="#b07a10" stroke-width="1.5"/>`; });
      g += `<text x="${P.l}" y="${H - 2}" font-size="10" fill="#6d6f75">-${dg.win >= 60 ? dg.win / 60 + ' min' : dg.win + ' s'}</text><text x="${W - P.r}" y="${H - 2}" font-size="10" fill="#6d6f75" text-anchor="end">now</text><line id="dgXh" x1="0" x2="0" y1="${P.t}" y2="${H - P.b}" stroke="#1e1f22" visibility="hidden"/>`;
      $('#dgArea').innerHTML = g;
      $('#dgUnit').textContent = `${dg.measure === 'pk' ? 'packets' : 'bytes'} a second, stacked by class${dg.client ? ', ' + dg.client : ''}`;
      $('#dgWinLbl').textContent = dg.win >= 60 ? `${dg.win / 60} min` : `${dg.win} s`;
      const sums = out.map(a => a.reduce((s, v) => s + v, 0) * dg.win / N), all = sums.reduce((a, b) => a + b, 0) || 1, mx = Math.max(1, ...sums);
      $('#dgBars').innerHTML = ORDER.map((k, j) => `<div class="row" title="${LABEL[k]}: ${Math.round(sums[j])}"><span>${LABEL[k]}</span><span class="track"><span class="fill" style="display:block;width:${sums[j] / mx * 100}%;background:${COLOR[k]}"></span></span><span class="v">${Math.round(sums[j]).toLocaleString()}${dg.measure === 'by' ? ' B' : ''} · ${Math.round(sums[j] / all * 100)}%</span></div>`).join('');
      // ladder: the broker in the middle, the busiest clients as lanes
      const recent = S.packets.slice(-36), names = [...new Set(recent.map(p => p.client))].slice(0, 4);
      const lanes = {}; const cols = names.length + 1, LW = 640, gap = LW / (cols + 0.2); const mid = Math.floor(names.length / 2);
      names.forEach((n, i) => lanes[n] = gap * (i < mid ? i + 0.6 : i + 1.6)); lanes.BROKER = gap * (mid + 0.6);
      const LH = 24, Hh = 32 + recent.length * LH;
      let L = '<defs>' + ORDER.map(k => `<marker id="ah-${k}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="${COLOR[k]}"/></marker>`).join('') + '<marker id="ah-drop" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#fff" stroke="#b07a10" stroke-width="1.2"/></marker></defs>';
      Object.entries(lanes).forEach(([n, lx]) => { L += `<line x1="${lx}" x2="${lx}" y1="24" y2="${Hh}" stroke="${n === 'BROKER' ? '#1e1f22' : '#9a9b97'}" stroke-width="${n === 'BROKER' ? 2 : 1}" ${n === 'BROKER' ? '' : 'stroke-dasharray="3 3"'}/><text x="${lx}" y="14" font-size="11" text-anchor="middle" font-weight="600" fill="#1e1f22">${esc(n.length > 18 ? n.slice(0, 17) + '…' : n)}</text>`; });
      recent.forEach((p, i) => {
        const yy = 38 + i * LH, cl = lanes[p.client]; if (cl === undefined) return;
        const from = p.dir === 'IN' ? cl : lanes.BROKER, to = p.dir === 'IN' ? lanes.BROKER : cl;
        const sp = p.topic && p.topic.split('/'), lbl = p.type + (p.type === 'PUBLISH' ? ' ' + (sp[0] === 'spBv1.0' ? (sp[1] === 'STATE' ? 'STATE' : sp[2]) : 'plain') + ' q' + p.qos : '');
        const color = p.dropped ? '#b07a10' : COLOR[p.cls];
        L += `<g data-line="${p.line ? p.line.id : ''}" style="cursor:pointer"><line x1="${from}" x2="${to + (to > from ? -2 : 2)}" y1="${yy}" y2="${yy}" stroke="${color}" stroke-width="2" ${p.dropped ? 'stroke-dasharray="5 3" marker-end="url(#ah-drop)"' : `marker-end="url(#ah-${p.cls})"`}><title>${esc(p.line ? p.line.text : '')}</title></line><text x="${(from + to) / 2}" y="${yy - 5}" font-size="10.5" text-anchor="middle" fill="${p.dropped ? '#7a5408' : '#1e1f22'}" font-weight="${p.dropped ? 600 : 400}">${esc(lbl)}${p.dropped ? ' DROPPED' : ''}${p.will ? ' (will)' : ''}</text></g>`;
      });
      const box = $('#dgLadder'), atB = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
      box.innerHTML = `<svg width="${LW}" height="${Hh}" viewBox="0 0 ${LW} ${Hh}" role="img" aria-label="Ladder diagram of recent packets">${L}</svg>`; if (atB) box.scrollTop = box.scrollHeight;
      $('#dgClients').innerHTML = [...S.clients].filter(([c]) => c).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 8).map(([n, c]) => { const t = Object.values(c.mix).reduce((a, v) => a + v, 0); return `<tr><td class="mono">${esc(n)}</td><td><span class="mini">${ORDER.filter(k => c.mix[k]).map(k => `<span style="flex:${c.mix[k] / t};background:${COLOR[k]}" title="${LABEL[k]} ${c.mix[k]}"></span>`).join('')}</span></td><td class="num">${c.in}</td><td class="num">${c.out}</td><td class="num" style="white-space:nowrap">${(c.bytes / 1024).toFixed(1)} KB</td></tr>`; }).join('');
      $('#dgSizes').innerHTML = ['birth', 'data', 'death', 'host', 'other'].filter(k => (S.sizes.get(k) || []).length).map(k => { const a = [...S.sizes.get(k)].sort((p, q) => p - q), lo = a[0], hi = a[a.length - 1], md = a[a.length >> 1], sc = v => Math.min(100, v / 2); return `<div class="row" title="${LABEL[k]}: ${lo} to ${hi} B, median ${md} B"><span>${LABEL[k]}</span><span class="rng"><i style="left:${sc(lo)}%;width:${Math.max(1, sc(hi) - sc(lo))}%;background:${COLOR[k]}"></i><em style="left:${sc(md)}%"></em></span><span class="v">${lo === hi ? lo : lo + '-' + hi} B</span></div>`; }).join('') || '<p class="note">No publishes yet.</p>';
    },
  };

  // ================= Faults and configuration =================
  screens.faults = {
    build(el) {
      el.innerHTML = head('Faults and configuration', 'Ch 17, 19') + `<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">
        <div class="panel"><h2>Fault knobs <span class="note nt">apply live</span></h2><div class="form">
          <label for="fDe">Drop every N matching PUBLISH</label><span><input id="fDe" type="number" min="0" style="width:6rem"> <span id="fDeOn"></span></span><span class="hint">0 turns it off. Book option <span class="mono">--drop-every</span>.</span>
          <label for="fDf">Drop filter</label><input id="fDf" type="text" class="mono"><span class="hint" id="fDfHint">A topic filter. <span class="mono">--drop-filter</span></span>
          <label>Will on takeover</label><label><input type="checkbox" id="fWt"> publish the old connection's will when its client id is taken over</label>
          <label>Sparkplug tap</label><label><input type="checkbox" id="fTap"> on</label></div>
          <div style="margin-top:.9rem;display:flex;gap:.5rem;align-items:center"><button class="btn primary" id="fApply">Apply</button><button class="btn" id="fRevert">Revert</button><span class="note">Each change is written to the trace.</span></div></div>
        <div class="panel"><h2>Broker settings <span class="note nt">need a restart</span></h2><div class="form" style="grid-template-columns:11rem 1fr">
          <label for="sLi">Listen (bench)</label><input id="sLi" type="text" class="mono"><label for="sCt">Connect timeout (s)</label><input id="sCt" type="number" style="width:6rem">
          <label for="sQl">Queue limit</label><span><input id="sQl" type="number" style="width:6rem"> <span class="restart" id="sQlNote"></span></span><label for="sTr">Trace kept (days)</label><input id="sTr" type="number" style="width:6rem"></div>
          <div style="margin-top:.9rem;display:flex;gap:.5rem;align-items:center"><button class="btn" id="sSave">Save</button><button class="btn danger" id="sRestart">Restart broker</button><span class="note" id="sNote"></span></div>
          <p class="note">Restarting drops every live connection (wills fire) and loses clean sessions and retained messages: the study broker keeps them in memory only.</p></div></div>
        <div class="panel" style="margin-top:.9rem"><h2>Member access <span class="note nt">MEMBER-ACCESS.md</span></h2>
          <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:1.5rem"><div class="form" style="grid-template-columns:13rem 1fr">
            <label>Member listener (TLS 8883)</label><span id="mOpenTxt"></span>
            <label for="mPk">Largest packet (KB)</label><input id="mPk" type="number" style="width:6rem"><label for="mRate">Publishes a second per member</label><input id="mRate" type="number" style="width:6rem">
            <label for="mPer">Connections per member</label><input id="mPer" type="number" style="width:6rem"><label for="mOff">Offline sessions expire (days)</label><input id="mOff" type="number" style="width:6rem">
            <label for="mRes">Reserved topics (read-only for members)</label><input id="mRes" type="text" class="mono"></div>
          <div><p class="note" id="mSync"></p><div style="display:flex;gap:.5rem;flex-wrap:wrap"><button class="btn primary" id="mApply">Apply limits</button><button class="btn" id="mSyncBtn">Sync access now</button><button class="btn danger" id="mClose"></button></div>
            <p class="note">Members sign in with the broker token from their learnscada.com account. Refused sign-ins are listed on the Clients screen.</p></div></div></div>
        <div class="panel" style="margin-top:.9rem"><h2>Change log</h2><table><thead><tr><th>Time</th><th>Setting</th><th>Old</th><th>New</th><th>Applied</th></tr></thead><tbody id="fLog"></tbody></table></div>`;
      this.fill();
      $('#fApply').addEventListener('click', () => {
        const df = $('#fDf').value.trim();
        if (!validFilter(df)) { $('#fDfHint').innerHTML = '<span class="a">Not a valid filter.</span>'; return; }
        A.setFaults({ dropEvery: Math.max(0, +$('#fDe').value || 0), dropFilter: df, willOnTakeover: $('#fWt').checked, tap: $('#fTap').checked });
        $('#fDfHint').innerHTML = 'A topic filter. <span class="mono">--drop-filter</span>'; this.render();
      });
      $('#fRevert').addEventListener('click', () => this.fill());
      $('#sSave').addEventListener('click', () => { A.saveSettings({ listen: $('#sLi').value, connectTimeout: +$('#sCt').value, queueLimit: +$('#sQl').value, traceDays: +$('#sTr').value }); $('#sNote').textContent = Object.keys(S.pending).length ? 'Saved; takes effect on restart.' : 'Saved.'; this.render(); });
      $('#sRestart').addEventListener('click', async () => { if (await confirmBox('Restart the broker?', 'Every live connection drops and wills fire. Clean sessions and retained messages are lost. Lab programs reconnect on their own.', 'Restart')) { A.restart(); $('#sNote').textContent = 'Restarting...'; } });
      $('#mApply').addEventListener('click', () => A.setMembers({ maxPacketKB: +$('#mPk').value, rate: +$('#mRate').value, perMember: +$('#mPer').value, offlineDays: +$('#mOff').value, reserved: $('#mRes').value }));
      $('#mSyncBtn').addEventListener('click', () => A.syncAccess());
      $('#mClose').addEventListener('click', async () => {
        if (S.members.open) { if (await confirmBox('Close to members?', 'The member listener stops: every member session ends and new sign-ins are refused. The bench keeps running.', 'Close to members')) A.setMembers({ open: false }); }
        else A.setMembers({ open: true });
        this.render();
      });
    },
    fill() {
      const F = S.faults, s = S.settings, m = S.members;
      $('#fDe').value = F.dropEvery; $('#fDf').value = F.dropFilter; $('#fWt').checked = F.willOnTakeover; $('#fTap').checked = F.tap;
      $('#sLi').value = S.pending.listen ?? s.listen; $('#sCt').value = S.pending.connectTimeout ?? s.connectTimeout; $('#sQl').value = S.pending.queueLimit ?? s.queueLimit; $('#sTr').value = S.pending.traceDays ?? s.traceDays;
      $('#mPk').value = m.maxPacketKB; $('#mRate').value = m.rate; $('#mPer').value = m.perMember; $('#mOff').value = m.offlineDays; $('#mRes').value = m.reserved;
    },
    render() {
      $('#fDeOn').innerHTML = S.faults.dropEvery ? '<span class="knob-on">on</span>' : '';
      $('#sQlNote').textContent = S.pending.queueLimit !== undefined ? `takes effect on restart (now ${S.settings.queueLimit})` : '';
      $('#mOpenTxt').innerHTML = S.members.open ? '<span class="dot"></span> open' : '<span class="dot off"></span> <span class="w">closed</span>';
      $('#mClose').textContent = S.members.open ? 'Close to members' : 'Open to members';
      $('#mClose').className = 'btn ' + (S.members.open ? 'danger' : 'primary');
      $('#mSync').textContent = `Access list from learnscada.com: synced ${dur(now() - S.members.listSynced)} ago (every 5 minutes).`;
      $('#fLog').innerHTML = S.changelog.slice(0, 30).map(c => `<tr><td class="mono">${ts(c.t).slice(0, 8)}</td><td>${esc(c.name)}</td><td class="mono">${esc(c.old)}</td><td class="mono">${esc(c.new)}</td><td>${c.applied === 'waiting for restart' ? '<span class="restart">waiting for restart</span>' : c.applied}</td></tr>`).join('') || '<tr><td colspan="5" class="note">No changes yet.</td></tr>';
    },
  };

  // ================= Labs =================
  const CARDS = [
    ['edge', 'Edge node', `<label>Group / node</label><span class="mono">Lab / Edge1</span><label>Device</label><span class="mono">PLC1 (simulated)</span>
      <label for="o-edge-host">Primary host</label><input id="o-edge-host" data-o="host" value="SCADA1"><label for="o-edge-scan">Scan (s)</label><input id="o-edge-scan" data-o="scan" type="number" step="0.5" value="1"><label for="o-edge-al">Aliases</label><input id="o-edge-al" data-o="aliases" type="checkbox">`,
      'Stop sends NDEATH before DISCONNECT. Kill gives no goodbye, so the broker publishes the will.'],
    ['host', 'Host', `<label for="o-host-id">Host id</label><input id="o-host-id" data-o="hostId" value="SCADA1"><label for="o-host-w">Write Setpoint</label><span><input id="o-host-w" type="number" value="58" style="width:5rem"> <button class="btn sm" data-write>Write</button></span>`,
      'A write goes out as DCMD; the edge node applies it and the change comes back in DDATA.'],
    ['silent', 'Connection endings', `<label for="o-s-end">Ending</label><select id="o-s-end" data-o="end"><option>silence</option><option>disconnect</option><option>close</option><option>violation</option><option>ping</option></select>
      <label for="o-s-ka">Keepalive</label><input id="o-s-ka" data-o="ka" type="number" value="5"><label for="o-s-wr">Will retained</label><input id="o-s-wr" data-o="willRetain" type="checkbox">`, 'Five ways a connection ends (Chapter 4). Watch which ones fire the will.'],
    ['mq', 'Pub/sub client', `<label for="o-mq-mode">Mode</label><select id="o-mq-mode" data-o="mode"><option value="sub">subscribe</option><option value="pub">publish</option></select>
      <label for="o-mq-f">Filters / topic</label><input id="o-mq-f" data-o="filters" value="lab/#"><label for="o-mq-m">Message</label><input id="o-mq-m" data-o="message" value="hello">
      <label for="o-mq-q">QoS</label><select id="o-mq-q" data-o="qos"><option>0</option><option>1</option></select><label for="o-mq-r">Retain / persist</label><input id="o-mq-r" data-o="retain" type="checkbox">`, 'Subscribe to watch, or publish once and disconnect.'],
    ['spdump', 'Sparkplug dump', `<label for="o-sd-f">Filter</label><input id="o-sd-f" data-o="filter" value="spBv1.0/#">`, 'Decodes every Sparkplug message it receives.'],
  ];
  const PRESETS = [
    [1, 'Lab 1: Lose the device birth', 'Drops every DBIRTH, so the node is born and the device never is.', 'The host will see data for a device with no birth and ask for rebirth, but no more than once every five seconds.'],
    [2, 'Lab 2: Lose the death', 'Drops every NDEATH. Then kill the edge node: the will fires, and is dropped too.', 'The host will keep believing the node is online, because no death ever arrives.'],
    [3, 'Lab 3: Two nodes, one name', 'Starts two edge nodes with the same group and node id, so the same MQTT client id.', 'Each connection takes over the other; every takeover fires the old one\'s will.'],
    [4, 'Lab 4: Steady loss', 'Drops one Sparkplug message in ten, of every kind; scan every 0.5 s.', 'The host will see gaps and request rebirths, rate-limited; values stay right between losses.'],
  ];
  function progOpts(kind) {
    const o = {}; $$(`#card-${kind} [data-o]`).forEach(i => { o[i.dataset.o] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? +i.value : i.value; });
    if (kind === 'mq') { if (o.mode === 'pub') { o.topic = o.filters; } o.persist = o.retain && o.mode === 'sub'; }
    return o;
  }
  screens.labs = {
    build(el) {
      el.innerHTML = head('Labs', 'Ch 4, 12 to 19') + `<div class="grid cards">${CARDS.map(([k, t, f, n]) => `<div class="panel card" id="card-${k}"><h2><span class="dot off" id="dot-${k}"></span> ${t}</h2><div class="form" style="grid-template-columns:8rem 1fr;gap:.35rem .6rem">${f}</div>
        <div class="cmd" id="cmd-${k}"></div><div class="console" id="con-${k}"></div><div style="display:flex;gap:.5rem;margin-top:.6rem" id="act-${k}"></div><p class="note">${n}</p></div>`).join('')}</div>
        <h2 class="sec">Chapter 19 presets</h2><div class="grid presets">${PRESETS.map(([n, t, d]) => `<div class="panel preset"><b>${t}</b><p>${d}</p><div style="display:flex;gap:.4rem;flex-wrap:wrap"><button class="btn primary sm" data-preset="${n}">Run preset</button><button class="btn sm" data-note="${n}">Notebook entry</button></div></div>`).join('')}</div>
        <div style="margin-top:.8rem"><button class="btn" id="labReset">Clear faults and restart the standard bench</button></div>`;
      el.addEventListener('click', async e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.start) { A.program(b.dataset.start, progOpts(b.dataset.start)); }
        if (b.dataset.stop) A.stop(b.dataset.stop);
        if (b.dataset.kill && await confirmBox('Kill the process?', 'No goodbye: the socket closes without DISCONNECT, so the broker publishes its will.', 'Kill')) A.kill(b.dataset.kill);
        if (b.dataset.write !== undefined) { if (!A.hostWrite('Setpoint', +$('#o-host-w').value)) alertNote('Start the host first.'); }
        if (b.dataset.preset) { A.preset(+b.dataset.preset); }
        if (b.dataset.note) { newRun(+b.dataset.note); show('notebook'); }
        if (b.id === 'labReset') { A.setFaults({ dropEvery: 0, dropFilter: 'spBv1.0/#', willOnTakeover: true, tap: true }); [...S.programs.values()].filter(p => p.state === 'running' && p.kind !== 'member').forEach(p => p.stop()); setTimeout(() => { A.program('host'); setTimeout(() => A.program('edge'), 500); }, 400); }
        this.render();
      });
      el.addEventListener('input', () => this.render());
    },
    render() {
      CARDS.forEach(([k]) => {
        const p = S.programs.get(k), run = p && p.state === 'running';
        $('#dot-' + k).className = 'dot ' + (run ? '' : 'off');
        $('#cmd-' + k).textContent = run ? p.cmd() : '$ ' + previewCmd(k);
        const con = $('#con-' + k), atB = con.scrollHeight - con.scrollTop - con.clientHeight < 20;
        con.textContent = p ? p.console.slice(-60).join('\n') : '';
        if (atB) con.scrollTop = con.scrollHeight;
        $('#act-' + k).innerHTML = run ? `<button class="btn" data-stop="${k}">Stop (Ctrl+C)</button><button class="btn danger" data-kill="${k}">Kill</button>` : `<button class="btn primary" data-start="${k}">Start</button>`;
      });
      const e2 = S.programs.get('edge-2');
      if (e2 && e2.state === 'running' && !$('#e2note')) $('#act-edge').insertAdjacentHTML('afterend', '<p class="note w" id="e2note">A second edge node (Lab 3) is running with the same client id. <button class="btn sm" data-stop="edge-2">Stop it</button></p>');
      if ((!e2 || e2.state !== 'running') && $('#e2note')) $('#e2note').remove();
    },
  };
  function previewCmd(k) {
    const o = progOpts(k);
    return { edge: `python -m edge --primary-host ${o.host}${o.scan !== 1 ? ' --scan ' + o.scan : ''}${o.aliases ? ' --aliases' : ''}`, host: `python -m host --id ${o.hostId}`,
      silent: `python -m labs.silent --end ${o.end} --keepalive ${o.ka}${o.willRetain ? ' --will-retain' : ''}`,
      mq: o.mode === 'sub' ? `python -m labs.mq sub ${o.filters} --qos ${o.qos}${o.persist ? ' --persist' : ''}` : `python -m labs.mq pub ${o.topic} "${o.message}" --qos ${o.qos}${o.retain ? ' --retain' : ''}`,
      spdump: `python -m labs.spdump --filter ${o.filter}` }[k];
  }
  const alertNote = msg => { const n = document.createElement('div'); n.className = 'toast'; n.textContent = msg; document.body.appendChild(n); setTimeout(() => n.remove(), 3000); };

  // ================= Notebook =================
  let runs = [], selRun = null;
  try { runs = JSON.parse(localStorage.getItem('sbm-notebook') || '[]'); } catch { runs = []; }
  const saveRuns = () => { try { localStorage.setItem('sbm-notebook', JSON.stringify(runs)); } catch { /* private mode */ } };
  function newRun(preset) {
    const p = PRESETS.find(x => x[0] === preset);
    const r = { id: Date.now(), title: p ? p[1] : 'My lab', preset: p ? `Lab ${preset}` : '', prediction: '', happened: '', rule: '', outcome: 'open', created: Date.now(), started: null, stopped: null, settings: null, lines: [] };
    runs.unshift(r); selRun = r.id; saveRuns(); return r;
  }
  screens.notebook = {
    build(el) {
      el.innerHTML = head('Notebook', 'Ch 19', '<button class="btn" id="nbNew">New run</button><button class="btn" id="nbAll">Export all</button>') + '<div class="grid" style="grid-template-columns:18rem minmax(0,1fr)"><div class="panel"><h2>Runs</h2><div id="nbList"></div></div><div class="panel" id="nbRun"></div></div>';
      el.addEventListener('click', e => {
        const b = e.target.closest('button, [data-run]'); if (!b) return;
        if (b.id === 'nbNew') { newRun(null); this.render(true); }
        if (b.dataset.run) { selRun = +b.dataset.run; this.render(true); }
        const r = runs.find(x => x.id === selRun);
        if (b.id === 'nbStart' && r) { if (!r.prediction.trim()) { $('#nbPredHint').textContent = 'Write the prediction first: what will happen, in one sentence.'; return; } r.started = Date.now(); r.startLine = S.trace.length ? S.trace[S.trace.length - 1].id : 0; r.settings = { faults: { ...S.faults }, programs: [...S.programs.values()].filter(p => p.state === 'running').map(p => p.cmd()) }; if (r.preset) A.preset(+r.preset.split(' ')[1]); S.runActive = r; saveRuns(); this.render(true); }
        if (b.id === 'nbStop' && r) { r.stopped = Date.now(); r.lines = S.trace.filter(L => L.id > (r.startLine || 0)).slice(-800).map(L => L.text); S.runActive = null; saveRuns(); this.render(true); }
        if (b.id === 'nbExport' && r) download(`${r.title.replace(/[^\w-]+/g, '-')}.md`, md(r));
        if (b.id === 'nbAll') download('studybroker-notebook.md', runs.map(md).join('\n\n---\n\n'));
        if (b.id === 'nbDel' && r) { confirmBox('Delete this run?', 'The prediction, notes and captured trace are removed.', 'Delete').then(ok => { if (ok) { runs = runs.filter(x => x !== r); selRun = runs[0] ? runs[0].id : null; saveRuns(); this.render(true); } }); }
      });
      el.addEventListener('input', e => { const r = runs.find(x => x.id === selRun); if (!r || !e.target.dataset.f) return; r[e.target.dataset.f] = e.target.value; saveRuns(); if (e.target.dataset.f === 'title') this.list(); });
      if (!runs.length) newRun(1);
      if (!selRun) selRun = runs[0].id;
    },
    list() { $('#nbList').innerHTML = runs.map(r => `<div class="nbitem ${r.id === selRun ? 'sel' : ''}" data-run="${r.id}"><b>${esc(r.title)}</b><br><span class="note">${new Date(r.created).toLocaleString()} · ${r.stopped ? r.outcome : r.started ? '<span class="w">running</span>' : 'not started'}</span></div>`).join(''); },
    render(full) {
      if (!full && $('#nbRun').innerHTML) { if (S.runActive) { const t = $('#nbTimer'); if (t) t.textContent = dur(Date.now() - S.runActive.started); } return; }
      this.list();
      const r = runs.find(x => x.id === selRun);
      if (!r) { $('#nbRun').innerHTML = '<p class="note">No run selected.</p>'; return; }
      $('#nbRun').innerHTML = `<div class="form" style="grid-template-columns:9rem 1fr;max-width:none">
        <label for="nbT">Title</label><input id="nbT" data-f="title" value="${esc(r.title)}"><label>Preset</label><span>${esc(r.preset || 'none (your own lab)')}</span>
        <label for="nbP">Prediction</label><textarea id="nbP" data-f="prediction" rows="3" ${r.started ? 'readonly' : ''} placeholder="Before starting: what will happen, and why?">${esc(r.prediction)}</textarea><span class="hint" id="nbPredHint">${r.started ? 'Locked when the run started.' : 'Required before Start (Chapter 19: predict first).'}</span></div>
        <div style="display:flex;gap:.5rem;margin:.8rem 0;align-items:center">${!r.started ? '<button class="btn primary" id="nbStart">Start run</button>' : !r.stopped ? `<button class="btn danger" id="nbStop">Stop and capture the trace</button><span class="note">running <span id="nbTimer">${dur(Date.now() - r.started)}</span></span>` : `<span class="note">Ran ${dur(r.stopped - r.started)}; ${r.lines.length} trace lines captured.</span>`}
          <button class="btn" id="nbExport">Export Markdown</button><button class="btn danger" id="nbDel" style="margin-left:auto">Delete</button></div>
        ${r.settings ? `<h3>Settings at start</h3><p class="mono note">drop_every=${r.settings.faults.dropEvery} drop_filter=${esc(r.settings.faults.dropFilter)} tap=${r.settings.faults.tap} will_on_takeover=${r.settings.faults.willOnTakeover}<br>${r.settings.programs.map(esc).join('<br>')}</p>` : ''}
        ${r.stopped ? `<h3>Captured trace</h3><div class="trace" style="height:220px">${r.lines.slice(-300).map(t => `<div>${esc(t)}</div>`).join('')}</div>` : ''}
        <div class="form" style="grid-template-columns:9rem 1fr;max-width:none;margin-top:.8rem">
        <label for="nbH">What happened</label><textarea id="nbH" data-f="happened" rows="3">${esc(r.happened)}</textarea>
        <label for="nbR">Rule it showed</label><textarea id="nbR" data-f="rule" rows="2">${esc(r.rule)}</textarea>
        <label for="nbO">Outcome</label><select id="nbO" data-f="outcome">${['open', 'matched', 'surprised'].map(o => `<option ${r.outcome === o ? 'selected' : ''}>${o}</option>`).join('')}</select></div>`;
    },
  };
  const md = r => `# ${r.title}\n\n- Preset: ${r.preset || 'none'}\n- Created: ${new Date(r.created).toISOString()}\n- Outcome: ${r.outcome}\n\n## Prediction\n\n${r.prediction}\n\n## Settings at start\n\n${r.settings ? '```\n' + JSON.stringify(r.settings, null, 2) + '\n```' : '(not started)'}\n\n## What happened\n\n${r.happened}\n\n## Rule it showed\n\n${r.rule}\n\n## Trace\n\n\`\`\`\n${(r.lines || []).join('\n')}\n\`\`\`\n`;

  // ================= System =================
  const sysHist = { cpu: [], mem: [] };
  setInterval(() => { const [ri, ro] = rate(); sysHist.cpu.push(Math.min(95, 2.5 + (ri + ro) * 0.9 + Math.random() * 1.5)); sysHist.mem.push(212 + S.sessions.size * 3 + S.trace.length / 300 + Math.random() * 2); ['cpu', 'mem'].forEach(k => sysHist[k].length > 120 && sysHist[k].shift()); }, 1000);
  let capture = null;
  screens.system = {
    build(el) {
      el.innerHTML = head('System', '') + '<div class="grid tiles" id="syTiles" style="grid-template-columns:repeat(4,minmax(0,1fr))"></div><div class="grid two"><div class="grid" style="gap:.9rem;align-content:start"><div class="panel"><h2>Services</h2><div id="sySvc"></div></div><div class="panel"><h2>WireGuard peers</h2><div id="syWg"></div></div></div><div class="grid" style="gap:.9rem;align-content:start"><div class="panel"><h2>Versions</h2><div id="syVer"></div></div><div class="panel"><h2>Packet capture</h2><div id="syCap"></div></div><div class="panel"><h2>Backups</h2><div id="syBk"></div></div></div></div>';
      el.addEventListener('click', e => { if (e.target.closest('#capGo')) { capture = { start: Date.now(), secs: +$('#capS').value }; this.render(); } });
    },
    render() {
      const spark = (a, mx) => `<svg class="spark" viewBox="0 0 100 28" preserveAspectRatio="none"><polyline fill="none" stroke="#4a4c52" stroke-width="1.5" points="${a.map((v, i) => `${i * 100 / Math.max(1, a.length - 1)},${26 - v / mx * 22}`).join(' ')}"/></svg>`;
      const c = sysHist.cpu.at(-1) || 0, m = sysHist.mem.at(-1) || 0;
      $('#syTiles').innerHTML = `<div class="panel tile"><div class="lbl">CPU</div><div class="val">${c.toFixed(0)}%</div>${spark(sysHist.cpu, 100)}</div><div class="panel tile"><div class="lbl">Memory</div><div class="val">${m.toFixed(0)} MB</div><div class="sub">of 2 GB</div>${spark(sysHist.mem, 2048)}</div>
        <div class="panel tile"><div class="lbl">Disk</div><div class="val">4.3 GB</div><div class="sub">of 50 GB · trace 61 MB</div></div><div class="panel tile"><div class="lbl">Droplet up</div><div class="val">12d 4h</div><div class="sub">studybroker-1 · NYC1</div></div>`;
      $('#sySvc').innerHTML = `<table><tbody>${[['studybroker', S.up ? 'running' : 'restarting broker'], ['caddy', 'running'], ['wg-quick@wg0', 'running'], ['unattended-upgrades', 'idle, last run 02:14']].map(([n, s]) => `<tr><td class="mono">${n}</td><td>${/running|idle/.test(s) ? '<span class="dot"></span>' : '<span class="dot warn"></span>'} ${s}</td></tr>`).join('')}</tbody></table>`;
      $('#syWg').innerHTML = `<table><thead><tr><th>Peer</th><th>Address</th><th>Last handshake</th><th class="num">Data</th></tr></thead><tbody><tr><td>desktop</td><td class="mono">10.88.0.2</td><td>42 s ago</td><td class="num">18.4 MB</td></tr><tr><td>laptop</td><td class="mono">10.88.0.3</td><td class="note">idle (3 h)</td><td class="num">2.1 MB</td></tr><tr><td>ignition-gw</td><td class="mono">10.88.0.4</td><td>1 m ago</td><td class="num">96.0 MB</td></tr></tbody></table>`;
      $('#syVer').innerHTML = '<dl class="kv"><dt>StudyBroker</dt><dd class="mono">main @ 946ce44</dd><dt>InsideTheBroker</dt><dd class="mono">main @ 0712659</dd><dt>Python</dt><dd class="mono">3.12.3</dd><dt>Ubuntu</dt><dd class="mono">24.04.1 LTS</dd></dl>';
      if (capture && Date.now() - capture.start > capture.secs * 1000) { capture.done = true; }
      $('#syCap').innerHTML = capture && !capture.done ? `<p>Capturing port 1884 and 8883... ${Math.ceil((capture.secs * 1000 - (Date.now() - capture.start)) / 1000)} s left</p>` :
        `${capture && capture.done ? `<p><span class="mono">capture-${new Date(capture.start).toISOString().slice(0, 19).replace(/:/g, '')}.pcap</span> <button class="btn sm" disabled title="Mockup: no real pcap">Download</button></p>` : ''}<div style="display:flex;gap:.5rem;align-items:center"><label for="capS">Seconds</label><input id="capS" type="number" value="30" style="width:5rem"><button class="btn" id="capGo">Start capture</button></div><p class="note">Phase 6. Opens in Wireshark with MQTT decoded (Decode As MQTT on 1884).</p>`;
      $('#syBk').innerHTML = '<p>Last nightly copy of settings and notebook: today 03:00 <button class="btn sm" disabled>Download</button></p><p class="note">DigitalOcean weekly droplet backups also run.</p>';
    },
  };

  // ---- lab run marker in the navigation ----
  function labRun() {
    const r = S.runActive, el = $('#labRun');
    el.hidden = !r; if (r) el.innerHTML = `<b>Lab run in progress</b>${esc(r.title)}<br><span class="mono">${dur(Date.now() - r.started)}</span> · prediction saved`;
  }

  // ---- ticks ----
  Sim.subscribe(k => { if (['sessions', 'config', 'program', 'refused'].includes(k)) queued = true; });
  let queued = false;
  setInterval(() => { statusBar(); labRun(); if (cur && screens[cur].render && cur !== 'trace') screens[cur].render(); if (cur === 'trace') screens.trace.count(); }, 1000);
  setInterval(() => { if (queued && cur && ['clients', 'faults', 'labs', 'overview'].includes(cur)) { queued = false; screens[cur].render(); } }, 300);
  statusBar();
  show(location.hash.slice(1) || 'overview');

  // ---- About this demo: shown on the first visit, and from the link in the navigation ----
  const about = $('#aboutDlg');
  $('#aboutBtn').addEventListener('click', () => about.showModal());
  $('#aboutClose').addEventListener('click', () => about.close());
  about.addEventListener('close', () => { try { localStorage.setItem('sbm-about-seen', '1'); } catch { /* private mode */ } });
  let seen = false; try { seen = localStorage.getItem('sbm-about-seen') === '1'; } catch { seen = false; }
  if (!seen) about.showModal();
})();
