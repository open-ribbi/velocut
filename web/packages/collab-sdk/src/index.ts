// @velocut/collab-sdk — local-first persistence & CRDT collaboration.
//
// What it owns: the Yjs mirror of the document (entity-granular merge),
// the BroadcastChannel realtime provider, IndexedDB document persistence,
// and the OPFS media store. The engine stays the single source of editing
// truth — this SDK only moves documents between sites and disk.

export { CollabSession, type CollabHost } from './collab';
export {
  saveMedia,
  loadMedia,
  kvGet,
  kvPut,
  saveFont,
  listFonts,
  loadFontData,
  type FontRecord,
} from './persistence';
