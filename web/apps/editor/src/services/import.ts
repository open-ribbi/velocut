// services/import.ts — the single media-import path: file → OPFS bytes →
// probe → addAsset → attach to the media worker. Used by the Toolbar's
// Import button and by media pasted/dropped into the agent console (which
// then references the minted asset ids in the prompt).

import type { MediaLibrary } from '@velocut/render-sdk';
import { saveMedia } from '@velocut/collab-sdk';
import type { Store } from '../state/store';
import { activeStorage } from './projects';

export interface ImportedAsset {
  assetId: string;
  name: string;
  kind: 'video' | 'image' | 'audio';
}

/** Import media files into the project. Unsupported types are skipped;
 *  per-file failures are logged and skipped (one bad file doesn't abort the
 *  batch). Returns the assets that actually landed, in input order. */
export async function importMediaFiles(store: Store, media: MediaLibrary, files: File[]): Promise<ImportedAsset[]> {
  const imported: ImportedAsset[] = [];
  for (const file of files) {
    const isVideo = file.type.startsWith('video/');
    const isImage = file.type.startsWith('image/');
    const isAudio = file.type.startsWith('audio/');
    if (!isVideo && !isImage && !isAudio) continue;
    try {
      // Media bytes live in OPFS so projects survive reloads; the
      // document only stores the opfs:// locator.
      const src = await saveMedia(file, activeStorage().mediaDir).catch(() => `local://${file.name}`);
      if (isAudio) {
        const probe = await media.probeAudio(file);
        const resp = store.dispatch({
          type: 'addAsset',
          kind: 'audio',
          src,
          name: file.name,
          durationUs: probe.durationUs,
          width: 0,
          height: 0,
          hasAudio: true,
        });
        if (resp.ok) {
          const ev = resp.events.find((e) => e.kind === 'assetAdded');
          if (ev && ev.kind === 'assetAdded') {
            await media.attachAudio(ev.assetId, probe.buffer);
            imported.push({ assetId: ev.assetId, name: file.name, kind: 'audio' });
          }
        }
      } else if (isVideo) {
        // Probe first so the document gets complete metadata in ONE command.
        const source = await media.probeVideo(file);
        const p = source.probe();
        const resp = store.dispatch({
          type: 'addAsset',
          kind: 'video',
          src,
          name: file.name,
          durationUs: p.durationUs,
          width: p.width,
          height: p.height,
          hasAudio: p.hasAudio,
        });
        if (resp.ok) {
          const ev = resp.events.find((e) => e.kind === 'assetAdded');
          if (ev && ev.kind === 'assetAdded') {
            media.attachVideo(ev.assetId, source, file);
            // Preview proxy build is opt-in until it has resource guards — a
            // background 4K transcode can run a second hardware decoder
            // alongside the live preview's and exhaust the GPU (machine hang).
            if (localStorage.getItem('velocut.autoProxy') === '1') void media.buildProxy(ev.assetId);
            imported.push({ assetId: ev.assetId, name: file.name, kind: 'video' });
          }
        }
      } else {
        const frame = await media.probeImage(file);
        const resp = store.dispatch({
          type: 'addAsset',
          kind: 'image',
          src,
          name: file.name,
          durationUs: 0,
          width: frame.displayWidth,
          height: frame.displayHeight,
          hasAudio: false,
        });
        if (resp.ok) {
          const ev = resp.events.find((e) => e.kind === 'assetAdded');
          if (ev && ev.kind === 'assetAdded') {
            media.attachImage(ev.assetId, frame);
            imported.push({ assetId: ev.assetId, name: file.name, kind: 'image' });
          }
        }
      }
    } catch (err) {
      console.error('[velocut] import failed', err);
    }
  }
  return imported;
}
