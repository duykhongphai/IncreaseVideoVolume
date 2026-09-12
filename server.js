'use strict';

/**
 * LoudLift – local web tool
 *  - Video stream is COPIED (no re-encode) by default => zero quality loss.
 *  - Only the audio is decoded, gain-adjusted and re-encoded.
 *  - Optional re-encode mode uses GPU encoders (NVENC / QSV / AMF / VideoToolbox)
 *    when available, falling back to multi-threaded CPU (libx264/libx265).
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile, execFileSync } = require('child_process');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'outputs');
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
const FILE_TTL_MS = 3 * 60 * 60 * 1000; // auto-delete files after 3h

for (const d of [UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// Locate ffmpeg / ffprobe (system PATH first, then bundled static binaries)
// ---------------------------------------------------------------------------
function findOnPath(name) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (first) return first;
  } catch { /* not found */ }
  return null;
}

function resolveFfmpeg() {
  const sys = findOnPath('ffmpeg');
  if (sys) return sys;
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
}
function resolveFfprobe() {
  const sys = findOnPath('ffprobe');
  if (sys) return sys;
  try { return require('ffprobe-static').path; } catch { return 'ffprobe'; }
}

const FFMPEG = resolveFfmpeg();
const FFPROBE = resolveFfprobe();
const CPU_THREADS = os.cpus().length;

// ---------------------------------------------------------------------------
// Hardware capability detection (run once at startup, cached)
// ---------------------------------------------------------------------------
const GPU_CANDIDATES = [
  { id: 'h264_nvenc', vendor: 'NVIDIA', api: 'NVENC', codec: 'H.264', hwaccel: 'cuda' },
  { id: 'hevc_nvenc', vendor: 'NVIDIA', api: 'NVENC', codec: 'H.265 / HEVC', hwaccel: 'cuda' },
  { id: 'h264_qsv', vendor: 'Intel', api: 'Quick Sync', codec: 'H.264', hwaccel: 'qsv' },
  { id: 'hevc_qsv', vendor: 'Intel', api: 'Quick Sync', codec: 'H.265 / HEVC', hwaccel: 'qsv' },
  { id: 'h264_amf', vendor: 'AMD', api: 'AMF', codec: 'H.264', hwaccel: 'd3d11va' },
  { id: 'hevc_amf', vendor: 'AMD', api: 'AMF', codec: 'H.265 / HEVC', hwaccel: 'd3d11va' },
  { id: 'h264_videotoolbox', vendor: 'Apple', api: 'VideoToolbox', codec: 'H.264', hwaccel: 'videotoolbox' },
  { id: 'hevc_videotoolbox', vendor: 'Apple', api: 'VideoToolbox', codec: 'H.265 / HEVC', hwaccel: 'videotoolbox' },
];

const CPU_ENCODERS = [
  { id: 'libx264', vendor: 'CPU', api: `x264 (${CPU_THREADS} threads)`, codec: 'H.264' },
  { id: 'libx265', vendor: 'CPU', api: `x265 (${CPU_THREADS} threads)`, codec: 'H.265 / HEVC' },
];

function run(bin, args, { timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function listEncoders() {
  const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders']);
  const set = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*[VAS][A-Z.]{5}\s+(\S+)/);
    if (m) set.add(m[1]);
  }
  return set;
}

async function testEncoder(encoderId) {
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=30:d=0.5',
    '-frames:v', '5', '-c:v', encoderId, '-f', 'null', '-',
  ];
  const r = await run(FFMPEG, args, { timeout: 20000 });
  return r.ok;
}

let capabilitiesPromise = null;
function getCapabilities() {
  if (capabilitiesPromise) return capabilitiesPromise;
  capabilitiesPromise = (async () => {
    const version = (await run(FFMPEG, ['-version'])).stdout.split(/\r?\n/)[0] || 'unknown';
    const available = await listEncoders();
    const gpu = [];
    for (const cand of GPU_CANDIDATES) {
      if (!available.has(cand.id)) continue;
      const ok = await testEncoder(cand.id);
      console.log(`[hw] ${cand.id.padEnd(18)} ${ok ? 'OK' : 'unavailable'}`);
      if (ok) gpu.push(cand);
    }
    const cpu = CPU_ENCODERS.filter(e => available.has(e.id));
    return { ffmpeg: FFMPEG, ffprobe: FFPROBE, version, cpuThreads: CPU_THREADS, gpuEncoders: gpu, cpuEncoders: cpu };
  })();
  return capabilitiesPromise;
}

