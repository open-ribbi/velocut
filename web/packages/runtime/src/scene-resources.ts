import { encodeGeometry, geometryHash, GEOMETRY_SOURCE, type SceneResources, type SceneSpec, type SceneGeometryResource } from '@velocut/scene-sdk';
import type { Store } from './store';

export interface SceneStorage {
  load(src: string): Promise<Blob | null>;
  save(file: File): Promise<string>;
}
const storage = new WeakMap<Store, SceneStorage>();
const resources = new WeakMap<Store, SceneResources>();
export function configureSceneStorage(store: Store, adapter: SceneStorage) {
  if (storage.has(store)) throw new Error('Scene storage is already bound; use a new Store for another project');
  storage.set(store, adapter);
  resources.delete(store);
}
function getStorage(store: Store) {
  const adapter = storage.get(store);
  if (!adapter)
    throw new Error('Configure project scene storage before importing or loading models and geometry');
  return adapter;
}
export async function modelDigest(data: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function saveSceneModel(store: Store, file: File) {
  return getStorage(store).save(file);
}
export function sceneResources(store: Store): SceneResources {
  let result = resources.get(store);
  if (!result) {
    result = {
      geometryBytes: async src => {
        if (!GEOMETRY_SOURCE.test(src)) throw new Error('invalid project geometry reference');
        const file = await getStorage(store).load(src);
        if (!file) throw new Error('geometry file is missing from this project');
        if (file.size > 512 * 1024) throw new Error('geometry resource exceeds byte budget');
        return file.arrayBuffer();
      },
      modelBytes: async (src) => {
        const match = /^opfs:\/\/scene-model-([a-f0-9]{64})\.glb$/.exec(src);
        if (!match) throw new Error('invalid project model reference');
        const file = await getStorage(store).load(src);
        if (!file) throw new Error(`model file is missing from this project: ${src}`);
        const bytes = await file.arrayBuffer();
        if ((await modelDigest(bytes)) !== match[1])
          throw new Error('model file content does not match its saved version');
        return bytes;
      },
    };
    resources.set(store, result);
  }
  return result;
}

/** Geometry files are immutable versions, intentionally retained for history.
 * A failed edit may leave an unreferenced file, never a half-committed document.
 * Dry runs use an ephemeral resolver and do not touch project storage. */
export async function externalizeSceneGeometry(store: Store, input: SceneSpec, persist: boolean) {
  const spec = structuredClone(input), pending = new Map<string, ArrayBuffer>();
  for (const [id, g] of Object.entries(spec.geometries ?? {})) {
    const bytes = encodeGeometry(g), hash = await geometryHash(bytes);
    const src = `opfs://scene-geometry-${hash}.vmesh`;
    const reference: SceneGeometryResource = {src, vertexCount:g.vertices.length, triangleCount:g.faces.length,
      hasUvs:!!g.uvs, byteLength:bytes.byteLength, ...(g.name == null ? {} : {name:g.name})};
    (spec.geometryResources ??= {})[id] = reference; pending.set(src,bytes);
  }
  delete spec.geometries;
  if (spec.geometryResources && !Object.keys(spec.geometryResources).length) delete spec.geometryResources;
  if (persist && pending.size) {
    const adapter = getStorage(store);
    for (const [src, bytes] of pending) {
      const old = await adapter.load(src);
      if (old) {
        if (old.size !== bytes.byteLength || await geometryHash(await old.arrayBuffer()) !== GEOMETRY_SOURCE.exec(src)![1]) throw new Error('saved geometry version is corrupt');
      } else {
        const saved = await adapter.save(new File([bytes],src.slice(7),{type:'application/octet-stream'}));
        if (saved !== src) throw new Error('geometry storage must preserve its content-addressed filename');
        const verified = await adapter.load(src);
        if (!verified || verified.size !== bytes.byteLength || await geometryHash(await verified.arrayBuffer()) !== GEOMETRY_SOURCE.exec(src)![1]) throw new Error('geometry storage did not preserve source bytes');
      }
    }
  }
  const base = sceneResources(store);
  return { spec, resources: persist ? base : { ...base, geometryBytes: async (src: string) => pending.get(src) ?? base.geometryBytes!(src) } };
}
