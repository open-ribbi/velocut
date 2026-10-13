// transcribe.ts — speech → caption clips (the AI-native captioning capability).
//
// Two layers, kept separate on purpose:
//   1. Transcriber  — audio PCM → timed text segments (the AI/ASR bit). The
//      interface is pluggable: WhisperTranscriber runs in-browser via
//      transformers.js + WebGPU, but a cloud-ASR adapter could drop in.
//   2. applyCaptions — segments → a batch of protocol commands (a text track +
//      one styled text clip per segment, placed near the bottom). This half is
//      pure document editing: it goes through the SAME dispatch/undo path as
//      every other edit, so captions are normal, hand-editable text clips.
//
// The agent triggers the whole thing via the velocut_transcribe tool; the
// Toolbar's Auto Captions button runs the identical pipeline.

import type { Clip, Command, Envelope, VDocument } from '@velocut/protocol';

/** One timed caption line. Times are integer microseconds in the caller's clock. */
export interface CaptionSegment {
  startUs: number;
  endUs: number;
  text: string;
}

/** Audio (mono, 16 kHz Float32) → caption segments. Pluggable backend. */
export interface Transcriber {
  /** language: ISO-ish hint ('chinese' | 'english' | …); undefined = autodetect. */
  transcribe(pcm16kMono: Float32Array, opts?: { language?: string }): Promise<CaptionSegment[]>;
}

const WHISPER_RATE = 16000;

/** Down-mix interleaved planes to mono and linearly resample to 16 kHz —
 *  what Whisper expects. */
export function toMono16k(planes: Float32Array[], channels: number, sampleRate: number): Float32Array {
  const frames = planes[0]?.length ?? 0;
  // Down-mix to mono first (average channels).
  const mono = new Float32Array(frames);
  for (let c = 0; c < channels; c++) {
    const p = planes[Math.min(c, planes.length - 1)];
    for (let i = 0; i < frames; i++) mono[i] += p[i] / channels;
  }
  if (sampleRate === WHISPER_RATE) return mono;
  const ratio = sampleRate / WHISPER_RATE;
  const outLen = Math.max(1, Math.floor(frames / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    out[i] = mono[i0] * (1 - frac) + (mono[i0 + 1] ?? mono[i0]) * frac;
  }
  return out;
}

/** Minimal slice of MediaLibrary that transcribeAsset needs (avoids a cycle). */
export interface PcmSource {
  requestPcm(
    assetId: string,
    fromUs: number,
    durUs: number,
  ): Promise<{ startUs?: number; sampleRate: number; channels: number; frames: number; planes: Float32Array[] }>;
}

/** Transcribe a source range at its original speed, returning source-clock captions.
 * PCM reads use 30 s windows; the mono recognition buffer spans the selected range. */
export async function transcribeAsset(
  media: PcmSource,
  transcriber: Transcriber,
  assetId: string,
  durationUs: number,
  opts?: { fromUs?: number; language?: string; onProgress?: (frac: number, label: string) => void },
): Promise<CaptionSegment[]> {
  opts?.onProgress?.(0, 'Decoding audio');
  const WINDOW_US = 30_000_000;
  const fromUs = opts?.fromUs ?? 0;
  if (!Number.isFinite(fromUs) || fromUs < 0 || !Number.isFinite(durationUs) || durationUs <= 0)
    throw new Error('Transcription requires a positive duration and nonnegative source offset');
  const audio = new Float32Array(Math.ceil((durationUs / 1e6) * WHISPER_RATE));
  for (let off = 0; off < durationUs; off += WINDOW_US) {
    const dur = Math.min(WINDOW_US, durationUs - off);
    const pcm = await media.requestPcm(assetId, fromUs + off, dur);
    if (pcm.frames > 0) {
      // Address each sample by source time. AAC padding must not accumulate
      // across windows, and missing audio must not move later words earlier.
      const start = Math.round(off * WHISPER_RATE / 1e6);
      const end = Math.min(audio.length, Math.round((off + dur) * WHISPER_RATE / 1e6));
      for (let i = start; i < end; i++) {
        const pos = (fromUs + i * 1e6 / WHISPER_RATE - (pcm.startUs ?? fromUs + off)) * pcm.sampleRate / 1e6;
        if (pos < -pcm.sampleRate / 1e6 || pos >= pcm.frames) continue;
        const j = Math.max(0, Math.floor(pos)), frac = Math.max(0, pos) - j;
        for (let ch = 0; ch < pcm.channels; ch++) {
          const plane = pcm.planes[ch];
          audio[i] += (plane[j] * (1 - frac) + plane[Math.min(j + 1, pcm.frames - 1)] * frac) / pcm.channels;
        }
      }
    }
    opts?.onProgress?.(Math.min(0.3, (off / durationUs) * 0.3), 'Decoding audio');
  }
  opts?.onProgress?.(0.35, 'Transcribing (first run downloads the model)');
  const segments = await transcriber.transcribe(audio, { language: opts?.language });
  return segments.map(segment => ({ ...segment,
    startUs: segment.startUs + fromUs, endUs: segment.endUs + fromUs,
  }));
}

/** Intersect source captions with the used source range, then map to the timeline. */
export function mapCaptionsToClip(
  segments: CaptionSegment[], clip: Pick<Clip, 'startUs' | 'durationUs' | 'sourceInUs' | 'speed'>,
): CaptionSegment[] {
  if (!Number.isFinite(clip.speed) || clip.speed <= 0) throw new Error('Caption clip speed must be positive');
  const end = clip.sourceInUs + clip.durationUs * clip.speed;
  return sanitizeSegments(segments.map(segment => ({
    text: segment.text,
    startUs: clip.startUs + Math.round((Math.max(clip.sourceInUs, segment.startUs) - clip.sourceInUs) / clip.speed),
    endUs: clip.startUs + Math.round((Math.min(end, segment.endUs) - clip.sourceInUs) / clip.speed),
  })));
}

/** In-browser Whisper via transformers.js (WebGPU). The heavy library and the
 *  ONNX model load lazily on first use, then stay warm. */
export class WhisperTranscriber implements Transcriber {
  private pipe: Promise<unknown> | null = null;
  private model: string;
  constructor(model = 'onnx-community/whisper-base') {
    this.model = model;
  }

  private load(): Promise<unknown> {
    return (this.pipe ??= (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('automatic-speech-recognition', this.model, { device: 'webgpu' });
    })());
  }

  async transcribe(pcm16kMono: Float32Array, opts?: { language?: string }): Promise<CaptionSegment[]> {
    const pipe = (await this.load()) as (
      audio: Float32Array,
      cfg: Record<string, unknown>,
    ) => Promise<{ chunks?: Array<{ timestamp: [number, number | null]; text: string }>; text?: string }>;
    const out = await pipe(pcm16kMono, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: opts?.language,
      task: 'transcribe',
    });
    const chunks = out.chunks ?? [];
    const segs: CaptionSegment[] = [];
    for (const c of chunks) {
      const text = c.text.trim();
      if (!text) continue;
      const start = Math.round((c.timestamp[0] ?? 0) * 1e6);
      const end = Math.round((c.timestamp[1] ?? c.timestamp[0] + 2) * 1e6);
      segs.push({ startUs: start, endUs: end, text });
    }
    return segs;
  }
}

