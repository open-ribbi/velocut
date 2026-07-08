// renderer-client.ts — main-thread facade for the worker-side compositor.
//
// A drop-in for the Renderer (same surface the preview consumers use) that owns
// a render.worker, transfers the preview canvas to it, and per frame gathers the
// source VideoFrames from the MediaLibrary and ships them across with the
// FrameGraph. The GPU pass + text rasterization happen in the worker; the main
// thread keeps only what MUST stay synchronous: the editor's text layout (caret
// geometry) — computed here against a local measuring context, the SAME math
// the worker rasterizes with, so the caret can't drift across the boundary.
//
// Frame gathering mirrors Renderer.layerSource: each asset layer's frame, plus
// each cross-clip transition's outgoing (`from`) frame. Frames are CLONED before
// transfer (a refcount bump — the MediaLibrary keeps its window frame) and the
// worker owns + closes the clones.

import type { FrameGraph, TextPayload, Transform } from '@velocut/protocol';
import type { MediaLibrary } from './media.ts';
import { computeInkRect, computeTextLayout, type InkRect, type TextLayout } from './textlayout.ts';
import type { AssetSize, ClientToRender, RenderToClient } from './render.worker.ts';

/** The preview renderer surface — implemented by both the worker-backed
 *  {@link RendererClient} (preview) and the concrete {@link Renderer} (export
 *  reuses the class directly). Consumers (Playback, PreviewPanel, FontLibrary)
 *  depend on this, not the concrete class, so the compositor can live on either
 *  thread. */
export interface PreviewRenderer {
  readonly version: number;
  readonly ready: boolean;
  init(canvas: HTMLCanvasElement): Promise<void>;
  render(fg: FrameGraph, media: MediaLibrary): void;
  registerFont(family: string, data: ArrayBuffer): Promise<void>;
  textLayout(text: TextPayload): TextLayout;
  measureText(text: TextPayload): { width: number; height: number };
  textInkRect(text: TextPayload): InkRect;
  setOverride(clipId: string, transform: Partial<Transform> | null): void;
  setTextOverride(clipId: string, text: TextPayload | null): void;
  resize(width: number, height: number): void;
  dispose(): void;
}

/** Bound on outstanding render messages: if the worker falls behind (slow GPU),
 *  drop frames instead of queuing unbounded work + VideoFrames. Realtime preview
 *  tolerates a dropped frame; a growing backlog of decoded frames it does not. */
const MAX_INFLIGHT = 2;

export class RendererClient implements PreviewRenderer {
  private worker: Worker | null = null;
  private initPromise: Promise<void> | null = null;
  private initCanvas: HTMLCanvasElement | null = null;
  /** Local measuring context for the editor's synchronous text layout. */
  private measureCtx: CanvasRenderingContext2D | null = null;
  /** Outstanding render messages (incremented on post, decremented on ack). */
  private inflight = 0;

  version = 0;
  ready = false;

  /** Transfer the canvas to a fresh render worker. Idempotent for the SAME
   *  canvas (React StrictMode mounts the preview twice on one singleton) —
   *  transferControlToOffscreen can only run once per canvas, so a repeat init
   *  returns the in-flight promise rather than re-transferring. */
  init(canvas: HTMLCanvasElement): Promise<void> {
    if (this.initPromise && this.initCanvas === canvas) return this.initPromise;
    this.initCanvas = canvas;
    this.initPromise = this.spawn(canvas);
    return this.initPromise;
  }

