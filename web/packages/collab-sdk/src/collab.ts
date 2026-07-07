// collab.ts — CRDT document sync + local-first persistence.
//
// The architecture doc reserved this seam: the engine's command stream and
// revision counter are already a fact log, so collaboration wraps the
// document rather than rewriting the engine. A Y.Doc mirrors the VDocument
// at entity granularity (one Y.Map entry per track / per asset) — peers
// editing DIFFERENT tracks merge without conflict; same-entity edits are
// last-writer-wins.
//
//   local command → engine applies → revision bumps → diff doc into Y.Doc
//   Y update      → BroadcastChannel (same-origin tabs) + IndexedDB persist
//   remote update → rebuild VDocument from Y → engine.load()
//
// The transport is a BroadcastChannel ("server-less" multi-tab realtime);
// swapping in y-websocket later is a provider change, not a model change.

import * as Y from 'yjs';
import type { Track, Asset, VDocument } from '@velocut/protocol';
import { CURRENT_FORMAT_VERSION, migrateDocument } from '@velocut/protocol';
import { kvGet, kvPut } from './persistence';

export interface CollabHost {
  getState(): { doc: VDocument; revision: number };
  subscribe(fn: () => void): () => void;
  loadDocument(doc: VDocument): void;
}

const LOCAL = 'velocut-local';
const REMOTE = 'velocut-remote';

export class CollabSession {
  private ydoc = new Y.Doc();
  private tracks: Y.Map<string>;
  private assets: Y.Map<string>;
  private meta: Y.Map<string | number>;
  private bc: BroadcastChannel;
  private presence: BroadcastChannel;
  private unsubscribe: (() => void) | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private applyingRemote = false;
  private peerSeen = new Map<string, number>();
  private peerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly siteId = Math.random().toString(36).slice(2, 10);

  /** Live peer-tab count (incl. self). */
  peers = 1;
  onPeersChange: ((n: number) => void) | null = null;

  constructor(
    private host: CollabHost,
    room = 'velocut-default',
    /** IndexedDB key for the persisted Y update — one per project. */
    private storageKey = 'ydoc',
  ) {
    this.tracks = this.ydoc.getMap('tracks');
    this.assets = this.ydoc.getMap('assets');
    this.meta = this.ydoc.getMap('meta');
    this.bc = new BroadcastChannel(`velocut-y-${room}`);
    this.presence = new BroadcastChannel(`velocut-presence-${room}`);
  }