// ---------------------------------------------------------------------------
// ffprobe helpers
// ---------------------------------------------------------------------------
async function probe(file) {
  const r = await run(FFPROBE, [
    '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', file,
  ], { timeout: 60000 });
  if (!r.ok) throw new Error('Could not read media info (ffprobe): ' + r.stderr.slice(0, 300));
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find(s => s.codec_type === 'video');
  const audios = (j.streams || []).filter(s => s.codec_type === 'audio');
  const fpsOf = (s) => {
    if (!s || !s.avg_frame_rate) return null;
    const [n, d] = s.avg_frame_rate.split('/').map(Number);
    return d ? +(n / d).toFixed(3) : null;
  };
  return {
    duration: Number(j.format?.duration) || 0,
    size: Number(j.format?.size) || 0,
    bitrate: Number(j.format?.bit_rate) || 0,
    formatName: j.format?.format_name || '',
    video: v ? {
      codec: v.codec_name, profile: v.profile, width: v.width, height: v.height,
      fps: fpsOf(v), pixFmt: v.pix_fmt, bitrate: Number(v.bit_rate) || null,
    } : null,
    audio: audios.map(a => ({
      index: a.index, codec: a.codec_name, channels: a.channels, channelLayout: a.channel_layout,
      sampleRate: Number(a.sample_rate) || null, bitrate: Number(a.bit_rate) || null,
      language: a.tags?.language || null,
    })),
  };
}

function parseFfTime(str) {
  // "HH:MM:SS.micro" -> seconds
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str || '');
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// ---------------------------------------------------------------------------
// In-memory registries
// ---------------------------------------------------------------------------
const uploads = new Map(); // id -> { path, originalName, ext, info, createdAt }
const jobs = new Map();    // id -> job

function newId() { return crypto.randomBytes(8).toString('hex'); }

function safeBase(name) {
  return path.parse(name).name.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80) || 'video';
}

// ---------------------------------------------------------------------------
// Encoding argument builders
// ---------------------------------------------------------------------------
const MP4_LIKE = new Set(['.mp4', '.m4v', '.mov']);
const KNOWN_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.avi', '.ts', '.flv', '.mts', '.m2ts']);

const AUDIO_CODEC_MAP = {
  aac: 'aac',
  mp3: 'libmp3lame',
  opus: 'libopus',
  vorbis: 'libvorbis',
  ac3: 'ac3',
  flac: 'flac',
};

function defaultAudioCodec(ext) {
  if (ext === '.webm') return 'opus';
  if (ext === '.avi') return 'mp3';
  return 'aac';
}

function outputExtFor(inputExt, videoMode, encoderId) {
  if (videoMode === 'copy') return KNOWN_CONTAINERS.has(inputExt) ? inputExt : '.mkv';
  // re-encode to h264/h265: webm cannot hold them, exotic containers -> mp4
  if (inputExt === '.mkv') return '.mkv';
  return '.mp4';
}

// "Easy listening": perceptual loudness (EBU R128 / LUFS) presets
// chain: highpass -> dynaudnorm (long-term leveling, ignores true silence) -> acompressor (short-term dynamics)
//        -> loudnorm (absolute perceptual level, 2-pass linear) -> limiter
const EASY_PRESETS = {
  speech: {
    I: -16, LRA: 7, TP: -1.5, hp: 80,
    dyn: 'dynaudnorm=f=300:g=15:p=0.9:m=30:t=0.002',
    comp: 'acompressor=threshold=-22dB:ratio=3:attack=10:release=200:knee=6',
  },
  media: {
    I: -14, LRA: 11, TP: -1.0, hp: 40,
    dyn: 'dynaudnorm=f=500:g=11:p=0.95:m=20:t=0.002',
    comp: 'acompressor=threshold=-20dB:ratio=2.5:attack=20:release=300:knee=8',
  },
  night: {
    I: -20, LRA: 5, TP: -2.0, hp: 80,
    dyn: 'dynaudnorm=f=200:g=11:p=0.9:m=35:t=0.002',
    comp: 'acompressor=threshold=-28dB:ratio=5:attack=5:release=150:knee=6',
  },
};

