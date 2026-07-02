// audio.ts — preview audio engine.
//
// Consumes the FrameGraph's AudioSlice[] (the same evaluated output the
// compositor consumes — no timeline knowledge here) and keeps each active
// slice scheduled ~1.2s ahead as AudioBufferSourceNodes on the AudioContext
// clock. PCM windows are decoded on demand in the media worker (lazy
// byte-range reads → AudioDecoder) and transferred over.
//
// While playing, the AudioContext is the MASTER clock (clockUs) — video
// frames chase what you hear, so A/V can't drift. Scheduling is
// sample-accurate; pause/seek tears all sources down and re-anchors.
//
// v1 scope: slices at speed 1 (speed-changed clips are muted — pitch-correct
// varispeed is an export-path feature), per-slice gain, additive mixing.

import type { FrameGraph, TimeUs } from '@velocut/protocol';
import type { MediaLibrary } from './media';

/** Keep this much audio scheduled ahead of the playhead. */
const AHEAD_US = 1_200_000;
/** One decode request covers this much source time. */
const CHUNK_US = 500_000;

interface SliceChannel {
  gain: GainNode;
  /** Timeline time scheduled up to (µs). */
  scheduledUntilTl: number;
  fetching: boolean;
  failed: boolean;
  sources: Set<AudioBufferSourceNode>;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private channels = new Map<string, SliceChannel>(); // key: clipId
  private playing = false;
  private anchorTlUs = 0;
  private anchorCtxSec = 0;
  /** Bumped on pause/seek — in-flight PCM for an old anchor is discarded. */
  private generation = 0;

  constructor(private media: MediaLibrary) {}

  /** AudioContext can only start from a user gesture — play() qualifies. */
  private ensureContext(): AudioContext {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.master.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  /** Master-clock readout while playing; null when audio isn't driving. */
  clockUs(): number | null {
    if (!this.playing || !this.ctx) return null;
    return this.anchorTlUs + (this.ctx.currentTime - this.anchorCtxSec) * 1e6;
  }

  /** RMS of the current output — diagnostics ("is sound actually playing"). */
  rms(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  onPlay(timelineUs: TimeUs) {
    const ctx = this.ensureContext();
    void ctx.resume();
    this.playing = true;
    this.anchorTlUs = timelineUs;
    this.anchorCtxSec = ctx.currentTime;
    this.generation++;
  }

  onPause() {
    this.playing = false;
    this.generation++;
    this.teardown();
  }

  onSeek(timelineUs: TimeUs) {
    if (!this.playing || !this.ctx) return;
    this.generation++;
    this.teardown();
    this.anchorTlUs = timelineUs;
    this.anchorCtxSec = this.ctx.currentTime;
  }

  private teardown() {
    for (const ch of this.channels.values()) {
      for (const s of ch.sources) {
        try {
          s.stop();
        } catch {
          /* already ended */
        }
      }
      ch.gain.disconnect();
    }
    this.channels.clear();
  }

  /** Called by the transport every rendered frame while playing. */
  update(fg: FrameGraph, playheadUs: TimeUs) {
    if (!this.playing || !this.ctx || !this.master) return;
    const active = new Set<string>();
    for (const slice of fg.audio ?? []) {
      // Varispeed audio is out of scope for the preview mixer (v1).
      if (slice.speed !== 1 || slice.gain <= 0) continue;
      active.add(slice.clipId);
      let ch = this.channels.get(slice.clipId);
      if (!ch) {
        const gain = this.ctx.createGain();
        gain.connect(this.master);
        ch = { gain, scheduledUntilTl: playheadUs, fetching: false, failed: false, sources: new Set() };
        this.channels.set(slice.clipId, ch);
      }
      ch.gain.gain.value = slice.gain;
      if (!ch.failed && !ch.fetching && ch.scheduledUntilTl < playheadUs + AHEAD_US) {
        this.fetchChunk(slice.clipId, slice.assetId, ch, slice, playheadUs);
      }
    }
    // Clip ended (or was edited away): cut its tail immediately.
    for (const [clipId, ch] of this.channels) {
      if (!active.has(clipId)) {
        for (const s of ch.sources) {
          try {
            s.stop();
          } catch {
            /* already ended */
          }
        }
        ch.gain.disconnect();
        this.channels.delete(clipId);
      }
    }
  }

  private fetchChunk(
    clipId: string,
    assetId: string,
    ch: SliceChannel,
    slice: { sourceTimeUs: number },
    playheadUs: number,
  ) {
    const ctx = this.ctx!;
    const gen = this.generation;
    ch.fetching = true;
    const tlFrom = Math.max(ch.scheduledUntilTl, playheadUs);
    // speed === 1 → source time advances 1:1 with timeline time.
    const srcFrom = slice.sourceTimeUs + (tlFrom - playheadUs);
    this.media.requestPcm(assetId, srcFrom, CHUNK_US).then(
      (pcm) => {
        ch.fetching = false;
        if (gen !== this.generation || !this.channels.has(clipId)) return;
        if (pcm.frames === 0) {
          ch.scheduledUntilTl = tlFrom + CHUNK_US;
          return;
        }
        const buffer = ctx.createBuffer(pcm.channels, pcm.frames, pcm.sampleRate);
        for (let c = 0; c < pcm.channels; c++) buffer.copyToChannel(pcm.planes[c], c);
        // The decoded window starts at an AAC frame boundary ≤ srcFrom; map
        // it back to timeline time and let start(when, offset) align.
        const tlStart = tlFrom + (pcm.startUs - srcFrom);
        const when = this.anchorCtxSec + (tlStart - this.anchorTlUs) / 1e6;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ch.gain);
        const now = ctx.currentTime;
        if (when >= now) source.start(when);
        else source.start(now, Math.min(now - when, buffer.duration));
        ch.sources.add(source);
        source.onended = () => ch.sources.delete(source);
        ch.scheduledUntilTl = tlStart + (pcm.frames / pcm.sampleRate) * 1e6;
      },
      () => {
        // Unsupported audio codec or decode failure — mute this clip, once.
        ch.fetching = false;
        ch.failed = true;
      },
    );
  }

  dispose() {
    this.onPause();
    void this.ctx?.close();
    this.ctx = null;
  }
}
