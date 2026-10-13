/* Members-only lock: trip content in data/*.json is AES-GCM encrypted with a content key.
   The key arrives via the invite link (#...&c=KEY), or the QR (same link).
   An existing member's saved group key also unwraps it if the organiser enabled that in lock.json. Stored in localStorage 'ck'. */
(function () {
'use strict';
const $ = s => document.querySelector(s);
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const L = {key: null};
window.AlpsLock = L;
async function importCk(raw) { return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']); }
async function dec(key, o) { return new Uint8Array(await crypto.subtle.decrypt({name: 'AES-GCM', iv: unb64u(o.iv)}, key, unb64u(o.ct))); }
let probe = null;
async function verify(raw) { // raw content key -> true if it decrypts the itinerary
  try { const k = await importCk(raw); if (!probe) probe = await (await fetch('data/itinerary.json')).json(); await dec(k, probe); return k; } catch (e) { return null; }
}
async function tryRaw(raw) { const k = await verify(raw); if (!k) return false; localStorage.setItem('ck', b64u(raw)); L.key = k; return true; }
async function lockFile() { return (await fetch('data/lock.json')).json(); }
async function viaGroupKey() {
  let g = null; try { g = JSON.parse(localStorage.getItem('grp') || 'null'); } catch (e) {}
  if (!g || !g.key) return false;
  try {
    const gk = await crypto.subtle.importKey('raw', unb64u(g.key), 'AES-GCM', false, ['decrypt']);
    for (const w of (await lockFile()).wraps.filter(w => w.type === 'grp')) { try { if (await tryRaw(await dec(gk, w))) return true; } catch (e) {} }
  } catch (e) {}
  return false;
}
function ckFromLink(str) { try { const h = str.includes('#') ? str.slice(str.indexOf('#') + 1) : str; const c = new URLSearchParams(h).get('c'); return c ? unb64u(c) : null; } catch (e) { return null; } }
async function viaLink(str) { const raw = ckFromLink(str); return raw ? tryRaw(raw) : false; }
L.forget = () => { localStorage.removeItem('ck'); L.key = null; };
L.fetchJson = async url => { const o = await (await fetch(url)).json(); return JSON.parse(new TextDecoder().decode(await dec(L.key, o))); };

function showLock(msg) {
  document.body.classList.add('locked');
  const el = $('#lockScreen'); el.classList.remove('hidden');
  el.innerHTML = '<div class="lock-card"><div class="lock-logo">⛰️</div><h1>Alps Trip</h1><p class="lock-tag">🔒 Members only</p>' +
    '<p class="muted">This trip guide is private to our travel group. </p><p class="note" id="lkAsk">Ask a group member for the invite link.</p>' +
    (msg ? '<p class="note" id="lockMsg">' + msg + '</p>' : '<p class="note hidden" id="lockMsg"></p>') +
    '<button class="btn primary" id="lkScan" style="width:100%">📷 Scan invite QR</button>' +
    '<label class="lk">Paste invite link<input type="text" id="lkLink" placeholder="https://…#g=…&k=…&c=…" autocomplete="off"></label><button class="btn" id="lkLinkGo" style="width:100%">Unlock with link</button>' +
    '<p class="muted small">Unlocking saves the key on this phone so the guide works offline. "Leave group" removes it.</p></div>';
  const say = t => { const m = $('#lockMsg'); m.textContent = t; m.classList.remove('hidden'); };
  const useLink = async str => {
    if (await viaLink(str)) { const h = str.includes('#') ? str.slice(str.indexOf('#')) : ''; if (/[#&]g=/.test(h)) location.hash = h.slice(1); location.reload(); return; }
    say(/[#&]g=/.test(str) && !/[#&]c=/.test(str) ? 'That is an older chat-only invite. Ask the organiser to send the new invite link (it ends with &c=…).' : 'That invite link is not valid for this trip.');
  };
  $('#lkLinkGo').onclick = () => useLink($('#lkLink').value.trim());
  $('#lkScan').onclick = () => scan(useLink, say);
}
let stream = null, timer = null;
async function scan(onText, say) {
  const dlg = $('#scanDlg'), v = $('#scanVideo'), msg = $('#scanMsg');
  const stop = () => { clearTimeout(timer); if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; if (dlg.open) dlg.close(); };
  $('#btnScanClose').onclick = stop;
  dlg.showModal(); msg.textContent = 'Starting camera…';
  try { stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: 'environment'}}); } catch (e) { msg.textContent = 'Camera unavailable (' + e.name + '). Paste the invite link instead.'; return; }
  v.srcObject = stream; await v.play().catch(() => {});
  msg.textContent = 'Point the camera at the invite QR on a member\'s phone.';
  const det = ('BarcodeDetector' in window) ? new BarcodeDetector({formats: ['qr_code']}) : null;
  if (!det && !window.jsQR) await new Promise(r => { const s = document.createElement('script'); s.src = 'js/vendor/jsQR.min.js'; s.onload = r; s.onerror = r; document.head.appendChild(s); });
  const cv = $('#scanCanvas'), ctx = cv.getContext('2d', {willReadFrequently: true});
  const tick = async () => {
    if (!stream) return;
    try {
      let text = null;
      if (v.videoWidth) {
        if (det) { const r = await det.detect(v); if (r[0]) text = r[0].rawValue; }
        else if (window.jsQR) { const w = Math.min(640, v.videoWidth), h = Math.round(v.videoHeight * w / v.videoWidth); cv.width = w; cv.height = h; ctx.drawImage(v, 0, 0, w, h); const r = jsQR(ctx.getImageData(0, 0, w, h).data, w, h); if (r) text = r.data; }
      }
      if (text && ckFromLink(text)) { stop(); return onText(text); }
      if (text) msg.textContent = 'That QR is not a trip invite.';
    } catch (e) {}
    timer = setTimeout(tick, 250);
  };
  tick();
}
// Resolves once unlocked (app.js awaits this before loading content).
L.ready = (async () => {
  const saved = localStorage.getItem('ck');
  if (saved && await tryRaw(unb64u(saved))) return;
  if (saved) localStorage.removeItem('ck');
  if (await viaLink(location.hash)) return;           // invite link opened directly: hash kept for chat.js to join
  if (await viaGroupKey()) return;                      // existing member, if organiser enabled group-key unlock
  const old = /[#&]g=/.test(location.hash) || localStorage.getItem('grp');
  if (/[#&]g=/.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
  showLock(old ? 'The guide is now members-only. Open or paste the latest invite link from the organiser once to unlock.' : '');
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js', {scope: './'}).catch(() => {}); // keep updates flowing
  await new Promise(() => {}); // stay locked
})();
})();