function easyTarget(opts) {
  const p = EASY_PRESETS[opts.preset] || EASY_PRESETS.speech;
  return Math.min(-8, Math.max(-30, Number(opts.targetLufs) || p.I));
}
function normalizeTarget(opts) { return Math.min(-5, Math.max(-30, Number(opts.targetLufs) || -14)); }

function loudnormFilter(I, TP, LRA, measured) {
  let ln = `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}`;
  if (measured) {
    ln += `:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}` +
      `:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true`;
  } else {
    ln += ':print_format=json';
  }
  return ln;
}

function usesLoudnorm(opts) { return opts.mode === 'normalize' || opts.mode === 'easy'; }

// Per-segment gain: chain of volume filters, each enabled only inside its time range (ms precision).
// This is an independent pre-stage: it can run alone (mode = segments) or before any other mode.
function segmentFilters(segments) {
  const out = [];
  for (const sg of (Array.isArray(segments) ? segments : []).slice(0, 500)) {
    const g = Math.min(40, Math.max(-40, Number(sg.gainDb) || 0));
    const a = Math.max(0, Number(sg.start) || 0);
    const b = Number(sg.end);
    if (Math.abs(g) < 0.005 || !(b > a)) continue;
    out.push(`volume=${g.toFixed(2)}dB:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'`);
  }
  return out;
}
function segmentsActive(opts) { return opts.mode === 'segments' || opts.applySegments === true; }

function buildAudioFilter(opts, measured = null) {
  const f = [];
  if (segmentsActive(opts)) f.push(...segmentFilters(opts.segments));
  if (opts.mode === 'easy') {
    const p = EASY_PRESETS[opts.preset] || EASY_PRESETS.speech;
    if (opts.highpass !== false) f.push(`highpass=f=${p.hp}`);
    if (opts.leveler !== false) f.push(p.dyn, p.comp);
    f.push(loudnormFilter(easyTarget(opts), p.TP, p.LRA, measured));
  } else if (opts.mode === 'normalize') {
    f.push(loudnormFilter(normalizeTarget(opts), -1.5, 11, measured));
  } else if (opts.mode === 'db') {
    const db = Math.min(40, Math.max(-40, Number(opts.value) || 0));
    f.push(`volume=${db}dB`);
  } else if (opts.mode === 'segments') {
    // segment layer only (already pushed above)
  } else {
    const mult = Math.min(50, Math.max(0.05, Number(opts.value) || 1));
    f.push(`volume=${mult}`);
  }
  if (opts.limiter !== false) f.push('alimiter=limit=0.97:level=false');
  // loudnorm internally upsamples to 192 kHz; bring the stream back to its original rate
  if (usesLoudnorm(opts)) f.push(`aresample=${Math.min(96000, Math.max(8000, Number(opts.sampleRate) || 48000))}`);
  if (!f.length) f.push('anull');
  return f.join(',');
}

function parseLoudnormJson(stderr) {
  const start = stderr.lastIndexOf('{'), end = stderr.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const j = JSON.parse(stderr.slice(start, end + 1));
    const keys = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'];
    if (keys.some(k => !Number.isFinite(Number(j[k])))) return null; // "-inf" on silent audio
    return j;
  } catch { return null; }
}

