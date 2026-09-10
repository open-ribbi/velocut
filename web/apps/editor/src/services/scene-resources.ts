import { loadMedia } from '@velocut/collab-sdk';
import type { SceneResources } from '@velocut/scene-sdk';
import type { Store } from '../state/store';
import { activeStorage } from './projects';

const resources = new WeakMap<Store, SceneResources>();
export async function modelDigest(data: ArrayBuffer): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...hash].map((v) => v.toString(16).padStart(2, '0')).join('');
}
export function sceneResources(store: Store): SceneResources {
  let result = resources.get(store);
  if (!result) {
    const dir = activeStorage().mediaDir;
    result = { modelBytes: async (src) => {
      const match = /^opfs:\/\/scene-model-([a-f0-9]{64})\.glb$/.exec(src);
      if (!match) throw new Error('invalid project model reference');
      const file = await loadMedia(src, dir);
      if (!file) throw new Error(`model file is missing from this project: ${src}`);
      const bytes = await file.arrayBuffer();
      if (await modelDigest(bytes) !== match[1]) throw new Error('model file content does not match its saved version');
      return bytes;
    } };
    resources.set(store, result);
  }
  return result;
}
