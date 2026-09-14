/* LoudLift full-page fixed-frame mask editor. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const round4 = (value) => Math.round(value * 10000) / 10000;
  const icon = (name) => `<svg class="ic"><use href="#i-${name}"/></svg>`;
  const params = new URLSearchParams(location.search);
  const uploadId = params.get('uploadId');
  const maskKey = uploadId ? `loudlift:videoMasks:${uploadId}` : '';
  const layoutKey = 'loudlift:videoEditorLayout';

  const st = {
    durationMs: 0, width: 16, height: 9, masks: [], selectedId: null, nextId: 1,
    videoZoom: 1, timelineZoom: 1, fitWidth: 640, fitHeight: 360, playheadMs: 0,
  };

  let video, overlay, stage, timelineCanvas, timelineCtx;
  let maskDrag = null, timelineDrag = null, saveTimer = 0, pendingVideoSeekMs = null;

  function fmt(ms) {
    ms = clamp(Math.round(Number(ms) || 0), 0, Number.MAX_SAFE_INTEGER);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const milli = ms % 1000;
    return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  }

  function shortDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 3 : 1)} s`;
    return fmt(ms);
  }

  function videoMs() { return clamp(Math.round((video?.currentTime || 0) * 1000), 0, st.durationMs); }
  function currentMs() { return st.playheadMs; }
  function selected() { return st.masks.find((mask) => mask.id === st.selectedId) || null; }
  function activeAt(mask, ms = currentMs()) { return ms >= mask.startMs && ms <= mask.endMs; }

  function sanitize(mask) {
    const duration = Math.max(1, st.durationMs);
    mask.x = round4(clamp(Number(mask.x) || 0, 0, 0.99));
    mask.y = round4(clamp(Number(mask.y) || 0, 0, 0.99));
    mask.width = round4(clamp(Number(mask.width) || 0.02, 0.01, 1 - mask.x));
    mask.height = round4(clamp(Number(mask.height) || 0.02, 0.01, 1 - mask.y));
    mask.startMs = clamp(Math.round(Number(mask.startMs) || 0), 0, duration - 1);
    mask.endMs = clamp(Math.round(Number(mask.endMs) || 1), mask.startMs + 1, duration);
    return mask;
  }

  function serializableMasks() {
    return st.masks.map((mask) => ({
      id: mask.id, x: mask.x, y: mask.y, width: mask.width, height: mask.height,
      startMs: mask.startMs, endMs: mask.endMs,
    }));
  }

  function save() {
    if (!maskKey) return;
    localStorage.setItem(maskKey, JSON.stringify(serializableMasks()));
    const state = $('saveState');
    state.classList.add('saving'); state.innerHTML = `${icon('clock')} Saving…`;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.classList.remove('saving'); state.innerHTML = `${icon('check')} Saved locally`;
    }, 220);
  }

  function loadSavedMasks() {
    try {
      const value = JSON.parse(localStorage.getItem(maskKey) || '[]');
      if (!Array.isArray(value)) return;
      st.masks = value.slice(0, 100).map((mask, index) => sanitize({ ...mask, id: Number(mask.id) || index + 1 }));
      st.nextId = Math.max(1, ...st.masks.map((mask) => mask.id + 1));
      st.selectedId = st.masks[0]?.id || null;
    } catch { st.masks = []; }
  }

  function seek(ms, centerTimeline = false) {
    const value = clamp(Math.round(Number(ms) || 0), 0, st.durationMs);
    updateCurrentState(value);
    requestVideoFrame(value);
    if (centerTimeline && st.timelineZoom > 1) centerTimelineOn(value);
  }

  function requestVideoFrame(ms) {
    if (!video || video.readyState < 1) { pendingVideoSeekMs = ms; return; }
    if (video.seeking) { pendingVideoSeekMs = ms; return; }
    pendingVideoSeekMs = null;
    if (Math.abs(videoMs() - ms) < 1) return;
    try { video.currentTime = ms / 1000; } catch { pendingVideoSeekMs = ms; }
  }

  function flushPendingVideoFrame() {
    if (pendingVideoSeekMs !== null && Math.abs(pendingVideoSeekMs - videoMs()) >= 1) {
      pendingVideoSeekMs = null;
      requestAnimationFrame(() => requestVideoFrame(currentMs()));
      return;
    }
    pendingVideoSeekMs = null;
    updateCurrentState(videoMs());
  }

  function updateCurrentState(ms = videoMs()) {
    st.playheadMs = clamp(Math.round(Number(ms) || 0), 0, st.durationMs);
    ms = st.playheadMs;
    $('editorTime').textContent = fmt(ms);
    for (const el of overlay.querySelectorAll('.editor-mask')) {
      const mask = st.masks.find((item) => item.id === Number(el.dataset.id));
      if (mask) el.classList.toggle('inactive', !activeAt(mask, ms));
    }
    for (const el of $('layerList').querySelectorAll('.layer-row')) {
      const mask = st.masks.find((item) => item.id === Number(el.dataset.id));
      if (mask) el.classList.toggle('active-now', activeAt(mask, ms));
    }
    updateActiveState(ms);
    drawTimeline();
  }

  function updateActiveState(ms = currentMs()) {
    const mask = selected(); if (!mask) return;
    const active = activeAt(mask, ms);
    $('activeState').textContent = active ? 'Active at playhead' : 'Outside time range';
    $('activeState').classList.toggle('inactive', !active);
  }

  function addMask(source = null) {
    if (!st.durationMs) return;
    const now = currentMs();
    const startMs = source ? source.startMs : Math.min(now, st.durationMs - 1);
    const mask = sanitize(source ? {
      ...source, id: st.nextId++,
      x: clamp(source.x + 0.025, 0, 1 - source.width),
      y: clamp(source.y + 0.025, 0, 1 - source.height),
    } : {
      id: st.nextId++, x: 0.3, y: 0.35, width: 0.4, height: 0.2, startMs,
      endMs: Math.min(st.durationMs, Math.max(startMs + 1, startMs + 3000)),
    });
    st.masks.push(mask); st.selectedId = mask.id;
    seek(mask.startMs, true); renderAll(); save();
  }

  function deleteSelected() {
    const index = st.masks.findIndex((mask) => mask.id === st.selectedId);
    if (index < 0) return;
    st.masks.splice(index, 1);
    st.selectedId = st.masks[Math.min(index, st.masks.length - 1)]?.id || null;
    renderAll(); save();
  }

  function clearMasks() {
    st.masks = []; st.selectedId = null;
    renderAll(); save();
  }

  function renderLayers() {
    const count = st.masks.length;
    $('layerCount').textContent = `${count} area${count === 1 ? '' : 's'}`;
    $('layerEmpty').classList.toggle('hidden', count > 0);
    $('layerList').classList.toggle('hidden', count === 0);
    $('clearMasks').classList.toggle('hidden', count === 0);
    $('layerList').innerHTML = st.masks.map((mask, index) => `<button type="button" class="layer-row${mask.id === st.selectedId ? ' selected' : ''}${activeAt(mask) ? ' active-now' : ''}" data-id="${mask.id}">
      <span class="layer-swatch">${index + 1}</span>
      <span><strong>Area ${index + 1}</strong><small>${fmt(mask.startMs)} → ${fmt(mask.endMs)}</small></span>
      <span class="layer-dot" aria-hidden="true"></span>
    </button>`).join('');
  }

  function renderOverlay() {
    overlay.innerHTML = st.masks.map((mask, index) => `<div class="editor-mask${mask.id === st.selectedId ? ' selected' : ''}${activeAt(mask) ? '' : ' inactive'}" data-id="${mask.id}" style="left:${mask.x * 100}%;top:${mask.y * 100}%;width:${mask.width * 100}%;height:${mask.height * 100}%">
      <span class="editor-mask-label">${index + 1}</span>
      <i data-handle="nw"></i><i data-handle="ne"></i><i data-handle="sw"></i><i data-handle="se"></i>
    </div>`).join('');
  }

  function renderProperties() {
    const mask = selected();
    $('propertiesEmpty').classList.toggle('hidden', !!mask);
    $('propertiesForm').classList.toggle('hidden', !mask);
    if (!mask) return;
    const index = st.masks.indexOf(mask) + 1;
    $('selectedNumber').textContent = index; $('selectedTitle').textContent = `Area ${index}`;
    $('startMs').value = mask.startMs; $('endMs').value = mask.endMs;
    $('startMs').max = Math.max(0, mask.endMs - 1); $('endMs').max = st.durationMs;
    $('startHuman').textContent = fmt(mask.startMs); $('endHuman').textContent = fmt(mask.endMs);
    $('maskDuration').textContent = shortDuration(mask.endMs - mask.startMs);
    $('maskX').value = (mask.x * 100).toFixed(1); $('maskY').value = (mask.y * 100).toFixed(1);
    $('maskW').value = (mask.width * 100).toFixed(1); $('maskH').value = (mask.height * 100).toFixed(1);
    updateActiveState();
  }

  function renderAll() {
    renderLayers(); renderOverlay(); renderProperties(); updateCurrentState();
  }

  function fitStage() {
    const viewport = $('stageViewport');
    const availableWidth = Math.max(120, viewport.clientWidth - 48);
    const availableHeight = Math.max(90, viewport.clientHeight - 48);
    const ratio = st.width / st.height;
    if (availableWidth / availableHeight > ratio) {
      st.fitHeight = availableHeight; st.fitWidth = availableHeight * ratio;
    } else {
      st.fitWidth = availableWidth; st.fitHeight = availableWidth / ratio;
    }
    applyVideoZoom(false);
  }

  function applyVideoZoom(keepCenter = true) {
    const viewport = $('stageViewport');
    const oldCenterX = viewport.scrollLeft + viewport.clientWidth / 2;
    const oldCenterY = viewport.scrollTop + viewport.clientHeight / 2;
    const oldWidth = stage.offsetWidth || st.fitWidth;
    const oldHeight = stage.offsetHeight || st.fitHeight;
    const width = Math.max(40, Math.round(st.fitWidth * st.videoZoom));
    const height = Math.max(30, Math.round(st.fitHeight * st.videoZoom));
    stage.style.width = `${width}px`; stage.style.height = `${height}px`;
    $('stageSpace').style.width = `${Math.max(viewport.clientWidth, width + 48)}px`;
    $('stageSpace').style.height = `${Math.max(viewport.clientHeight, height + 48)}px`;
    $('videoZoom').value = Math.round(st.videoZoom * 100);
    $('videoZoomLabel').textContent = st.videoZoom === 1 ? 'Fit' : `${Math.round(st.videoZoom * 100)}%`;
    requestAnimationFrame(() => {
      if (!keepCenter || oldWidth <= 0 || oldHeight <= 0) return;
      viewport.scrollLeft = oldCenterX / oldWidth * width - viewport.clientWidth / 2;
      viewport.scrollTop = oldCenterY / oldHeight * height - viewport.clientHeight / 2;
    });
  }

  function setVideoZoom(value) {
    st.videoZoom = clamp(Number(value) / 100, 0.25, 3);
    applyVideoZoom();
  }

  function niceTimeStep(pxPerMs) {
    const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    return steps.find((step) => step * pxPerMs >= 88) || 3600000;
  }

  function timelineSnapMs() {
    return [1000, 500, 100, 50][st.timelineZoom - 1] || 1000;
  }

  function timelineScale() {
    return [1, 2, 10, 20][st.timelineZoom - 1] || 1;
  }

  function snapPlayhead(ms) {
    const step = timelineSnapMs();
    return clamp(Math.round(ms / step) * step, 0, st.durationMs);
  }

  function snapTimelineValue(ms) {
    const step = timelineSnapMs();
    return Math.round(ms / step) * step;
  }

  function timelineMetrics() {
    const scroll = $('timelineScroll');
    const cssWidth = Math.max(scroll.clientWidth, Math.round(scroll.clientWidth * timelineScale()));
    const rulerHeight = 35;
    const rowHeight = 34;
    const cssHeight = Math.max(scroll.clientHeight, rulerHeight + Math.max(1, st.masks.length) * rowHeight + 16);
    return { scroll, cssWidth, cssHeight, rulerHeight, rowHeight };
  }

  function drawTimeline() {
    if (!timelineCanvas || !st.durationMs) return;
    const { cssWidth: width, cssHeight: height, rulerHeight, rowHeight } = timelineMetrics();
    const requestedDpr = window.devicePixelRatio || 1;
    const dpr = Math.max(.25, Math.min(requestedDpr, 32000 / width, 8000 / height));
    if (timelineCanvas.width !== Math.round(width * dpr) || timelineCanvas.height !== Math.round(height * dpr)) {
      timelineCanvas.width = Math.round(width * dpr); timelineCanvas.height = Math.round(height * dpr);
      timelineCanvas.style.width = `${width}px`; timelineCanvas.style.height = `${height}px`;
    }
    const ctx = timelineCtx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#090d13'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111722'; ctx.fillRect(0, 0, width, rulerHeight);
    const pxPerMs = width / st.durationMs;
    const snap = timelineSnapMs();
    const labelStep = Math.max(snap, Math.ceil(niceTimeStep(pxPerMs) / snap) * snap);
    ctx.textBaseline = 'top'; ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    for (let ms = 0; ms <= st.durationMs + snap; ms += snap) {
      const x = Math.round(ms * pxPerMs) + .5;
      const isMajor = Math.abs((ms / labelStep) - Math.round(ms / labelStep)) < .001;
      ctx.strokeStyle = isMajor ? '#516078' : '#283244';
      ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, isMajor ? 17 : 25); ctx.lineTo(x, height); ctx.stroke();
      if (isMajor) {
        ctx.fillStyle = '#aeb9cb';
        const label = fmt(ms);
        const labelX = clamp(x + 5, 5, width - ctx.measureText(label).width - 5);
        ctx.fillText(label, labelX, 4);
      }
    }
    ctx.strokeStyle = '#344055'; ctx.beginPath(); ctx.moveTo(0, rulerHeight + .5); ctx.lineTo(width, rulerHeight + .5); ctx.stroke();
    for (let index = 0; index < Math.max(1, st.masks.length); index++) {
      const y = rulerHeight + index * rowHeight;
      ctx.fillStyle = index % 2 ? '#0d121a' : '#0b1017'; ctx.fillRect(0, y, width, rowHeight);
      ctx.strokeStyle = '#1d2634'; ctx.beginPath(); ctx.moveTo(0, y + rowHeight + .5); ctx.lineTo(width, y + rowHeight + .5); ctx.stroke();
      const mask = st.masks[index]; if (!mask) continue;
      const x0 = mask.startMs * pxPerMs; const x1 = mask.endMs * pxPerMs;
      const selectedFill = mask.id === st.selectedId ? '#2f6fe0' : '#35445b';
      ctx.fillStyle = selectedFill; ctx.fillRect(x0, y + 6, Math.max(3, x1 - x0), rowHeight - 12);
      ctx.fillStyle = mask.id === st.selectedId ? '#a7c4ff' : '#74839a';
      ctx.fillRect(x0, y + 6, 5, rowHeight - 12); ctx.fillRect(Math.max(x0, x1 - 5), y + 6, 5, rowHeight - 12);
      ctx.fillStyle = '#fff'; ctx.font = '600 12px "Segoe UI", system-ui, sans-serif';
      const label = `Area ${index + 1}`;
      if (x1 - x0 > ctx.measureText(label).width + 18) ctx.fillText(label, x0 + 10, y + 10);
    }
    const playheadX = currentMs() * pxPerMs;
    ctx.strokeStyle = '#ff5267'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(playheadX + .5, 0); ctx.lineTo(playheadX + .5, height); ctx.stroke();
    ctx.fillStyle = '#ff5267'; ctx.beginPath(); ctx.moveTo(playheadX - 5, 0); ctx.lineTo(playheadX + 5, 0); ctx.lineTo(playheadX, 7); ctx.closePath(); ctx.fill();
    $('timelineResolution').textContent = `Level ${st.timelineZoom}/4 · playhead step ${shortDuration(snap)} · labels ${shortDuration(labelStep)}`;
  }

  function centerTimelineOn(ms) {
    const { scroll, cssWidth } = timelineMetrics();
    scroll.scrollLeft = ms / st.durationMs * cssWidth - scroll.clientWidth / 2;
  }

  function setTimelineZoom(value) {
    const focusMs = currentMs();
    st.timelineZoom = clamp(Math.round(Number(value) || 1), 1, 4);
    $('timelineZoom').value = st.timelineZoom;
    drawTimeline();
    requestAnimationFrame(() => centerTimelineOn(focusMs));
  }

  function timelinePoint(e) {
    const rect = timelineCanvas.getBoundingClientRect();
    return { x: clamp(e.clientX - rect.left, 0, rect.width), y: e.clientY - rect.top, width: rect.width };
  }

  function bindTimeline() {
    timelineCanvas.addEventListener('pointerdown', (e) => {
      const point = timelinePoint(e); const metrics = timelineMetrics();
      const ms = point.x / point.width * st.durationMs;
      const playheadHitMs = 8 / point.width * st.durationMs;
      const startPlayheadDrag = () => {
        video.pause();
        const value = snapPlayhead(ms);
        timelineDrag = { mode: 'playhead', id: e.pointerId, lastValue: value };
        timelineCanvas.setPointerCapture(e.pointerId);
        seek(value);
        e.preventDefault();
      };
      if (point.y < metrics.rulerHeight || Math.abs(ms - currentMs()) <= playheadHitMs) { startPlayheadDrag(); return; }
      const index = Math.floor((point.y - metrics.rulerHeight) / metrics.rowHeight);
      const mask = st.masks[index];
      if (!mask) { startPlayheadDrag(); return; }
      st.selectedId = mask.id;
      const edgeHitMs = 8 / point.width * st.durationMs;
      const mode = Math.abs(ms - mask.startMs) <= edgeHitMs ? 'start'
        : Math.abs(ms - mask.endMs) <= edgeHitMs ? 'end'
          : ms >= mask.startMs && ms <= mask.endMs ? 'move' : 'seek';
      if (mode === 'seek') { startPlayheadDrag(); renderAll(); return; }
      timelineDrag = { mode, x: point.x, width: point.width, original: { ...mask }, id: e.pointerId };
      timelineCanvas.setPointerCapture(e.pointerId); renderAll(); e.preventDefault();
    });
    timelineCanvas.addEventListener('pointermove', (e) => {
      if (!timelineDrag) return;
      const point = timelinePoint(e);
      if (timelineDrag.mode === 'playhead') {
        const value = snapPlayhead(point.x / point.width * st.durationMs);
        if (value !== timelineDrag.lastValue) {
          timelineDrag.lastValue = value;
          seek(value);
        }
        return;
      }
      const mask = selected(); if (!mask) return;
      const delta = Math.round((point.x - timelineDrag.x) / timelineDrag.width * st.durationMs);
      const original = timelineDrag.original;
      if (timelineDrag.mode === 'start') mask.startMs = clamp(snapTimelineValue(original.startMs + delta), 0, mask.endMs - 1);
      else if (timelineDrag.mode === 'end') mask.endMs = clamp(snapTimelineValue(original.endMs + delta), mask.startMs + 1, st.durationMs);
      else {
        const length = original.endMs - original.startMs;
        const start = clamp(snapTimelineValue(original.startMs + delta), 0, st.durationMs - length);
        mask.startMs = start; mask.endMs = start + length;
      }
      renderLayers(); renderProperties(); drawTimeline();
    });
    const endDrag = () => {
      if (!timelineDrag) return;
      const changedMask = timelineDrag.mode !== 'playhead';
      timelineDrag = null;
      if (changedMask) { renderAll(); save(); }
      else updateCurrentState();
    };
    timelineCanvas.addEventListener('pointerup', endDrag);
    timelineCanvas.addEventListener('pointercancel', endDrag);
    timelineCanvas.addEventListener('keydown', handlePreviewKeys);
    $('timelineScroll').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); setTimelineZoom(st.timelineZoom + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }

  function overlayPoint(e) {
    const rect = overlay.getBoundingClientRect();
    return { x: clamp((e.clientX - rect.left) / rect.width, 0, 1), y: clamp((e.clientY - rect.top) / rect.height, 0, 1) };
  }

  function bindOverlay() {
    overlay.addEventListener('pointerdown', (e) => {
      const element = e.target.closest('.editor-mask');
      if (!element) { st.selectedId = null; renderAll(); return; }
      st.selectedId = Number(element.dataset.id);
      const mask = selected(); const point = overlayPoint(e);
      maskDrag = { point, handle: e.target.dataset.handle || 'move', original: { ...mask }, id: e.pointerId };
      overlay.setPointerCapture(e.pointerId); renderAll(); e.preventDefault();
    });
    overlay.addEventListener('pointermove', (e) => {
      if (!maskDrag) return;
      const mask = selected(); if (!mask) return;
      const point = overlayPoint(e); const dx = point.x - maskDrag.point.x; const dy = point.y - maskDrag.point.y; const original = maskDrag.original;
      if (maskDrag.handle === 'move') {
        mask.x = clamp(original.x + dx, 0, 1 - original.width);
        mask.y = clamp(original.y + dy, 0, 1 - original.height);
      } else {
        if (maskDrag.handle.includes('w')) { const right = original.x + original.width; mask.x = clamp(original.x + dx, 0, right - .01); mask.width = right - mask.x; }
        if (maskDrag.handle.includes('e')) mask.width = clamp(original.width + dx, .01, 1 - original.x);
        if (maskDrag.handle.includes('n')) { const bottom = original.y + original.height; mask.y = clamp(original.y + dy, 0, bottom - .01); mask.height = bottom - mask.y; }
        if (maskDrag.handle.includes('s')) mask.height = clamp(original.height + dy, .01, 1 - original.y);
      }
      sanitize(mask); renderOverlay(); renderProperties();
    });
    const endDrag = () => { if (!maskDrag) return; maskDrag = null; renderAll(); save(); };
    overlay.addEventListener('pointerup', endDrag);
    overlay.addEventListener('pointercancel', endDrag);
    overlay.addEventListener('keydown', handlePreviewKeys);
  }

  function handlePreviewKeys(e) {
    if (e.target.matches('input')) return;
    if (e.key === ' ') { togglePlay(); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      seek(currentMs() + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 100 : 1)); e.preventDefault();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected()) { deleteSelected(); e.preventDefault(); }
  }

  function togglePlay() {
    if (!video) return;
    if (video.paused) video.play().catch(() => {}); else video.pause();
  }

  function updateTiming(role, value) {
    const mask = selected(); if (!mask) return;
    const ms = Math.round(Number(value)); if (!Number.isFinite(ms)) { renderProperties(); return; }
    if (role === 'start') mask.startMs = clamp(ms, 0, mask.endMs - 1);
    else mask.endMs = clamp(ms, mask.startMs + 1, st.durationMs);
    renderAll(); save();
  }

  function previewTiming(role, value) {
    const mask = selected();
    if (!mask || value === '') return;
    const ms = Math.round(Number(value));
    if (!Number.isFinite(ms)) return;
    if (role === 'start') mask.startMs = clamp(ms, 0, mask.endMs - 1);
    else mask.endMs = clamp(ms, mask.startMs + 1, st.durationMs);
    $('startHuman').textContent = fmt(mask.startMs);
    $('endHuman').textContent = fmt(mask.endMs);
    $('maskDuration').textContent = shortDuration(mask.endMs - mask.startMs);
    $('startMs').max = Math.max(0, mask.endMs - 1);
    $('endMs').min = mask.startMs + 1;
    renderLayers(); renderOverlay(); updateCurrentState(); save();
  }

  function updateGeometry() {
    const mask = selected(); if (!mask) return;
    mask.x = Number($('maskX').value) / 100; mask.y = Number($('maskY').value) / 100;
    mask.width = Number($('maskW').value) / 100; mask.height = Number($('maskH').value) / 100;
    sanitize(mask); renderAll(); save();
  }

  function restoreLayout() {
    try {
      const layout = JSON.parse(localStorage.getItem(layoutKey) || '{}');
      if (layout.left) document.documentElement.style.setProperty('--editor-left', `${clamp(layout.left, 160, 420)}px`);
      if (layout.right) document.documentElement.style.setProperty('--editor-right', `${clamp(layout.right, 220, 430)}px`);
      if (layout.timeline) document.documentElement.style.setProperty('--editor-timeline', `${clamp(layout.timeline, 170, 480)}px`);
    } catch { /* use CSS defaults */ }
  }

  function saveLayout() {
    const styles = getComputedStyle(document.documentElement);
    localStorage.setItem(layoutKey, JSON.stringify({
      left: parseFloat(styles.getPropertyValue('--editor-left')),
      right: parseFloat(styles.getPropertyValue('--editor-right')),
      timeline: parseFloat(styles.getPropertyValue('--editor-timeline')),
    }));
  }

  function bindSplitter(id, kind) {
    const splitter = $(id);
    splitter.addEventListener('pointerdown', (e) => {
      const styles = getComputedStyle(document.documentElement);
      const original = kind === 'left' ? parseFloat(styles.getPropertyValue('--editor-left'))
        : kind === 'right' ? parseFloat(styles.getPropertyValue('--editor-right'))
          : parseFloat(styles.getPropertyValue('--editor-timeline'));
      const start = kind === 'timeline' ? e.clientY : e.clientX;
      splitter.classList.add('dragging'); splitter.setPointerCapture(e.pointerId);
      const move = (event) => {
        const delta = (kind === 'timeline' ? event.clientY : event.clientX) - start;
        if (kind === 'left') document.documentElement.style.setProperty('--editor-left', `${clamp(original + delta, 160, 420)}px`);
        else if (kind === 'right') document.documentElement.style.setProperty('--editor-right', `${clamp(original - delta, 220, 430)}px`);
        else document.documentElement.style.setProperty('--editor-timeline', `${clamp(original - delta, 170, 480)}px`);
        fitStage(); drawTimeline();
      };
      const up = () => {
        splitter.classList.remove('dragging'); splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', up);
        saveLayout(); fitStage(); drawTimeline();
      };
      splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', up);
      e.preventDefault();
    });
    splitter.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const styles = getComputedStyle(document.documentElement);
      if (kind === 'timeline' && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const current = parseFloat(styles.getPropertyValue('--editor-timeline'));
        document.documentElement.style.setProperty('--editor-timeline', `${clamp(current + (e.key === 'ArrowUp' ? step : -step), 170, 480)}px`);
      } else if (kind !== 'timeline' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const prop = kind === 'left' ? '--editor-left' : '--editor-right'; const current = parseFloat(styles.getPropertyValue(prop));
        const direction = e.key === 'ArrowRight' ? 1 : -1;
        document.documentElement.style.setProperty(prop, `${clamp(current + direction * step * (kind === 'right' ? -1 : 1), kind === 'left' ? 160 : 220, kind === 'left' ? 420 : 430)}px`);
      } else return;
      saveLayout(); fitStage(); drawTimeline(); e.preventDefault();
    });
  }

  function bindControls() {
    for (const id of ['addMaskTop', 'addMaskEmpty', 'addMask']) $(id).addEventListener('click', () => addMask());
    $('deleteMask').addEventListener('click', deleteSelected);
    $('duplicateMask').addEventListener('click', () => { const mask = selected(); if (mask) addMask(mask); });
    $('clearMasks').addEventListener('click', clearMasks);
    $('editorPlay').addEventListener('click', togglePlay);
    $('layerList').addEventListener('click', (e) => {
      const row = e.target.closest('.layer-row'); if (!row) return;
      st.selectedId = Number(row.dataset.id); const mask = selected(); if (mask) seek(mask.startMs, true); renderAll();
    });
    $('startMs').addEventListener('input', (e) => previewTiming('start', e.target.value));
    $('endMs').addEventListener('input', (e) => previewTiming('end', e.target.value));
    $('startMs').addEventListener('change', (e) => updateTiming('start', e.target.value));
    $('endMs').addEventListener('change', (e) => updateTiming('end', e.target.value));
    document.querySelectorAll('[data-set-current]').forEach((button) => button.addEventListener('click', () => updateTiming(button.dataset.setCurrent, currentMs())));
    for (const id of ['maskX', 'maskY', 'maskW', 'maskH']) $(id).addEventListener('change', updateGeometry);
    $('videoZoom').addEventListener('input', (e) => setVideoZoom(e.target.value));
    $('videoZoomOut').addEventListener('click', () => setVideoZoom(st.videoZoom * 100 - 25));
    $('videoZoomIn').addEventListener('click', () => setVideoZoom(st.videoZoom * 100 + 25));
    $('videoZoomFit').addEventListener('click', () => setVideoZoom(100));
    $('timelineZoom').addEventListener('input', (e) => setTimelineZoom(e.target.value));
    $('timelineZoomOut').addEventListener('click', () => setTimelineZoom(st.timelineZoom - 1));
    $('timelineZoomIn').addEventListener('click', () => setTimelineZoom(st.timelineZoom + 1));
    $('timelineZoomFit').addEventListener('click', () => setTimelineZoom(1));
    $('timelineToStart').addEventListener('click', () => seek(0, true));
    bindSplitter('leftSplitter', 'left'); bindSplitter('rightSplitter', 'right'); bindSplitter('timelineSplitter', 'timeline');
  }

  async function load() {
    if (!uploadId) return showError('Open the editor from a video in LoudLift so it knows which source to use.');
    try {
      const response = await fetch(`/api/upload/${encodeURIComponent(uploadId)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Video not found');
      const info = data.info || {};
      st.durationMs = Math.max(1, Math.round((Number(info.duration) || 0) * 1000));
      st.width = Number(info.video?.width) || 16; st.height = Number(info.video?.height) || 9;
      $('editorFileName').textContent = data.name || 'Untitled video';
      $('editorFileMeta').textContent = `${st.width}×${st.height} · ${info.video?.fps || '?'} fps · ${fmt(st.durationMs)}`;
      $('editorDuration').textContent = fmt(st.durationMs);
      document.title = `${data.name || 'Video'} · LoudLift editor`;
      video.src = `/api/source/${encodeURIComponent(uploadId)}`;
      loadSavedMasks(); renderAll();
      requestAnimationFrame(() => { fitStage(); drawTimeline(); });
    } catch (error) { showError(error.message); }
  }

  function showError(message) {
    $('editorShell').classList.add('hidden'); $('editorError').classList.remove('hidden');
    $('editorErrorText').textContent = `${message} Return to LoudLift and upload the video again.`;
  }

  function bindReturnToMain() {
    const returnUrl = uploadId ? `index.html?uploadId=${encodeURIComponent(uploadId)}` : 'index.html';
    for (const id of ['editorBack', 'editorDone']) {
      const link = $(id);
      link.href = returnUrl;
      link.addEventListener('click', (event) => {
        if (!window.opener || window.opener.closed) return;
        event.preventDefault();
        window.opener.postMessage({ type: 'loudlift-editor-done', uploadId }, location.origin);
        window.opener.focus();
        window.close();
        setTimeout(() => { if (!window.closed) location.href = returnUrl; }, 120);
      });
    }
  }

  function init() {
    video = $('editorVideo'); overlay = $('editorOverlay'); stage = $('editorStage');
    timelineCanvas = $('timelineCanvas'); timelineCtx = timelineCanvas.getContext('2d');
    restoreLayout(); bindControls(); bindOverlay(); bindTimeline(); bindReturnToMain();
    video.addEventListener('play', () => { $('editorPlay').innerHTML = icon('pause'); $('editorPlay').setAttribute('aria-label', 'Pause'); });
    video.addEventListener('pause', () => { $('editorPlay').innerHTML = icon('play'); $('editorPlay').setAttribute('aria-label', 'Play'); });
    video.addEventListener('timeupdate', () => { if (!video.seeking && !timelineDrag) updateCurrentState(videoMs()); });
    video.addEventListener('seeked', flushPendingVideoFrame);
    video.addEventListener('loadeddata', () => {
      if (pendingVideoSeekMs !== null) requestVideoFrame(pendingVideoSeekMs);
      else if (video.currentTime === 0) seek(1);
    });
    new ResizeObserver(() => { fitStage(); drawTimeline(); }).observe($('stageViewport'));
    new ResizeObserver(drawTimeline).observe($('timelineScroll'));
    window.addEventListener('keydown', (e) => { if (!e.target.matches('input, button, a')) handlePreviewKeys(e); });
    load();
  }

  init();
})();
