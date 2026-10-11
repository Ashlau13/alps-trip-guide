/* Alps Trip Guide - main app (offline-first, no external content APIs) */
(function () {
'use strict';
const TZ = 'Asia/Tokyo';
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const CAT_ICON = {transport:'🚌',lodging:'🛏️',parking:'🅿️',nature:'🌲',viewpoint:'🏔️',history:'🏯',shrine:'⛩️',temple:'🛕',museum:'🏛️',food:'🍱',shopping:'🛍️',town:'🏘️',onsen:'♨️',info:'ℹ️',garden:'🌸'};

const S = {
  pois: [], byId: {}, itin: null, items: [],
  pos: null,            // {lat, lon, acc, t, sim:bool}
  gpsState: 'init',     // init | watching | ok | denied | unavailable | sim
  simPlace: null, simNow: null, viewPoi: null, prevTab: 'here', mapArea: 'All', tab: 'here'
};
window.AlpsApp = S;

// ---------- geo helpers ----------
const R = 6371000, rad = d => d * Math.PI / 180;
function dist(a, b) {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat/2)**2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
const compass = deg => ['N','NE','E','SE','S','SW','W','NW'][Math.round(deg / 45) % 8];
function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)) + ' km'; }
function travelHint(m, target, from) {
  const inKami = target.area === 'Kamikochi';
  const fromKami = from && from.area === 'Kamikochi';
  if (m < 1300 || (inKami && fromKami && m < 7000)) {
    const min = Math.max(1, Math.round(m * 1.25 / 75)); // ~4.5 km/h with detour factor
    return '🚶 ~' + (min >= 60 ? (min / 60).toFixed(1) + ' h' : min + ' min') + ' walk';
  }
  if (inKami && !fromKami) return '🚌 bus only (no cars in Kamikochi)';
  let min = Math.round(m * 1.4 / 1000 / 45 * 60 / 5) * 5; min = Math.max(5, min);
  return '🚗 ~' + (min >= 60 ? Math.floor(min / 60) + ' h ' + (min % 60 ? (min % 60) + ' min' : '') : min + ' min') + ' drive (est.)';
}
S.util = {dist, bearing, compass, fmtDist};

