// exporter.ts — offline render → encode → MP4 mux.
//
// The preview path is best-effort (nearest decoded frame, realtime). Export
// is frame-exact and offline: for each output frame we evaluate the engine,
// pull the EXACT decoded source frame (media.exactFrame), composite with a
// dedicated offscreen Renderer, snapshot the canvas into a VideoFrame, and
// feed VideoEncoder → mp4-muxer. Audio is mixed offline from the supplied
// clip plan (speed-1 clips, matching the preview mixer) and AAC-encoded.

import { Muxer, ArrayBufferTarget, FileSystemWritableFileStreamTarget } from 'mp4-muxer';
import type { FrameGraph, TimeUs } from '@velocut/protocol';
import { Renderer } from './renderer';
import type { MediaLibrary } from './media';

const EXPORT_TMP = 'velocut-export-tmp.mp4';

/** Open an OPFS file to stream the muxed MP4 to disk (so a long export's output
 *  never sits on the JS heap). Sweeps the previous temp first; returns null if
 *  OPFS / writable streams aren't available (→ caller falls back to memory). */
async function openExportFile(): Promise<{
  handle: FileSystemFileHandle;
  writable: FileSystemWritableFileStream;
} | null> {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const dir = await navigator.storage.getDirectory();
    await dir.removeEntry(EXPORT_TMP).catch(() => {});
    const handle = await dir.getFileHandle(EXPORT_TMP, { create: true });
    if (typeof handle.createWritable !== 'function') return null;
    const writable = await handle.createWritable();
    return { handle, writable };
  } catch {
    return null;
  }
}

export interface AudioClipPlan {
  assetId: string;
  /** Where on the timeline the clip starts / how long it plays. */
  startUs: TimeUs;
  durationUs: TimeUs;
  /** Source offset at the clip's start (speed 1 → advances 1:1). */
  sourceInUs: TimeUs;
  gain: number;
}

/** Video codec FAMILY the export targets. AVC (H.264) is the safe default
 *  (8-bit, ≤4K); HEVC/AV1 break that ceiling (8K, better efficiency, 10-bit
 *  capable) where the platform encoder supports them. Resolved against the
 *  real encoder via pickCodec(), which falls back to AVC if unsupported. */
export type VideoCodecFamily = 'avc' | 'hevc' | 'av1';

export interface ExportOptions {
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  durationUs: TimeUs;
  evaluate: (timeUs: TimeUs) => FrameGraph;
  audioClips?: AudioClipPlan[];
  /** Target average video bitrate (bits/s). NO app-imposed cap — passed straight
   *  to the encoder; omit for a heuristic default (≈0.10 bpp, see export()). */
  videoBitrate?: number;
  /** Codec family (default 'avc'). Auto-falls back to AVC if the platform
   *  encoder can't do the requested family at this resolution. */
  videoCodec?: VideoCodecFamily;
  audioBitrate?: number;
  onProgress?: (fraction: number, label: string) => void;
  signal?: AbortSignal;
}

const AUDIO_RATE = 48000;
const AUDIO_CHANNELS = 2;

/** Codec-string candidates per family, highest capability first (the level in
 *  each string caps resolution/framerate; we pick the first the encoder accepts).
 *  AVC tops at 4K; HEVC/AV1 reach 8K (measured: isConfigSupported on this stack). */
const CODEC_CANDIDATES: Record<VideoCodecFamily, string[]> = {
  avc: ['avc1.640034', 'avc1.640028', 'avc1.4d0028', 'avc1.42E01F'],
  hevc: ['hvc1.1.6.L186.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0'],
  av1: ['av01.0.16M.08', 'av01.0.13M.08', 'av01.0.09M.08', 'av01.0.08M.08', 'av01.0.05M.08'],
};

/** Pick the most capable codec string in a family the encoder will accept at this
 *  resolution/framerate, or null if none (caller falls back to AVC). */
async function pickCodec(
  family: VideoCodecFamily,
  width: number,
  height: number,
  framerate: number,
): Promise<{ family: VideoCodecFamily; codec: string } | null> {
  for (const codec of CODEC_CANDIDATES[family]) {
    try {
      if ((await VideoEncoder.isConfigSupported({ codec, width, height, framerate })).supported)
        return { family, codec };
    } catch {
      /* malformed/unsupported string on this platform — try the next */
    }
  }
  return null;
}

export class Exporter {
  constructor(private media: MediaLibrary) {}

