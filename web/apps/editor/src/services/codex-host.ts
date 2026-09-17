import {modelConfiguration} from './declarative-models';
import { createProjectHost } from '@velocut/runtime/host';
import type { Store } from '@velocut/runtime/store';
import type { MediaLibrary, Observer, Playback } from '@velocut/render-sdk';
export function createCodexHost(
  store: Store,
  media: MediaLibrary,
  observer: Observer,
  project: { id: string; name: string },
  playback?: Playback,
) {
  const host=createProjectHost(store, media, observer, project, { name: 'Codex', peerPrefix: 'codex' }, playback);
  return {...host,execute:(...args:Parameters<typeof host.execute>)=>args[0]==='modelConfiguration'?modelConfiguration(args[1]):host.execute(...args)};
}
