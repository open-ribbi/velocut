// services/motion.ts — the velocut.motionClip primitive (declarative).
//
// A motion clip is an agent-authored, deterministic 2D motion-graphics overlay
// described by a DECLARATIVE MotionSpec (render-sdk/motionspec.ts): a JSON scene
// graph of layers with keyframed transforms. This file is the glue: validate +
// compile the spec, PERSIST it (so the clip survives reload / export — the spec
// is stored, not the frames), attach the compiled per-frame rasterizer, and lay
// it on a Graphics track. Mirrors services/tts.ts (generate → addAsset +
// addClip) and services/caption.ts.
//
// The spec being data (not a closure) is what makes it persistable AND safe to
// author from the velocut_script sandbox — nothing is eval'd on the host.

import { compileMotionSpec, validateMotionSpec, type MotionSpec } from '@velocut/render-sdk';
import type { MediaLibrary } from '@velocut/render-sdk';
import { kvGet, kvPut } from '@velocut/collab-sdk';
import type { Store } from '../state/store';

export type { MotionSpec } from '@velocut/render-sdk';

export interface MotionResult {
  ok: boolean;
  assetId?: string;
  clipId?: string;
  trackId?: string;
  atUs?: number;
  durationUs?: number;
  frameCount?: number;
  message?: string;
}

/** Options a caller passes alongside the spec (placement + naming). */
export interface MotionClipOptions {
  spec: MotionSpec;
  atUs?: number;
  trackId?: string;
  name?: string;
}

const specKey = (assetId: string) => `motion:${assetId}`;

/** Persist a motion spec keyed by assetId (IndexedDB, like fonts). */
async function saveSpec(assetId: string, spec: MotionSpec): Promise<void> {
  await kvPut(specKey(assetId), new TextEncoder().encode(JSON.stringify(spec)));
}

/** Read a persisted motion spec back, or null if absent/corrupt. */
async function loadSpec(assetId: string): Promise<MotionSpec | null> {
  const raw = await kvGet(specKey(assetId));
  if (!raw) return null;
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as MotionSpec;
  } catch {
    return null;
  }
}

/** Compile a spec against the doc defaults and attach it as a motion source. */
async function attachSpec(store: Store, media: MediaLibrary, assetId: string, spec: MotionSpec) {
  const doc = store.getState().doc;
  const compiled = compileMotionSpec(spec, {
    width: doc.width,
    height: doc.height,
    fps: doc.fpsNum / doc.fpsDen || 30,
  });
  await compiled.load();
  media.attachMotion(assetId, compiled.render, {
    width: compiled.width,
    height: compiled.height,
    frameDurUs: compiled.frameDurUs,
    frameCount: compiled.frameCount,
  });
  return compiled;
}

/**
 * Create a procedural motion-graphics clip from a declarative spec and lay it on
 * a Graphics video track. Same surface as window.velocut.motionClip and the
 * agent's velocut_script `velocut.motionClip`. The spec is persisted, so the clip
 * re-renders deterministically after reload and on export.
 */
export async function createMotionClip(store: Store, media: MediaLibrary, opts: MotionClipOptions): Promise<MotionResult> {
  const spec = opts?.spec;
  const specErr = validateMotionSpec(spec);
  if (specErr) return { ok: false, message: specErr };

  const durationUs = Math.round(spec.durationUs);

  // Resolve the graphics track (reuse a video track named Graphics, else create one —
  // appended last so overlays composite on top).
  let trackId = opts.trackId;
  if (!trackId) {
    const existing = store.getState().doc.tracks.find((t) => t.kind === 'video' && t.name === 'Graphics');
    if (existing) trackId = existing.id;
    else {
      const r = store.dispatch({ type: 'addTrack', kind: 'video', name: 'Graphics' });
      const ev = r.ok ? r.events.find((e) => e.kind === 'trackAdded') : undefined;
      trackId = ev?.kind === 'trackAdded' ? ev.trackId : undefined;
    }
  }
  if (!trackId) return { ok: false, message: 'Failed to create the graphics track.' };

  const atUs = Math.max(0, Math.round(opts.atUs ?? 0));
  const name = opts.name ?? 'Motion graphics';
  const width = Math.round(spec.width ?? store.getState().doc.width);
  const height = Math.round(spec.height ?? store.getState().doc.height);

  // Key the asset by its own id (src=motion://<assetId>) so restore reads the
  // right spec; the human-readable name lives in the asset's name field.
  const aResp = store.dispatch({ type: 'addAsset', kind: 'image', src: 'motion://pending', name, durationUs, width, height });
  const aEv = aResp.ok ? aResp.events.find((e) => e.kind === 'assetAdded') : undefined;
  const assetId = aEv?.kind === 'assetAdded' ? aEv.assetId : undefined;
  if (!assetId) return { ok: false, message: 'Failed to register the graphics asset.' };

  // Persist first, then attach (so a reload before attach still finds the spec).
  let frameCount: number | undefined;
  try {
    await saveSpec(assetId, spec);
    frameCount = (await attachSpec(store, media, assetId, spec)).frameCount;
  } catch (e) {
    return { ok: false, message: 'Motion compile/render error: ' + (e instanceof Error ? e.message : String(e)) };
  }

  const cResp = store.dispatch({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs });
  if (!cResp.ok) return { ok: false, message: `Failed to place the clip on the track: ${cResp.error?.message ?? ''}` };
  const cEv = cResp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;
  return { ok: true, assetId, clipId, trackId, atUs, durationUs, frameCount };
}

/** Re-attach a motion asset after reload by reading its persisted spec. Returns
 *  true if restored. Called from restoreMedia for motion:// assets. */
export async function restoreMotionClip(store: Store, media: MediaLibrary, assetId: string): Promise<boolean> {
  const spec = await loadSpec(assetId);
  if (!spec || validateMotionSpec(spec)) return false;
  try {
    await attachSpec(store, media, assetId, spec);
    return true;
  } catch {
    return false;
  }
}