function videoEncoderArgs(encoderId, quality) {
  const q = Math.min(35, Math.max(10, Number(quality) || 20));
  switch (encoderId) {
    case 'h264_nvenc':
    case 'hevc_nvenc':
      return ['-c:v', encoderId, '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(q), '-b:v', '0', '-spatial_aq', '1'];
    case 'h264_qsv':
    case 'hevc_qsv':
      return ['-c:v', encoderId, '-preset', 'medium', '-global_quality', String(q)];
    case 'h264_amf':
    case 'hevc_amf':
      return ['-c:v', encoderId, '-quality', 'quality', '-rc', 'cqp', '-qp_i', String(q), '-qp_p', String(q)];
    case 'h264_videotoolbox':
    case 'hevc_videotoolbox':
      return ['-c:v', encoderId, '-q:v', String(Math.round(100 - (q - 10) * 2.4))];
    case 'libx265':
      return ['-c:v', 'libx265', '-preset', 'medium', '-crf', String(q), '-threads', '0'];
    default:
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', String(q), '-threads', '0'];
  }
}

function buildArgs({ input, output, outExt, opts, encoderId, hwaccel, measured = null }) {
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-stats_period', '0.5'];
  if (hwaccel) args.push('-hwaccel', hwaccel);
  args.push('-threads', '0', '-i', input);
  args.push('-map', '0:v:0', '-map', '0:a?', '-sn', '-dn');
  args.push('-map_metadata', '0', '-map_chapters', '0');

  // ---- video ----
  if (opts.videoMode === 'copy' || !encoderId) {
    args.push('-c:v', 'copy');
  } else {
    args.push(...videoEncoderArgs(encoderId, opts.quality));
    if (encoderId === 'libx264' || encoderId === 'h264_qsv' || encoderId === 'h264_nvenc' || encoderId === 'h264_amf') {
      args.push('-pix_fmt', 'yuv420p');
    }
  }

  // ---- audio ----
  const codecKey = AUDIO_CODEC_MAP[opts.audioCodec] ? opts.audioCodec : defaultAudioCodec(outExt);
  const codec = AUDIO_CODEC_MAP[codecKey];
  args.push('-c:a', codec);
  if (codecKey !== 'flac') {
    const kbps = Math.min(512, Math.max(64, Number(opts.audioBitrate) || 192));
    args.push('-b:a', `${kbps}k`);
  }
  if (codecKey === 'opus' || codecKey === 'vorbis') args.push('-ar', '48000');
  args.push('-filter_threads', String(CPU_THREADS));
  args.push('-af', buildAudioFilter(opts, measured));

  // ---- container ----
  if (MP4_LIKE.has(outExt)) args.push('-movflags', '+faststart');
  args.push('-max_muxing_queue_size', '4096');
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(output);
  return args;
}

// ---------------------------------------------------------------------------
// Job runner (with automatic fallback: GPU -> CPU, hwaccel -> software decode)
// ---------------------------------------------------------------------------
function runFfmpeg(job, args) {
  return new Promise((resolve) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    job.child = child;
    let stderr = '';
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const k = line.slice(0, eq), v = line.slice(eq + 1).trim();
        if (k === 'out_time') {
          const t = parseFfTime(v);
          if (t != null && job.duration > 0) job.percent = Math.min(99.9, (t / job.duration) * 100);
          job.outTime = t;
        } else if (k === 'speed') {
          const s = parseFloat(v);
          if (!Number.isNaN(s) && s > 0) {
            job.speed = s;
            if (job.duration > 0 && job.outTime != null) job.eta = Math.max(0, (job.duration - job.outTime) / s);
          }
        } else if (k === 'fps') {
          job.fps = parseFloat(v) || 0;
        }
        job.updatedAt = Date.now();
      }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    child.on('error', (e) => resolve({ ok: false, stderr: String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0 && !job.cancelled, code, stderr }));
  });
}

