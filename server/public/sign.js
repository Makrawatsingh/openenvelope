const root = document.getElementById('sign'); const token = root.dataset.token;
const pad = document.getElementById('pad'), ctx = pad.getContext('2d'); let drawing = false, drawn = false;
ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.strokeStyle = '#0b2a6b';
const pos = (e) => { const r = pad.getBoundingClientRect(); return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height]; };
pad.addEventListener('pointerdown', (e) => { drawing = true; pad.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.moveTo(...pos(e)); });
pad.addEventListener('pointermove', (e) => { if (!drawing) return; ctx.lineTo(...pos(e)); ctx.stroke(); drawn = true; });
pad.addEventListener('pointerup', () => { drawing = false; });
document.getElementById('clear').onclick = () => { ctx.clearRect(0, 0, pad.width, pad.height); drawn = false; };

(async () => {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
  const pdf = await pdfjs.getDocument(`/s/${token}/file`).promise;
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i); const vp = p.getViewport({ scale: 1.4 });
    const wrap = document.createElement('div'); wrap.className = 'page';
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; wrap.append(c);
    document.getElementById('pages').append(wrap);
    await p.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
})();

document.getElementById('signform').addEventListener('submit', async (e) => {
  e.preventDefault(); const err = document.getElementById('err'); err.textContent = '';
  if (!drawn) { err.textContent = 'Please draw your signature.'; return; }
  const r = await fetch(`/s/${token}`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: document.getElementById('name').value, agree: document.getElementById('agree').checked, signature: pad.toDataURL('image/png') }) });
  const j = await r.json();
  if (!r.ok) { err.textContent = j.error; return; }
  root.innerHTML = '<div class="card"><h1>Signed ✓</h1><p>Thank you. The sender has been notified and receives the signed PDF with an audit trail.</p></div>';
});
