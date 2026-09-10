// Ephemeral workspace state, shared by UI and agent. Camera navigation does
// not alter SceneSpec or create undo entries; authored camera edits still do.
import {
  validateViewCamera,
  type SceneViewCamera,
  normalizeSceneSpec,
  sceneObjects,
  SCENE_VIEWS,
  type SceneView,
} from '@velocut/scene-sdk';
import type { Store } from './store';

export interface DirectorSession {
  assetId: string;
  objectId: string | null;
  timeS: number;
  playing: boolean;
  view: SceneView;
  mode: 'translate' | 'rotate' | 'scale';
  focusId: string | null;
  viewRevision: number;
  camera?: SceneViewCamera;
}
export interface DirectorSessionOptions {
  assetId?: string;
  open?: boolean;
  objectId?: string | null;
  timeS?: number;
  playing?: boolean;
  view?: SceneView;
  mode?: DirectorSession['mode'];
  /** Frame this object/group, null frames the whole scene. */
  focusId?: string | null;
  camera?: SceneViewCamera | null;
}
const controllers = new WeakMap<Store, ReturnType<typeof createController>>();
function createController(store: Store) {
  let state: DirectorSession | null = null;
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((fn) => fn());
  let observedSpec: string | undefined;
  store.subscribe(() => {
    if (!state) return;
    const asset = store.getState().doc.assets.find((a) => a.id === state!.assetId);
    if (!asset?.spec) {
      state = null;
      notify();
      return;
    }
    if (asset.spec === observedSpec) return;
    observedSpec = asset.spec;
    try {
      const spec = normalizeSceneSpec(JSON.parse(asset.spec));
      const ids = new Set(sceneObjects(spec).map((e) => e.object.id));
      const objectId = state.objectId && ids.has(state.objectId) ? state.objectId : null;
      const focusId = state.focusId && ids.has(state.focusId) ? state.focusId : null;
      const timeS = Math.min(state.timeS, spec.durationUs / 1e6);
      state = {
        ...state,
        objectId,
        focusId,
        timeS,
        playing: state.playing && timeS < spec.durationUs / 1e6,
        viewRevision: state.viewRevision + (focusId !== state.focusId ? 1 : 0),
      };
      notify();
    } catch {
      state = null;
      notify();
    }
  });
  const update = (opts: DirectorSessionOptions) => {
    try {
      if (!opts || typeof opts !== 'object' || Array.isArray(opts))
        throw new Error('director options must be an object');
      if (
        Object.keys(opts).some(
          (k) =>
            ![
              'assetId',
              'open',
              'objectId',
              'timeS',
              'playing',
              'view',
              'mode',
              'focusId',
              'camera',
            ].includes(k),
        )
      )
        throw new Error('unknown director option');
      if (opts.open === false) {
        state = null;
        notify();
        return { ok: true as const, state };
      }
      const assetId = opts.assetId ?? state?.assetId;
      const asset = store.getState().doc.assets.find((a) => a.id === assetId);
      if (!asset?.src.startsWith('scene://') || !asset.spec)
        throw new Error('director requires a scene assetId');
      const spec = normalizeSceneSpec(JSON.parse(asset.spec));
      observedSpec = asset.spec;
      const fresh = !state || state.assetId !== asset.id;
      const current: DirectorSession = fresh
        ? {
            assetId: asset.id,
            objectId: null,
            timeS: 0,
            playing: false,
            view: 'perspective',
            mode: 'translate',
            focusId: null,
            viewRevision: 0,
          }
        : state!;
      const next = { ...current };
      for (const k of ['objectId', 'focusId'] as const) {
        if (opts[k] !== undefined) {
          if (opts[k] !== null && !sceneObjects(spec).some((e) => e.object.id === opts[k]))
            throw new Error(`unknown object '${opts[k]}'`);
          next[k] = opts[k]!;
        }
      }
      if (opts.timeS !== undefined) {
        if (!Number.isFinite(opts.timeS) || opts.timeS < 0 || opts.timeS > spec.durationUs / 1e6)
          throw new Error('timeS outside scene duration');
        next.timeS = opts.timeS;
      }
      if (opts.playing !== undefined) {
        if (typeof opts.playing !== 'boolean') throw new Error('playing must be boolean');
        next.playing = opts.playing;
      }
      if (opts.view !== undefined) {
        if (!SCENE_VIEWS.includes(opts.view)) throw new Error('unknown director view');
        next.view = opts.view;
      }
      if (opts.mode !== undefined) {
        if (!['translate', 'rotate', 'scale'].includes(opts.mode))
          throw new Error('unknown gizmo mode');
        next.mode = opts.mode;
      }
      if (opts.view !== undefined || opts.focusId !== undefined) delete next.camera;
      if (opts.camera != null) {
        const err = validateViewCamera(opts.camera);
        if (err) throw new Error(err);
        if (opts.view === 'shot') throw new Error('custom camera cannot override shot view');
        next.camera = structuredClone(opts.camera);
        if (opts.view === undefined) next.view = 'perspective';
      } else if (opts.camera === null) delete next.camera;
      if (opts.view !== undefined || opts.focusId !== undefined || opts.camera !== undefined)
        next.viewRevision++;
      state = next;
      notify();
      return { ok: true as const, state };
    } catch (e) {
      return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    getSnapshot: () => state,
    update,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
export function directorController(store: Store) {
  let controller = controllers.get(store);
  if (!controller) {
    controller = createController(store);
    controllers.set(store, controller);
  }
  return controller;
}
export function directorSession(store: Store, opts?: DirectorSessionOptions) {
  const controller = directorController(store);
  return opts ? controller.update(opts) : { ok: true as const, state: controller.getSnapshot() };
}
