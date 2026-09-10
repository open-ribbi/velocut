import type { SceneResources } from '@velocut/scene-sdk';
import type { Store } from './store';

export interface SceneStorage {
  load(src: string): Promise<Blob | null>;
  save(file: File): Promise<string>;
}
const storage = new WeakMap<Store, SceneStorage>();
const resources = new WeakMap<Store, SceneResources>();
export function configureSceneStorage(store: Store, adapter: SceneStorage) {
  storage.set(store, adapter);
  resources.delete(store);
}
function getStorage(store: Store) {
  const adapter = storage.get(store);
  if (!adapter)
    throw new Error('Configure project scene storage before importing or loading GLB models');
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
