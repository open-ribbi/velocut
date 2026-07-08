// services/scene.ts — the velocut.sceneClip primitive (declarative 3D scenes).
//
// Mirrors services/motion.ts exactly: validate + compile the SceneSpec,
// dispatch ONE batch (track if needed + asset carrying the spec + clip) → one
// attributed, atomically-undoable history node; attach the compiled per-frame
// renderer through the same procedural-source seam motion uses; and keep the
// attached renderer in sync with the in-document spec on every change (edit,
// undo, history jump, remote peer — one code path).

import { compileSceneSpec, validateSceneSpec, type SceneSpec, type CompiledScene } from '@velocut/scene-sdk';
import type { MediaLibrary } from '@velocut/render-sdk';
import type { Asset, Command } from '@velocut/protocol';
import type { Store } from '../state/store';

export type { SceneSpec } from '@velocut/scene-sdk';

export interface SceneResult {
  ok: boolean;
  assetId?: string;
  clipId?: string;
  trackId?: string;
  atUs?: number;
  durationUs?: number;
  frameCount?: number;
  message?: string;
}

export interface SceneClipOptions {
  spec: SceneSpec;
  atUs?: number;
  trackId?: string;
  name?: string;
}

async function compileFor(store: Store, spec: SceneSpec): Promise<CompiledScene> {
  const doc = store.getState().doc;
  const compiled = compileSceneSpec(spec, {
    width: doc.width,
    height: doc.height,
    fps: doc.fpsNum / doc.fpsDen || 30,
  });
  await compiled.load();
  return compiled;
}

function attach(media: MediaLibrary, assetId: string, compiled: CompiledScene): void {
  // Every attached scene holds a live WebGL context (browsers cap those at
  // ~8-16) — replacing a renderer without disposing the old one turns spec
  // iteration into "oldest context will be lost" black frames.
  attachedCompiled.get(assetId)?.dispose();
  attachedCompiled.set(assetId, compiled);
  // The motion-source seam is shape-generic (render(index) → VideoFrame);
  // scenes ride it unchanged.
  media.attachMotion(assetId, compiled.render, {
    width: compiled.width,
    height: compiled.height,
    frameDurUs: compiled.frameDurUs,
    frameCount: compiled.frameCount,
  });
}

/**
 * Create a 3D scene clip from a declarative spec and lay it on a Scenes video
 * track. Same surface as window.velocut.sceneClip and the agent's
 * velocut_script `velocut.sceneClip`.
 */
export async function createSceneClip(store: Store, media: MediaLibrary, opts: SceneClipOptions): Promise<SceneResult> {
  const spec = opts?.spec;
  const specErr = validateSceneSpec(spec);
  if (specErr) return { ok: false, message: specErr };

  const durationUs = Math.round(spec.durationUs);
  const atUs = Math.max(0, Math.round(opts.atUs ?? 0));
  const name = opts.name ?? '3D scene';
  const width = Math.round(spec.width ?? store.getState().doc.width);
  const height = Math.round(spec.height ?? store.getState().doc.height);

  // Compile BEFORE dispatching so a failing spec leaves no document residue.
  let compiled: CompiledScene;
  try {
    compiled = await compileFor(store, spec);
  } catch (e) {
    return { ok: false, message: 'Scene compile error: ' + (e instanceof Error ? e.message : String(e)) };
  }

  // Predict engine-minted ids (use-then-increment; dispatch is synchronous on
  // this thread) so creation is a single atomic batch — see motion.ts.
  const doc = store.getState().doc;
  let nextId = doc.nextId;
  const commands: Command[] = [];
  let trackId = opts.trackId;
  if (!trackId) {
    const existing = doc.tracks.find((t) => t.kind === 'video' && t.name === 'Scenes');
    if (existing) trackId = existing.id;
    else {
      commands.push({ type: 'addTrack', kind: 'video', name: 'Scenes' });
      trackId = `track_${nextId++}`;
    }
  }
  const assetId = `asset_${nextId++}`;
  commands.push({
    type: 'addAsset',
    kind: 'image',
    src: `scene://${assetId}`,
    name,
    durationUs,
    width,
    height,
    spec: JSON.stringify(spec),
  });
  commands.push({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs });

  const resp = store.dispatch({ type: 'batch', commands });
  if (!resp.ok) {
    compiled.dispose();
    return { ok: false, message: `Failed to create the scene clip: ${resp.error?.message ?? ''}` };
  }
  const cEv = resp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;

  attach(media, assetId, compiled);
  attachedSpecs.set(assetId, JSON.stringify(spec));
  return { ok: true, assetId, clipId, trackId, atUs, durationUs, frameCount: compiled.frameCount };
}

// ------------------------------------------------------------ spec syncing

/** assetId → spec text the attached renderer was compiled from (motion.ts
 *  pattern: recompile whenever the in-document spec differs). */
const attachedSpecs = new Map<string, string>();

/** assetId → the live compiled renderer, so replacement/removal can free its
 *  WebGL context instead of stranding it until GC. */
const attachedCompiled = new Map<string, CompiledScene>();

/** Free renderers whose asset left the document (undo of creation, deletion,
 *  a remote peer's removal). Called after every media restore sweep. */
export function pruneSceneRenderers(store: Store): void {
  const live = new Set(store.getState().doc.assets.map((a) => a.id));
  for (const [id, compiled] of attachedCompiled) {
    if (live.has(id)) continue;
    compiled.dispose();
    attachedCompiled.delete(id);
    attachedSpecs.delete(id);
  }
}

/** Ensure a scene asset's attached renderer matches its in-document spec. */
export async function syncSceneAsset(store: Store, media: MediaLibrary, asset: Asset): Promise<boolean> {
  const spec = asset.spec;
  if (spec == null) return false;
  if (attachedSpecs.get(asset.id) === spec && media.hasAsset(asset.id)) return true;
  let parsed: SceneSpec;
  try {
    parsed = JSON.parse(spec) as SceneSpec;
  } catch {
    return false;
  }
  if (validateSceneSpec(parsed)) return false;
  try {
    const compiled = await compileFor(store, parsed);
    attach(media, asset.id, compiled);
    attachedSpecs.set(asset.id, spec);
    return true;
  } catch {
    return false;
  }
}
