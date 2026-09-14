# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People processing their own video files locally who need faster, more precise audio adjustment and lightweight visual redaction without moving media to a cloud editor.

## Product Purpose

LoudLift adjusts video loudness, balances time segments, and can cover selected frame regions with timed black areas. Success means the user can inspect, configure, process, preview, and download a correct result on the same machine.

## Positioning

Audio-only work preserves the original video stream bit-for-bit, while jobs that genuinely change pixels deliberately switch to GPU/CPU video encoding with automatic fallback.

## Operating Context

The product is a self-hosted browser interface backed by local Node.js, FFmpeg, and ffprobe processes. Users upload one video, configure audio and optional visual edits, run a job, then preview and download the result.

## Capabilities and Constraints

- Audio gain, normalization, easy-listening processing, and millisecond-precise audio segments.
- Multiple fixed-frame black areas with independent millisecond start and end times.
- Visual edits require video re-encoding; audio-only jobs may stream-copy video.
- Uploads and outputs are local temporary files and are deleted automatically after three hours.
- The interface must remain usable on desktop and mobile web, while the precision editor is desktop-first.

## Brand Commitments

The product name is LoudLift. Its voice is direct and technical without assuming professional editing knowledge. The incumbent dark interface, blue action color, status colors, and Lucide-style stroke icons remain recognizable.

## Evidence on Hand

- Working Express and FFmpeg implementation in `server.js`.
- Existing browser UI and design tokens in `public/`.
- A user-supplied visual reference for a dark timeline ruler with clear divisions and a red playhead.
- No commercial claims, customer testimonials, or external brand assets are supplied.

## Product Principles

- Keep media processing local and explain when re-encoding is unavoidable.
- Make precision visible through exact timing, clear rulers, and immediate preview.
- Preserve source quality and speed whenever the requested edit allows it.
- Expose advanced control progressively without hiding the primary task.

## Accessibility & Inclusion

Core controls must support keyboard operation, visible focus, readable contrast, and semantic labels. Pointer gestures need numeric alternatives for exact input.
