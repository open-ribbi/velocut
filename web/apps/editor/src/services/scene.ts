export * from '@velocut/runtime/scene';
import { bindSceneAuthoring as bind } from '@velocut/runtime/scene';
import { configureSceneStorage } from '@velocut/runtime/scene-resources';
import { loadMedia, saveMedia } from '@velocut/collab-sdk';
import { activeStorage } from './projects';
import type { Store } from '@velocut/runtime/store';
import type { MediaLibrary } from '@velocut/render-sdk';
export function bindSceneAuthoring(store: Store, media: MediaLibrary) {
  const { mediaDir } = activeStorage();
  configureSceneStorage(store, {
    load: (src) => loadMedia(src, mediaDir),
    save: (file) => saveMedia(file, mediaDir),
  });
  bind(store, media);
}
