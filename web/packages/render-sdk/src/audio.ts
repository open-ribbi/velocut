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
// Constant-rate varispeed changes pitch and tempo together, matching export.
// Per-slice gain comes from the engine, including volume keyframes.

import type { FrameGraph, TimeUs } from '@velocut/protocol';
import type { MediaLibrary } from './media.ts';
import { validatePreviewRate } from './preview-rate.ts';

/** Keep this much audio scheduled ahead of the playhead. */
const AHEAD_US = 1_200_000;
/** One decode request covers this much source time. */
const CHUNK_US = 500_000;
/** Allow ordinary render quanta/jitter before treating a stopped device as lost. */
const CLOCK_STALL_MS = 250;

interface SliceChannel {
  gain: GainNode;
  assetId: string;
  speed: number;
  sourceOffsetUs: number;
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
  private rate = 1;
  private clockStarted = false;
  private clockStalled = false;
  private lastClockSec = 0;
  private lastClockWall = 0;
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
    const now = performance.now(), seconds = this.ctx.currentTime;
    if (this.ctx.state === 'running' && seconds > this.lastClockSec) {
      this.lastClockSec = seconds;
      this.lastClockWall = now;
      this.clockStarted = true;
      this.clockStalled = false;
    }
    // A device can stop advancing even while reporting "running". Give up
    // the master clock until fresh progress is observed, and discard queued
    // PCM so recovery cannot play audio from before the interruption.
    if (this.clockStarted && (this.ctx.state !== 'running' || now - this.lastClockWall >= CLOCK_STALL_MS)) {
      this.clockStarted = false;
      this.clockStalled = true;
      this.generation++;
      this.teardown();
    }
    if (!this.clockStarted || this.ctx.state !== 'running') return null;
    return this.anchorTlUs + (seconds - this.anchorCtxSec) * 1e6 * this.rate;
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

  onPlay(timelineUs: TimeUs, rate = 1) {
    validatePreviewRate(rate);
    const ctx = this.ensureContext();
    void ctx.resume();
    this.teardown();
    this.rate = rate;
    this.playing = true;
    this.anchorTlUs = timelineUs;
    this.anchorCtxSec = ctx.currentTime;
    this.clockStarted = false;
    this.clockStalled = false;
    this.lastClockSec = ctx.currentTime;
    this.lastClockWall = performance.now();
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
    // Initial scheduling may start an output device. After a confirmed clock
    // interruption, wait for clockUs()/Playback to observe progress and rejoin.
    if (this.clockStalled || this.ctx.state !== 'running') return;
    const active = new Set<string>();
    for (const slice of fg.audio ?? []) {
      if (!Number.isFinite(slice.speed) || slice.speed <= 0 || slice.gain <= 0) continue;
      active.add(slice.clipId);
      let ch = this.channels.get(slice.clipId);
      const sourceOffsetUs = slice.sourceTimeUs - playheadUs * slice.speed;
      if (ch && (ch.assetId !== slice.assetId || ch.speed !== slice.speed || Math.abs(ch.sourceOffsetUs - sourceOffsetUs) > 2)) {
        for (const source of ch.sources) { try { source.stop(); } catch {} }
        ch.gain.disconnect();
        this.channels.delete(slice.clipId);
        ch = undefined;
      }
      if (!ch) {
        const gain = this.ctx.createGain();
        gain.connect(this.master);
        ch = { gain, assetId: slice.assetId, speed: slice.speed, sourceOffsetUs, scheduledUntilTl: playheadUs, fetching: false, failed: false, sources: new Set() };
        this.channels.set(slice.clipId, ch);
      }
      ch.gain.gain.value = slice.gain;
      if (!ch.failed && !ch.fetching && ch.scheduledUntilTl < playheadUs + AHEAD_US * this.rate) {
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
    slice: { sourceTimeUs: number; speed: number },
    playheadUs: number,
  ) {
    const ctx = this.ctx!;
    const gen = this.generation;
    ch.fetching = true;
    const tlFrom = Math.max(ch.scheduledUntilTl, playheadUs);
    const speed = slice.speed;
    const srcFrom = slice.sourceTimeUs + (tlFrom - playheadUs) * speed;
    const chunkUs = Math.min(CHUNK_US * this.rate, 1_000_000 / speed);
    this.media.requestPcm(assetId, srcFrom, chunkUs * speed).then(
      (pcm) => {
        ch.fetching = false;
        if (gen !== this.generation || this.channels.get(clipId) !== ch) return;
        if (pcm.frames === 0) {
          ch.scheduledUntilTl = tlFrom + chunkUs;
          return;
        }
        const buffer = ctx.createBuffer(pcm.channels, pcm.frames, pcm.sampleRate);
        for (let c = 0; c < pcm.channels; c++) buffer.copyToChannel(pcm.planes[c], c);
        // Decoder windows can include AAC padding on both sides. Schedule only
        // the requested range; otherwise adjacent chunks replay the same samples.
        const sourceStart = Math.max(srcFrom, pcm.startUs);
        const sourceEnd = Math.min(srcFrom + chunkUs * speed, pcm.startUs + buffer.duration * 1e6);
        const tlStart = tlFrom + (sourceStart - srcFrom) / speed;
        const when = this.anchorCtxSec + (tlStart - this.anchorTlUs) / 1e6 / this.rate;
        const now = ctx.currentTime;
        const offset = (sourceStart - pcm.startUs) / 1e6 + Math.max(0, now - when) * this.rate * speed;
        const duration = (sourceEnd - pcm.startUs) / 1e6 - offset;
        ch.scheduledUntilTl = tlFrom + chunkUs;
        if (duration <= 0) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this.rate * speed;
        source.connect(ch.gain);
        source.start(Math.max(now, when), offset, duration);
        ch.sources.add(source);
        source.onended = () => ch.sources.delete(source);
      },
      () => {
        if (gen !== this.generation || this.channels.get(clipId) !== ch) return;
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
