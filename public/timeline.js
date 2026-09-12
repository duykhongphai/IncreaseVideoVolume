/* Timeline editor: waveform (peak + RMS per bucket) + per-segment gain, ms-precise split points */
window.Timeline = (() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const MIN_DB = -60;
  const SILENCE_DB = -55;
  const MIN_SPAN = 0.05; // seconds visible at max zoom

  const st = {
    id: null, duration: 0, data: null, splits: [], gains: [],
    view: [0, 0], playhead: 0, loading: false, activeSeg: -1,
  };
  let canvas, ctx, video, dpr = 1, drag = null, raf = 0, onChange = () => {};

  // ------------------------------------------------------------ math helpers
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const u8db = (v) => v / 255 * -MIN_DB + MIN_DB;
  const dbPow = (db) => Math.pow(10, db / 10);
  const powDb = (p) => 10 * Math.log10(Math.max(p, 1e-10));
  const round3 = (t) => Math.round(t * 1000) / 1000;

  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
  function fmt(t) {
    t = Math.max(0, t || 0);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t - h * 3600 - m * 60;
    const ss = s.toFixed(3).padStart(6, '0');
    return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + ss;
  }
  function parse(str) {
    const parts = String(str || '').trim().replace(',', '.').split(':');
    if (!parts.length || parts.some(p => p === '' || isNaN(Number(p)))) return null;
    let t = 0; for (const p of parts) t = t * 60 + Number(p);
    return t;
  }

  // ------------------------------------------------------------ segments model
  function bounds() { return [0, ...st.splits, st.duration]; }
  function segs() {
    const b = bounds(); const out = [];
    for (let i = 0; i < b.length - 1; i++) out.push({ i, start: b[i], end: b[i + 1], gainDb: st.gains[i] || 0 });
    return out;
  }
  function segIndexAt(t) {
    let i = 0; while (i < st.splits.length && t >= st.splits[i]) i++; return i;
  }
  function gainAt(t) { return st.gains[segIndexAt(t)] || 0; }

  function segStats(start, end) {
    if (!st.data) return { rms: MIN_DB, peak: MIN_DB };
    const { bucketMs, count, peak, rms } = st.data;
    let i0 = clamp(Math.floor(start * 1000 / bucketMs), 0, count), i1 = clamp(Math.ceil(end * 1000 / bucketMs), 0, count);
    if (i1 <= i0) i1 = Math.min(count, i0 + 1);
    let pw = 0, pk = 0, n = 0;
    for (let i = i0; i < i1; i++) { pw += dbPow(u8db(rms[i])); if (peak[i] > pk) pk = peak[i]; n++; }
    return { rms: n ? powDb(pw / n) : MIN_DB, peak: n ? u8db(pk) : MIN_DB };
  }

  function addSplit(t) {
    t = round3(clamp(t, 0, st.duration));
    if (t <= 0.001 || t >= st.duration - 0.001) return false;
    if (st.splits.some(s => Math.abs(s - t) < 0.001)) return false;
    const k = segIndexAt(t); // segment being cut
    st.splits.splice(k, 0, t);
    st.gains.splice(k + 1, 0, st.gains[k] || 0);
    changed(); return true;
  }
  function removeSplit(k) {
    if (k < 0 || k >= st.splits.length) return;
    st.splits.splice(k, 1);
    st.gains.splice(k + 1, 1);
    changed();
  }
  function moveSplit(k, t) {
    const lo = (k > 0 ? st.splits[k - 1] : 0) + 0.001, hi = (k < st.splits.length - 1 ? st.splits[k + 1] : st.duration) - 0.001;
    st.splits[k] = round3(clamp(t, lo, hi));
  }
  function setGain(i, g) { st.gains[i] = clamp(Math.round(Number(g) * 10) / 10 || 0, -40, 40); }
  function changed() { st.gains.length = st.splits.length + 1; for (let i = 0; i < st.gains.length; i++) st.gains[i] = st.gains[i] || 0; renderTable(); draw(); onChange(); }

  // ------------------------------------------------------------ auto tools
  function autoSplit({ thresholdDb = 6, minLen = 2, block = 0.5 } = {}) {
    if (!st.data) return 0;
    const blocks = [];
    for (let t = 0; t < st.duration; t += block) blocks.push({ t: round3(t), rms: segStats(t, Math.min(t + block, st.duration)).rms });
    const splits = []; let segStart = 0, acc = [];
    for (let k = 0; k < blocks.length; k++) {
      const b = blocks[k];
      if (b.rms < SILENCE_DB) continue; // ignore silence
      if (!acc.length) { acc.push(b.rms); continue; }
      const mean = powDb(acc.reduce((a, d) => a + dbPow(d), 0) / acc.length);
      if (Math.abs(b.rms - mean) > thresholdDb && b.t - segStart >= minLen) {
        const next = blocks.slice(k, k + 3).filter(x => x.rms >= SILENCE_DB);
        if (next.length >= 2 && next.every(x => Math.abs(x.rms - mean) > thresholdDb * 0.7)) {
          splits.push(b.t); segStart = b.t; acc = [b.rms]; continue;
        }
      }
      acc.push(b.rms);
      if (acc.length > 40) acc.shift(); // rolling window (~20 s)
    }
    st.splits = splits; st.gains = new Array(splits.length + 1).fill(0);
    changed();
    return splits.length;
  }

  function autoBalance(targetDb) {
    let clipped = 0;
    for (const s of segs()) {
      const { rms, peak } = segStats(s.start, s.end);
      if (rms < SILENCE_DB) { st.gains[s.i] = 0; continue; }
      let g = targetDb - rms;
      const cap = -1 - peak; // keep true peak under -1 dBFS
      if (g > cap) { g = cap; clipped++; }
      st.gains[s.i] = clamp(Math.round(g * 10) / 10, -40, 40);
    }
    changed();
    return clipped;
  }
  function loudestRms() {
    let best = MIN_DB;
    for (const s of segs()) { const r = segStats(s.start, s.end).rms; if (r > best) best = r; }
    return best;
  }

  // ------------------------------------------------------------ view / zoom
  function setView(a, b) {
    let span = clamp(b - a, MIN_SPAN, st.duration || MIN_SPAN);
    a = clamp(a, 0, Math.max(0, st.duration - span));
    st.view = [a, a + span];
    draw();
  }
  function zoom(factor, at) {
    const [a, b] = st.view; const span = b - a; if (at == null) at = (a + b) / 2;
    const ns = clamp(span * factor, MIN_SPAN, st.duration);
    const ratio = (at - a) / span;
    setView(at - ns * ratio, at - ns * ratio + ns);
  }
  function ensureVisible(t) {
    const [a, b] = st.view; const span = b - a;
    if (t < a || t > b) setView(t - span * 0.1, t - span * 0.1 + span);
  }

  // ------------------------------------------------------------ drawing
  function niceStep(pxPerSec) {
    const steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
    for (const s of steps) if (s * pxPerSec >= 90 * dpr) return s;
    return 3600;
  }
  function draw() {
    if (!canvas || !ctx) return;
    const W = canvas.width, H = canvas.height, R = Math.round(18 * dpr);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b0e13'; ctx.fillRect(0, 0, W, H);
    if (!st.duration) return;
    const [v0, v1] = st.view; const span = (v1 - v0) || 1;
    const xOf = (t) => (t - v0) / span * W;
    const tOf = (x) => v0 + x / W * span;
    const S = segs();

    // segment tints
    S.forEach((s) => {
      const x0 = Math.max(0, xOf(s.start)), x1 = Math.min(W, xOf(s.end));
      if (x1 <= 0 || x0 >= W) return;
      ctx.fillStyle = s.i === st.activeSeg ? 'rgba(47,111,224,.16)' : (s.i % 2 ? 'rgba(127,171,255,.05)' : 'rgba(255,255,255,.02)');
      ctx.fillRect(x0, R, x1 - x0, H - R);
    });

    // waveform
    if (st.data) {
      const { bucketMs, count, peak, rms } = st.data;
      const mid = R + (H - R) / 2, half = (H - R) / 2 - 3 * dpr;
      for (let x = 0; x < W; x++) {
        const t0 = tOf(x), t1 = tOf(x + 1);
        let i0 = Math.floor(t0 * 1000 / bucketMs), i1 = Math.ceil(t1 * 1000 / bucketMs);
        if (i1 <= i0) i1 = i0 + 1;
        i0 = clamp(i0, 0, count); i1 = clamp(i1, 0, count);
        if (i1 <= i0) continue;
        let pk = 0, pw = 0;
        for (let i = i0; i < i1; i++) { if (peak[i] > pk) pk = peak[i]; pw += dbPow(u8db(rms[i])); }
        const pkDb = u8db(pk), rmsDb = powDb(pw / (i1 - i0));
        const g = gainAt((t0 + t1) / 2);
        const amp = (db) => clamp((db - MIN_DB) / -MIN_DB, 0, 1) * half;
        // original (grey)
        const aP = amp(pkDb), aR = amp(rmsDb);
        ctx.fillStyle = '#3a4557'; ctx.fillRect(x, mid - aP, 1, Math.max(1, aP * 2));
        ctx.fillStyle = '#556279'; ctx.fillRect(x, mid - aR, 1, Math.max(1, aR * 2));
        // after gain (blue / red when clipping)
        if (Math.abs(g) > 0.01) {
          const pkA = pkDb + g, clip = pkA > -0.05;
          const bP = amp(pkA), bR = amp(rmsDb + g);
          ctx.fillStyle = clip ? 'rgba(239,91,106,.55)' : 'rgba(47,111,224,.45)'; ctx.fillRect(x, mid - bP, 1, Math.max(1, bP * 2));
          ctx.fillStyle = clip ? '#ff8c99' : '#7fabff'; ctx.fillRect(x, mid - bR, 1, Math.max(1, bR * 2));
        }
      }
      // 0 dB / center line
      ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(0, mid, W, 1);
    } else {
      ctx.fillStyle = '#556279'; ctx.font = `${13 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(st.loading ? 'Analyzing waveform…' : 'No waveform data', W / 2, H / 2);
    }

    // ruler
    ctx.fillStyle = '#12161e'; ctx.fillRect(0, 0, W, R);
    ctx.fillStyle = '#2a3342'; ctx.fillRect(0, R - 1, W, 1);
    const step = niceStep(W / span);
    ctx.font = `${10 * dpr}px system-ui, sans-serif`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const first = Math.floor(v0 / step) * step;
    for (let t = first; t <= v1 + step; t += step) {
      const x = xOf(t); if (x < -50 || x > W + 50) continue;
      ctx.fillStyle = '#3a4557'; ctx.fillRect(Math.round(x), 0, 1, R);
      ctx.fillStyle = '#97a3b7';
      const label = step >= 1 ? fmt(t).replace(/\.\d{3}$/, '') : fmt(t);
      ctx.fillText(label, Math.round(x) + 3 * dpr, R / 2);
      // minor ticks
      for (let k = 1; k < 5; k++) { const xm = xOf(t + step * k / 5); ctx.fillStyle = '#242c39'; ctx.fillRect(Math.round(xm), R - 5 * dpr, 1, 5 * dpr); }
    }

    // segment labels
    ctx.font = `bold ${11 * dpr}px system-ui, sans-serif`; ctx.textBaseline = 'top';
    S.forEach((s) => {
      const x0 = Math.max(0, xOf(s.start)), x1 = Math.min(W, xOf(s.end));
      if (x1 - x0 < 30 * dpr) return;
      const g = s.gainDb; const txt = `#${s.i + 1}  ${g > 0 ? '+' : ''}${g.toFixed(1)} dB`;
      ctx.fillStyle = 'rgba(11,14,19,.75)'; ctx.fillRect(x0 + 4 * dpr, R + 4 * dpr, ctx.measureText(txt).width + 8 * dpr, 16 * dpr);
      ctx.fillStyle = Math.abs(g) > 0.01 ? '#7fabff' : '#97a3b7'; ctx.fillText(txt, x0 + 8 * dpr, R + 6 * dpr);
    });

    // split lines
    st.splits.forEach((t, k) => {
      const x = Math.round(xOf(t)); if (x < 0 || x > W) return;
      ctx.fillStyle = drag && drag.split === k ? '#f5b84a' : '#f5b84a';
      ctx.fillRect(x - 1, R, 2 * dpr, H - R);
      ctx.beginPath(); ctx.moveTo(x - 6 * dpr, R); ctx.lineTo(x + 6 * dpr, R); ctx.lineTo(x, R + 7 * dpr); ctx.closePath(); ctx.fill();
    });

    // playhead
    const px = Math.round(xOf(st.playhead));
    if (px >= 0 && px <= W) {
      ctx.fillStyle = '#ef5b6a'; ctx.fillRect(px, 0, Math.max(1, 1.5 * dpr), H);
      ctx.beginPath(); ctx.moveTo(px - 6 * dpr, 0); ctx.lineTo(px + 6 * dpr, 0); ctx.lineTo(px, 8 * dpr); ctx.closePath(); ctx.fill();
    }
  }

  // ------------------------------------------------------------ table
  function renderTable() {
    const table = $('segTable'); if (!table) return;
    const S = segs();
    const rows = S.map((s) => {
      const { rms, peak } = segStats(s.start, s.end);
      const after = peak + s.gainDb;
      const afterCls = after > -0.05 ? 'clip' : (after > -1 ? '' : 'ok');
      const silent = rms < SILENCE_DB;
      return `<tr data-i="${s.i}" class="${s.i === st.activeSeg ? 'active' : ''}">
        <td><span class="idx" style="background:${s.i % 2 ? '#2f6fe0' : '#556279'}">${s.i + 1}</span></td>
        <td><input type="text" data-role="start" data-i="${s.i}" value="${fmt(s.start)}" ${s.i === 0 ? 'disabled' : ''} /></td>
        <td><input type="text" data-role="end" data-i="${s.i}" value="${fmt(s.end)}" ${s.i === S.length - 1 ? 'disabled' : ''} /></td>
        <td>${fmt(s.end - s.start)}</td>
        <td>${silent ? '<span class="muted">silence</span>' : rms.toFixed(1) + ' dB'}</td>
        <td>${silent ? '—' : peak.toFixed(1) + ' dB'}</td>
        <td><input type="number" step="0.1" min="-40" max="40" data-role="gain" data-i="${s.i}" value="${s.gainDb.toFixed(1)}" />
            <input type="range" min="-20" max="30" step="0.1" data-role="gainRange" data-i="${s.i}" value="${clamp(s.gainDb, -20, 30)}" /></td>
        <td class="${afterCls}">${silent ? '—' : (after > -0.05 ? icon('alert') + ' clip ' : '') + after.toFixed(1) + ' dB'}</td>
        <td>${s.i < S.length - 1 ? `<button type="button" class="btn small ghost" data-role="merge" data-i="${s.i}" title="Remove the split after this segment">Merge with next</button>` : ''}</td>
      </tr>`;
    }).join('');
    table.innerHTML = `<thead><tr><th>#</th><th>Start</th><th>End</th><th>Length</th><th>Source RMS</th><th>Source peak</th><th>Gain (dB)</th><th>Peak after</th><th></th></tr></thead><tbody>${rows}</tbody>`;
  }

  function onTableInput(e) {
    const el = e.target; const role = el.dataset.role; if (!role) return;
    const i = Number(el.dataset.i);
    if (role === 'gain' || role === 'gainRange') {
      setGain(i, el.value);
      const row = el.closest('tr');
      row.querySelector('[data-role=gain]').value = st.gains[i].toFixed(1);
      row.querySelector('[data-role=gainRange]').value = clamp(st.gains[i], -20, 30);
      const { peak, rms } = segStats(...(() => { const s = segs()[i]; return [s.start, s.end]; })());
      const after = peak + st.gains[i]; const cell = row.children[7];
      cell.className = after > -0.05 ? 'clip' : (after > -1 ? '' : 'ok');
      cell.innerHTML = rms < SILENCE_DB ? '—' : (after > -0.05 ? icon('alert') + ' clip ' : '') + after.toFixed(1) + ' dB';
      draw(); onChange();
    }
  }
  function onTableChange(e) {
    const el = e.target; const role = el.dataset.role; if (!role) return;
    const i = Number(el.dataset.i);
    if (role === 'start' || role === 'end') {
      const t = parse(el.value);
      if (t == null) { el.value = fmt(role === 'start' ? segs()[i].start : segs()[i].end); return; }
      moveSplit(role === 'start' ? i - 1 : i, t);
      changed();
    }
  }
  function onTableClick(e) {
    const btn = e.target.closest('[data-role=merge]');
    if (btn) { removeSplit(Number(btn.dataset.i)); return; }
    const tr = e.target.closest('tr[data-i]');
    if (tr && !e.target.matches('input')) { const s = segs()[Number(tr.dataset.i)]; st.activeSeg = s.i; seek(s.start); ensureVisible(s.start); renderTable(); draw(); }
  }

  // ------------------------------------------------------------ playback sync
  function seek(t) {
    st.playhead = clamp(t, 0, st.duration);
    if (video && Math.abs(video.currentTime - st.playhead) > 0.005) { try { video.currentTime = st.playhead; } catch { /* not ready */ } }
    $('tlTime').textContent = fmt(st.playhead);
    draw();
  }
  function tick() {
    if (!video || video.paused) { raf = 0; return; }
    st.playhead = video.currentTime; $('tlTime').textContent = fmt(st.playhead);
    const seg = segIndexAt(st.playhead); if (seg !== st.activeSeg) { st.activeSeg = seg; renderTable(); }
    ensureVisible(st.playhead); draw();
    raf = requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------ canvas interaction
  function hitSplit(x) {
    const [v0, v1] = st.view; const W = canvas.width;
    let best = -1, bestD = 7 * dpr;
    st.splits.forEach((t, k) => { const d = Math.abs((t - v0) / (v1 - v0) * W - x); if (d < bestD) { bestD = d; best = k; } });
    return best;
  }
  function tAtX(x) { const [v0, v1] = st.view; return v0 + x / canvas.width * (v1 - v0); }

  function bindCanvas() {
    canvas.addEventListener('pointerdown', (e) => {
      canvas.focus();
      const x = e.offsetX * dpr;
      drag = { x0: x, view0: [...st.view], split: hitSplit(x), moved: false, id: e.pointerId };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      const x = e.offsetX * dpr;
      if (!drag) { canvas.style.cursor = hitSplit(x) >= 0 ? 'ew-resize' : 'crosshair'; return; }
      if (Math.abs(x - drag.x0) > 3 * dpr) drag.moved = true;
      if (drag.split >= 0) { moveSplit(drag.split, tAtX(x)); draw(); }
      else if (drag.moved) { const dt = (drag.x0 - x) / canvas.width * (drag.view0[1] - drag.view0[0]); setView(drag.view0[0] + dt, drag.view0[1] + dt); canvas.style.cursor = 'grabbing'; }
    });
    const up = (e) => {
      if (!drag) return;
      const x = e.offsetX * dpr;
      if (drag.split >= 0) changed();
      else if (!drag.moved) { seek(tAtX(x)); st.activeSeg = segIndexAt(st.playhead); renderTable(); }
      drag = null; canvas.style.cursor = 'crosshair';
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', () => { drag = null; });
    canvas.addEventListener('dblclick', (e) => { const k = hitSplit(e.offsetX * dpr); if (k >= 0) removeSplit(k); else addSplit(tAtX(e.offsetX * dpr)); });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) { const [a, b] = st.view; const dt = (e.deltaY > 0 ? 1 : -1) * (b - a) * 0.15; setView(a + dt, b + dt); }
      else zoom(e.deltaY > 0 ? 1.25 : 0.8, tAtX(e.offsetX * dpr));
    }, { passive: false });
    canvas.addEventListener('keydown', (e) => {
      if (e.key === 's' || e.key === 'S') { addSplit(st.playhead); e.preventDefault(); }
      else if (e.key === ' ') { togglePlay(); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { seek(st.playhead - (e.shiftKey ? 1 : 0.01)); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { seek(st.playhead + (e.shiftKey ? 1 : 0.01)); e.preventDefault(); }
    });
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  function resize() {
    if (!canvas) return;
    dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    draw();
  }

  // ------------------------------------------------------------ init / public API
  function init(opts = {}) {
    canvas = $('tlCanvas'); ctx = canvas.getContext('2d'); video = $('tlVideo');
    onChange = opts.onChange || onChange;
    bindCanvas();
    new ResizeObserver(resize).observe(canvas);
    video.addEventListener('play', () => { $('tlPlay').innerHTML = icon('pause') + ' <span>Pause</span>'; if (!raf) raf = requestAnimationFrame(tick); });
    video.addEventListener('pause', () => { $('tlPlay').innerHTML = icon('play') + ' <span>Play</span>'; });
    video.addEventListener('seeked', () => { st.playhead = video.currentTime; $('tlTime').textContent = fmt(st.playhead); draw(); });
    video.addEventListener('error', () => { $('tlStatus').textContent += ' — The browser cannot play this format; the timeline can still be edited.'; });
    $('tlPlay').addEventListener('click', togglePlay);
    $('tlSplitHere').addEventListener('click', () => { if (!addSplit(st.playhead)) toastMsg('Cannot split here (duplicate split or at the very edge).'); });
    $('tlSplitAtBtn').addEventListener('click', () => {
      const t = parse($('tlSplitAt').value);
      if (t == null) return toastMsg('Time format: m:ss.mmm (for example 1:23.456)');
      if (addSplit(t)) { seek(t); ensureVisible(t); } else toastMsg('Cannot split at this position.');
    });
    $('tlSplitAt').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('tlSplitAtBtn').click(); });
    $('tlZoomIn').addEventListener('click', () => zoom(0.5, st.playhead));
    $('tlZoomOut').addEventListener('click', () => zoom(2, st.playhead));
    $('tlZoomFit').addEventListener('click', () => setView(0, st.duration));
    $('tlAutoSplit').addEventListener('click', () => {
      if (!st.data) return toastMsg('No waveform data yet.');
      const n = autoSplit();
      toastMsg(n ? `Split into ${n + 1} segments based on loudness changes.` : 'Loudness is fairly even; no clear split point was found.', true);
    });
    $('tlLoudest').addEventListener('click', () => { $('tlTarget').value = loudestRms().toFixed(1); });
    $('tlBalance').addEventListener('click', () => {
      if (!st.data) return toastMsg('No waveform data yet.');
      const target = clamp(Number($('tlTarget').value) || -18, -40, -3);
      const capped = autoBalance(target);
      toastMsg(`Balanced ${st.gains.length} segments to ${target} dBFS.` + (capped ? ` ${capped} segment(s) were capped so peaks stay below -1 dB.` : ''), true);
    });
    $('tlClear').addEventListener('click', () => { st.splits = []; st.gains = [st.gains[0] || 0]; changed(); });
    const table = $('segTable');
    table.addEventListener('input', onTableInput);
    table.addEventListener('change', onTableChange);
    table.addEventListener('click', onTableClick);
  }

  function toastMsg(msg, ok) { if (window.__toast) window.__toast(msg, ok); else console.log(msg); }

  async function load(id, duration) {
    if (st.id === id && st.data) return;
    reset();
    st.id = id; st.duration = duration || 0; st.gains = [0];
    st.view = [0, st.duration];
    video.src = `/api/source/${id}`;
    st.loading = true; $('tlStatus').textContent = 'Analyzing waveform…'; draw(); renderTable();
    try {
      const r = await fetch(`/api/waveform/${id}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Error');
      if (st.id !== id) return;
      const dec = (b64) => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      st.data = { bucketMs: j.bucketMs, count: j.count, peak: dec(j.peak), rms: dec(j.rms) };
      if (j.duration) st.duration = j.duration;
      st.view = [0, st.duration];
      $('tlStatus').textContent = `Analyzed ${j.count.toLocaleString()} points at ${j.bucketMs} ms resolution.`;
    } catch (e) {
      $('tlStatus').textContent = 'Analysis failed: ' + e.message;
    } finally {
      st.loading = false; resize(); renderTable(); draw();
    }
  }

  function reset() {
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    st.id = null; st.duration = 0; st.data = null; st.splits = []; st.gains = [0]; st.view = [0, 0]; st.playhead = 0; st.activeSeg = -1;
    if ($('tlStatus')) $('tlStatus').textContent = 'Not analyzed yet.';
    if ($('tlTime')) $('tlTime').textContent = '0:00.000';
    if ($('segTable')) $('segTable').innerHTML = '';
    draw();
  }

  function getSegments() { return segs().map(s => ({ start: s.start, end: s.end, gainDb: s.gainDb })); }
  function isReady() { return !!st.data; }

  return { init, load, reset, getSegments, isReady, fmt, parse };
})();