/** Sort, drop empties, and clamp each segment's end to the next start so no two
 *  caption clips overlap (the engine rejects overlap on a text track). */
export function sanitizeSegments(segments: CaptionSegment[]): CaptionSegment[] {
  const sorted = [...segments]
    .filter((s) => Number.isFinite(s.startUs) && Number.isFinite(s.endUs) && s.text.trim() && s.endUs > s.startUs)
    .sort((a, b) => a.startUs - b.startUs);
  const out: CaptionSegment[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const s = { ...sorted[i], startUs: Math.max(0, Math.round(sorted[i].startUs)) };
    const next = sorted[i + 1];
    s.endUs = Math.round(next ? Math.min(s.endUs, next.startUs) : s.endUs);
    if (s.endUs - s.startUs >= 50_000) out.push(s); // ≥ 50 ms
  }
  return out;
}

export interface CaptionStyle {
  fontSize?: number;
  color?: string;
  /** 0 = centre, 0.36 ≈ lower third. */
  bottomFraction?: number;
  trackName?: string;
}

/**
 * Turn segments into real text clips on a new text track, placed near the
 * bottom. Goes through `dispatch` so the whole thing is one coherent set of
 * undoable protocol edits — exactly what a hand-built caption track would be.
 * Returns the new trackId, or null if nothing usable was produced.
 */
export function applyCaptions(
  dispatch: (cmd: Command) => Envelope,
  doc: VDocument,
  segments: CaptionSegment[],
  style: CaptionStyle = {},
): { trackId: string; count: number } | null {
  const segs = sanitizeSegments(segments);
  if (!segs.length) return null;
  const fontSize = style.fontSize ?? Math.round(doc.height * 0.052);
  const color = style.color ?? '#ffffff';
  const yBottom = Math.round(doc.height * (style.bottomFraction ?? 0.36));

  const trackResp = dispatch({ type: 'addTrack', kind: 'text', name: style.trackName ?? 'Captions' });
  if (!trackResp.ok) return null;
  const trackId = trackResp.events.find((e) => e.kind === 'trackAdded')?.trackId;
  if (!trackId) return null;

  // One batch of addTextClip (atomic; minted ids come back in order).
  const clipResp = dispatch({
    type: 'batch',
    commands: segs.map((s) => ({
      type: 'addTextClip' as const,
      trackId,
      startUs: s.startUs,
      durationUs: s.endUs - s.startUs,
      text: { content: s.text, fontSize, color, align: 'center' },
    })),
  });
  if (!clipResp.ok) return null;
  const clipIds = clipResp.events.filter((e) => e.kind === 'clipAdded').map((e) => e.clipId);

  // Place every caption in the lower third (centre-origin px, +y is down).
  if (yBottom !== 0) {
    dispatch({
      type: 'batch',
      commands: clipIds.map((clipId) => ({
        type: 'setTransform' as const,
        clipId,
        transform: { x: 0, y: yBottom, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 },
      })),
    });
  }
  return { trackId, count: clipIds.length };
}
