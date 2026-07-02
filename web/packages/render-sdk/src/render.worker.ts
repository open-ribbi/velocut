// render.worker.ts — WebGPU preview compositing, off the main thread.
//
// The preview canvas's control is transferred here (transferControlToOffscreen),
// so the GPU pass — importExternalTexture + command encoding + submit, plus the
// 2D-canvas text rasterization — runs in this worker instead of competing with
// React, gestures, and GC on the main thread. The decode worker still feeds the
// main-thread MediaLibrary; RendererClient (main thread) gathers each frame's
// source VideoFrames and TRANSFERS clones here with the FrameGraph.
//
// This drives the very same Renderer the EXPORT path uses, in its "frameFor"
// mode (frames supplied by clipId, no MediaLibrary touch beyond asset sizes) —
// the battle-tested offline path, so the worker inherits its correctness. The
// export Renderer stays on the main thread untouched; only PREVIEW moved.

import { Renderer } from './renderer';
import type { MediaLibrary } from './media';
import type { FrameGraph, TextPayload, Transform } from '@velocut/protocol';

/** Asset pixel dimensions the renderer needs (proxy frames sample across the
 *  original-sized quad, so size ≠ the transferred frame's displayWidth). */
export interface AssetSize {
  width: number;
  height: number;
}

export type ClientToRender =
  | { type: 'init'; canvas: OffscreenCanvas; width: number; height: number }
  | {
      // One composited frame. `clips[i]` names the FrameGraph layer the
      // transferred `frames[i]` belongs to (top-level OR a transition's `from`
      // side); `sizes[assetId]` carries each asset's original dimensions.
      type: 'render';
      fg: FrameGraph;
      sizes: Record<string, AssetSize>;
      clips: string[];
      frames: VideoFrame[];
    }
  | { type: 'override'; clipId: string; transform: Partial<Transform> | null }
  | { type: 'textOverride'; clipId: string; text: TextPayload | null }
  | { type: 'registerFont'; family: string; data: ArrayBuffer }
  | { type: 'resize'; width: number; height: number }
  | { type: 'dispose' };

export type RenderToClient =
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'rendered' } // a render message was consumed (its frames are owned here now)
  | { type: 'version'; value: number }; // a paused-time invalidation (font/shader compiled)

const ctx = self as unknown as Worker;
const renderer = new Renderer();

// The renderer pulls asset sizes off a MediaLibrary; in frameFor mode that's the
// ONLY method it reaches for, so a stub backed by the per-render `sizes` map
// stands in for the real (main-thread) library.
let sizes: Record<string, AssetSize> = {};
const stubMedia = { assetSize: (id: string): AssetSize | null => sizes[id] ?? null } as unknown as MediaLibrary;

// The previous render's transferred frames, held one extra frame so the GPU has
// finished sampling them (importExternalTexture references the frame until the
// submit completes) before we close them. Closed when the next render arrives.
let pendingClose: VideoFrame[] = [];

// Push paused-time invalidations (a font/shader finishing compile produces no
// further render messages) back to the main thread so it repaints.
renderer.onInvalidate = () => ctx.postMessage({ type: 'version', value: renderer.version } satisfies RenderToClient);

ctx.onmessage = (e: MessageEvent<ClientToRender>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init': {
      msg.canvas.width = msg.width;
      msg.canvas.height = msg.height;
      renderer.init(msg.canvas).then(
        () => ctx.postMessage({ type: 'ready' } satisfies RenderToClient),
        (err: unknown) =>
          ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) } satisfies RenderToClient),
      );
      break;
    }
    case 'render': {
      // Free the previous batch — its GPU work completed during the frame gap.
      for (const f of pendingClose) f.close();
      pendingClose = msg.frames;
      sizes = msg.sizes;
      const map = new Map<string, VideoFrame>();
      msg.clips.forEach((clipId, i) => map.set(clipId, msg.frames[i]));
      try {
        renderer.render(msg.fg, stubMedia, (clipId) => map.get(clipId) ?? null);
      } catch (err) {
        ctx.postMessage({ type: 'error', message: String((err as Error)?.message ?? err) } satisfies RenderToClient);
      }
      ctx.postMessage({ type: 'rendered' } satisfies RenderToClient);
      break;
    }
    case 'override':
      renderer.setOverride(msg.clipId, msg.transform);
      break;
    case 'textOverride':
      renderer.setTextOverride(msg.clipId, msg.text);
      break;
    case 'registerFont':
      void renderer.registerFont(msg.family, msg.data).catch(() => {});
      break;
    case 'resize':
      renderer.resize(msg.width, msg.height);
      break;
    case 'dispose':
      for (const f of pendingClose) f.close();
      pendingClose = [];
      renderer.dispose();
      break;
  }
};
