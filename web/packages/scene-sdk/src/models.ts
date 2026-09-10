import type { SceneAssetManifest, SceneSpec } from './types.ts';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const MAX_MODEL_BYTES = 64 * 1024 * 1024;
export interface SceneResources {
  /** Resolve immutable, project-owned model bytes. Never fetch arbitrary URLs. */
  modelBytes(src: string): Promise<ArrayBuffer>;
}

/** Self-contained GLB 2 only. Reject missing/remote dependencies before a loader
 * runs, so a model is reproducible offline and cannot make incidental requests. */
export function validateGlb(data: ArrayBuffer): void {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 20 || data.byteLength > MAX_MODEL_BYTES) throw new Error('GLB must contain 20 bytes to 64 MiB');
  const view = new DataView(data);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== data.byteLength) throw new Error('expected a GLB 2 file with a valid length');
  const size = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a || size % 4 || size + 20 > data.byteLength) throw new Error('GLB is missing its JSON chunk');
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, size)));
  if (json.asset?.version !== '2.0') throw new Error('only glTF 2.0 models are supported');
  for (const entries of [json.buffers, json.images]) {
    if (entries != null && !Array.isArray(entries)) throw new Error('invalid GLB resource list');
    for (const entry of entries ?? []) {
      if (entry?.uri != null && (typeof entry.uri !== 'string' || !/^data:[^,]*;base64,/i.test(entry.uri))) throw new Error('GLB must embed all buffers and textures; external URIs are unsupported');
    }
  }
  for (const image of json.images ?? []) {
    if (image.mimeType != null && !['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(image.mimeType)) throw new Error('GLB textures must be PNG, JPEG, WebP or AVIF bitmaps');
    if (image.uri && !/^data:image\/(png|jpeg|webp|avif);base64,/i.test(image.uri)) throw new Error('GLB texture data URIs must contain PNG, JPEG, WebP or AVIF bitmaps');
  }
  if ((json.nodes?.length ?? 0) > 20000 || (json.meshes?.length ?? 0) > 2000) throw new Error('model exceeds the node/mesh budget');
  // Cycles or shared children turn a node tree into an ambiguous scene graph.
  const nodes = json.nodes ?? [];
  if (!Array.isArray(nodes)) throw new Error('invalid GLB nodes');
  const visiting = new Set<number>(), visited = new Map<number, number>(), parented = new Set<number>();
  const visit = (id: number, depth: number): number => {
    if (!Number.isInteger(id) || id < 0 || id >= nodes.length || depth > 128) throw new Error('invalid or excessively deep GLB node hierarchy');
    if (visiting.has(id)) throw new Error('GLB node hierarchy contains a cycle');
    if (visited.has(id)) return visited.get(id)!;
    visiting.add(id);
    const children = nodes[id]?.children ?? [];
    if (!Array.isArray(children)) throw new Error('invalid GLB children');
    let height = 1;
    for (const child of children) {
      if (parented.has(child)) throw new Error('GLB node has multiple parents');
      parented.add(child); height = Math.max(height, 1 + visit(child, depth + 1));
    }
    if (height > 128) throw new Error('GLB node hierarchy is excessively deep');
    visiting.delete(id); visited.set(id, height); return height;
  };
  for (let i = 0; i < nodes.length; i++) visit(i, 0);
  let offset = 20 + size;
  while (offset < data.byteLength) {
    if (offset + 8 > data.byteLength) throw new Error('truncated GLB chunk');
    const length = view.getUint32(offset, true);
    if (length % 4 || offset + 8 + length > data.byteLength) throw new Error('invalid GLB chunk length');
    offset += 8 + length;
  }
}

export async function parseSceneModel(data: ArrayBuffer): Promise<GLTF> {
  validateGlb(data);
  const [{ LoadingManager }, { GLTFLoader }] = await Promise.all([
    import('three'), import('three/examples/jsm/loaders/GLTFLoader.js'),
  ]);
  const manager = new LoadingManager();
  const failedResources: string[] = [];
  manager.onError = (url) => failedResources.push(url);
  manager.setURLModifier((url) => {
    if (!/^(data:|blob:)/i.test(url)) throw new Error('model dependencies must be embedded');
    return url;
  });
  const model = await new GLTFLoader(manager).parseAsync(data, '');
  if (failedResources.length) throw new Error('model contains a buffer or texture that could not be decoded');
  model.scene.updateMatrixWorld(true);
  let vertices = 0;
  model.scene.traverse((o) => {
    const mesh = o as import('three').Mesh;
    if (!o.matrixWorld.elements.every(Number.isFinite)) throw new Error('model contains an invalid transform');
    const position = mesh.geometry?.getAttribute('position');
    vertices += position?.count ?? 0;
    if (position) for (let i = 0; i < position.count; i++) {
      if (![position.getX(i), position.getY(i), position.getZ(i)].every(Number.isFinite)) throw new Error('model contains non-finite vertex positions');
    }
  });
  if (!vertices || vertices > 2_000_000) throw new Error('model needs visible geometry with at most 2 million vertices');
  for (const clip of model.animations) for (const track of clip.tracks) {
    if (!track.times.every(Number.isFinite) || !track.values.every(Number.isFinite)) throw new Error('model contains invalid animation values');
  }
  return model;
}

const caches = new WeakMap<SceneResources, Map<string, Promise<GLTF>>>();
export function loadImportedModel(src: string, resources?: SceneResources): Promise<GLTF> {
  if (!resources) return Promise.reject(new Error('imported model resource resolver is unavailable'));
  let cache = caches.get(resources);
  if (!cache) { cache = new Map(); caches.set(resources, cache); }
  let model = cache.get(src);
  if (!model) {
    model = resources.modelBytes(src).then(parseSceneModel);
    cache.set(src, model);
    model.catch(() => cache!.delete(src));
  }
  return model;
}


export function withImportedModels(manifest: SceneAssetManifest, spec: SceneSpec): SceneAssetManifest {
  const result = { ...manifest, characters: { ...manifest.characters }, props: { ...manifest.props } };
  for (const [id, model] of Object.entries(spec.models ?? {})) {
    result.characters[id] = { ...model, file: model.src, license: 'user imported' };
    result.props[id] = { label: model.label, license: 'user imported' };
  }
  return result;
}