  async export(opts: ExportOptions): Promise<Blob> {
    const { width, height, fpsNum, fpsDen, durationUs, evaluate, signal } = opts;
    const frameDurUs = (1e6 * fpsDen) / fpsNum;
    const totalFrames = Math.max(1, Math.round(durationUs / frameDurUs));
    const framerate = fpsNum / fpsDen;
    const hasAudio = (opts.audioClips?.length ?? 0) > 0;

    // Resolve the codec against the real encoder BEFORE muxing (the muxer needs
    // the family up front). Requested family first, AVC as the universal fallback.
    const want = opts.videoCodec ?? 'avc';
    const picked =
      (await pickCodec(want, width, height, framerate)) ??
      (want !== 'avc' ? await pickCodec('avc', width, height, framerate) : null);
    if (!picked) throw new Error(`No usable video encoder config (${width}x${height}@${framerate})`);

    // Stream the output to OPFS when possible so the whole MP4 doesn't buffer
    // in memory; otherwise fall back to an in-memory ArrayBuffer (faststart).
    const stream = await openExportFile();
    const muxer = new Muxer({
      target: stream
        ? new FileSystemWritableFileStreamTarget(stream.writable)
        : new ArrayBufferTarget(),
      video: { codec: picked.family, width, height },
      ...(hasAudio
        ? { audio: { codec: 'aac' as const, numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_RATE } }
        : {}),
      // Streaming → moov at the end (sequential writes); memory → faststart.
      fastStart: stream ? false : 'in-memory',
    }) as Muxer<ArrayBufferTarget>;

    // ---- video ----
    const offscreen = new OffscreenCanvas(width, height);
    const renderer = new Renderer();
    await renderer.init(offscreen);

    const videoEncoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => console.error('[velocut] video encode error', e),
    });
    videoEncoder.configure({
      codec: picked.codec,
      width,
      height,
      framerate,
      // No app cap: explicit videoBitrate passes through; default is a ≈0.10 bpp
      // heuristic (raised from 0.07 — the old default looked soft on motion).
      bitrate: opts.videoBitrate ?? Math.round(width * height * framerate * 0.1),
      latencyMode: 'quality',
    });

    const keyint = Math.max(1, Math.round(framerate * 2)); // 2s GOP

    // Gather the exact decoded source frames for one output time. Kept serial
    // per frame (one forward-running decoder per source); consecutive frames'
    // gathers are pipelined below so the worker decode of frame n+1 overlaps
    // the render+encode of frame n.
    const gather = async (t: number): Promise<{ fg: FrameGraph; frames: Map<string, VideoFrame> }> => {
      const fg = evaluate(t);
      const frames = new Map<string, VideoFrame>();
      // Every source frame this output frame needs: each top-level layer PLUS
      // each cross-clip transition's nested outgoing (`from`) layer. A transition
      // mixes two source positions — the preview pulls both via frameForFrom, so
      // export must gather the `from` frame too or the outgoing side renders blank.
      const need: { clipId: string; assetId: string; sourceTimeUs: number; from?: boolean }[] = [];
      for (const layer of fg.layers) {
        if (layer.assetId) need.push({ clipId: layer.clipId, assetId: layer.assetId, sourceTimeUs: layer.sourceTimeUs });
        const from = layer.transition?.from;
        if (from?.assetId) need.push({ clipId: from.clipId, assetId: from.assetId, sourceTimeUs: from.sourceTimeUs, from: true });
      }
      for (const n of need) {
        if (frames.has(n.clipId)) continue; // de-dupe (one decoder per asset, serial)
        // Outgoing side uses a dedicated decoder so a same-asset transition
        // doesn't thrash the single export decoder between two source positions.
        const f = n.from
          ? await this.media.exactFrameFrom(n.assetId, n.sourceTimeUs)
          : await this.media.exactFrame(n.assetId, n.sourceTimeUs);
        if (f) frames.set(n.clipId, f);
      }
      return { fg, frames };
    };

    let nextFrames = gather(0);
    for (let n = 0; n < totalFrames; n++) {
      if (signal?.aborted) {
        (await nextFrames).frames.forEach((f) => f.close());
        this.media.releaseExactFromDecoders();
        throw new DOMException('aborted', 'AbortError');
      }
      const t = Math.round(n * frameDurUs);
      const { fg, frames } = await nextFrames;
      // Prefetch the next frame's source frames while we render/encode this one.
      if (n + 1 < totalFrames) nextFrames = gather(Math.round((n + 1) * frameDurUs));

      renderer.render(fg, this.media, (clipId) => frames.get(clipId) ?? null);
      await renderer.workDone();

      const vf = new VideoFrame(offscreen, { timestamp: t, duration: frameDurUs });
      videoEncoder.encode(vf, { keyFrame: n % keyint === 0 });
      vf.close();
      for (const f of frames.values()) f.close();

      // Backpressure: don't let the encode queue run away.
      while (videoEncoder.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
      opts.onProgress?.(((n + 1) / totalFrames) * (hasAudio ? 0.85 : 1), 'Rendering video frames');
    }
    await videoEncoder.flush();
    videoEncoder.close();
    renderer.dispose();
    this.media.releaseExactFromDecoders(); // free the transition outgoing-side decoders

    // ---- audio ----
    if (hasAudio) {
      await this.encodeAudio(opts, muxer, durationUs);
    }

    muxer.finalize();
    if (stream) {
      await stream.writable.close();
      // A File backed by the OPFS entry — downloading it streams from disk, so
      // the output bytes never re-materialize on the JS heap.
      return await stream.handle.getFile();
    }
    const { buffer } = muxer.target as ArrayBufferTarget;
    return new Blob([buffer], { type: 'video/mp4' });
  }

  private async encodeAudio(opts: ExportOptions, muxer: Muxer<ArrayBufferTarget>, durationUs: TimeUs) {
    const total = Math.ceil((durationUs / 1e6) * AUDIO_RATE);

    const audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (e) => console.error('[velocut] audio encode error', e),
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: AUDIO_RATE,
      numberOfChannels: AUDIO_CHANNELS,
      bitrate: opts.audioBitrate ?? 192_000,
    });

    // Each clip's timeline sample span, precomputed.
    const spans = opts.audioClips!.map((clip) => {
      const start = Math.floor((clip.startUs / 1e6) * AUDIO_RATE);
      return { clip, start, end: start + Math.floor((clip.durationUs / 1e6) * AUDIO_RATE) };
    });

    // Mix + encode in ~1 s windows that are an exact multiple of the 1024-sample
    // AAC frame. Only one small window buffer is resident — never the whole
    // timeline (which would be GBs of Float32 for a long export).
    const FRAME = 1024;
    const WIN = FRAME * 47; // ≈ 1.0027 s @ 48 kHz
    const win = [new Float32Array(WIN), new Float32Array(WIN)];

    for (let winStart = 0; winStart < total; winStart += WIN) {
      if (opts.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const len = Math.min(WIN, total - winStart);
      win[0].fill(0, 0, len);
      win[1].fill(0, 0, len);

      // Mix every clip overlapping [winStart, winStart+len).
      for (const { clip, start, end } of spans) {
        const a = Math.max(winStart, start);
        const b = Math.min(winStart + len, end);
        if (b <= a) continue;
        const srcUs = clip.sourceInUs + ((a - start) / AUDIO_RATE) * 1e6;
        const durUs = ((b - a) / AUDIO_RATE) * 1e6;
        let pcm;
        try {
          pcm = await this.media.requestPcm(clip.assetId, srcUs, durUs);
        } catch {
          continue; // unsupported / no audio
        }
        if (!pcm.frames) continue;
        const ratio = pcm.sampleRate / AUDIO_RATE; // nearest-sample resample
        const outLen = Math.min(b - a, Math.floor(pcm.frames / ratio));
        const base = a - winStart;
        for (let ch = 0; ch < AUDIO_CHANNELS; ch++) {
          const src = pcm.planes[Math.min(ch, pcm.channels - 1)];
          const dst = win[ch];
          for (let i = 0; i < outLen; i++) dst[base + i] += src[Math.floor(i * ratio)] * clip.gain;
        }
      }

      // Emit whole 1024-sample AAC frames from this window.
      for (let pos = 0; pos < len; pos += FRAME) {
        const m = Math.min(FRAME, len - pos);
        const planar = new Float32Array(m * AUDIO_CHANNELS);
        for (let ch = 0; ch < AUDIO_CHANNELS; ch++) planar.set(win[ch].subarray(pos, pos + m), ch * m);
        const data = new AudioData({
          format: 'f32-planar',
          sampleRate: AUDIO_RATE,
          numberOfFrames: m,
          numberOfChannels: AUDIO_CHANNELS,
          timestamp: Math.round(((winStart + pos) / AUDIO_RATE) * 1e6),
          data: planar,
        });
        audioEncoder.encode(data);
        data.close();
        while (audioEncoder.encodeQueueSize > 16) await new Promise((r) => setTimeout(r, 0));
      }
      opts.onProgress?.(0.85 + (winStart / total) * 0.15, 'Encoding audio');
    }
    await audioEncoder.flush();
    audioEncoder.close();
  }
}
