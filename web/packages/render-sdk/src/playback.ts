// playback.ts — the preview transport loop.
//
// Every animation frame: read the transport clock, evaluate(t) on the engine
// (cheap, pure), pull best-effort frames from the media layer, composite via
// WebGPU, and keep the audio engine scheduled ahead. While audio is active
// the AudioContext is the master clock (no drift against what you hear);
// otherwise the wall clock drives.

import type { FrameGraph, TimeUs } from '@velocut/protocol';
import type { MediaLibrary } from './media.ts';
import type { PreviewRenderer } from './renderer-client.ts';
import type { AudioEngine } from './audio.ts';
import { validatePreviewRate } from './preview-rate.ts';

export interface PreviewSessionOptions {
  rate?: number;
  playing?: boolean;
  timeUs?: number;
}

/** What the transport needs from the app's store — any state container that
 *  fronts an ICoreEngine satisfies this. */
export interface TransportStore {
  getState(): { playing: boolean; playheadUs: TimeUs; durationUs: TimeUs; revision: number };
  seek(timeUs: TimeUs): void;
  setPlaying(playing: boolean): void;
  evaluate(timeUs: TimeUs): FrameGraph;
}

export class Playback {
  private previewRate = 1;
  private audioDriving = false;
  private rateListeners = new Set<() => void>();
  get rate() { return this.previewRate; }
  subscribeRate = (listener: () => void) => {
    this.rateListeners.add(listener);
    return () => { this.rateListeners.delete(listener); };
  };

  private currentTime() {
    const s = this.store.getState();
    if (!s.playing) return s.playheadUs;
    const now = performance.now();
    let audioT = this.audio?.clockUs() ?? null;
    if (audioT !== null && !this.audioDriving) {
      // Autoplay may delay AudioContext.resume(). Join the wall clock when
      // audio becomes available, instead of jumping back to the old anchor.
      this.audio!.onSeek(this.playStartUs + (now - this.playStartWall) * 1000 * this.rate);
      audioT = this.audio!.clockUs();
    }
    if (audioT !== null && (!this.audioDriving || audioT !== this.playStartUs)) {
      // Keep the fallback anchored at the last audio progress, not at the
      // eventual stall-detection time or a possibly stale rendered playhead.
      // Frozen reads must not keep moving this wall-clock anchor forward.
      this.playStartUs = audioT;
      this.playStartWall = now;
    }
    this.audioDriving = audioT !== null;
    const t = audioT ?? this.playStartUs + (now - this.playStartWall) * 1000 * this.rate;
    return Math.min(Math.max(0, t), Math.max(0, s.durationUs));
  }

  setRate(rate: number) {
    validatePreviewRate(rate);
    if (rate === this.rate) return;
    // Sample the OLD clock before replacing its slope. Speed changes never seek.
    const at = this.currentTime();
    this.previewRate = rate;
    if (this.store.getState().playing) {
      this.store.seek(at);
      this.playStartUs = at;
      this.playStartWall = performance.now();
      this.audio?.onPlay(at, rate);
      this.audioDriving = this.audio?.clockUs() != null;
    }
    this.rateListeners.forEach(fn => fn());
  }