async function processJob(job) {
  const up = uploads.get(job.uploadId);
  const opts = job.opts;
  const caps = await getCapabilities();

  // Build attempt plan
  const attempts = [];
  if (opts.videoMode === 'copy') {
    attempts.push({ encoderId: null, hwaccel: null, label: 'Stream copy (lossless video)' });
  } else {
    const gpu = caps.gpuEncoders.find(e => e.id === opts.encoder);
    const cpu = caps.cpuEncoders.find(e => e.id === opts.encoder);
    if (gpu) {
      attempts.push({ encoderId: gpu.id, hwaccel: 'auto', label: `${gpu.vendor} ${gpu.api} (${gpu.codec}) + GPU decode` });
      attempts.push({ encoderId: gpu.id, hwaccel: null, label: `${gpu.vendor} ${gpu.api} (${gpu.codec})` });
    } else if (cpu) {
      attempts.push({ encoderId: cpu.id, hwaccel: 'auto', label: `${cpu.api} + GPU decode` });
    }
    // CPU fallback always last
    const fallback = gpu && gpu.codec.startsWith('H.265') ? 'libx265' : 'libx264';
    attempts.push({ encoderId: fallback, hwaccel: null, label: `CPU ${fallback} (${CPU_THREADS} threads)` });
  }

  // Pass 1 (loudness modes): measure integrated loudness so pass 2 can apply an exact, linear gain
  let measured = null;
  if (usesLoudnorm(opts) && !job.cancelled) {
    job.phase = 'Pass 1/2: measuring perceived loudness (LUFS)';
    job.engine = 'EBU R128 analysis';
    const mArgs = [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'info', '-progress', 'pipe:1', '-nostats',
      '-threads', '0', '-i', up.path, '-map', '0:a:0', '-vn', '-sn', '-dn',
      '-filter_threads', String(CPU_THREADS), '-af', buildAudioFilter({ ...opts, limiter: false }, null),
      '-f', 'null', '-',
    ];
    const r = await runFfmpeg(job, mArgs);
    measured = r.ok ? parseLoudnormJson(r.stderr) : null;
    if (measured) {
      job.measured = {
        inputI: Number(measured.input_i), inputTp: Number(measured.input_tp), inputLra: Number(measured.input_lra),
        targetI: opts.mode === 'easy' ? easyTarget(opts) : normalizeTarget(opts),
      };
      console.log(`[job ${job.id}] measured: I=${measured.input_i} LUFS, TP=${measured.input_tp} dBTP, LRA=${measured.input_lra} LU`);
    } else {
      console.warn(`[job ${job.id}] loudness measurement unavailable, falling back to single-pass loudnorm`);
    }
    job.phase = 'Pass 2/2: applying and writing output';
  }

  let lastErr = '';
  for (let i = 0; i < attempts.length; i++) {
    if (job.cancelled) break;
    const a = attempts[i];
    job.engine = a.label;
    job.percent = 0; job.eta = null; job.speed = null; job.outTime = 0;
    job.attempt = i + 1; job.attempts = attempts.length;
    const args = buildArgs({ input: up.path, output: job.outPath, outExt: job.outExt, opts, encoderId: a.encoderId, hwaccel: a.hwaccel, measured });
    job.command = ['ffmpeg', ...args].map(s => /\s/.test(s) ? `"${s}"` : s).join(' ');
    console.log(`[job ${job.id}] attempt ${i + 1}/${attempts.length}: ${a.label}`);
    const r = await runFfmpeg(job, args);
    if (r.ok) {
      job.status = 'done'; job.percent = 100; job.eta = 0;
      job.outSize = fs.existsSync(job.outPath) ? fs.statSync(job.outPath).size : 0;
      job.finishedAt = Date.now();
      console.log(`[job ${job.id}] done in ${((job.finishedAt - job.startedAt) / 1000).toFixed(1)}s via ${a.label}`);
      return;
    }
    lastErr = r.stderr || `ffmpeg exited with code ${r.code}`;
    console.warn(`[job ${job.id}] attempt failed: ${lastErr.split('\n').slice(-3).join(' | ')}`);
    try { fs.unlinkSync(job.outPath); } catch { /* ignore */ }
  }
  job.status = job.cancelled ? 'cancelled' : 'error';
  job.error = job.cancelled ? 'Cancelled' : lastErr.trim().split('\n').slice(-6).join('\n');
  job.finishedAt = Date.now();
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${newId()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD_BYTES } });

