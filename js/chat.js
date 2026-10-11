/* Group chat: text, quick pings, hold-to-record voice messages.
   Transport: ntfy.sh public server (no account). Payloads end-to-end encrypted with AES-GCM;
   the key lives only in the join link fragment (#g=topic&k=key) and on members' devices.
   Offline: outbox in IndexedDB, auto-sent when a connection returns; history cached locally. */
(function () {
'use strict';
const NTFY = localStorage.getItem('ntfyBase') || 'https://ntfy.sh'; // override only for local testing
const MAX_REC_MS = 30000, MIN_REC_MS = 600, ATTACH_LIMIT = 1900000; // ntfy.sh anonymous attachment limit is 2 MB
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const A = () => window.AlpsApp;
const PINGS = ['📍 Where are you?', '🚗 Meet at the car', '🚌 Heading to the bus', '⏱️ Running 10 min late', '👍 I\'m OK', '🍜 Food?'];

// ---------- IndexedDB ----------
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open('alps-group', 1);
    r.onupgradeneeded = () => { const d = r.result; ['msgs', 'outbox', 'blobs'].forEach(n => d.createObjectStore(n, {keyPath: 'id'})); d.createObjectStore('meta', {keyPath: 'k'}); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction(store, mode); const s = t.objectStore(store); let out; const r = fn(s); if (r) r.onsuccess = () => out = r.result; t.oncomplete = () => res(out); t.onerror = () => rej(t.error); });
}
const put = (st, v) => tx(st, 'readwrite', s => s.put(v));
const get = (st, k) => tx(st, 'readonly', s => s.get(k));
const del = (st, k) => tx(st, 'readwrite', s => s.delete(k));
const all = st => tx(st, 'readonly', s => s.getAll());
const clear = st => tx(st, 'readwrite', s => s.clear());

// ---------- crypto ----------
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
function bigB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
let KEY = null;
async function loadKey(k) { KEY = await crypto.subtle.importKey('raw', unb64u(k), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function encBytes(u8) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv}, KEY, u8)); const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out; }
async function decBytes(u8) { return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: u8.slice(0, 12)}, KEY, u8.slice(12))); }
async function encObj(o) { return 'e1.' + b64u(await encBytes(new TextEncoder().encode(JSON.stringify(o)))); }
async function decObj(s) { if (!s || s.slice(0, 3) !== 'e1.') throw new Error('not ours'); return JSON.parse(new TextDecoder().decode(await decBytes(unb64u(s.slice(3))))); }
function rnd(n) { const a = 'abcdefghijkmnpqrstuvwxyz23456789'; return Array.from(crypto.getRandomValues(new Uint8Array(n)), x => a[x % a.length]).join(''); }
const uid = () => Date.now().toString(36) + rnd(8);

// ---------- state ----------
const C = {grp: null, me: null, es: null, conn: 'off', lastId: null, backoff: 2000, unread: 0, msgs: new Map(), ackQ: new Set(), ackT: null, flushing: false};
window.AlpsChat = C;
function loadCfg() {
  try { C.grp = JSON.parse(localStorage.getItem('grp') || 'null'); } catch (e) { C.grp = null; }
  try { C.me = JSON.parse(localStorage.getItem('me') || 'null'); } catch (e) { C.me = null; }
  if (!C.me) { C.me = {name: '', dev: rnd(10)}; localStorage.setItem('me', JSON.stringify(C.me)); }
}
const shareOn = () => localStorage.getItem('shareLoc') === '1'; // OFF by default; opt-in per device
function joinLink() { const base = location.origin + location.pathname.replace(/index\.html$/, ''); const ck = localStorage.getItem('ck'); return base + '#g=' + C.grp.topic + '&k=' + C.grp.key + (ck ? '&c=' + ck : ''); }
function parseJoin(str) {
  try {
    const h = str.includes('#') ? str.slice(str.indexOf('#') + 1) : str;
    const p = new URLSearchParams(h); const g = p.get('g'), k = p.get('k');
    if (g && k && /^[-_A-Za-z0-9]{20,64}$/.test(g) && unb64u(k).length === 32) return {topic: g, key: k};
  } catch (e) {}
  return null;
}

// ---------- connection indicator ----------
function setConn(s) {
  C.conn = s;
  const c = $('#netChip'); if (!c) return;
  if (!C.grp) { c.className = 'chip'; c.textContent = '💬 no group'; return; }
  const q = C.queued || 0;
  c.className = 'chip ' + ({live: 'live', off: 'off', connecting: 'warn', error: 'warn'}[s] || '');
  c.textContent = ({live: '● Live', off: '● Offline', connecting: '● Connecting', error: '● Retrying'}[s] || s) + (q ? ' · ' + q + ' queued' : '');
}