  private spawn(canvas: HTMLCanvasElement): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      this.worker = worker;
      worker.onmessage = (e: MessageEvent<RenderToClient>) => {
        const m = e.data;
        switch (m.type) {
          case 'ready':
            this.ready = true;
            resolve();
            break;
          case 'error':
            // Pre-ready errors fail init (→ the preview shows them); later ones
            // (a GPU hiccup mid-session) are logged, matching the main-thread
            // renderer's uncapturederror handler.
            if (!this.ready) reject(new Error(m.message));
            else console.error('[velocut][render-worker]', m.message);
            break;
          case 'rendered':
            this.inflight = Math.max(0, this.inflight - 1);
            break;
          case 'version':
            this.version = m.value;
            break;
        }
      };
      worker.onerror = (e) => {
        if (!this.ready) reject(new Error(e.message || 'render worker failed to start'));
      };
      const offscreen = canvas.transferControlToOffscreen();
      const msg: ClientToRender = { type: 'init', canvas: offscreen, width: canvas.width, height: canvas.height };
      worker.postMessage(msg, [offscreen]);
    });
  }

  render(fg: FrameGraph, media: MediaLibrary): void {
    const worker = this.worker;
    if (!worker || !this.ready) return;

    const clips: string[] = [];
    const frames: VideoFrame[] = [];
    const sizes: Record<string, AssetSize> = {};
    const take = (clipId: string, assetId: string, frame: VideoFrame | null) => {
      if (!frame) return;
      const size = media.assetSize(assetId);
      if (size) sizes[assetId] = size;
      clips.push(clipId);
      frames.push(frame.clone()); // refcount bump — the MediaLibrary keeps its frame
    };

    for (const layer of fg.layers) {
      // Text layers rasterize in the worker (from the payload) — no frame to ship.
      if (layer.assetId && !layer.text) {
        take(layer.clipId, layer.assetId, media.frameFor(layer.assetId, layer.sourceTimeUs));
      }
      const from = layer.transition?.from;
      if (from?.assetId) {
        const conflicting = from.assetId === layer.assetId;
        take(from.clipId, from.assetId, media.frameForFrom(from.assetId, from.sourceTimeUs, conflicting));
      }
    }

    // Worker is behind → drop this frame (release the clones we just took).
    if (this.inflight > MAX_INFLIGHT) {
      for (const f of frames) f.close();
      return;
    }
    this.inflight++;
    const msg: ClientToRender = { type: 'render', fg, sizes, clips, frames };
    worker.postMessage(msg, frames as unknown as Transferable[]);
  }

  /** Layout the editor uses for caret/selection — synchronous, on the main
   *  thread, against a local context. Matches the worker's raster because both
   *  run {@link computeTextLayout} with the same fonts loaded (see registerFont). */
  textLayout(text: TextPayload): TextLayout {
    this.measureCtx ??= document.createElement('canvas').getContext('2d')!;
    return computeTextLayout(text, this.measureCtx);
  }

  measureText(text: TextPayload): { width: number; height: number } {
    const l = this.textLayout(text);
    return { width: l.frameW, height: l.frameH };
  }

  /** Visible (ink) bounds within the raster frame — selection chrome only;
   *  hit-testing and caret math stay on the padded frame. */
  textInkRect(text: TextPayload): InkRect {
    this.measureCtx ??= document.createElement('canvas').getContext('2d')!;
    return computeInkRect(text, this.measureCtx);
  }

  /** Register a custom font on BOTH threads: the main thread so the editor's
   *  measureText (caret geometry) uses the real font, and the worker so its
   *  rasterizer does — otherwise one measures a fallback while the other draws
   *  the real glyphs and the caret drifts. */
  async registerFont(family: string, data: ArrayBuffer): Promise<void> {
    const face = new FontFace(family, data);
    await face.load();
    document.fonts.add(face);
    // No transfer: the worker gets a structured-clone copy of the bytes (font
    // files are small + this is one-time), leaving `data` intact.
    const msg: ClientToRender = { type: 'registerFont', family, data };
    this.worker?.postMessage(msg);
  }

  setOverride(clipId: string, transform: Partial<Transform> | null): void {
    const msg: ClientToRender = { type: 'override', clipId, transform };
    this.worker?.postMessage(msg);
  }

  setTextOverride(clipId: string, text: TextPayload | null): void {
    const msg: ClientToRender = { type: 'textOverride', clipId, text };
    this.worker?.postMessage(msg);
  }

  resize(width: number, height: number): void {
    const msg: ClientToRender = { type: 'resize', width, height };
    this.worker?.postMessage(msg);
  }

  dispose(): void {
    // Terminating reclaims the worker's GPU device + any held frames; the
    // explicit dispose message is unnecessary once the thread is gone.
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}