  /** Restore persisted state (if any), then begin syncing. */
  async start(): Promise<void> {
    const saved = await kvGet(this.storageKey);
    if (saved && saved.byteLength > 0) {
      Y.applyUpdate(this.ydoc, saved, REMOTE);
      const doc = this.rebuildDocument();
      if (doc) {
        // Version-guard the persisted document before it reaches the engine. A
        // migrated doc is re-stamped at the current version on the next push; a
        // FUTURE-version doc is refused and we bail WITHOUT wiring the persist
        // observers, so the newer project on disk is never clobbered by our
        // (older) empty fallback.
        const stored = this.meta.get('formatVersion') as number | undefined;
        const res = migrateDocument(doc, stored);
        if (!res.ok) {
          console.error(
            `[velocut] Failed to load the saved project: ${res.reason === 'future' ? `format comes from a newer app version (v${res.version})` : res.message}. Disk data was preserved; this session starts with a blank project.`,
          );
          return;
        }
        this.applyingRemote = true;
        try {
          this.host.loadDocument(res.doc);
        } finally {
          this.applyingRemote = false;
        }
      }
    } else {
      // First run — seed Y from the engine's current (empty) document.
      this.pushLocal();
    }

    // Local edits → Y.
    this.unsubscribe = this.host.subscribe(() => {
      if (!this.applyingRemote) this.pushLocal();
    });

    // Y updates → broadcast + persist.
    this.ydoc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOCAL) this.bc.postMessage(update);
      this.scheduleSave();
    });

    // Remote updates → Y → engine.
    this.bc.onmessage = (e: MessageEvent<Uint8Array>) => {
      Y.applyUpdate(this.ydoc, new Uint8Array(e.data), REMOTE);
      this.applyRemote();
    };

    // Lightweight presence: ping every 2s, expire peers after 5s.
    this.presence.onmessage = (e: MessageEvent<string>) => {
      this.peerSeen.set(e.data, Date.now());
    };
    this.peerTimer = setInterval(() => {
      this.presence.postMessage(this.siteId);
      const cutoff = Date.now() - 5_000;
      for (const [id, at] of this.peerSeen) if (at < cutoff) this.peerSeen.delete(id);
      const n = this.peerSeen.size + 1;
      if (n !== this.peers) {
        this.peers = n;
        this.onPeersChange?.(n);
      }
    }, 2_000);
    this.presence.postMessage(this.siteId);
  }

  private lastRevisionPushed = -1;

  /** Diff the engine document into Y (entity granularity, change-only). */
  private pushLocal() {
    const { doc, revision } = this.host.getState();
    if (revision === this.lastRevisionPushed) return;
    this.lastRevisionPushed = revision;
    this.ydoc.transact(() => {
      const liveTracks = new Set<string>();
      for (const t of doc.tracks) {
        liveTracks.add(t.id);
        const json = JSON.stringify(t);
        if (this.tracks.get(t.id) !== json) this.tracks.set(t.id, json);
      }
      for (const id of [...this.tracks.keys()]) if (!liveTracks.has(id)) this.tracks.delete(id);

      const liveAssets = new Set<string>();
      for (const a of doc.assets) {
        liveAssets.add(a.id);
        const json = JSON.stringify(a);
        if (this.assets.get(a.id) !== json) this.assets.set(a.id, json);
      }
      for (const id of [...this.assets.keys()]) if (!liveAssets.has(id)) this.assets.delete(id);

      if (this.meta.get('formatVersion') !== CURRENT_FORMAT_VERSION) {
        this.meta.set('formatVersion', CURRENT_FORMAT_VERSION);
      }
      const order = JSON.stringify(doc.tracks.map((t) => t.id));
      if (this.meta.get('trackOrder') !== order) this.meta.set('trackOrder', order);
      // nextId merges as max() so concurrent peers don't mint colliding ids.
      const current = (this.meta.get('nextId') as number) ?? 0;
      if (doc.nextId > current) this.meta.set('nextId', doc.nextId);
      for (const key of ['id', 'name', 'width', 'height', 'fpsNum', 'fpsDen'] as const) {
        const v = doc[key] as string | number;
        if (this.meta.get(key) !== v) this.meta.set(key, v);
      }
    }, LOCAL);
  }

  private rebuildDocument(): VDocument | null {
    if (this.meta.get('width') == null) return null;
    const order: string[] = JSON.parse((this.meta.get('trackOrder') as string) ?? '[]');
    const tracks: Track[] = [];
    const seen = new Set<string>();
    for (const id of order) {
      const json = this.tracks.get(id);
      if (json) {
        tracks.push(JSON.parse(json) as Track);
        seen.add(id);
      }
    }
    // Tracks created by a peer that this site's order doesn't know yet.
    for (const [id, json] of this.tracks) if (!seen.has(id)) tracks.push(JSON.parse(json) as Track);
    const assets = [...this.assets.values()].map((j) => JSON.parse(j) as Asset);
    const localNext = this.host.getState().doc.nextId;
    return {
      id: (this.meta.get('id') as string) ?? this.host.getState().doc.id,
      name: (this.meta.get('name') as string) ?? 'Untitled',
      width: this.meta.get('width') as number,
      height: this.meta.get('height') as number,
      fpsNum: (this.meta.get('fpsNum') as number) ?? 30,
      fpsDen: (this.meta.get('fpsDen') as number) ?? 1,
      nextId: Math.max((this.meta.get('nextId') as number) ?? 1, localNext),
      assets,
      tracks,
    };
  }

  private applyRemote() {
    const doc = this.rebuildDocument();
    if (!doc) return;
    const current = this.host.getState().doc;
    if (JSON.stringify(current) === JSON.stringify(doc)) return; // converged
    this.applyingRemote = true;
    try {
      this.host.loadDocument(doc);
      this.lastRevisionPushed = this.host.getState().revision;
    } finally {
      this.applyingRemote = false;
    }
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void kvPut(this.storageKey, Y.encodeStateAsUpdate(this.ydoc));
    }, 300);
  }

  dispose() {
    this.unsubscribe?.();
    if (this.peerTimer) clearInterval(this.peerTimer);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.bc.close();
    this.presence.close();
    this.ydoc.destroy();
  }
}
