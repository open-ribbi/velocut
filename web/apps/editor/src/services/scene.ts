import { configureMediaResources } from '@velocut/runtime';
import { probeMediaFile } from '@velocut/render-sdk';
export * from '@velocut/runtime/scene';
import { bindSceneAuthoring as bind } from '@velocut/runtime/scene';
import { configureSceneStorage } from '@velocut/runtime/scene-resources';
import { loadMedia, saveMedia, removeMedia } from '@velocut/collab-sdk';
import { activeStorage } from './projects';
import type { Store } from '@velocut/runtime/store';
import type { MediaLibrary } from '@velocut/render-sdk';
export function bindSceneAuthoring(store: Store, media: MediaLibrary) {
  const { mediaDir } = activeStorage();
  configureSceneStorage(store, {
    load: (src) => loadMedia(src, mediaDir),
    save: (file) => saveMedia(file, mediaDir),
  });
  configureMediaResources(store, {
    storage: {
      write: async (name, data) => { await saveMedia(new File([data], name, { type: data.type }), mediaDir); },
      read: name => loadMedia(`opfs://${name}`, mediaDir),
      remove: name => removeMedia(`opfs://${name}`, mediaDir),
    },
    probe: (file, signal) => probeMediaFile(media, file, signal),
  });
  bind(store, media);
}
