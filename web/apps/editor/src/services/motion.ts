// services/motion.ts — the velocut.motionClip primitive (declarative).
//
// A motion clip is an agent-authored, deterministic 2D motion-graphics overlay
// described by a DECLARATIVE MotionSpec (render-sdk/motionspec.ts): a JSON scene
// graph of layers with keyframed transforms. This file is the glue: validate +
// compile the spec, store it IN THE DOCUMENT (Asset.spec — so undo/redo, the
// branching history board, multi-tab sync and persistence all carry it), attach
// the compiled per-frame rasterizer, and lay it on a Graphics track.
//
// The spec being data (not a closure) is what makes it persistable AND safe to
// author from the velocut_script sandbox — nothing is eval'd on the host.

import { compileMotionSpec, validateMotionSpec, type MotionSpec } from '@velocut/render-sdk';
import type { MediaLibrary } from '@velocut/render-sdk';
import { kvGet, kvDelete } from '@velocut/collab-sdk';
import type { Asset, Command } from '@velocut/protocol';
import { motionKey } from './projects';
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
 * agent's velocut_script `velocut.motionClip`.
 *
 * The whole creation (track if needed + asset with its spec + clip) dispatches
 * as ONE batch → one attributed history node; undo removes it atomically, and
 * the spec rides the document into history, collab sync and persistence.
 */
export async function createMotionClip(store: Store, media: MediaLibrary, opts: MotionClipOptions): Promise<MotionResult> {
  const spec = opts?.spec;
  const specErr = validateMotionSpec(spec);
  if (specErr) return { ok: false, message: specErr };

  const durationUs = Math.round(spec.durationUs);
  const atUs = Math.max(0, Math.round(opts.atUs ?? 0));
  const name = opts.name ?? 'Motion graphics';
  const width = Math.round(spec.width ?? store.getState().doc.width);
  const height = Math.round(spec.height ?? store.getState().doc.height);

  // Compile BEFORE dispatching: a spec that fails to compile (bad image URL,
  // font error) must not leave a half-created asset in the document.
  let compiled: Awaited<ReturnType<typeof attachSpec>> | null = null;
  try {
    const doc = store.getState().doc;
    compiled = compileMotionSpec(spec, { width: doc.width, height: doc.height, fps: doc.fpsNum / doc.fpsDen || 30 });
    await compiled.load();
  } catch (e) {
    return { ok: false, message: 'Motion compile/render error: ' + (e instanceof Error ? e.message : String(e)) };
  }

  // Ids are minted deterministically (use-then-increment on doc.nextId), and
  // dispatch is synchronous on this thread, so the batch can be assembled
  // against predicted ids — that is what lets creation be a single command.
  const doc = store.getState().doc;
  let nextId = doc.nextId;
  const commands: Command[] = [];
  let trackId = opts.trackId;
  if (!trackId) {
    const existing = doc.tracks.find((t) => t.kind === 'video' && t.name === 'Graphics');
    if (existing) trackId = existing.id;
    else {
      commands.push({ type: 'addTrack', kind: 'video', name: 'Graphics' });
      trackId = `track_${nextId++}`;
    }
  }
  const assetId = `asset_${nextId++}`;
  commands.push({
    type: 'addAsset',
    kind: 'image',
    src: `motion://${assetId}`,
    name,
    durationUs,
    width,
    height,
    spec: JSON.stringify(spec),
  });
  commands.push({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs });

  const resp = store.dispatch({ type: 'batch', commands });
  if (!resp.ok) return { ok: false, message: `Failed to create the motion clip: ${resp.error?.message ?? ''}` };
  const cEv = resp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;

  media.attachMotion(assetId, compiled.render, {
    width: compiled.width,
    height: compiled.height,
    frameDurUs: compiled.frameDurUs,
    frameCount: compiled.frameCount,
  });
  attachedSpecs.set(assetId, JSON.stringify(spec));
  return { ok: true, assetId, clipId, trackId, atUs, durationUs, frameCount: compiled.frameCount };
}

// ------------------------------------------------------------ spec syncing

/** assetId → the spec text the currently-attached compiled source was built
 *  from. A document change (edit, undo, branch jump, remote peer) that leaves
 *  a different spec on the asset triggers a recompile — one code path for
 *  every way a spec can change. */
const attachedSpecs = new Map<string, string>();

/** Ensure a motion asset's attached renderer matches its in-document spec.
 *  Cheap when nothing changed (one string compare). */
export async function syncMotionAsset(store: Store, media: MediaLibrary, asset: Asset): Promise<boolean> {
  const spec = asset.spec;
  if (spec == null) return false; // not yet migrated / genuinely missing
  if (attachedSpecs.get(asset.id) === spec && media.hasAsset(asset.id)) return true;
  let parsed: MotionSpec;
  try {
    parsed = JSON.parse(spec) as MotionSpec;
  } catch {
    return false;
  }
  if (validateMotionSpec(parsed)) return false;
  try {
    await attachSpec(store, media, asset.id, parsed);
    attachedSpecs.set(asset.id, spec);
    return true;
  } catch {
    return false;
  }
}

// ------------------------------------------------------- legacy migration

/** One-time app-level migration: fold pre-v2 motion specs (IndexedDB
 *  `motion:<project>:<assetId>`) into Asset.spec, then delete the kv keys.
 *  Runs at bootstrap after the collab restore; a single batch → one honest
 *  history node. Idempotent: folded assets have spec set and are skipped. */
export async function migrateLegacyMotionSpecs(store: Store): Promise<void> {
  const doc = store.getState().doc;
  const commands: Command[] = [];
  const foldedKeys: string[] = [];
  for (const a of doc.assets) {
    if (!a.src.startsWith('motion://') || a.spec != null) continue;
    const raw = await kvGet(motionKey(a.id)).catch(() => null);
    if (!raw) continue;
    const text = new TextDecoder().decode(raw);
    try {
      JSON.parse(text);
    } catch {
      continue; // corrupt legacy entry; leave the kv key for forensics
    }
    commands.push({ type: 'setAssetSpec', assetId: a.id, spec: text });
    foldedKeys.push(motionKey(a.id));
  }
  if (!commands.length) return;
  const resp = store.dispatch(
    commands.length === 1 ? commands[0] : { type: 'batch', commands },
  );
  if (!resp.ok) {
    console.warn('[velocut] legacy motion-spec migration failed:', resp.error);
    return;
  }
  for (const k of foldedKeys) await kvDelete(k).catch(() => {});
}