// ---------- rendering ----------
function fmtTime(ms) { return new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short'}).format(new Date(ms)); }
function locLine(m) {
  if (!m.loc) return '';
  const app = A(), u = app.util;
  let s = '📍 ';
  const near = app.pois.map(p => ({p, d: u.dist(m.loc, p)})).sort((a, b) => a.d - b.d)[0];
  if (m.mine) s += 'location shared';
  else if (app.pos) { const d = u.dist(app.pos, m.loc); s += u.fmtDist(d) + ' ' + u.compass(u.bearing(app.pos, m.loc)) + ' of you'; }
  else s += 'shared location';
  if (near && near.d < 3000) s += ' · near ' + esc(near.p.name);
  const ageMin = Math.round((m.t - (m.loc.t || m.t)) / 60000);
  if (ageMin > 1) s += ' · fix ' + ageMin + ' min before sending';
  return '<div class="loc">' + s + '</div>';
}
function statusHtml(m) {
  if (!m.mine) return '';
  if (m.status === 'queued') return ' · <span class="st-queued">🕓 queued (will send when online)</span>';
  if (m.status === 'sending') return ' · sending…';
  if (m.status === 'error') return ' · <span class="st-error">⚠️ ' + esc(m.err || 'failed') + '</span>';
  if (m.deliveredTo && m.deliveredTo.length) return ' · <span class="st-delivered">✓✓ delivered to ' + esc(m.deliveredTo.join(', ')) + '</span>';
  if (m.status === 'sent') return ' · ✓ sent';
  return '';
}
function msgHtml(m) {
  let body = '';
  if (m.type === 'text') body = '<div>' + esc(m.text) + '</div>';
  else if (m.type === 'ping') body = '<div class="ping">' + esc(m.text) + '</div>';
  else if (m.type === 'voice') body = m.voiceErr ? '<div>🎙️ Voice message (' + esc(m.voiceErr) + ')</div>' : '<button class="play" data-play="' + m.id + '">▶ Voice message · ' + Math.round((m.dur || 0) / 1000) + ' s</button>';
  else if (m.type === 'sys') return '<div class="msg sys" data-id="' + m.id + '">' + esc(m.text) + '</div>';
  return '<div class="msg ' + (m.mine ? 'me' : '') + '" data-id="' + m.id + '" data-status="' + (m.status || '') + '">' + (m.mine ? '' : '<div class="from">' + esc(m.from) + '</div>') + body + locLine(m) +
    '<div class="meta">' + fmtTime(m.t) + statusHtml(m) + '</div></div>';
}
function renderMsgs() {
  const el = $('#msgList'); if (!el) return;
  const list = [...C.msgs.values()].sort((a, b) => a.t - b.t).slice(-200);
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  el.innerHTML = list.length ? list.map(msgHtml).join('') : '<div class="msg sys">No messages yet. Say hi 👋 - messages are end-to-end encrypted.</div>';
  if (atBottom || true) el.scrollTop = el.scrollHeight;
}
function updateUnread() { const b = $('#unread'); if (!b) return; b.textContent = C.unread; b.classList.toggle('hidden', !C.unread); }

function renderSetup() {
  const el = $('#groupSetup');
  const chat = $('#groupChat');
  if (C.grp && C.me.name) {
    el.innerHTML = '<details class="card"><summary><b>Invite / group settings</b></summary><p>Other members scan this QR in the app (Group → Scan QR) or open/paste the link:</p><div class="qr" id="qrBox"></div><div class="linkbox" id="joinLinkBox"></div>' +
      '<div class="row" style="margin-top:8px"><button class="btn" id="btnCopy">Copy link</button><button class="btn" id="btnShare">Share…</button></div>' +
      '<label style="display:block;margin-top:10px;font-weight:700">Your display name<input type="text" id="nameEdit" maxlength="24" value="' + esc(C.me.name) + '"></label>' +
      '<p class="muted small">Anyone with this link can read and post in the group - share it only with your travel group. Messages are relayed by the public ntfy.sh server but encrypted on your phone; ntfy.sh keeps messages ~12 h and voice files ~3 h, so this app stores history on each phone.</p>' +
      '<button class="btn" id="btnLeave">Leave group on this phone</button></details>';
    chat.classList.remove('hidden');
    drawQr(); $('#joinLinkBox').textContent = joinLink();
    $('#btnCopy').onclick = () => navigator.clipboard.writeText(joinLink()).then(() => A().toast('Join link copied'), () => A().toast('Copy failed - long-press the link'));
    $('#btnShare').onclick = () => navigator.share ? navigator.share({title: 'Join our trip group chat', url: joinLink()}).catch(() => {}) : A().toast('Sharing not supported - use Copy');
    $('#nameEdit').onchange = e => { const v = e.target.value.trim(); if (v) { C.me.name = v; localStorage.setItem('me', JSON.stringify(C.me)); $('#grpMe').textContent = 'as ' + v; } };
    $('#btnLeave').onclick = async () => { if (!confirm('Leave the group on this phone? Local history will be deleted and the trip guide will lock until you join again.')) return; localStorage.removeItem('grp'); localStorage.removeItem('lastId'); localStorage.removeItem('roster'); C.roster = {}; await Promise.all(['msgs', 'outbox', 'blobs'].map(clear)); C.grp = null; C.msgs.clear(); disconnect(); if (window.AlpsLock) { AlpsLock.forget(); location.reload(); return; } renderSetup(); setConn('off'); };
    $('#grpMe').textContent = 'as ' + C.me.name;
    renderMembers();
    return;
  }
  chat.classList.add('hidden');
  const pending = C.pendingJoin;
  el.innerHTML = '<div class="card"><h2>Group chat for the 6 of you</h2><p>Text, quick pings and voice messages. Works with patchy signal: messages queue on the phone and send automatically when you are back online.</p>' +
    '<label style="display:block;font-weight:700">Your display name<input type="text" id="nameInput" maxlength="24" placeholder="e.g. Ash" value="' + esc(C.me.name || '') + '"></label>' +
    (pending ? '<p class="note">Join link detected. Tap <b>Join group</b>.</p><button class="btn primary" id="btnJoinPending" style="width:100%">Join group</button>' :
    '<div class="row" style="margin-top:10px"><button class="btn primary" id="btnCreate">Create group (organiser)</button><button class="btn" id="btnScan">📷 Scan QR to join</button></div>' +
    '<label style="display:block;font-weight:700;margin-top:10px">…or paste a join link<input type="text" id="joinPaste" placeholder="https://…#g=…&k=…"></label><button class="btn" id="btnJoinPaste" style="width:100%;margin-top:6px">Join with link</button>') +
    '<p class="muted small">Only one person creates the group, then shows the QR code to the others.</p></div>';
  const needName = () => { const v = ($('#nameInput').value || '').trim(); if (!v) { A().toast('Enter your display name first'); $('#nameInput').focus(); return null; } C.me.name = v; localStorage.setItem('me', JSON.stringify(C.me)); return v; };
  if (pending) { $('#btnJoinPending').onclick = () => { if (needName()) joinGroup(pending); }; return; }
  $('#btnCreate').onclick = () => { if (!needName()) return; const key = b64u(crypto.getRandomValues(new Uint8Array(32))); joinGroup({topic: 'alps-' + rnd(28), key}, true); };
  $('#btnJoinPaste').onclick = () => { if (!needName()) return; const g = parseJoin($('#joinPaste').value.trim()); if (!g) return A().toast('That is not a valid join link'); joinGroup(g); };
  $('#btnScan').onclick = () => { if (!needName()) return; startScan(); };
}
function drawQr() {
  const box = $('#qrBox'); if (!box || typeof qrcode !== 'function') return;
  const q = qrcode(0, 'M'); q.addData(joinLink()); q.make();
  box.innerHTML = q.createSvgTag({cellSize: 6, margin: 3, scalable: true});
}

// ---------- group lifecycle ----------
async function joinGroup(g, created) {
  C.grp = {topic: g.topic, key: g.key, joined: Date.now()};
  localStorage.setItem('grp', JSON.stringify(C.grp));
  C.pendingJoin = null;
  await loadKey(g.key);
  renderSetup();
  addSys(created ? 'Group created. Show the QR (Invite) to the others.' : 'Joined the group as ' + C.me.name + '.');
  if (created) { const d = $('#groupSetup details'); if (d) d.open = true; }
  connect(); flush();
  if (!localStorage.getItem('joinSent-' + g.topic)) { localStorage.setItem('joinSent-' + g.topic, '1'); C.lastPres = 0; sendPres('join'); } else sendPres('hb');
}
async function addSys(text) { const m = {id: 'sys-' + uid(), type: 'sys', text, t: Date.now()}; C.msgs.set(m.id, m); await put('msgs', m); renderMsgs(); }

// ---------- presence (members: joined / viewing / last seen) ----------
// Encrypted 'pres' events: join (once per device) and hb. hb = one on app open, then only while the Group tab is on screen, max 1 per 10 min.
// No 'away' events (saves ntfy quota): a member counts as online for ~20 min after their last heartbeat.
// Never rendered in the chat feed. Roster kept in localStorage so it survives offline reloads.
const GROUP_SIZE = 6, HB_MS = 600000, ONLINE_MS = 1200000, MIN_GAP_MS = 600000, ACK_IDLE_MS = 30000, ACK_MAX_MS = 120000;
const TABN = {here: 'Here', plan: 'Plan', map: 'Map', places: 'Places', stays: 'Stays', group: 'Group'};
function loadRoster() { try { C.roster = JSON.parse(localStorage.getItem('roster') || '{}') || {}; } catch (e) { C.roster = {}; } }
function saveRoster() { localStorage.setItem('roster', JSON.stringify(C.roster)); }
function seen(env, kind) {
  if (!env || !env.dev) return;
  const t = env.t || Date.now();
  const r = C.roster[env.dev] || (C.roster[env.dev] = {dev: env.dev, name: env.from || '?', joined: t, last: 0, state: 'away'});
  if (env.from) r.name = env.from;
  if (kind === 'join' || (env.joined && env.joined < r.joined)) r.joined = Math.min(r.joined, env.joined || t);
  if (t >= r.last) {
    r.last = t;
    if (kind === 'away') r.state = 'away';
    else if (kind === 'join' || kind === 'hb') { r.state = 'on'; if (env.tab) r.tab = env.tab; }
  }
  saveRoster(); renderMembers();
}
function ago(ms) { const m = Math.round(ms / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 48) return h + ' h ago'; return Math.round(h / 24) + ' days ago'; }
function isOnline(r) { return r.dev === C.me.dev ? !document.hidden : (r.state !== 'away' && Date.now() - r.last < ONLINE_MS); }
function renderMembers() {
  const el = $('#members'); if (!el || !C.grp) return;
  if (C.me.name) { const r = C.roster[C.me.dev] || (C.roster[C.me.dev] = {dev: C.me.dev, joined: C.grp.joined || Date.now(), last: Date.now(), state: 'on'}); r.name = C.me.name; if (!document.hidden) r.last = Date.now(); }
  const list = Object.values(C.roster).sort((a, b) => a.joined - b.joined);
  const on = list.filter(isOnline).length, total = Math.max(GROUP_SIZE, list.length);
  const open = el.querySelector('details') ? el.querySelector('details').open : false;
  el.innerHTML = '<details class="card members"' + (open ? ' open' : '') + '><summary><b>👥 Members</b> <span class="mcount">' + on + ' of ' + total + ' online</span> <span class="muted small">· ' + list.length + ' joined</span></summary><ul>' +
    list.map(r => { const o = isOnline(r), me = r.dev === C.me.dev; return '<li data-dev="' + esc(r.dev) + '" class="' + (o ? 'on' : 'off') + '"><span class="dot"></span><div><b>' + esc(r.name) + (me ? ' (you)' : '') + '</b><div class="muted small">' +
      (o ? '<span class="st-on">Online now · viewing' + (r.tab && TABN[r.tab] && !me ? ' ' + TABN[r.tab] : '') + '</span>' : 'Last seen ' + ago(Date.now() - r.last)) + ' · joined ' + fmtTime(r.joined) + '</div></div></li>'; }).join('') +
    (list.length < GROUP_SIZE ? '<li class="off muted small">Waiting for ' + (GROUP_SIZE - list.length) + ' more to join…</li>' : '') +
    '</ul><p class="muted small">Online = active in the last ~20 min (status updates at most every 10 min, to save the shared Wi-Fi quota). Status is end-to-end encrypted like messages.</p></details>';
}
async function sendPres(ev, keepalive) {
  if (!C.grp || !KEY || !C.me.name || !navigator.onLine) return;
  const now = Date.now();
  if (ev !== 'hb' && ev !== 'join') return; // 'away' no longer sent
  if (now - (C.lastPres || 0) < MIN_GAP_MS) return; // max 1 heartbeat per 10 min
  C.lastPres = now; C.presState = 'on';
  const env = {id: 'p-' + uid(), type: 'pres', ev, from: C.me.name, dev: C.me.dev, t: now, joined: C.grp.joined, tab: A().tab};
  seen(env, ev);
  try {
    const body = JSON.stringify({topic: C.grp.topic, message: await encObj(env)}); // no title/tags: silent for ntfy app subscribers
    await fetch(NTFY + '/', {method: 'POST', body, keepalive: !!keepalive});
    C.presCount = (C.presCount || 0) + 1;
  } catch (e) { C.lastPres = 0; }
}
function presTick() { if (!document.hidden && A().tab === 'group' && C.grp && Date.now() - (C.lastPres || 0) >= HB_MS) sendPres('hb'); renderMembers(); }
C.sendPres = sendPres; C.renderMembers = renderMembers;

// ---------- receiving ----------
function disconnect() { if (C.es) { C.es.close(); C.es = null; } clearTimeout(C.reT); }
function connect() {
  disconnect();
  if (!C.grp) return setConn('off');
  if (!navigator.onLine) return setConn('off');
  setConn('connecting');
  const since = localStorage.getItem('lastId') || 'all';
  const es = new EventSource(NTFY + '/' + C.grp.topic + '/sse?since=' + encodeURIComponent(since));
  C.es = es;
  es.onopen = () => { C.backoff = 2000; setConn('live'); flush(); };
  es.onmessage = ev => { try { handleEvent(JSON.parse(ev.data)); } catch (e) { console.warn(e); } };
  es.onerror = () => {
    es.close(); if (C.es !== es) return; C.es = null;
    setConn(navigator.onLine ? 'error' : 'off');
    C.reT = setTimeout(connect, C.backoff); C.backoff = Math.min(C.backoff * 2, 30000);
  };
}
async function handleEvent(ev) {
  if (ev.event !== 'message') return;
  localStorage.setItem('lastId', ev.id);
  let env;
  try { env = await decObj(ev.message); } catch (e) { return; } // not decryptable: ignore
  if (!env || !env.id) return;
  if (env.type === 'pres') { if (env.dev !== C.me.dev) seen(env, env.ev); return; }
  if (env.dev !== C.me.dev && env.type !== 'sys') seen(env, 'msg');
  if (env.dev !== C.me.dev && (env.refs || env.acks)) {
    for (const ref of [...(env.refs || []), ...(env.acks || [])]) {
      const m = C.msgs.get(ref) || await get('msgs', ref);
      if (m && m.mine) { m.deliveredTo = [...new Set([...(m.deliveredTo || []), env.from])]; m.status = 'delivered'; C.msgs.set(m.id, m); await put('msgs', m); }
    }
    renderMsgs();
  }
  if (env.type === 'ack') return;
  const existing = C.msgs.get(env.id) || await get('msgs', env.id);
  if (env.dev === C.me.dev) { // echo of my own message
    if (existing && existing.status !== 'delivered') { existing.status = existing.status === 'queued' || existing.status === 'sending' ? 'sent' : existing.status; existing.ntfyId = ev.id; C.msgs.set(existing.id, existing); await put('msgs', existing); renderMsgs(); }
    return;
  }
  if (existing) return;
  const m = {id: env.id, type: env.type, text: env.text, from: env.from || '?', dev: env.dev, t: env.t || ev.time * 1000, loc: env.loc || null, dur: env.dur, mime: env.mime, mine: false, ntfyId: ev.id};
  if (env.type === 'voice') {
    try {
      let bytes;
      if (env.inline) bytes = Uint8Array.from(atob(env.inline), c => c.charCodeAt(0));
      else if (ev.attachment && ev.attachment.url) { const r = await fetch(ev.attachment.url); if (!r.ok) throw new Error('HTTP ' + r.status); bytes = new Uint8Array(await r.arrayBuffer()); }
      else throw new Error('missing file');
      const plain = await decBytes(bytes);
      await put('blobs', {id: m.id, blob: new Blob([plain], {type: env.mime || 'audio/webm'})});
    } catch (e) { m.voiceErr = 'audio expired/unavailable'; m.voiceErrDetail = String(e && e.message || e); }
  }
  C.msgs.set(m.id, m); await put('msgs', m);
  if (A().tab !== 'group' || document.hidden) { C.unread++; updateUnread(); }
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') { try { new Notification(m.from, {body: m.type === 'voice' ? '🎙️ Voice message' : m.text, tag: 'grp'}); } catch (e) {} }
  if (navigator.vibrate && m.type === 'ping') navigator.vibrate(200);
  renderMsgs();
  queueAck(m.id);
}
// Receipts: one silent ack per message burst (sent 30 s after the last incoming message, or at most 2 min after the first); also piggyback on your next message.
function queueAck(id) { if (!C.ackQ.size) C.ackFirst = Date.now(); C.ackQ.add(id); clearTimeout(C.ackT); C.ackT = setTimeout(sendAcks, Math.max(0, Math.min(ACK_IDLE_MS, C.ackFirst + ACK_MAX_MS - Date.now()))); }
async function sendAcks() {
  if (!C.ackQ.size || !navigator.onLine || !C.grp) return;
  const refs = [...C.ackQ]; C.ackQ.clear();
  try { await publishText({id: 'ack-' + uid(), type: 'ack', refs, from: C.me.name, dev: C.me.dev, t: Date.now()}, true); C.ackCount = (C.ackCount || 0) + 1; }
  catch (e) { refs.forEach(r => C.ackQ.add(r)); }
}

// ---------- sending ----------
async function publishText(env, silent) {
  const r = await fetch(NTFY + '/', {method: 'POST', body: JSON.stringify(silent ? {topic: C.grp.topic, message: await encObj(env)} : {topic: C.grp.topic, message: await encObj(env), title: 'Trip group', tags: ['speech_balloon']})});
  if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
  return r.json();
}
async function publishVoice(env, blob) {
  const enc = await encBytes(new Uint8Array(await blob.arrayBuffer()));
  if (enc.length > ATTACH_LIMIT) { const e = new Error('clip too large'); e.status = 413; throw e; }
  const r = await fetch(NTFY + '/' + C.grp.topic, {method: 'PUT', body: enc, headers: {'Filename': 'v.bin', 'X-Message': await encObj(env), 'X-Title': 'Trip group', 'X-Tags': 'microphone'}});
  if (r.ok) return r.json();
  if (r.status !== 429 && enc.length < 2400) { // fallback: tiny clip inline (4 KB message limit)
    return publishText(Object.assign({}, env, {inline: bigB64(enc)}));
  }
  const e = new Error('HTTP ' + r.status); e.status = r.status; throw e;
}
function currentLoc() {
  if (!shareOn()) return null; // location only when the user opted in
  const p = A().pos; if (!p) return null;
  return {lat: +p.lat.toFixed(5), lon: +p.lon.toFixed(5), acc: Math.round(p.acc || 0), t: p.t || Date.now()};
}
async function send(type, text, extra) {
  if (!C.grp) return;
  const m = Object.assign({id: uid(), type, text, from: C.me.name, dev: C.me.dev, t: Date.now(), loc: currentLoc(), mine: true, status: 'queued'}, extra || {});
  C.msgs.set(m.id, m); await put('msgs', m);
  await put('outbox', {id: m.id, created: m.t});
  renderMsgs(); countQueued();
  flush();
  return m;
}
async function countQueued() { C.queued = (await all('outbox')).length; setConn(C.conn); }
async function flush() {
  if (C.flushing || !C.grp || !navigator.onLine) { countQueued(); return; }
  C.flushing = true;
  try {
    const box = (await all('outbox')).sort((a, b) => a.created - b.created);
    for (const o of box) {
      const m = C.msgs.get(o.id) || await get('msgs', o.id);
      if (!m) { await del('outbox', o.id); continue; }
      const env = {id: m.id, type: m.type, text: m.text, from: m.from, dev: m.dev, t: m.t, loc: m.loc || undefined, dur: m.dur, mime: m.mime};
      const pig = [...C.ackQ]; if (pig.length) env.acks = pig;
      m.status = 'sending'; renderMsgs();
      try {
        if (m.type === 'voice') { const b = await get('blobs', m.id); await publishVoice(env, b.blob); }
        else await publishText(env);
        if (m.status !== 'delivered') m.status = 'sent';
        pig.forEach(r => C.ackQ.delete(r));
        await del('outbox', o.id);
      } catch (e) {
        if (e.status && e.status !== 429 && e.status < 500) { m.status = 'error'; m.err = e.message; await del('outbox', o.id); }
        else { m.status = 'queued'; C.msgs.set(m.id, m); await put('msgs', m); break; } // network/rate limit: keep queued
      }
      C.msgs.set(m.id, m); await put('msgs', m);
    }
  } finally { C.flushing = false; renderMsgs(); countQueued(); }
}
C.flush = flush; C.send = send;

// ---------- voice recording (hold to record) ----------
const REC = {stream: null, rec: null, chunks: [], t0: 0, timer: null, holding: false, idleT: null};
function pickMime() {
  if (!window.MediaRecorder) return null;
  const c = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/aac', 'audio/ogg;codecs=opus', 'audio/webm'];
  for (const t of c) { try { if (MediaRecorder.isTypeSupported(t)) return t; } catch (e) {} }
  return '';
}
async function ensureStream() {
  if (REC.stream && REC.stream.getAudioTracks().some(t => t.readyState === 'live')) return REC.stream;
  REC.stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: true, noiseSuppression: true, channelCount: 1}});
  return REC.stream;
}
function releaseSoon() { clearTimeout(REC.idleT); REC.idleT = setTimeout(() => { if (REC.stream && !REC.rec) { REC.stream.getTracks().forEach(t => t.stop()); REC.stream = null; } }, 90000); }
async function recStart(ev) {
  if (ev) ev.preventDefault();
  if (REC.rec) return;
  const btn = $('#btnVoice');
  const mime = pickMime();
  if (mime === null || !navigator.mediaDevices) { $('#voiceNote').textContent = 'Voice messages are not supported in this browser.'; return; }
  REC.holding = true;
  let stream;
  try { const had = !!REC.stream; stream = await ensureStream(); if (!had && !REC.holding) { $('#voiceNote').textContent = 'Microphone ready - now press and hold to record.'; releaseSoon(); return; } }
  catch (e) { $('#voiceNote').textContent = 'Microphone blocked (' + e.name + '). Allow mic access in browser/app settings.'; REC.holding = false; return; }
  if (!REC.holding) { releaseSoon(); return; }
  const opts = {audioBitsPerSecond: 24000}; if (mime) opts.mimeType = mime;
  let rec; try { rec = new MediaRecorder(stream, opts); } catch (e) { rec = new MediaRecorder(stream); }
  REC.rec = rec; REC.chunks = []; REC.t0 = Date.now();
  rec.ondataavailable = e => { if (e.data && e.data.size) REC.chunks.push(e.data); };
  rec.onstop = async () => {
    const dur = Date.now() - REC.t0, type = rec.mimeType || mime || 'audio/webm';
    REC.rec = null; btn.classList.remove('rec'); btn.textContent = '🎙️ Hold to record voice message'; clearInterval(REC.timer); releaseSoon();
    if (dur < MIN_REC_MS) { $('#voiceNote').textContent = 'Too short - hold the button while you talk.'; return; }
    const blob = new Blob(REC.chunks, {type});
    const id = uid();
    await put('blobs', {id, blob});
    await send('voice', '', {id, dur, mime: type});
    $('#voiceNote').textContent = 'Voice message ' + Math.round(dur / 1000) + ' s (' + Math.round(blob.size / 1024) + ' KB, ' + type.split(';')[0] + ')';
  };
  rec.start(250);
  btn.classList.add('rec');
  REC.timer = setInterval(() => { const s = (Date.now() - REC.t0) / 1000; btn.textContent = '🔴 Recording… ' + s.toFixed(0) + ' s / 30 s - release to send'; if (s * 1000 >= MAX_REC_MS) recStop(); }, 200);
}
function recStop(ev) { if (ev) ev.preventDefault(); REC.holding = false; if (REC.rec && REC.rec.state !== 'inactive') REC.rec.stop(); }
async function play(id, btn) {
  const b = await get('blobs', id); if (!b) return A().toast('Audio not available');
  const url = URL.createObjectURL(b.blob); const a = new Audio(url);
  btn.textContent = '🔊 Playing…'; a.onended = a.onerror = () => { btn.textContent = '▶ Play again'; URL.revokeObjectURL(url); };
  a.play().catch(e => { btn.textContent = '▶ Tap to play'; A().toast('Playback blocked: ' + e.message); });
}