app.get('/api/capabilities', async (_req, res) => {
  try { res.json(await getCapabilities()); }
  catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

app.post('/api/upload', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file received' });
  const id = path.parse(req.file.filename).name;
  try {
    const info = await probe(req.file.path);
    if (!info.audio.length) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'This video has no audio stream, so there is nothing to adjust.' });
    }
    // Decode multer's latin1 filename into UTF-8 (fixes Vietnamese names)
    let originalName = req.file.originalname;
    try { originalName = Buffer.from(originalName, 'latin1').toString('utf8'); } catch { /* keep */ }
    uploads.set(id, { id, path: req.file.path, originalName, ext: path.extname(req.file.filename).toLowerCase(), info, createdAt: Date.now() });
    res.json({ id, name: originalName, info });
  } catch (e) {
    fs.unlink(req.file.path, () => {});
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Analyse loudness: mean / peak volume so the UI can suggest a safe gain
app.post('/api/analyze/:id', async (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.status(404).json({ error: 'File not found' });
  const r = await run(FFMPEG, [
    '-hide_banner', '-nostdin', '-threads', '0', '-i', up.path, '-vn', '-sn', '-dn',
    '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-',
  ], { timeout: 30 * 60 * 1000 });
  const mean = /mean_volume:\s*(-?[\d.]+)\s*dB/.exec(r.stderr);
  const max = /max_volume:\s*(-?[\d.]+)\s*dB/.exec(r.stderr);
  if (!max) return res.status(500).json({ error: 'Loudness analysis failed' });
  const maxDb = Number(max[1]);
  const meanDb = mean ? Number(mean[1]) : null;
  const headroomDb = Math.max(0, -maxDb - 0.3);
  res.json({ meanDb, maxDb, headroomDb: +headroomDb.toFixed(2), safeMultiplier: +Math.pow(10, headroomDb / 20).toFixed(3) });
});

// Stream the original upload (for timeline scrubbing / preview)
app.get('/api/source/:id', (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.status(404).send('File not found');
  res.sendFile(up.path);
});

// Waveform analysis: peak + RMS (dB) per bucket of a few ms, packed as base64 Uint8 (0 = -60 dB, 255 = 0 dB)
const WAVE_SR = 16000;
const WAVE_MAX_BUCKETS = 400000;
app.get('/api/waveform/:id', (req, res) => {
  const up = uploads.get(req.params.id);
  if (!up) return res.status(404).json({ error: 'File not found' });
  const duration = up.info.duration || 0;
  let bucketMs = Number(req.query.bucketMs) || 0;
  if (!bucketMs) bucketMs = Math.max(5, Math.ceil((duration * 1000) / WAVE_MAX_BUCKETS));
  bucketMs = Math.min(1000, Math.max(1, Math.round(bucketMs)));
  if (up.waveform && up.waveform.bucketMs === bucketMs) return res.json(up.waveform);

  const spb = Math.max(1, Math.round(WAVE_SR * bucketMs / 1000)); // samples per bucket
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '0', '-i', up.path,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(WAVE_SR), '-f', 's16le', '-',
  ];
  const child = spawn(FFMPEG, args, { windowsHide: true });
  const peaks = [], rms = [];
  let sumSq = 0, maxAbs = 0, n = 0, leftover = null, stderr = '';
  const toU8 = (lin) => {
    const db = 20 * Math.log10(Math.max(lin, 1e-6));
    return Math.max(0, Math.min(255, Math.round((db + 60) / 60 * 255)));
  };
  const flush = () => { peaks.push(toU8(maxAbs)); rms.push(toU8(Math.sqrt(sumSq / n))); sumSq = 0; maxAbs = 0; n = 0; };
  child.stdout.on('data', (chunk) => {
    const buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
    const usable = buf.length - (buf.length % 2);
    for (let i = 0; i < usable; i += 2) {
      const v = buf.readInt16LE(i) / 32768;
      const a = v < 0 ? -v : v;
      if (a > maxAbs) maxAbs = a;
      sumSq += v * v;
      if (++n === spb) flush();
    }
    leftover = usable < buf.length ? Buffer.from(buf.subarray(usable)) : null;
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  child.on('error', (e) => res.status(500).json({ error: String(e) }));
  child.on('close', (code) => {
    if (n > 0) flush();
    if (code !== 0 && !peaks.length) return res.status(500).json({ error: 'Waveform analysis failed: ' + stderr.slice(-300) });
    const out = {
      bucketMs, count: peaks.length, duration,
      peak: Buffer.from(Uint8Array.from(peaks)).toString('base64'),
      rms: Buffer.from(Uint8Array.from(rms)).toString('base64'),
    };
    up.waveform = out;
    res.json(out);
  });
});

app.post('/api/process', async (req, res) => {
  const { uploadId, ...opts } = req.body || {};
  const up = uploads.get(uploadId);
  if (!up) return res.status(404).json({ error: 'The upload has expired or does not exist. Please upload again.' });

  const videoMode = opts.videoMode === 'reencode' ? 'reencode' : 'copy';
  const outExt = outputExtFor(up.ext, videoMode, opts.encoder);
  const label = opts.mode === 'normalize' ? 'normalized'
    : opts.mode === 'easy' ? `easy-${EASY_PRESETS[opts.preset] ? opts.preset : 'speech'}`
    : opts.mode === 'segments' ? 'segments'
    : opts.mode === 'db' ? `${Number(opts.value) >= 0 ? '+' : ''}${Number(opts.value)}dB`
      : `x${Number(opts.value)}`;
  const segSuffix = (opts.applySegments === true && opts.mode !== 'segments' && segmentFilters(opts.segments).length) ? '-seg' : '';
  const id = newId();
  const job = {
    id, uploadId, opts: { ...opts, videoMode, sampleRate: up.info.audio[0]?.sampleRate || 48000 },
    status: 'running', percent: 0, speed: null, eta: null, fps: 0, phase: '', measured: null,
    duration: up.info.duration, outExt,
    outPath: path.join(OUTPUT_DIR, `${id}${outExt}`),
    outName: `${safeBase(up.originalName)}_volume_${label}${segSuffix}${outExt}`,
    startedAt: Date.now(), updatedAt: Date.now(), engine: '', error: null, cancelled: false,
  };
  jobs.set(id, job);
  processJob(job).catch((e) => { job.status = 'error'; job.error = String(e.message || e); job.finishedAt = Date.now(); });
  res.json({ jobId: id, outName: job.outName });
});

function publicJob(job) {
  const { child, outPath, opts, ...rest } = job;
  return rest;
}

app.get('/api/job/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

// Server-sent events progress stream
app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  const send = () => res.write(`data: ${JSON.stringify(publicJob(job))}\n\n`);
  send();
  const timer = setInterval(() => {
    send();
    if (job.status !== 'running') { clearInterval(timer); res.end(); }
  }, 500);
  req.on('close', () => clearInterval(timer));
});

app.post('/api/cancel/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'running' && job.child) {
    job.cancelled = true;
    try { job.child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'done' || !fs.existsSync(job.outPath)) return res.status(404).send('Output file not found');
  const inline = req.query.inline === '1';
  if (inline) {
    // for <video> preview: support range requests via sendFile
    return res.sendFile(job.outPath);
  }
  res.download(job.outPath, job.outName);
});

