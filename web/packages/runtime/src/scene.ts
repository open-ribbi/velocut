// services/scene.ts — the velocut.sceneClip primitive (declarative 3D scenes).
//
// Mirrors services/motion.ts exactly: validate + compile the SceneSpec,
// dispatch ONE batch (track if needed + asset carrying the spec + clip) → one
// attributed, atomically-undoable history node; attach the compiled per-frame
// renderer through the same procedural-source seam motion uses; and keep the
// attached renderer in sync with the in-document spec on every change (edit,
// undo, history jump, remote peer — one code path).

import {
  MAX_MODEL_BYTES,
  validateGlb,
  loadImportedModel,
  nextSceneId,
  type SceneModel,
  sceneObjects,
  normalizeSceneSpec,
  applySceneEdits,
  type SceneEdit,
  type SceneViewCamera,
  type SceneView,
  compileSceneSpec,
  validateSceneSpec,
  type SceneSpec,
  type CompiledScene,
} from '@velocut/scene-sdk';
import type { MediaLibrary } from '@velocut/render-sdk';
import { validateCommand, type Envelope, type VDocument } from '@velocut/protocol';
import type { Asset, Command } from '@velocut/protocol';
import { sceneResources, modelDigest, saveSceneModel } from './scene-resources';
import type { Store } from './store';

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

async function compileFor(
  store: Store,
  spec: SceneSpec,
  doc: VDocument = store.getState().doc,
): Promise<CompiledScene> {
  const compiled = compileSceneSpec(spec, {
    resources: sceneResources(store),
    assetBase: sceneState(store).assetBase,
    width: doc.width,
    height: doc.height,
    fps: doc.fpsNum / doc.fpsDen || 30,
  });
  try {
    await compiled.load();
    return compiled;
  } catch (e) {
    compiled.dispose();
    throw e;
  }
}