// ---------- QR scanning ----------
let scanStream = null, scanTimer = null;
async function startScan() {
  const dlg = $('#scanDlg'), v = $('#scanVideo'), msg = $('#scanMsg');
  dlg.showModal(); msg.textContent = 'Starting camera…';
  try { scanStream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}}); }
  catch (e) { msg.textContent = 'Camera unavailable (' + e.name + '). Paste the join link instead.'; return; }
  v.srcObject = scanStream; await v.play().catch(() => {});
  msg.textContent = 'Point the camera at the QR code on the organiser\'s phone.';
  const det = ('BarcodeDetector' in window) ? new BarcodeDetector({formats: ['qr_code']}) : null;
  if (!det && !window.jsQR) await new Promise(r => { const s = document.createElement('script'); s.src = 'js/vendor/jsQR.min.js'; s.onload = r; s.onerror = r; document.head.appendChild(s); });
  const cv = $('#scanCanvas'), ctx = cv.getContext('2d', {willReadFrequently: true});
  const tick = async () => {
    if (!scanStream) return;
    try {
      let text = null;
      if (v.videoWidth) {
        if (det) { const r = await det.detect(v); if (r[0]) text = r[0].rawValue; }
        else if (window.jsQR) { const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth); cv.width = w; cv.height = h; ctx.drawImage(v, 0, 0, w, h); const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h); if (r) text = r.data; }
      }
      if (text) { const g = parseJoin(text); if (g) { stopScan(); joinGroup(g); return; } msg.textContent = 'That QR is not a group join code.'; }
    } catch (e) {}
    scanTimer = setTimeout(tick, 250);
  };
  tick();
}
function stopScan() { clearTimeout(scanTimer); if (scanStream) scanStream.getTracks().forEach(t => t.stop()); scanStream = null; const d = $('#scanDlg'); if (d.open) d.close(); }