  /** UI/agent transport controls. Validate the whole request before any effect. */
  session(opts?: PreviewSessionOptions) {
    try {
      if (opts !== undefined) {
        if (!opts || typeof opts !== 'object' || Array.isArray(opts) || Object.keys(opts).some(k => !['rate', 'playing', 'timeUs'].includes(k)))
          throw new Error('preview options must contain only rate, playing, timeUs');
        if (opts.rate !== undefined) validatePreviewRate(opts.rate);
        if (opts.playing !== undefined && typeof opts.playing !== 'boolean') throw new Error('playing must be boolean');
        if (opts.timeUs !== undefined && (!Number.isFinite(opts.timeUs) || opts.timeUs < 0 || opts.timeUs > this.store.getState().durationUs))
          throw new Error('timeUs outside project duration');
        if (opts.rate !== undefined) this.setRate(opts.rate);
        if (opts.timeUs !== undefined) this.seek(opts.timeUs);
        if (opts.playing === true) this.play();
        if (opts.playing === false) this.pause();
      }
      const s = this.store.getState();
      return { ok: true as const, state: { rate: this.rate, playing: s.playing, timeUs: Math.round(this.currentTime()), durationUs: s.durationUs } };
    } catch (error) {
      return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
    }
  }
  private raf = 0;
  private playStartWall = 0; // performance.now() when play began
  private playStartUs = 0; // playhead at that moment
  private running = false;
  // Dirty tracking: skip evaluate+render while paused and nothing changed.
  private lastT = -1;
  private lastRevision = -1;
  private lastMediaVersion = -1;
  private lastRendererVersion = -1;
  private invalidated = false;

  constructor(
    private store: TransportStore,
    private media: MediaLibrary,
    private renderer: PreviewRenderer,
    private audio: AudioEngine | null = null,
  ) {}

  /** Force the next frame to re-evaluate + repaint (ghost overlays etc.). */
  invalidate() {
    this.invalidated = true;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      const s = this.store.getState();
      let t = s.playheadUs;
      if (s.playing) {
        // Audio is the master clock while it runs — what you hear is true.
        t = this.currentTime();
        const end = Math.max(s.durationUs, 0);
        if (t >= end) {
          t = end;
          this.store.setPlaying(false);
          this.audio?.onPause();
        }
        this.store.seek(t);
      }
      const playing = this.store.getState().playing;
      this.media.setPlaying(playing);
      // Paused with no document edits and no new decoded frames → the canvas
      // already shows this exact composite; skip the evaluate (engine JSON
      // round-trip) and the GPU pass entirely.
      const tInt = Math.round(t);
      const dirty =
        s.playing ||
        this.invalidated ||
        tInt !== this.lastT ||
        s.revision !== this.lastRevision ||
        this.media.version !== this.lastMediaVersion ||
        this.renderer.version !== this.lastRendererVersion;
      if (dirty) {
        this.invalidated = false;
        const fg = this.store.evaluate(tInt);
        try {
          this.renderer.render(fg, this.media);
        } catch (e) {
          // One bad frame (e.g. a detached VideoFrame) must not kill the
          // transport loop — the next edit/seek re-marks dirty and retries.
          console.error('[velocut] render tick failed', e);
        }
        if (playing) this.audio?.update(fg, tInt);
        this.lastT = tInt;
        this.lastRevision = s.revision;
        this.lastMediaVersion = this.media.version;
        this.lastRendererVersion = this.renderer.version;
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  play() {
    const s = this.store.getState();
    if (s.playing) return;
    const atEnd = s.playheadUs >= s.durationUs && s.durationUs > 0;
    this.playStartUs = atEnd ? 0 : s.playheadUs;
    if (atEnd) this.store.seek(0);
    this.playStartWall = performance.now();
    this.store.setPlaying(true);
    this.audio?.onPlay(this.playStartUs, this.rate);
    this.audioDriving = this.audio?.clockUs() != null;
  }

  pause() {
    if (this.store.getState().playing) this.store.seek(this.currentTime());
    this.store.setPlaying(false);
    this.audio?.onPause();
  }

  toggle() {
    if (this.store.getState().playing) this.pause();
    else this.play();
  }

  /** Seek during playback re-anchors both clocks. */
  seek(timeUs: TimeUs) {
    this.store.seek(timeUs);
    const s = this.store.getState();
    if (s.playing) {
      this.playStartUs = timeUs;
      this.playStartWall = performance.now();
      this.audio?.onSeek(timeUs);
    }
  }

  stop() {
    this.pause();
    this.running = false;
    cancelAnimationFrame(this.raf);
  }
}
