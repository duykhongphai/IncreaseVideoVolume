<p align="center">
  <img src="https://img.shields.io/badge/node-%3E%3D18-3c873a?logo=node.js&logoColor=white" alt="Node 18+">
  <img src="https://img.shields.io/badge/ffmpeg-native-007808?logo=ffmpeg&logoColor=white" alt="FFmpeg">
  <img src="https://img.shields.io/badge/video-lossless%20copy-2f6fe0" alt="Lossless">
  <img src="https://img.shields.io/badge/accel-GPU%20%2B%20CPU-f5b84a" alt="GPU + CPU">
  <img src="https://img.shields.io/badge/license-MIT-lightgrey" alt="MIT">
</p>

<h1 align="center">LoudLift</h1>

<p align="center">
  <strong>Make any video louder, even and comfortable to listen to — without touching a single video frame.</strong><br>
  A self-hosted web tool built on FFmpeg. Runs entirely on your machine, uses your GPU and every CPU core.
</p>

---

## Why LoudLift

Most "increase video volume" tools re-encode the whole file. That takes forever and degrades the picture. LoudLift never does that: the video stream is **copied bit-for-bit** and only the audio track is decoded, processed and re-encoded. A one-hour 4K video is done in well under a minute, and the output frames are identical to the source (verified by hashing the video stream).

On top of a simple gain slider it brings tools you would normally find in a video editor or a broadcast loudness suite:

| | Feature | What it does |
|---|---|---|
| **×** | **Multiplier / dB** | Classic boost with presets, plus a loudness scan that tells you the maximum safe gain before clipping. |
| **R128** | **Auto normalize** | Two-pass EBU R128 `loudnorm` to any LUFS target (YouTube -14, podcast -16, broadcast -23). |
| **🎧** | **Easy listening** | Measures loudness the way human hearing perceives it, levels quiet and loud passages, removes low-frequency rumble and lands the whole video at a comfortable level. Presets for speech, film/music and night mode. |
| **✂** | **Segments (timeline)** | Waveform timeline at 5 ms resolution with zoom and pan, millisecond-precise split points, auto-split by loudness changes, one-click balancing of every segment to the same RMS level, live "after gain" preview with clipping warnings. |
| **⚡** | **GPU + CPU** | Optional re-encode mode auto-detects NVIDIA NVENC, Intel Quick Sync, AMD AMF and Apple VideoToolbox, with hardware decoding and automatic CPU fallback. Audio filters use every core. |

Segment gains are an independent layer that can be combined with any other mode: balance the segments first, then run *Easy listening* on top. The loudness measurement pass sees the balanced signal, so the final level is exact.

> The emoji in the table above are only for the README. The application UI uses SVG icons throughout.

## Quick start

**Requirements**