// ---------- boot ----------
async function init() {
  loadCfg(); loadRoster(); C.openedAt = Date.now();
  const fromHash = parseJoin(location.hash.slice(1));
  if (fromHash) { history.replaceState(null, '', location.pathname + location.search); } // keep secret out of the address bar
  if (fromHash && (!C.grp || C.grp.topic !== fromHash.topic)) C.pendingJoin = fromHash;
  if (C.grp) await loadKey(C.grp.key);
  (await all('msgs')).forEach(m => C.msgs.set(m.id, m));
  renderSetup(); renderMsgs();
  if (C.pendingJoin) { A().showTab('group'); if (C.me.name) { /* one tap to confirm */ } }
  $('#pings').innerHTML = PINGS.map(p => '<button data-ping="' + esc(p) + '">' + esc(p) + '</button>').join('');
  $('#pings').onclick = e => { const b = e.target.closest('[data-ping]'); if (b) send('ping', b.dataset.ping); };
  $('#btnSend').onclick = () => { const i = $('#msgInput'); const v = i.value.trim(); if (!v) return; i.value = ''; send('text', v); };
  $('#msgInput').onkeydown = e => { if (e.key === 'Enter') $('#btnSend').click(); };
  const sl = $('#shareLoc'); sl.checked = shareOn();
  const locNote = () => { $('#locNote').textContent = sl.checked ? '📍 Your last GPS fix is attached to messages you send.' : 'Location sharing is off - no location is attached to your messages.'; };
  sl.onchange = () => { localStorage.setItem('shareLoc', sl.checked ? '1' : '0'); locNote(); }; locNote();
  const vb = $('#btnVoice');
  vb.addEventListener('pointerdown', recStart); vb.addEventListener('pointerup', recStop); vb.addEventListener('pointercancel', recStop); vb.addEventListener('pointerleave', recStop);
  vb.addEventListener('contextmenu', e => e.preventDefault());
  vb.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) recStart(e); });
  vb.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') recStop(e); });
  if (pickMime() === null) $('#voiceNote').textContent = 'Voice messages are not supported in this browser (no MediaRecorder).';
  $('#msgList').onclick = e => { const b = e.target.closest('[data-play]'); if (b) play(b.dataset.play, b); };
  $('#btnScanClose').onclick = stopScan;
  window.addEventListener('online', () => { connect(); flush(); sendAcks(); });
  window.addEventListener('offline', () => { disconnect(); setConn('off'); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) C.openedAt = Date.now(); if (!document.hidden && C.grp && !C.es && navigator.onLine) connect(); if (document.hidden) sendAcks(); else if (A().tab === 'group') sendPres('hb'); renderMembers(); });
  window.addEventListener('pagehide', () => sendAcks());
  setInterval(presTick, 30000);
  document.addEventListener('tabchange', e => { if (e.detail === 'group') { sendPres('hb'); C.unread = 0; updateUnread(); renderMsgs(); if ('Notification' in window && Notification.permission === 'default' && C.grp) { try { Notification.requestPermission(); } catch (x) {} } } });
  document.addEventListener('posupdate', () => { if (A().tab === 'group') renderMsgs(); });
  setInterval(() => { if (navigator.onLine && C.grp) flush(); }, 15000);
  setConn('off');
  if (C.grp) { connect(); flush(); if (!document.hidden) sendPres('hb'); }
  C.ready = true;
}
function start() { if (A() && A().ready) init(); else document.addEventListener('appready', init, {once: true}); }
start();
})();
