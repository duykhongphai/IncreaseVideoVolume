/* global fetch, XMLHttpRequest, EventSource, Timeline */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const state = {
    uploadId: null, fileName: '', info: null, caps: null,
    mode: 'multiplier', jobId: null, es: null, forcedVideoMode: false,
  };

  // ---------------------------------------------------------------- helpers
  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
  function toast(msg, ok = false, ms = 5000) {
    const t = $('toast'); t.classList.remove('hidden');
    t.textContent = msg; t.className = 'toast' + (ok ? ' ok' : '');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.add('hidden'), ms);
  }
  window.__toast = (msg, ok) => toast(msg, !!ok, ok ? 4000 : 6000);
  const fmtBytes = (b) => {
    if (!b) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b < 10 && i > 0 ? 2 : 1)} ${u[i]}`;
  };
  const fmtTime = (s) => {
    if (s == null || !isFinite(s)) return '—';
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const setFill = (el, pct) => { el.style.transform = `scaleX(${Math.min(100, Math.max(0, pct)) / 100})`; };
  const multToDb = (m) => 20 * Math.log10(m);
  const dbToMult = (db) => Math.pow(10, db / 20);
  const videoMaskKey = (id) => `loudlift:videoMasks:${id}`;
  function getVideoMasks() {
    if (!state.uploadId) return [];
    try {
      const value = JSON.parse(localStorage.getItem(videoMaskKey(state.uploadId)) || '[]');
      return Array.isArray(value) ? value : [];
    } catch { return []; }
  }
  function clearVideoMasks(id) {
    if (!id) return;
    try { localStorage.removeItem(videoMaskKey(id)); } catch { /* storage may be unavailable */ }
  }
  async function api(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
    return j;
  }

  function setUploadUrl(id) {
    const url = new URL(location.href);
    if (id) url.searchParams.set('uploadId', id);
    else url.searchParams.delete('uploadId');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }

  // ---------------------------------------------------------------- hardware
  async function loadCaps() {
    try {
      const caps = await api('/api/capabilities');
      state.caps = caps;
      const hw = $('hw'); hw.innerHTML = '';
      const vendors = [...new Set(caps.gpuEncoders.map(g => `${g.vendor} ${g.api}`))];
      if (vendors.length) {
        for (const v of vendors) hw.insertAdjacentHTML('beforeend', `<span class="hw-chip gpu">${icon('zap')} GPU: ${esc(v)}</span>`);
      } else {
        hw.insertAdjacentHTML('beforeend', `<span class="hw-chip none">${icon('zap')} GPU: no hardware encoder</span>`);
      }
      hw.insertAdjacentHTML('beforeend', `<span class="hw-chip cpu">${icon('cpu')} CPU: ${caps.cpuThreads} threads</span>`);

      const sel = $('encoderSel'); sel.innerHTML = '';
      for (const g of caps.gpuEncoders) sel.add(new Option(`GPU · ${g.vendor} ${g.api} — ${g.codec}`, g.id));
      for (const c of caps.cpuEncoders) sel.add(new Option(`CPU · ${c.api} — ${c.codec}`, c.id));
      if (!sel.options.length) sel.add(new Option('CPU · libx264 — H.264', 'libx264'));
    } catch (e) {
      $('hw').innerHTML = `<span class="hw-chip none">Server unreachable</span>`;
      toast('Cannot reach the server: ' + e.message);
    }
  }

  // ---------------------------------------------------------------- upload
  const dz = $('dropzone'), fileInput = $('fileInput');
  $('browseBtn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
  dz.addEventListener('click', () => fileInput.click());
  ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => { const f = e.dataTransfer.files?.[0]; if (f) uploadFile(f); });
  fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) uploadFile(f); fileInput.value = ''; });
  document.addEventListener('paste', (e) => {
    const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith('video/'));
    if (f) uploadFile(f);
  });

  function uploadFile(file) {
    if (state.uploadId) {
      clearVideoMasks(state.uploadId);
      fetch(`/api/upload/${state.uploadId}`, { method: 'DELETE' }).catch(() => {});
    }
    state.uploadId = null; state.info = null;
    setUploadUrl(null);
    $('fileInfo').classList.add('hidden');
    $('step-settings').classList.add('disabled');
    $('startBtn').disabled = true;
    $('analyzeResult').textContent = '';
    $('uploadProgress').classList.remove('hidden');
    setFill($('uploadFill'), 0); $('uploadPct').textContent = '0%';
    $('uploadText').textContent = `Uploading ${file.name} (${fmtBytes(file.size)})…`;

    const fd = new FormData(); fd.append('video', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    const t0 = Date.now();
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      const speed = e.loaded / ((Date.now() - t0) / 1000);
      setFill($('uploadFill'), pct);
      $('uploadPct').textContent = pct.toFixed(0) + '%';
      $('uploadText').textContent = `Uploading… ${fmtBytes(e.loaded)} / ${fmtBytes(e.total)} · ${fmtBytes(speed)}/s`;
    };
    xhr.onload = () => {
      let j = {}; try { j = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status !== 200) { $('uploadProgress').classList.add('hidden'); toast(j.error || 'Upload failed'); return; }
      $('uploadText').textContent = 'Upload complete'; setFill($('uploadFill'), 100); $('uploadPct').textContent = '100%';
      activateUpload(j);
      $('step-settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('Upload complete. Choose a volume setting and press Start.', true, 3000);
    };
    xhr.onerror = () => { $('uploadProgress').classList.add('hidden'); toast('Upload failed (connection to the server was lost)'); };
    xhr.send(fd);
  }

  function renderFileInfo({ name, info }) {
    const v = info.video, a = info.audio[0];
    const kv = (label, val, cls = '') => `<div class="kv ${cls}"><small>${label}</small><strong>${val ?? '—'}</strong></div>`;
    $('fileInfo').innerHTML = [
      kv('File name', esc(name), 'name'),
      kv('Duration', fmtTime(info.duration)),
      kv('Size', fmtBytes(info.size)),
      kv('Video', v ? `${v.codec?.toUpperCase()} ${v.width}×${v.height} @ ${v.fps ?? '?'} fps` : 'None'),
      kv('Audio', a ? `${a.codec?.toUpperCase()} · ${a.channels} ch · ${a.sampleRate ? a.sampleRate / 1000 + ' kHz' : ''}${a.bitrate ? ' · ' + Math.round(a.bitrate / 1000) + ' kbps' : ''}` : 'None'),
      kv('Total bitrate', info.bitrate ? Math.round(info.bitrate / 1000) + ' kbps' : '—'),
    ].join('');
    $('fileInfo').classList.remove('hidden');
    if (info.audio.length > 1) toast(`This video has ${info.audio.length} audio tracks. The same adjustment is applied to all of them.`, true, 4000);
  }

  function activateUpload(data) {
    state.uploadId = data.id; state.fileName = data.name; state.info = data.info;
    setUploadUrl(data.id);
    renderFileInfo(data);
    Timeline.reset();
    $('videoEditorOpen').href = `editor.html?uploadId=${encodeURIComponent(data.id)}`;
    if (state.mode === 'segments') Timeline.load(data.id, data.info.duration || 0);
    updateSegLayer(); updateVideoEdits();
    $('step-settings').classList.remove('disabled');
    $('startBtn').disabled = false;
    $('step-result').classList.add('hidden');
  }

  async function restoreUploadFromUrl() {
    const id = new URLSearchParams(location.search).get('uploadId');
    if (!id || state.uploadId === id) return;
    try {
      const data = await api(`/api/upload/${encodeURIComponent(id)}`);
      activateUpload(data);
      toast('Video restored. Your editor changes are ready to process.', true, 3000);
    } catch (error) {
      setUploadUrl(null);
      toast(`Could not restore the video: ${error.message}`);
    }
  }

  // ---------------------------------------------------------------- settings
  $('modeTabs').addEventListener('click', (e) => {
    const b = e.target.closest('.tab'); if (!b) return;
    state.mode = b.dataset.mode;
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === b));
    document.querySelectorAll('.mode-panel').forEach(p => p.classList.toggle('hidden', p.id !== `panel-${state.mode}`));
    if (state.mode === 'segments' && state.uploadId) Timeline.load(state.uploadId, state.info?.duration || 0);
    updateSegLayer();
  });

  function syncMult(v, from) {
    v = Math.min(50, Math.max(0.05, Number(v) || 1));
    if (from !== 'range') $('multRange').value = Math.min(10, Math.max(0.5, v));
    if (from !== 'input') $('multInput').value = +v.toFixed(2);
    const db = multToDb(v);
    $('multHint').textContent = `Equivalent to ${db >= 0 ? '+' : ''}${db.toFixed(2)} dB` + (v > 6 ? ' — very strong boost, keep the limiter on to avoid distortion' : '');
    $('multHint').classList.toggle('warn', v > 6);
  }
  function syncDb(v, from) {
    v = Math.min(40, Math.max(-40, Number(v) || 0));
    if (from !== 'range') $('dbRange').value = Math.min(30, Math.max(-20, v));
    if (from !== 'input') $('dbInput').value = v;
    $('dbHint').textContent = `Equivalent to ×${dbToMult(v).toFixed(2)}` + (v > 15 ? ' — very strong boost, keep the limiter on to avoid distortion' : '');
    $('dbHint').classList.toggle('warn', v > 15);
  }
  $('multRange').addEventListener('input', (e) => syncMult(e.target.value, 'range'));
  $('multInput').addEventListener('input', (e) => syncMult(e.target.value, 'input'));
  $('dbRange').addEventListener('input', (e) => syncDb(e.target.value, 'range'));
  $('dbInput').addEventListener('input', (e) => syncDb(e.target.value, 'input'));
  $('lufsRange').addEventListener('input', (e) => { $('lufsInput').value = e.target.value; });
  $('lufsInput').addEventListener('input', (e) => { $('lufsRange').value = e.target.value; });
  document.querySelectorAll('[data-mult]').forEach(b => b.addEventListener('click', () => syncMult(b.dataset.mult)));
  document.querySelectorAll('[data-db]').forEach(b => b.addEventListener('click', () => syncDb(b.dataset.db)));
  syncMult(2); syncDb(6);

  function syncVideoModeUI() {
    const re = document.querySelector('input[name=videoMode]:checked').value === 'reencode';
    document.querySelectorAll('#videoModeGroup .radio').forEach(l => l.classList.toggle('active', l.querySelector('input').checked));
    document.querySelectorAll('.reencode-only').forEach(el => el.classList.toggle('hidden', !re));
  }
  document.querySelectorAll('input[name=videoMode]').forEach(r => r.addEventListener('change', syncVideoModeUI));
  $('qualityRange').addEventListener('input', (e) => { $('qualityLabel').textContent = e.target.value; });

  document.querySelectorAll('input[name=easyPreset]').forEach(r => r.addEventListener('change', () => {
    document.querySelectorAll('#easyPresets .radio').forEach(l => l.classList.toggle('active', l.querySelector('input').checked));
    $('easyTarget').value = r.dataset.target;
  }));

  // Segment gains are an independent layer: they can be applied before any other mode.
  function activeSegments() {
    if (!Timeline.isReady()) return [];
    return Timeline.getSegments().filter(sg => Math.abs(sg.gainDb) > 0.01);
  }
  function updateSegLayer() {
    const segs = activeSegments();
    const show = state.mode !== 'segments' && segs.length > 0;
    $('segLayer').classList.toggle('hidden', !show);
    if (show) {
      const total = Timeline.getSegments().length;
      $('segLayerInfo').textContent = `${segs.length} of ${total} segments carry a gain. They are applied before the "${modeName()}" stage (and before loudness measurement).`;
    }
  }
  function modeName() {
    return { multiplier: 'Multiplier', db: 'Decibels', normalize: 'Auto normalize', easy: 'Easy listening', segments: 'Segments' }[state.mode] || state.mode;
  }

  function updateVideoEdits() {
    const copy = document.querySelector('input[name=videoMode][value=copy]');
    const reencode = document.querySelector('input[name=videoMode][value=reencode]');
    const masks = getVideoMasks();
    const hasMasks = masks.length > 0;
    if (hasMasks) {
      if (copy.checked) { state.forcedVideoMode = true; reencode.checked = true; }
      copy.disabled = true;
    } else {
      copy.disabled = false;
      if (state.forcedVideoMode) { copy.checked = true; state.forcedVideoMode = false; }
    }
    $('videoEditorCount').classList.toggle('hidden', !hasMasks);
    $('videoEditorCount').textContent = `${masks.length} area${masks.length === 1 ? '' : 's'}`;
    $('videoEditorStatus').textContent = hasMasks
      ? `${masks.length} timed black area${masks.length === 1 ? ' is' : 's are'} saved and will be applied during processing.`
      : 'Open the full editor to place timed black areas with millisecond precision.';
    syncVideoModeUI();
  }

  // ---------------------------------------------------------------- analyze
  $('analyzeBtn').addEventListener('click', async () => {
    if (!state.uploadId) return;
    const btn = $('analyzeBtn'), label = btn.querySelector('span');
    btn.disabled = true; label.textContent = 'Analyzing…';
    $('analyzeResult').textContent = '';
    try {
      const r = await api(`/api/analyze/${state.uploadId}`, { method: 'POST' });
      const res = $('analyzeResult');
      res.innerHTML = `Peak: <b>${r.maxDb} dB</b> · Mean: <b>${r.meanDb ?? '?'} dB</b> · ` +
        (r.headroomDb > 0.1
          ? `Safe boost without clipping: up to <b>+${r.headroomDb} dB</b> (×${r.safeMultiplier}) — <button type="button" class="link" id="applySafe">apply</button>`
          : `The audio already reaches full scale. Boosting further relies on the limiter (enabled) or use normalization.`);
      const ap = $('applySafe');
      if (ap) ap.addEventListener('click', () => {
        if (state.mode === 'db') syncDb(r.headroomDb); else syncMult(r.safeMultiplier);
      });
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; label.textContent = 'Analyze current loudness'; }
  });

  // ---------------------------------------------------------------- process
  $('startBtn').addEventListener('click', startJob);
  async function startJob() {
    if (!state.uploadId) return;
    const value = state.mode === 'db' ? Number($('dbInput').value) : Number($('multInput').value);
    const body = {
      uploadId: state.uploadId,
      mode: state.mode,
      value,
      targetLufs: state.mode === 'easy' ? Number($('easyTarget').value) : Number($('lufsInput').value),
      preset: document.querySelector('input[name=easyPreset]:checked')?.value || 'speech',
      leveler: $('easyLeveler').checked,
      highpass: $('easyHighpass').checked,
      limiter: $('limiterChk').checked,
      audioCodec: $('audioCodec').value,
      audioBitrate: Number($('audioBitrate').value),
      videoMode: document.querySelector('input[name=videoMode]:checked').value,
      encoder: $('encoderSel').value,
      quality: Number($('qualityRange').value),
    };
    const videoMasks = getVideoMasks();
    if (videoMasks.length) body.videoMasks = videoMasks;
    const segs = activeSegments();
    if (state.mode === 'segments') {
      if (!Timeline.isReady()) { toast('Waveform analysis is still running. Please wait a moment.'); return; }
      if (!segs.length && !videoMasks.length) { toast('No edit has been configured. Set a segment gain or add a black area to the video.'); return; }
      body.segments = Timeline.getSegments();
    } else if (segs.length && $('applySegChk').checked) {
      body.segments = Timeline.getSegments();
      body.applySegments = true;
    }
    if (state.mode === 'multiplier' && Math.abs(value - 1) < 1e-6 && !body.applySegments && !videoMasks.length) { toast('A ×1 multiplier would not change the volume.'); return; }
    if (state.mode === 'db' && value === 0 && !body.applySegments && !videoMasks.length) { toast('0 dB would not change the volume.'); return; }

    try {
      $('startBtn').disabled = true;
      const r = await api('/api/process', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      state.jobId = r.jobId;
      showProgress();
      watchJob(r.jobId);
    } catch (e) { toast(e.message); $('startBtn').disabled = false; }
  }

  function showProgress() {
    $('step-result').classList.add('hidden');
    $('step-progress').classList.remove('hidden');
    setFill($('procFill'), 0); $('procFill').classList.add('indeterminate');
    $('procPct').textContent = '0%'; $('procText').textContent = 'Starting FFmpeg…';
    $('procStats').innerHTML = ''; $('engineLabel').innerHTML = '';
    $('step-progress').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function watchJob(jobId) {
    if (state.es) state.es.close();
    const es = new EventSource(`/api/progress/${jobId}`);
    state.es = es;
    es.onmessage = (ev) => {
      const job = JSON.parse(ev.data);
      renderJob(job);
      if (job.status !== 'running') { es.close(); state.es = null; onJobEnd(job); }
    };
    es.onerror = async () => {
      es.close(); state.es = null;
      const poll = async () => {
        try {
          const job = await api(`/api/job/${jobId}`);
          renderJob(job);
          if (job.status === 'running') setTimeout(poll, 1000); else onJobEnd(job);
        } catch (e) { toast('Lost connection to the server: ' + e.message); $('startBtn').disabled = false; }
      };
      poll();
    };
  }

  function renderJob(job) {
    const pct = job.percent || 0;
    const fill = $('procFill');
    if (pct > 0) fill.classList.remove('indeterminate');
    setFill(fill, pct);
    $('procPct').textContent = pct.toFixed(1) + '%';
    const attemptTxt = job.attempts > 1 ? ` (attempt ${job.attempt}/${job.attempts})` : '';
    $('engineLabel').innerHTML = (job.phase ? `${esc(job.phase)} · ` : '') + `Engine: <b>${esc(job.engine || '…')}</b>${attemptTxt}`;
    $('procText').textContent = pct > 0
      ? `Processed ${fmtTime(job.outTime)} / ${fmtTime(job.duration)}`
      : 'Starting FFmpeg…';
    const stats = [];
    if (job.speed) stats.push(`Speed: <b>${job.speed.toFixed(1)}×</b> realtime`);
    if (job.fps) stats.push(`<b>${Math.round(job.fps)}</b> fps`);
    if (job.eta != null && job.status === 'running') stats.push(`Remaining: <b>${fmtTime(job.eta)}</b>`);
    stats.push(`Elapsed: <b>${fmtTime((Date.now() - job.startedAt) / 1000)}</b>`);
    $('procStats').innerHTML = stats.map(s => `<span>${s}</span>`).join('');
  }

  function onJobEnd(job) {
    $('startBtn').disabled = false;
    $('step-progress').classList.add('hidden');
    if (job.status !== 'done') {
      toast(job.status === 'cancelled' ? 'Processing cancelled.' : 'Processing failed:\n' + (job.error || 'Unknown error'), false, 9000);
      return;
    }
    const secs = ((job.finishedAt - job.startedAt) / 1000);
    const url = `/api/download/${job.id}`;
    $('downloadBtn').href = url; $('downloadBtn').download = job.outName;
    $('preview').src = url + '?inline=1';
    $('resultSummary').innerHTML =
      `<b>${esc(job.outName)}</b><br>` +
      `Size: <b>${fmtBytes(job.outSize)}</b> · Processing time: <b>${secs.toFixed(1)} s</b>` +
      (job.duration && secs > 0 ? ` (${(job.duration / secs).toFixed(1)}× realtime)` : '') + `<br>` +
      `Engine: <b>${esc(job.engine)}</b>` +
      (job.videoMaskCount ? `<br>Video edits: <b>${job.videoMaskCount} black area${job.videoMaskCount === 1 ? '' : 's'}</b>` : '') +
      (job.measured ? `<div class="result-loud"><span>Measured → target loudness:</span><b>${job.measured.inputI.toFixed(1)}</b>${icon('arrow')}<b class="ok">${job.measured.targetI.toFixed(1)} LUFS</b><span class="muted">(peak ${job.measured.inputTp.toFixed(1)} dBTP · range ${job.measured.inputLra.toFixed(1)} LU)</span></div>` : '');
    $('cmdText').textContent = job.command || '';
    $('step-result').classList.remove('hidden');
    $('step-result').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Done. Press "Download video".', true, 4000);
  }

  $('cancelBtn').addEventListener('click', async () => {
    if (!state.jobId) return;
    try { await api(`/api/cancel/${state.jobId}`, { method: 'POST' }); } catch (e) { toast(e.message); }
  });
  $('againBtn').addEventListener('click', () => {
    $('step-result').classList.add('hidden');
    $('preview').pause();
    $('step-settings').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('newBtn').addEventListener('click', () => {
    $('preview').pause(); $('preview').removeAttribute('src');
    $('step-result').classList.add('hidden');
    $('fileInfo').classList.add('hidden'); $('uploadProgress').classList.add('hidden');
    if (state.uploadId) {
      clearVideoMasks(state.uploadId);
      fetch(`/api/upload/${state.uploadId}`, { method: 'DELETE' }).catch(() => {});
    }
    state.uploadId = null; state.info = null;
    setUploadUrl(null);
    $('videoEditorOpen').href = 'editor.html';
    Timeline.reset(); updateSegLayer(); updateVideoEdits();
    $('step-settings').classList.add('disabled'); $('startBtn').disabled = true;
    $('analyzeResult').textContent = '';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.es) { e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('storage', (e) => {
    if (state.uploadId && e.key === videoMaskKey(state.uploadId)) updateVideoEdits();
  });
  window.addEventListener('focus', updateVideoEdits);
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'loudlift-editor-done') return;
    if (event.data.uploadId === state.uploadId) updateVideoEdits();
  });

  Timeline.init({ onChange: updateSegLayer });
  updateVideoEdits();
  loadCaps();
  restoreUploadFromUrl();
})();
