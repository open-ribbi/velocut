import type { Stage } from './stage.ts';

/** Geometric evidence for placement. Bounds are evaluated at the requested
 * pose; group bounds include descendants, empty groups have null bounds. */
export function inspectStage(stage: Stage) {
  const { three } = stage;
  stage.scene.updateMatrixWorld(true);
  return [
    ...stage.groups.map((e) => ({ ...e, kind: 'group' as const })),
    ...stage.characters.map((e) => ({ ...e, kind: 'character' as const })),
    ...stage.props.map((e) => ({ ...e, kind: 'prop' as const })),
    ...stage.lights.map((e) => ({ ...e, kind: 'light' as const })),
  ].map(({ kind, spec, root }) => {
    const bounds = new three.Box3().setFromObject(root, true);
    return {
      light: stage.lights.find((l) => l.spec.id === spec.id) ? { type: (spec as import('./types.ts').SceneLight).type, intensity: stage.lights.find((l) => l.spec.id === spec.id)!.light.intensity } : undefined,
      id: spec.id!, name: spec.name, kind, parentId: spec.parentId ?? ('attachTo' in spec ? spec.attachTo?.character : undefined),
      parentMatrix: root.parent?.matrixWorld.toArray() ?? new three.Matrix4().toArray(),
      positionScale: stage.props.find((p) => p.root === root)?.attachComp ?? 1,
      position: root.getWorldPosition(new three.Vector3()).toArray(),
      quaternion: root.getWorldQuaternion(new three.Quaternion()).toArray(),
      scale: root.getWorldScale(new three.Vector3()).toArray(),
      bounds: bounds.isEmpty() ? null : {
        min: bounds.min.toArray(), max: bounds.max.toArray(),
        size: bounds.getSize(new three.Vector3()).toArray(), center: bounds.getCenter(new three.Vector3()).toArray(),
      },
    };
  });
}

export interface SceneViewCamera {
  position: [number, number, number];
  target: [number, number, number];
  up?: [number, number, number];
  projection?: 'perspective' | 'orthographic';
  fov?: number;
  /** Orthographic vertical span, meters. */
  height?: number;
}
export function validateViewCamera(camera: SceneViewCamera): string | null {
  const vec = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
  if (!camera || typeof camera !== 'object' || !vec(camera.position) || !vec(camera.target)) return 'view camera needs finite position/target triples';
  if (camera.position.every((n,i) => n === camera.target[i])) return 'view camera position and target must differ';
  if (camera.up != null && (!vec(camera.up) || Math.hypot(...camera.up) < 1e-9)) return 'invalid view camera up vector';
  if (camera.projection != null && !['perspective', 'orthographic'].includes(camera.projection)) return 'invalid view projection';
  if (camera.fov != null && (!Number.isFinite(camera.fov) || camera.fov < 1 || camera.fov > 179)) return 'view fov must be 1..179 degrees';
  if (camera.height != null && (!Number.isFinite(camera.height) || camera.height <= 0 || camera.height > 1e6)) return 'view height must be positive meters';
  return null;
}

export type SceneView = 'shot' | 'front' | 'right' | 'top' | 'perspective';
export const SCENE_VIEWS: SceneView[] = ['shot', 'front', 'right', 'top', 'perspective'];


/** Shared framing for construction screenshots and the live Director. */
export function constructionCamera(stage: Stage, width: number, height: number, view: Exclude<SceneView, 'shot'>, objectId?: string, custom?: SceneViewCamera) {
  const T = stage.three;
  if (custom) {
    const error = validateViewCamera(custom); if (error) throw new Error(error);
    const target = new T.Vector3(...custom.target), position = new T.Vector3(...custom.position);
    const span = (custom.height ?? 5) / 2, aspect = width / height;
    const far = Math.max(500, position.distanceTo(target) * 10);
    const camera = custom.projection === 'orthographic' ? new T.OrthographicCamera(-span*aspect, span*aspect, span, -span, 0.01, far) :
      new T.PerspectiveCamera(custom.fov ?? 40, aspect, 0.01, far);
    if (custom.up) camera.up.set(...custom.up);
    camera.position.copy(position); camera.lookAt(target);
    return { camera, target };
  }
  const entries = [...stage.characters, ...stage.props, ...stage.groups, ...(objectId ? stage.lights : [])];
  const targets = objectId ? entries.filter((e) => e.spec.id === objectId) : entries;
  if (objectId && !targets.length) throw new Error(`unknown object '${objectId}'`);
  const bb = new T.Box3();
  stage.scene.updateMatrixWorld(true);
  for (const e of targets) {
    const bounds = new T.Box3().setFromObject(e.root, true);
    if (bounds.isEmpty() && objectId) { const point = e.root.getWorldPosition(new T.Vector3()); bounds.setFromCenterAndSize(point, new T.Vector3(1, 1, 1)); }
    bb.union(bounds);
  }
  if (bb.isEmpty()) bb.set(new T.Vector3(-1, 0, -1), new T.Vector3(1, 2, 1));
  const center = bb.getCenter(new T.Vector3());
  const radius = Math.max(0.1, bb.getSize(new T.Vector3()).length() / 2);
  const aspect = width / height, span = radius * 1.2;
  const direction = view === 'top' ? new T.Vector3(0, 1, 0) : view === 'right' ? new T.Vector3(1, 0, 0) :
    view === 'front' ? new T.Vector3(0, 0, 1) : new T.Vector3(1, 0.75, 1).normalize();
  const distance = radius * 4 / Math.min(1, aspect);
  const camera = view === 'perspective' ? new T.PerspectiveCamera(40, aspect, 0.01, distance + radius * 10) :
    new T.OrthographicCamera(-span * Math.max(1, aspect), span * Math.max(1, aspect), span / Math.min(1, aspect), -span / Math.min(1, aspect), 0.01, distance + radius * 10);
  if (view === 'top') camera.up.set(0, 0, -1);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.lookAt(center);
  return { camera, target: center };
}
