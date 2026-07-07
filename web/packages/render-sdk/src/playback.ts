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

/** What the transport needs from the app's store — any state container that
 *  fronts an ICoreEngine satisfies this. */
export interface TransportStore {
  getState(): { playing: boolean; playheadUs: TimeUs; durationUs: TimeUs; revision: number };
  seek(timeUs: TimeUs): void;
  setPlaying(playing: boolean): void;
  evaluate(timeUs: TimeUs): FrameGraph;
}

export class Playback {
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
        const audioT = this.audio?.clockUs();
        t = audioT ?? this.playStartUs + (performance.now() - this.playStartWall) * 1000;
        const end = Math.max(s.durationUs, 1);
        if (t >= end) {
          t = end;
          this.store.setPlaying(false);
          this.audio?.onPause();
        }
        this.store.seek(t);
      }
      this.media.setPlaying(s.playing);
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
        if (s.playing) this.audio?.update(fg, tInt);
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
    const atEnd = s.playheadUs >= s.durationUs && s.durationUs > 0;
    this.playStartUs = atEnd ? 0 : s.playheadUs;
    if (atEnd) this.store.seek(0);
    this.playStartWall = performance.now();
    this.store.setPlaying(true);
    this.audio?.onPlay(this.playStartUs);
  }

  pause() {
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
    this.running = false;
    this.audio?.onPause();
    cancelAnimationFrame(this.raf);
  }
}
