// Tracked document / video viewer: renders the PDF page by page with pdf.js and reports
// which page is on screen every few seconds (time-per-page analytics).
const app = document.getElementById('app');
const id = app.dataset.id, kind = app.dataset.kind;
const gate = document.getElementById('gate'), err = document.getElementById('err'), pagesEl = document.getElementById('pages');
let session = null, current = 1, lastTick = Date.now();

gate.addEventListener('submit', async (e) => {
  e.preventDefault(); err.textContent = '';
  const body = { viewer: document.getElementById('who').value, password: document.getElementById('pw')?.value };
  const r = await fetch(`/d/${id}/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) { err.textContent = j.error === 'wrong password' ? 'Wrong password.' : 'This link is no longer available.'; return; }
  session = j.session; gate.remove();
  if (kind === 'video') return showVideo(j);
  await showPdf(j);
});

async function showPdf(j) {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument(j.file_url).promise;
  const obs = new IntersectionObserver((ents) => {
    for (const en of ents) if (en.isIntersecting && en.intersectionRatio > 0.5) { tick(); current = Number(en.target.dataset.page); show(); }
  }, { threshold: [0.5] });
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const vp = p.getViewport({ scale: 1.6 });
    const wrap = document.createElement('div'); wrap.className = 'page'; wrap.dataset.page = i;
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    wrap.append(c);
    if (j.watermark) { const w = document.createElement('div'); w.className = 'wm'; w.textContent = j.watermark; wrap.append(w); }
    pagesEl.append(wrap); obs.observe(wrap);
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
  document.addEventListener('contextmenu', (e) => { if (app.dataset.download !== 'true') e.preventDefault(); });
  function show() { document.getElementById('pg').textContent = `Page ${current} / ${pdf.numPages}`; }
  show();
}

function showVideo(j) {
  const v = document.createElement('video'); v.src = j.file_url; v.controls = true; v.playsInline = true;
  pagesEl.append(v); current = 'video';
  v.addEventListener('play', () => { lastTick = Date.now(); });
  v.addEventListener('pause', tick);
}

function tick() {
  if (!session) return;
  const secs = (Date.now() - lastTick) / 1000; lastTick = Date.now();
  if (document.hidden || secs <= 0) return;
  const body = JSON.stringify({ s: session, page: current, seconds: Math.min(secs, 60) });
  navigator.sendBeacon ? navigator.sendBeacon(`/d/${id}/ping`, new Blob([body], { type: 'application/json' }))
    : fetch(`/d/${id}/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
}
setInterval(tick, 5000);
document.addEventListener('visibilitychange', () => { if (document.hidden) tick(); else lastTick = Date.now(); });
window.addEventListener('pagehide', tick);