app.delete('/api/upload/:id', (req, res) => {
  const up = uploads.get(req.params.id);
  if (up) { fs.unlink(up.path, () => {}); uploads.delete(up.id); }
  res.json({ ok: true });
});

// Error handler (multer size limit, etc.)
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message || String(err) });
});

// ---------------------------------------------------------------------------
// Housekeeping: delete stale uploads/outputs
// ---------------------------------------------------------------------------
function cleanup() {
  const now = Date.now();
  for (const [id, up] of uploads) {
    if (now - up.createdAt > FILE_TTL_MS) { fs.unlink(up.path, () => {}); uploads.delete(id); }
  }
  for (const [id, job] of jobs) {
    if (job.status !== 'running' && now - (job.finishedAt || job.startedAt) > FILE_TTL_MS) {
      fs.unlink(job.outPath, () => {}); jobs.delete(id);
    }
  }
  // orphan files from previous runs
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        const st = fs.statSync(p);
        if (now - st.mtimeMs > FILE_TTL_MS) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  }
}
setInterval(cleanup, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`\n  LoudLift`);
  console.log(`  ->  http://localhost:${PORT}\n`);
  console.log(`  ffmpeg : ${FFMPEG}`);
  console.log(`  ffprobe: ${FFPROBE}`);
  console.log(`  CPU    : ${CPU_THREADS} threads`);
  console.log(`  Probing GPU encoders...`);
  const caps = await getCapabilities();
  if (caps.gpuEncoders.length) {
    console.log(`  GPU    : ${[...new Set(caps.gpuEncoders.map(g => `${g.vendor} ${g.api}`))].join(', ')}`);
  } else {
    console.log(`  GPU    : no hardware encoder detected (CPU will be used for re-encoding)`);
  }
  cleanup();
});