- [Node.js](https://nodejs.org) 18 or newer
- [FFmpeg](https://ffmpeg.org) on your `PATH`. A *full* build (for example the one from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) on Windows) includes every GPU encoder. If no FFmpeg is found, the bundled `ffmpeg-static` binary is used automatically.

**Install and run**

```bash
git clone https://github.com/<you>/loudlift.git
cd loudlift
npm install
npm start
```

Open <http://localhost:3000>. On Windows you can also double-click `start.bat`.

Use a different port with `PORT=8080 npm start`.

## Using it

1. **Drop a video** onto the page. Duration, codecs and bitrates are read with `ffprobe`; the file never leaves your machine.
2. **Pick a mode** in the *Volume settings* card:
   - *Multiplier* or *Decibels* for a fixed boost. Press **Analyze current loudness** to see peak and mean level and apply the largest clipping-free gain in one click.
   - *Auto normalize* for a standard LUFS target.
   - *Easy listening* when you just want it to sound good. Choose *Speech*, *Film / music* or *Night mode*.
   - *Segments (timeline)* when different parts of the video have different levels. Press **Auto-split by loudness**, then **Balance all segments**, or place split points yourself (click, drag, `S`, or type `m:ss.mmm`).
3. **Start processing.** Progress, speed and ETA are streamed live. GPU or CPU engine and every fallback attempt are shown.
4. **Preview and download.** The result plays in the browser; the FFmpeg command that produced it is shown for reference.

Uploads and results are deleted automatically after three hours.

## How the audio pipeline works

Every job builds one FFmpeg filter graph in this fixed order:

```
segment gains  →  mode chain  →  limiter  →  resample (loudness modes only)
```

| Stage | Filters |
|---|---|
| Segment gains | `volume=<dB>:enable='between(t,start,end)'` per segment, millisecond-precise |
| Multiplier / dB | `volume=2.0` or `volume=6dB` |
| Auto normalize | `loudnorm=I=<target>:TP=-1.5:LRA=11` with measured values from pass 1, `linear=true` |
| Easy listening | `highpass` → `dynaudnorm` (long-term leveling, ignores true silence) → `acompressor` (short-term dynamics) → `loudnorm` (two-pass) |
| Limiter | `alimiter=limit=0.97:level=false` |
| Resample | `aresample=<source rate>` so `loudnorm` does not leave the file at 192 kHz |

Easy-listening presets:

| Preset | Target | LRA | Leveling | Compression |
|---|---|---|---|---|
| Speech · vlog · lecture | -16 LUFS | 7 LU | strong, up to +30 dB, high-pass 80 Hz | 3:1 from -22 dB |
| Film · music · gameplay | -14 LUFS | 11 LU | gentle, 5 s window, high-pass 40 Hz | 2.5:1 from -20 dB |
| Night mode · headphones | -20 LUFS | 5 LU | very strong, 2 s window | 5:1 from -28 dB |

Video handling:

| Mode | Command (abridged) |
|---|---|
| Stream copy (default) | `ffmpeg -i in.mp4 -map 0:v:0 -map 0:a -c:v copy -c:a aac -b:a 192k -af "<graph>" -movflags +faststart out.mp4` |
| Re-encode on GPU | `ffmpeg -hwaccel auto -i in.mp4 -c:v h264_qsv -global_quality 20 -c:a aac -af "<graph>" out.mp4` |
| Re-encode on CPU | `ffmpeg -i in.mp4 -c:v libx264 -crf 20 -threads 0 -c:a aac -af "<graph>" out.mp4` |

GPU encoders are probed at start-up with a tiny test encode, so only encoders that actually work on the machine are offered. If a GPU attempt fails (driver, unsupported pixel format, …) the job is retried without hardware decoding and finally on the CPU.

## HTTP API

The UI is a thin client over a small JSON API, so the tool can be scripted.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/capabilities` | FFmpeg version, CPU threads, working GPU and CPU encoders |
| `POST` | `/api/upload` | multipart field `video`; returns `{ id, name, info }` |
| `POST` | `/api/analyze/:id` | peak / mean level and clipping-free headroom |
| `GET` | `/api/waveform/:id` | peak + RMS per bucket (base64 `Uint8`, 0 = -60 dB, 255 = 0 dB) |
| `GET` | `/api/source/:id` | streams the uploaded file (timeline preview) |
| `POST` | `/api/process` | starts a job; body: `uploadId`, `mode`, `value`, `targetLufs`, `preset`, `segments`, `applySegments`, `limiter`, `audioCodec`, `audioBitrate`, `videoMode`, `encoder`, `quality` |
| `GET` | `/api/progress/:jobId` | Server-Sent Events with percent, speed, ETA, phase, engine |
| `GET` | `/api/job/:jobId` | same data as a single JSON document |
| `POST` | `/api/cancel/:jobId` | kills the running FFmpeg process |
| `GET` | `/api/download/:jobId` | the result (`?inline=1` for playback) |
| `DELETE` | `/api/upload/:id` | removes an upload early |

Example: boost by 6 dB with the default settings.

```bash
ID=$(curl -s -F video=@input.mp4 http://localhost:3000/api/upload | jq -r .id)
JOB=$(curl -s -X POST -H 'Content-Type: application/json' \
  -d "{\"uploadId\":\"$ID\",\"mode\":\"db\",\"value\":6,\"videoMode\":\"copy\"}" \
  http://localhost:3000/api/process | jq -r .jobId)
curl -o louder.mp4 "http://localhost:3000/api/download/$JOB"
```

## Project layout

```
server.js            Express API, FFmpeg runner, GPU probing, two-pass loudness, SSE progress, clean-up
public/index.html    UI markup and the SVG icon sprite
public/app.js        Upload, settings, job tracking, result view
public/timeline.js   Waveform timeline: zoom/pan, split points, auto-split, balancing
public/style.css     Theme and layout
start.bat            Windows launcher (installs dependencies on first run)
uploads/, outputs/   Runtime data, git-ignored
```

## FAQ

**Does it really not touch the video?**
Yes. In the default mode the video stream is copied with `-c:v copy`. Hashing the video stream of input and output gives the same MD5.

**Why is the audio re-encoded at all?**
Gain cannot be changed inside a compressed audio stream, so the audio is decoded, processed and encoded again. The default is AAC at 192 kbps, which is transparent for virtually all sources. FLAC is available for MKV if you want it lossless.

**When should I use the GPU?**
Only when you choose *Re-encode video*, for example to convert a WMV to MP4 while boosting the volume. In stream-copy mode there is no video work to accelerate, and the audio pipeline already runs many times faster than realtime on the CPU.

**Why two passes for loudness?**
Single-pass `loudnorm` has to guess and works in a dynamic mode. Measuring the whole file first lets pass 2 apply one exact linear gain, which is more accurate and more transparent.

**Can I run it on a server for other people?**
It is designed as a local tool: there is no authentication and uploads are stored on disk. Put it behind a reverse proxy with auth if you expose it.

## License

MIT