// ---------- time helpers (Asia/Tokyo) ----------
function now() { return S.simNow ? new Date(S.simNow) : new Date(); }
function parseJst(s) { if (!s) return null; if (!/[zZ]|[+-]\d\d:?\d\d$/.test(s)) s += '+09:00'; return new Date(s); }
const fmtT = d => new Intl.DateTimeFormat('en-GB', {timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false}).format(d);
const fmtD = d => new Intl.DateTimeFormat('en-GB', {timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short'}).format(d);
const jstDate = d => new Intl.DateTimeFormat('en-CA', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'}).format(d);
function rel(ms) {
  const m = Math.round(Math.abs(ms) / 60000);
  if (m < 60) return m + ' min';
  const h = Math.floor(m / 60), mm = m % 60;
  if (h < 48) return h + ' h' + (mm ? ' ' + mm + ' min' : '');
  return Math.round(h / 24) + ' days';
}
S.time = {now, parseJst, fmtT, fmtD};

// ---------- data ----------
async function loadData() {
  const [p, i] = await Promise.all([AlpsLock.fetchJson('data/pois.json'), AlpsLock.fetchJson('data/itinerary.json')]);
  S.pois = p.pois; S.pois.forEach(x => S.byId[x.id] = x);
  S.itin = i; S.items = [];
  i.days.forEach(d => d.items.forEach(it => S.items.push(Object.assign({date: d.date}, it, {_s: parseJst(it.start), _e: parseJst(it.end)}))));
  S.items.sort((a, b) => a._s - b._s);
}

// ---------- nearest / place cards ----------
function withDistances(from) {
  return S.pois.map(p => ({p, d: dist(from, p)})).sort((a, b) => a.d - b.d);
}
function nearbyList(from, excludeId, fromPoi) {
  return withDistances(from).filter(x => x.p.id !== excludeId && x.d < 25000).slice(0, 10);
}
const safeUrl = u => /^https:\/\//.test(u || '') ? u : '#';
const linksHtml = ls => ls && ls.length ? '<div class="links">' + ls.map(l => '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">🔗 ' + esc(l.label) + '</a>').join('') + '</div>' : '';
function placeHtml(p, opts) {
  opts = opts || {};
  const here = opts.here, d = opts.d;
  let status = '';
  if (d != null) status = here ? '<span class="status">✓ You are here</span>' : '<span class="status far">Nearest place · ' + fmtDist(d) + ' away</span>';
  const practical = p.practical && p.practical.length ? '<div class="sec"><h3>Practical (verified)</h3><ul class="practical">' + p.practical.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' : '';
  const approx = /APPROXIMATE/.test(p.coord_source) ? '<div class="warnnote">📌 Map pin approximate: ' + esc(p.coord_source.replace('APPROXIMATE: ', '')) + '</div>' : '';
  const from = opts.from;
  let near = '';
  if (from) {
    const list = nearbyList(from, p.id, p);
    near = '<div class="sec"><h3>Nearby worth visiting ' + (opts.fromLabel ? '<small>(' + esc(opts.fromLabel) + ')</small>' : '') + '</h3><ul class="list nearby">' +
      list.map(x => '<li><button class="item" data-poi="' + x.p.id + '"><span class="cat">' + (CAT_ICON[x.p.category] || '•') + '</span><span class="nm">' + esc(x.p.name) + '<small>' + esc(x.p.name_ja) + '</small></span><span class="d"><b>' + fmtDist(x.d) + '</b>' + travelHint(x.d, x.p, p) + '</span></button></li>').join('') + '</ul></div>';
  }
  return '<article class="card place" data-id="' + p.id + '">' + status +
    '<h2>' + (CAT_ICON[p.category] || '') + ' ' + esc(p.name) + '</h2><div class="ja">' + esc(p.name_ja) + ' · ' + esc(p.area) + '</div>' +
    '<div class="sec"><h3>What it is</h3><p>' + esc(p.info) + '</p></div>' + practical + (p.links ? '<div class="sec"><h3>Official links</h3>' + linksHtml(p.links) + '</div>' : '') +
    '<div class="sec"><h3>Local history</h3><p>' + esc(p.history) + '</p></div>' +
    '<div class="sec"><h3>Tips</h3><p>' + esc(p.tips) + '</p></div>' + approx + near + '</article>';
}
function renderHere() {
  const el = $('#hereCard');
  if (!S.pos) {
    el.innerHTML = '<div class="card"><h2>Finding your location…</h2><p class="muted">Allow location access, or pick a place below. Everything works offline.</p><button class="btn primary" id="btnPick">Pick a place / simulate location</button></div>';
    $('#btnPick').onclick = () => $('#settings').showModal();
    return;
  }
  const list = withDistances(S.pos);
  const inside = list.filter(x => x.d <= x.p.radius + Math.min(S.pos.acc || 0, 150));
  const top = inside[0] || list[0];
  const here = !!inside[0];
  S.currentPoi = here ? top.p.id : null;
  S.nearestPoi = top.p.id;
  el.innerHTML = placeHtml(top.p, {here, d: here ? null : top.d, from: S.pos, fromLabel: 'sorted by distance from you'}).replace('<article', '<article id="hereArticle"') +
    (here ? '' : '');
  if (here) el.querySelector('article').insertAdjacentHTML('afterbegin', '<span class="status">✓ You are here</span> ');
}
function renderPlace(id) {
  const p = S.byId[id]; if (!p) return;
  S.viewPoi = id;
  const from = S.pos || p;
  $('#placeDetail').innerHTML = placeHtml(p, {d: S.pos ? dist(S.pos, p) : null, here: S.pos && dist(S.pos, p) <= p.radius, from, fromLabel: S.pos ? 'distance from you' : 'distance from this place'});
  showTab('place');
}

// ---------- next step ----------
function computeNext() {
  const t = now();
  const items = S.items;
  if (!items.length) return null;
  const cur = items.filter(it => it._e && it._s <= t && t < it._e && !it.optional).pop();
  const next = items.find(it => it._s > t && !it.optional) || items.find(it => it._s > t);
  const first = items[0], last = items[items.length - 1];
  return {t, cur, next, before: t < first._s, after: t > (last._e || last._s)};
}
function renderBanner() {
  const n = computeNext(), el = $('#nextBanner');
  if (!n) { el.innerHTML = ''; return; }
  let html = '';
  const locLine = it => {
    if (!it || !it.poi || !S.byId[it.poi]) return '';
    const p = S.byId[it.poi];
    if (!S.pos) return '<div class="sub">📍 ' + esc(p.name) + '</div>';
    const d = dist(S.pos, p);
    if (d <= p.radius + 100) return '<div class="sub"><span class="here">✓ You are here</span> ' + esc(p.name) + '</div>';
    return '<div class="sub">📍 ' + esc(p.name) + ' - ' + fmtDist(d) + ' away · ' + travelHint(d, p, S.currentPoi ? S.byId[S.currentPoi] : null) + '</div>';
  };
  if (n.before) {
    html = '<div class="lbl">Trip starts in ' + rel(S.items[0]._s - n.t) + '</div><div class="ttl">' + esc(S.items[0].title) + '</div>';
  } else if (n.after) {
    html = '<div class="lbl">Trip complete</div><div class="ttl">Safe travels home! おつかれさまでした</div>';
  } else {
    if (n.cur) html += '<div class="lbl">Now · until ' + fmtT(n.cur._e) + '</div><div class="ttl">' + esc(n.cur.title) + '</div>' + locLine(n.cur);
    if (n.next) {
      const flags = (n.next.placeholder ? ' <span class="ph">' + (n.next.type === 'lodging' ? 'TBD' : 'PLACEHOLDER') + '</span>' : '') + (n.next.approx ? ' <small>(approx.)</small>' : '');
      html += '<div class="lbl" style="margin-top:' + (n.cur ? '8px' : '0') + '">Next step · ' + fmtD(n.next._s) + ' ' + fmtT(n.next._s) + ' JST · in ' + rel(n.next._s - n.t) + '</div>' +
        '<div class="ttl">' + esc(n.next.title) + flags + '</div>' + locLine(n.next) + (n.next.notes ? '<div class="sub">' + esc(n.next.notes) + '</div>' : '');
    }
  }
  const simTag = (S.simNow ? ' 🕒 simulated time ' + fmtD(n.t) + ' ' + fmtT(n.t) : '') + (S.simPlace ? ' 📍 simulated location' : '');
  if (simTag) html += '<div class="sub muted small">' + simTag + '</div>';
  el.innerHTML = html;
}

// ---------- itinerary ----------
function tripHeader() {
  const tr = S.itin.trip || {};
  const all = S.items.filter(i => i.placeholder || i.confirm).map(i => fmtD(i._s) + ': ' + i.title + (i.placeholder ? '' : ' (confirm booking)'));
  const rng = tr.start ? fmtD(parseJst(tr.start + 'T12:00')) + ' - ' + fmtD(parseJst(tr.end + 'T12:00')) + ' ' + tr.end.slice(0, 4) : '';
  return '<div class="card trip"><h2>' + esc(tr.title || 'Trip') + '</h2>' +
    '<div class="n"><b>' + esc(rng) + '</b>' + (tr.dates_provisional ? ' <span class="ph">PROVISIONAL DATES</span>' : '') + ' · ' + esc(tr.travellers || '') + '</div>' +
    (tr.dates_note ? '<div class="warnnote">📅 ' + esc(tr.dates_note) + '</div>' : '') +
    (tr.route ? '<div class="n">🗺️ ' + esc(tr.route) + '</div>' : '') +
    (tr.car ? '<div class="n">🚗 ' + esc(tr.car) + '</div>' : '') +
    (all.length ? '<details class="todo"><summary>Still to fill in / book (' + all.length + ')</summary><ul>' + all.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></details>' : '') + '</div>';
}
function renderPlan() {
  const n = computeNext(), t = now();
  $('#planList').innerHTML = tripHeader() + S.itin.days.map((d, di) => {
    const items = S.items.filter(i => i.date === d.date);
    return '<div class="day" id="day-' + (di + 1) + '"><h3>Day ' + (di + 1) + ' · ' + esc(fmtD(parseJst(d.date + 'T12:00'))) + ' - ' + esc(d.title) + '</h3>' + (d.note ? '<div class="warnnote daynote">⚠️ ' + esc(d.note) + '</div>' : '') + items.map(it => {
      const cls = (n && n.next && n.next.id === it.id) ? 'next' : ((it._e || it._s) < t ? 'past' : '');
      const p = it.poi && S.byId[it.poi];
      return '<div class="it ' + cls + (it.optional ? ' opt' : '') + '" data-it="' + it.id + '"><div class="t">' + fmtT(it._s) + (it._e ? '<br><small class="muted">-' + fmtT(it._e) + '</small>' : '') + (it.approx ? '<br><small class="muted">approx</small>' : '') + '</div><div><b>' + esc(it.title) + '</b>' +
        (it.optional ? '<span class="op">OPTIONAL</span>' : '') + (it.placeholder ? '<span class="ph">' + (it.type === 'lodging' ? 'TBD' : 'PLACEHOLDER') + '</span>' : '') + (it.confirm ? '<span class="cf">CONFIRM</span>' : '') +
        (it.notes ? '<div class="n">' + esc(it.notes) + '</div>' : '') +
        (it.details && it.details.length ? '<ul class="det">' + it.details.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
        linksHtml(it.links) +
        (p ? '<div class="n"><a href="#" data-poi="' + p.id + '">📍 ' + esc(p.name) + '</a></div>' : '') + '</div></div>';
    }).join('') + ((S.itin.stays && S.itin.stays.areas.filter(a => a.nights[0] === d.date).map(a => stayArea(a, false)).join('')) || '') + '</div>';
  }).join('') + '<p class="muted small">Lodging: ' + S.itin.lodging.map(l => esc(l.name) + (l.placeholder ? ' (TBD)' : (l.confirm ? ' (confirm)' : ''))).join(' · ') + '</p>';
}


// ---------- stays (lodging shortlist) ----------
function stayCard(o) {
  const tag = o.tag ? '<span class="stag stag-' + esc(o.tag.toLowerCase().replace(/\s+/g, '-')) + '">' + esc(o.tag) + '</span>' : '';
  const name = o.url ? '<a href="' + esc(o.url) + '" target="_blank" rel="noopener">' + esc(o.en) + ' ↗</a>' : esc(o.en);
  return '<div class="stay"><div class="stay-h"><b>' + name + '</b>' + tag + '<span class="nb">NOT BOOKED</span></div>' +
    (o.jp ? '<div class="muted small">' + esc(o.jp) + '</div>' : '') + '<ul class="det">' +
    (o.parking ? '<li>🅿️ ' + esc(o.parking) + '</li>' : '') + (o.features ? '<li>✨ ' + esc(o.features) + '</li>' : '') +
    (o.price ? '<li>💴 ' + esc(o.price) + '</li>' : '') + (o.opens ? '<li>📅 ' + esc(o.opens) + '</li>' : '') + '</ul></div>';
}
function stayArea(a, open) {
  return '<details class="stayarea"' + (open ? ' open' : '') + '><summary>🛏️ ' + esc(a.area) + ' <small class="muted">' + esc(a.jp || '') + ' · ' + esc(a.label) + ' · ' + a.options.length + ' choices</small></summary>' +
    (a.notes || []).map(n => '<div class="warnnote">⚠️ ' + esc(n) + '</div>').join('') + a.options.map(stayCard).join('') + '</details>';
}
function renderStays() {
  const st = S.itin.stays; if (!st) return;
  $('#staysList').innerHTML = '<div class="note">' + esc(st.status) + ' ' + esc(st.groupNote) + '</div>' + st.areas.map(a => stayArea(a, true)).join('');
}

// ---------- map (offline SVG sketch) ----------
const AREAS = {All: null, Hakuba: ['Hakuba', 'Hakuba route', 'Omachi'], Kamikochi: ['Kamikochi', 'Hirayu', 'Okuhida'], Takayama: ['Takayama'], 'Ito/Izu': ['Ito'], Karuizawa: ['Karuizawa'], Tokyo: ['Tokyo'], 'Matsumoto/Azumino': ['Matsumoto', 'Azumino'], Suwa: ['Lake Suwa']};
function renderMap() {
  $('#mapAreas').innerHTML = Object.keys(AREAS).map(a => '<button class="' + (a === S.mapArea ? 'on' : '') + '" data-area="' + a + '">' + a + '</button>').join('');
  const sel = AREAS[S.mapArea];
  const pts = S.pois.filter(p => !sel || sel.includes(p.area));
  let lat0 = Math.min(...pts.map(p => p.lat)), lat1 = Math.max(...pts.map(p => p.lat)), lon0 = Math.min(...pts.map(p => p.lon)), lon1 = Math.max(...pts.map(p => p.lon));
  const k = Math.cos(rad((lat0 + lat1) / 2));
  let w = (lon1 - lon0) * k, h = lat1 - lat0; const span = Math.max(w, h, 0.004) * 1.3;
  const cx = (lon0 + lon1) / 2, cy = (lat0 + lat1) / 2;
  const X = lon => 500 + ((lon - cx) * k) / span * 1000, Y = lat => 500 - (lat - cy) / span * 1000;
  // route through itinerary POIs in order
  const seq = []; S.items.forEach(it => { const p = !it.optional && it.poi && S.byId[it.poi]; if (p && seq[seq.length - 1] !== p) seq.push(p); });
  let svg = '<rect x="0" y="0" width="1000" height="1000" fill="#eef3ee"/>';
  svg += '<polyline points="' + seq.map(p => X(p.lon).toFixed(1) + ',' + Y(p.lat).toFixed(1)).join(' ') + '" fill="none" stroke="#d9480f" stroke-width="5" stroke-dasharray="14 10" stroke-linejoin="round" opacity=".7"/>';
  const fs = sel ? 30 : 24, boxes = [];
  const key = ['haneda', 'karuizawa-psp', 'happo-bt', 'sanmachi', 'kappa-bashi', 'akandana', 'ito-stn', 'jogasaki', 'omuro', 'matsumoto-castle', 'suwa-akimiya', 'happo-ike'];
  const ki = p => { const i = key.indexOf(p.id); return i < 0 ? 99 : i; };
  const main = p => p.category === 'lodging' && !p.tbd;
  const order = pts.slice().sort((a, b) => ki(a) - ki(b) || main(b) - main(a));
  let dots = '', labels = '';
  order.forEach(p => {
    const x = X(p.lon), y = Y(p.lat), lodge = p.category === 'lodging';
    dots += '<g class="mp" data-poi="' + p.id + '" style="cursor:pointer"><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + (lodge ? 16 : 12) + '" fill="' + (lodge ? '#0b4f6c' : '#2b8a3e') + '" stroke="#fff" stroke-width="4"/><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="30" fill="transparent"/></g>';
    if (!(sel || main(p) || key.includes(p.id))) return;
    const txt = p.name.split(' (')[0], w = txt.length * fs * 0.55, h = fs * 1.1;
    let lx = x + 18, ly = y + fs * 0.35;
    if (lx + w > 990) lx = x - 18 - w;
    const bx = {x: lx, y: ly - fs, w, h};
    if (boxes.some(o => bx.x < o.x + o.w && o.x < bx.x + bx.w && bx.y < o.y + o.h && o.y < bx.y + bx.h)) return;
    boxes.push(bx);
    labels += '<text data-poi="' + p.id + '" x="' + lx.toFixed(1) + '" y="' + ly.toFixed(1) + '" font-size="' + fs + '" font-weight="700" fill="#222" stroke="#fff" stroke-width="5" paint-order="stroke" style="cursor:pointer">' + esc(txt) + '</text>';
  });
  svg += dots + labels;
  if (S.pos) svg += '<circle cx="' + X(S.pos.lon).toFixed(1) + '" cy="' + Y(S.pos.lat).toFixed(1) + '" r="16" fill="#1c7ed6" stroke="#fff" stroke-width="5"><title>You</title></circle>';
  svg += '<text x="20" y="985" font-size="22" fill="#555">N ↑ · width ≈ ' + Math.round(span * 111) + ' km · © OpenStreetMap contributors</text>';
  $('#map').innerHTML = svg;
}

// ---------- places list ----------
function renderPlaces() {
  const q = ($('#placeSearch').value || '').toLowerCase();
  const base = S.pos ? withDistances(S.pos) : S.pois.map(p => ({p, d: null}));
  $('#placeList').innerHTML = '<ul class="list">' + base.filter(x => !q || (x.p.name + ' ' + x.p.name_ja + ' ' + x.p.area + ' ' + x.p.category).toLowerCase().includes(q)).map(x =>
    '<li><button class="item" data-poi="' + x.p.id + '"><span class="cat">' + (CAT_ICON[x.p.category] || '•') + '</span><span class="nm">' + esc(x.p.name) + '<small>' + esc(x.p.name_ja) + ' · ' + esc(x.p.area) + '</small></span>' + (x.d != null ? '<span class="d"><b>' + fmtDist(x.d) + '</b></span>' : '') + '</button></li>').join('') + '</ul>';
}

// ---------- GPS ----------
let watchId = null;
function gpsChip() {
  const c = $('#gpsChip');
  c.className = 'chip';
  if (S.simPlace) { c.textContent = '📍 simulated'; c.classList.add('warn'); }
  else if (S.gpsState === 'ok' && S.pos) c.textContent = '📍 ±' + Math.round(S.pos.acc || 0) + ' m';
  else if (S.gpsState === 'denied') { c.textContent = '📍 denied'; c.classList.add('off'); }
  else if (S.gpsState === 'unavailable') { c.textContent = '📍 no GPS'; c.classList.add('off'); }
  else c.textContent = '📍 searching';
}
function startGps() {
  if (S.simPlace) return;
  if (!('geolocation' in navigator)) { S.gpsState = 'unavailable'; permNote('This device/browser has no geolocation. Use "Pick a place" in ⚙️ settings.'); gpsChip(); return; }
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  S.gpsState = 'watching'; gpsChip();
  watchId = navigator.geolocation.watchPosition(pos => {
    if (S.simPlace) return;
    S.pos = {lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: pos.timestamp, sim: false};
    S.gpsState = 'ok'; permNote(''); refresh();
  }, err => {
    if (err.code === 1) { S.gpsState = 'denied'; permNote('Location permission is off. You can still browse everything: tap a place, or use ⚙️ → "Simulate location". To enable: iPhone Settings → Privacy → Location Services → Safari Websites / this app → While Using.'); }
    else { S.gpsState = 'unavailable'; if (!S.pos) permNote('Could not get a GPS fix yet (' + esc(err.message || 'timeout') + '). Keep the app open outdoors, or pick a place manually.'); }
    gpsChip(); refresh();
  }, {enableHighAccuracy: true, maximumAge: 15000, timeout: 30000});
}
function permNote(msg) { const n = $('#permNote'); if (!msg) { n.classList.add('hidden'); return; } n.innerHTML = msg + ' <button class="btn" id="btnPick2" style="margin-top:6px">Pick a place</button>'; n.classList.remove('hidden'); $('#btnPick2').onclick = () => $('#settings').showModal(); }
function setSimPlace(id) {
  S.simPlace = id || null;
  if (id) { const p = S.byId[id]; S.pos = {lat: p.lat, lon: p.lon, acc: 10, t: Date.now(), sim: true}; S.gpsState = 'sim'; }
  else { S.pos = null; startGps(); }
  gpsChip(); refresh();
}
function setSimNow(iso) { S.simNow = iso ? parseJst(iso).getTime() : null; refresh(); }
S.setSimPlace = setSimPlace; S.setSimNow = setSimNow;

// ---------- tabs & events ----------
function showTab(name) {
  if (name !== 'place') S.prevTab = name;
  S.tab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'map') renderMap();
  if (name === 'places') renderPlaces();
  if (name === 'plan') renderPlan();
  if (name === 'stays') renderStays();
  window.scrollTo(0, 0);
  if (name === 'plan') { const nx = document.querySelector('.it.next'); if (nx) setTimeout(() => nx.scrollIntoView({block: 'center'}), 50); }
  document.dispatchEvent(new CustomEvent('tabchange', {detail: name}));
}
S.showTab = showTab;
function refresh() {
  renderBanner(); renderHere(); gpsChip();
  if (S.tab === 'map') renderMap(); if (S.tab === 'places') renderPlaces(); if (S.tab === 'plan') renderPlan(); if (S.tab === 'stays') renderStays();
  document.dispatchEvent(new CustomEvent('posupdate'));
}
S.refresh = refresh;
S.toast = function (msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms || 2500); };

function wire() {
  document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  document.body.addEventListener('click', e => {
    const b = e.target.closest('[data-poi]'); if (b) { e.preventDefault(); renderPlace(b.dataset.poi); return; }
    const a = e.target.closest('[data-area]'); if (a) { S.mapArea = a.dataset.area; renderMap(); }
  });
  $('#btnBack').onclick = () => showTab(S.prevTab || 'here');
  $('#placeSearch').oninput = renderPlaces;
  $('#btnSettings').onclick = () => { $('#settings').showModal(); };
  const sel = $('#simPlace');
  sel.innerHTML += S.pois.slice().sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name)).map(p => '<option value="' + p.id + '">' + esc(p.area + ' - ' + p.name) + '</option>').join('');
  sel.value = S.simPlace || '';
  sel.onchange = () => setSimPlace(sel.value);
  const st = $('#simTime');
  if (S.simNow) st.value = new Intl.DateTimeFormat('sv-SE', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(S.simNow)).replace(' ', 'T');
  st.onchange = () => setSimNow(st.value || null);
  $('#btnRealTime').onclick = () => { st.value = ''; setSimNow(null); };
  $('#btnRetryGps').onclick = () => { sel.value = ''; setSimPlace(null); };
  setInterval(() => { renderBanner(); }, 30000);
}

// ---------- service worker ----------
function registerSW() {
  const el = $('#swStatus');
  if (!('serviceWorker' in navigator)) { el.textContent = 'Service worker not supported - offline mode unavailable.'; return; }
  navigator.serviceWorker.register('sw.js', {scope: './'}).then(reg => {
    S.swReg = reg;
    navigator.serviceWorker.ready.then(() => { el.textContent = '✅ Offline ready: app and all content cached on this device.'; S.offlineReady = true; });
  }).catch(e => { el.textContent = 'Service worker failed: ' + e.message; });
  navigator.serviceWorker.addEventListener('message', ev => { if (ev.data && ev.data.type === 'precached') { S.precached = ev.data.count; el.textContent = '✅ Offline ready: ' + ev.data.count + ' files cached (' + ev.data.version + ').'; } });
}

// ---------- boot ----------
async function boot() {
  const q = new URLSearchParams(location.search);
  await window.AlpsLock.ready;
  document.body.classList.remove('locked');
  await loadData();
  if (q.get('now')) S.simNow = parseJst(q.get('now')).getTime();
  const sim = q.get('sim');
  wire();
  registerSW();
  if (sim && S.byId[sim]) { $('#simPlace').value = sim; setSimPlace(sim); } else { startGps(); refresh(); }
  if (q.get('tab')) showTab(q.get('tab'));
  S.ready = true;
  document.dispatchEvent(new CustomEvent('appready'));
}
boot().catch(e => { document.body.insertAdjacentHTML('afterbegin', '<div class="note">Failed to start: ' + esc(e.message) + '</div>'); console.error(e); });
})();