function attach(store: Store, media: MediaLibrary, assetId: string, compiled: CompiledScene): void {
  // Every attached scene holds a live WebGL context (browsers cap those at
  // ~8-16) — replacing a renderer without disposing the old one turns spec
  // iteration into "oldest context will be lost" black frames.
  sceneState(store).compiled.get(assetId)?.dispose();
  sceneState(store).compiled.set(assetId, compiled);
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
export async function createSceneClip(
  store: Store,
  media: MediaLibrary,
  opts: SceneClipOptions,
  dispatch: SceneDispatch = (cmd) => store.dispatch(cmd),
): Promise<SceneResult> {
  let spec = opts?.spec;
  const specErr = validateSceneSpec(spec);
  if (specErr) return { ok: false, message: specErr };
  spec = normalizeSceneSpec(spec);

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
    return {
      ok: false,
      message: 'Scene compile error: ' + (e instanceof Error ? e.message : String(e)),
    };
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

  const resp = dispatch({ type: 'batch', commands });
  if (!resp.ok) {
    compiled.dispose();
    return { ok: false, message: `Failed to create the scene clip: ${resp.error?.message ?? ''}` };
  }
  const cEv = resp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;

  attach(store, media, assetId, compiled);
  sceneState(store).specs.set(assetId, JSON.stringify(spec));
  return { ok: true, assetId, clipId, trackId, atUs, durationUs, frameCount: compiled.frameCount };
}

// ------------------------------------------------------------ spec syncing

/** assetId → spec text the attached renderer was compiled from (motion.ts
 *  pattern: recompile whenever the in-document spec differs). */
const states = new WeakMap<
  Store,
  { specs: Map<string, string>; compiled: Map<string, CompiledScene>; assetBase?: string }
>();
function sceneState(store: Store) {
  let state = states.get(store);
  if (!state) {
    state = { specs: new Map(), compiled: new Map() };
    states.set(store, state);
  }
  return state;
}
export function sceneAssetBase(store: Store): string | undefined {
  return sceneState(store).assetBase;
}
export function disposeSceneAuthoring(store: Store) {
  for (const compiled of sceneState(store).compiled.values()) compiled.dispose();
  states.delete(store);
  authoringMedia.delete(store);
}

/** assetId → the live compiled renderer, so replacement/removal can free its
 *  WebGL context instead of stranding it until GC. */

/** Guard raw setAssetSpec commands (velocut.apply / the script sandbox)
 *  BEFORE they reach the engine. The engine stores specs opaquely by design,
 *  and the UI validates its own edits — but a raw apply used to write an
 *  invalid spec straight into the document: the attached renderer silently
 *  kept showing the LAST good compile (so the author saw stale success), and
 *  the clip only collapsed to black on reload. Reject at the door with the
 *  validator's message so an agent can self-correct immediately. */
export function checkSpecCommand(
  store: Store,
  cmd: { type?: string; assetId?: string; spec?: unknown; commands?: unknown[] },
  validateMotion: (spec: unknown) => string | null,
): string | null {
  if (cmd?.type === 'batch' && Array.isArray(cmd.commands)) {
    for (const inner of cmd.commands) {
      const err = checkSpecCommand(store, inner as typeof cmd, validateMotion);
      if (err) return err;
    }
    return null;
  }
  if (cmd?.type !== 'setAssetSpec' || typeof cmd.spec !== 'string') return null;
  const asset = store.getState().doc.assets.find((a) => a.id === cmd.assetId);
  if (!asset) return null; // unknown asset → let the engine produce its own error
  let parsed: unknown;
  try {
    parsed = JSON.parse(cmd.spec);
  } catch {
    return null; // not JSON → the engine rejects it with its own message
  }
  if (asset.src.startsWith('scene://')) return validateSceneSpec(parsed);
  if (asset.src.startsWith('motion://')) return validateMotion(parsed);
  return null;
}

/** Free renderers whose asset left the document (undo of creation, deletion,
 *  a remote peer's removal). Called after every media restore sweep. */
export function pruneSceneRenderers(store: Store): void {
  const live = new Set(store.getState().doc.assets.map((a) => a.id));
  for (const [id, compiled] of sceneState(store).compiled) {
    if (live.has(id)) continue;
    compiled.dispose();
    sceneState(store).compiled.delete(id);
    sceneState(store).specs.delete(id);
  }
}

/** Ensure a scene asset's attached renderer matches its in-document spec. */
export async function syncSceneAsset(
  store: Store,
  media: MediaLibrary,
  asset: Asset,
): Promise<boolean> {
  const spec = asset.spec;
  if (spec == null) return false;
  if (sceneState(store).specs.get(asset.id) === spec && media.hasAsset(asset.id)) return true;
  let parsed: SceneSpec;
  try {
    parsed = JSON.parse(spec) as SceneSpec;
  } catch {
    return false;
  }
  if (validateSceneSpec(parsed)) return false;
  try {
    const compiled = await compileFor(store, parsed);
    if (store.getState().doc.assets.find((a) => a.id === asset.id)?.spec !== spec) {
      compiled.dispose();
      return false;
    }
    attach(store, media, asset.id, compiled);
    sceneState(store).specs.set(asset.id, spec);
    return true;
  } catch {
    return false;
  }
}

// A transport-independent seam. The UI resolves the media library registered
// at bootstrap; agent hosts can supply their attributed dispatch function.
const authoringMedia = new WeakMap<Store, MediaLibrary>();
export function bindSceneAuthoring(
  store: Store,
  media: MediaLibrary,
  options: { assetBase?: string } = {},
): void {
  authoringMedia.set(store, media);
  sceneState(store).assetBase = options.assetBase;
}
export interface SceneEditOptions {
  assetId: string;
  expectedRevision?: number;
  edits: SceneEdit[];
}
type SceneDispatch = (cmd: Command) => ReturnType<Store['dispatch']>;

function readScene(store: Store, assetId: string) {
  const { doc, revision } = store.getState();
  const asset = doc.assets.find((a) => a.id === assetId);
  if (!asset?.src.startsWith('scene://') || !asset.spec) throw new Error('scene asset not found');
  const spec = JSON.parse(asset.spec) as SceneSpec;
  const err = validateSceneSpec(spec);
  if (err) throw new Error(err);
  return { asset, spec: normalizeSceneSpec(spec), revision };
}

export async function replaceSceneSpec(
  store: Store,
  assetId: string,
  spec: SceneSpec,
  expectedRevision: number,
  dispatch: SceneDispatch = (cmd) => store.dispatch(cmd),
) {
  let compiled: CompiledScene | undefined;
  try {
    const media = authoringMedia.get(store);
    if (!media) throw new Error('scene authoring is not initialized');
    const before = readScene(store, assetId);
    if (before.revision !== expectedRevision)
      throw new Error('conflict: document changed; read the scene again');
    const error = validateSceneSpec(spec);
    if (error) throw new Error(error);
    const normalized = normalizeSceneSpec(spec);
    // Metadata changes need a timeline resize transaction, not an opaque spec edit.
    for (const k of ['durationUs', 'width', 'height', 'fps'] as const) {
      if (spec[k] !== before.spec[k]) throw new Error(`change ${k} by creating a new scene clip`);
    }
    const serialized = JSON.stringify(normalized);
    if (new TextEncoder().encode(serialized).length > 262144)
      throw new Error('scene spec exceeds 256 KiB');
    compiled = await compileFor(store, normalized);
    if (
      store.getState().revision !== expectedRevision ||
      store.getState().doc.assets.find((a) => a.id === assetId)?.spec !== before.asset.spec
    ) {
      throw new Error('conflict: document changed while compiling; read the scene again');
    }
    const r = dispatch({ type: 'setAssetSpec', assetId, spec: serialized });
    if (!r.ok) throw new Error(r.error.message);
    attach(store, media, assetId, compiled);
    sceneState(store).specs.set(assetId, serialized);
    compiled = undefined; // ownership transferred
    return {
      ok: true as const,
      assetId,
      revision: store.getState().revision,
      ready: true,
      spec: normalized,
    };
  } catch (e) {
    compiled?.dispose();
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

export async function editScene(store: Store, opts: SceneEditOptions, dispatch?: SceneDispatch) {
  try {
    const before = readScene(store, opts.assetId);
    const result = applySceneEdits(before.spec, opts.edits);
    const committed = await replaceSceneSpec(
      store,
      opts.assetId,
      result.spec,
      opts.expectedRevision ?? before.revision,
      dispatch,
    );
    return committed.ok ? { ...committed, changedIds: result.changedIds } : committed;
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Queries use their own compiler: a concurrent preview/export cannot change
 * the pose between inspection and capture. No document edits or uploads. */
export async function inspectScene(
  store: Store,
  opts: {
    assetId: string;
    timeS?: number;
    view?: SceneView;
    objectId?: string;
    camera?: SceneViewCamera;
  },
  capture = false,
) {
  let compiled: CompiledScene | undefined;
  try {
    const { spec, revision } = readScene(store, opts.assetId);
    const doc = store.getState().doc;
    const width = spec.width ?? doc.width,
      height = spec.height ?? doc.height;
    const factor = Math.min(1, 768 / Math.max(width, height));
    compiled = await compileFor(store, {
      ...spec,
      width: Math.max(16, Math.round(width * factor)),
      height: Math.max(16, Math.round(height * factor)),
    });
    const timeS = opts.timeS ?? 0;
    const objects = compiled.inspect(timeS);
    const blob = capture ? await compiled.capture(opts) : undefined;
    return { ok: true as const, assetId: opts.assetId, revision, timeS, spec, objects, blob };
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  } finally {
    compiled?.dispose();
  }
}

export interface SceneArrangeOptions {
  assetId: string;
  ids: string[];
  mode: 'ground' | 'on' | 'align';
  referenceId?: string;
  axis?: 'x' | 'y' | 'z';
  edge?: 'min' | 'max' | 'center';
  gap?: number;
  timeS?: number;
  expectedRevision?: number;
}

/** Placement uses evaluated world bounds, converts each displacement to its
 * parent's local coordinates, and translates the whole keyframe path. 'on'
 * centers X/Z and places the object's lower bound on the reference's top;
 * it is geometric bounding-box placement, not a collision/contact solver. */
export async function arrangeScene(
  store: Store,
  opts: SceneArrangeOptions,
  dispatch?: SceneDispatch,
) {
  try {
    if (
      !Array.isArray(opts.ids) ||
      !opts.ids.length ||
      opts.ids.length > 200 ||
      new Set(opts.ids).size !== opts.ids.length
    )
      throw new Error('ids must contain 1..200 unique object IDs');
    if (!['ground', 'on', 'align'].includes(opts.mode)) throw new Error('unknown arrange mode');
    if (opts.axis != null && !['x', 'y', 'z'].includes(opts.axis))
      throw new Error('unknown align axis');
    if (opts.edge != null && !['min', 'max', 'center'].includes(opts.edge))
      throw new Error('unknown align edge');
    const gap = opts.gap ?? 0;
    if (!Number.isFinite(gap)) throw new Error('gap must be finite meters');
    const r = await inspectScene(store, opts);
    if (!r.ok) return r;
    if (opts.expectedRevision != null && opts.expectedRevision !== r.revision)
      throw new Error('conflict: document changed; read the scene again');
    const targets = new Map(r.objects.map((o) => [o.id, o]));
    const reference = opts.referenceId ? targets.get(opts.referenceId) : undefined;
    if (opts.mode !== 'ground' && !reference?.bounds)
      throw new Error('on/align requires a referenceId with geometry');
    const moves = new Set(opts.ids);
    for (const id of [...opts.ids, ...(reference ? [reference.id] : [])]) {
      if (!targets.has(id)) throw new Error(`unknown object '${id}'`);
      let parent = targets.get(id)?.parentId;
      while (parent) {
        if (moves.has(id) && parent === reference?.id)
          throw new Error('reference includes a moving object; choose a separate support object');
        if (moves.has(parent))
          throw new Error(
            'cannot arrange an object together with its descendant or use its descendant as reference',
          );
        parent = targets.get(parent)?.parentId;
      }
    }
    if (reference && moves.has(reference.id)) throw new Error('reference must not be moved');
    const T = await import('three');
    const edits: SceneEdit[] = [];
    for (const id of opts.ids) {
      const object = targets.get(id)!;
      if (!object.bounds) throw new Error(`object '${id}' has no geometry`);
      const authored = sceneObjects(r.spec).find((e) => e.object.id === id)!.object;
      if ('physics' in authored && authored.physics && (opts.timeS ?? 0) !== 0)
        throw new Error('arrange physics props at timeS:0 to change their initial pose');
      const delta = new T.Vector3();
      if (opts.mode === 'align') {
        const axis = opts.axis ?? 'x',
          i = { x: 0, y: 1, z: 2 }[axis],
          edge = opts.edge ?? 'center';
        delta[axis] = reference!.bounds![edge][i] - object.bounds[edge][i] + gap;
      } else {
        delta.y =
          (opts.mode === 'ground' ? 0 : reference!.bounds!.max[1]) + gap - object.bounds.min[1];
        if (opts.mode === 'on') {
          delta.x = reference!.bounds!.center[0] - object.bounds.center[0];
          delta.z = reference!.bounds!.center[2] - object.bounds.center[2];
        }
      }
      const inverse = new T.Matrix4().fromArray(object.parentMatrix).invert();
      delta
        .applyMatrix4(inverse)
        .sub(new T.Vector3().applyMatrix4(inverse))
        .divideScalar(object.positionScale);
      const position = { ...authored.position };
      for (const axis of ['x', 'y', 'z'] as const) {
        if (Math.abs(delta[axis]) < 1e-9) continue;
        const fallback =
          object.kind === 'prop' && !('attachTo' in authored && authored.attachTo) && axis === 'y'
            ? 0.5
            : 0;
        const previous = position[axis] ?? fallback;
        position[axis] = Array.isArray(previous)
          ? previous.map((k) => ({ ...k, v: k.v + delta[axis] }))
          : previous + delta[axis];
      }
      edits.push({ type: 'update', id, patch: { position } });
    }
    return editScene(
      store,
      { assetId: opts.assetId, edits, expectedRevision: r.revision },
      dispatch,
    );
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

export interface SceneModelImportOptions {
  assetId: string;
  /** Local File for human imports; base64 for the JSON/script transport. */
  file?: File;
  base64?: string;
  name?: string;
  kind?: 'prop' | 'character';
  expectedRevision?: number;
}

export async function importSceneModel(
  store: Store,
  opts: SceneModelImportOptions,
  dispatch?: SceneDispatch,
) {
  try {
    const before = readScene(store, opts.assetId);
    const expected = opts.expectedRevision ?? before.revision;
    if (expected !== before.revision)
      throw new Error('conflict: document changed; read the scene again');
    if (opts.kind != null && opts.kind !== 'prop' && opts.kind !== 'character')
      throw new Error('import kind must be prop or character');
    let bytes: ArrayBuffer;
    if (opts.file instanceof File) {
      if (opts.file.size > MAX_MODEL_BYTES) throw new Error('GLB exceeds 64 MiB');
      bytes = await opts.file.arrayBuffer();
    } else {
      if (
        typeof opts.base64 !== 'string' ||
        opts.base64.length > Math.ceil(MAX_MODEL_BYTES / 3) * 4
      )
        throw new Error('provide a GLB file or base64 payload (up to 64 MiB)');
      const text = atob(opts.base64);
      const array = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) array[i] = text.charCodeAt(i);
      bytes = array.buffer;
    }
    validateGlb(bytes);
    const hash = await modelDigest(bytes);
    const src = await saveSceneModel(
      store,
      new File([bytes], `scene-model-${hash}.glb`, { type: 'model/gltf-binary' }),
    );
    const model = await loadImportedModel(src, sceneResources(store));
    const T = await import('three');
    model.scene.updateMatrixWorld(true);
    const bounds = new T.Box3().setFromObject(model.scene, true);
    const clips: SceneModel['clips'] = {};
    for (const clip of model.animations) {
      if (!clip.name || Object.hasOwn(clips, clip.name))
        throw new Error('GLB animation names must be non-empty and unique');
      Object.defineProperty(clips, clip.name, {
        value: { loop: true },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    const morphs = new Set<string>();
    const bones: Record<string, string> = {};
    model.scene.traverse((o) => {
      const mesh = o as import('three').Mesh;
      for (const name of Object.keys(mesh.morphTargetDictionary ?? {})) morphs.add(name);
      if ((o as import('three').Bone).isBone && /(^|[:_])head$/i.test(o.name)) bones.head = o.name;
    });
    const modelId = `model/${hash}`;
    const objectId = nextSceneId(before.spec, opts.kind === 'character' ? 'char' : 'prop');
    const label = opts.name ?? opts.file?.name ?? 'Imported model';
    (before.spec.models ??= {})[modelId] = {
      src,
      label,
      heightM: bounds.max.y - bounds.min.y,
      clips,
      bones,
      morphs: [...morphs],
    };
    if (opts.kind === 'character') {
      const first = Object.keys(clips)[0];
      (before.spec.characters ??= []).push({
        id: objectId,
        model: modelId,
        name: label,
        ...(first ? { actions: [{ clip: first, start: 0 }] } : {}),
      });
    } else
      (before.spec.props ??= []).push({
        id: objectId,
        model: modelId,
        name: label,
        position: { y: 0 },
      });
    const result = await replaceSceneSpec(store, opts.assetId, before.spec, expected, dispatch);
    return result.ok ? { ...result, modelId, objectId, clips: Object.keys(clips) } : result;
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

/** Preserve the legacy command API, including mixed batches, while ensuring
 * every scene changed by it compiles before a real document/history mutation. */
export function dispatchSceneAware(
  store: Store,
  cmd: Command,
  dispatch: SceneDispatch = (c) => store.dispatch(c),
): Envelope | Promise<Envelope> {
  const touchesScene = (c: Command): boolean => {
    if (c?.type === 'batch') return Array.isArray(c.commands) && c.commands.some(touchesScene);
    if (c?.type === 'addAsset') return typeof c.src === 'string' && c.src.startsWith('scene://');
    if (c?.type === 'setAssetSpec')
      return store
        .getState()
        .doc.assets.some((a) => a.id === c.assetId && a.src.startsWith('scene://'));
    return false;
  };
  if (!touchesScene(cmd)) return dispatch(cmd);
  return (async () => {
    const prepared: Array<{ asset: Asset; compiled: CompiledScene }> = [];
    try {
      const valid = validateCommand(cmd);
      if (!valid.ok)
        return { ok: false as const, error: { code: valid.code, message: valid.message } };
      const before = store.getState();
      const { TsEngine } = await import('@velocut/core-ts');
      const engine = new TsEngine();
      const loaded = engine.load(before.doc);
      if (!loaded.ok) return loaded;
      const simulated = engine.apply(cmd);
      if (!simulated.ok) return simulated;
      const candidate = engine.document();
      const media = authoringMedia.get(store);
      if (!media) throw new Error('scene authoring is not initialized');
      for (const asset of candidate.assets) {
        if (!asset.src.startsWith('scene://')) continue;
        const previous = before.doc.assets.find((a) => a.id === asset.id);
        if (previous?.spec === asset.spec && previous?.src === asset.src) continue;
        if (!asset.spec)
          throw new Error('scene assets require a spec; remove the asset to delete a scene');
        const spec = JSON.parse(asset.spec);
        const error = validateSceneSpec(spec);
        if (error) throw new Error(error);
        if (Math.round(spec.durationUs) !== asset.durationUs)
          throw new Error('scene duration must agree with its asset metadata');
        prepared.push({ asset, compiled: await compileFor(store, spec, candidate) });
      }
      if (store.getState().revision !== before.revision)
        throw new Error('conflict: document changed while compiling the batch');
      const result = dispatch(cmd);
      if (!result.ok) return result;
      for (const { asset, compiled } of prepared) {
        attach(store, media, asset.id, compiled);
        sceneState(store).specs.set(asset.id, asset.spec!);
      }
      prepared.length = 0;
      return result;
    } catch (e) {
      return {
        ok: false as const,
        error: { code: 'invalidScene', message: e instanceof Error ? e.message : String(e) },
      };
    } finally {
      for (const p of prepared) p.compiled.dispose();
    }
  })();
}

export interface SceneExportOptions {
  assetId: string;
  timeS?: number;
  objectIds?: string[];
  includeEnvironment?: boolean;
  includeCamera?: boolean;
  maxTextureSize?: number;
  expectedRevision?: number;
}
/** Read-only snapshot export; the revision identifies exactly what was exported. */
export async function exportSceneModel(
  store: Store,
  options: SceneExportOptions,
  signal?: AbortSignal,
) {
  try {
    const { spec, revision } = readScene(store, options.assetId);
    if (options.expectedRevision != null && options.expectedRevision !== revision)
      throw new Error('conflict: document revision changed before export');
    const { exportSceneGlb } = await import('@velocut/scene-sdk');
    const result = await exportSceneGlb(spec, {
      ...options,
      assetBase: sceneAssetBase(store),
      resources: sceneResources(store),
      signal,
    });
    return { ok: true as const, assetId: options.assetId, revision, ...result };
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
  }
}
