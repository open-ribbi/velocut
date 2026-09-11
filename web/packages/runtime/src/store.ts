// state/store.ts — the single app store. It owns the engine, exposes a
// command dispatch (the same path the AgentConsole and window.velocut use),
// and snapshots the document for React via useSyncExternalStore.
//
// It also owns the branching edit HISTORY (state/history.ts): every dispatch
// records a node (with WHO made it), and undo/redo/jump drive the engine by
// loading a node's snapshot — so the engine stays a pure reducer and any past
// state can be checked out and continued from on a new branch.

import type { Command, Envelope, FrameGraph, TimeUs, VDocument } from '@velocut/protocol';
import { validateCommand } from '@velocut/protocol';
import type { ShotAnalysis } from '@velocut/render-sdk';
import type { ICoreEngine } from './engine';
import { HistoryTree, describeCommand, type Actor } from './history';

export interface UiState {
  doc: VDocument;
  revision: number;
  selectedClipId: string | null;
  /** UI-local selection; selectedClipId is the active clip for property editing. */
  selectedClipIds: string[];
  playheadUs: TimeUs;
  playing: boolean;
  durationUs: TimeUs;
  engineKind: 'wasm' | 'ts';
  canUndo: boolean;
  canRedo: boolean;
  lastError: string | null;
  /** Bumped on any history change so the board re-renders. */
  historyRev: number;
  /** Latest shot segmentation per asset, from the agent's observe(shots) — the
   *  timeline draws these cut boundaries so the human sees the structure the
   *  agent reasons over. Source-µs boundaries; the timeline maps them onto clips. */
  shots: Record<string, ShotAnalysis>;
}

type Listener = () => void;

export interface StoreOptions {
  /** Identity used for edits without an explicit actor (UI gestures). */
  localUser?: Actor;
  /** Restored history tree (persisted across reloads). */
  restoredHistory?: HistoryTree;
  /** Called after every history change so the host can persist it. */
  onHistory?: (tree: HistoryTree) => void;
}

export class Store {
  private engine: ICoreEngine;
  private listeners = new Set<Listener>();
  private state: UiState;
  private history: HistoryTree;
  private localUser: Actor;
  private onHistory?: (tree: HistoryTree) => void;
  /** The first external loadDocument after a restored history is the collab
   *  restore echo — absorb it into head instead of recording a sync node. */
  private awaitingRestore = false;
  private selectionAnchor: string | null = null;

  constructor(engine: ICoreEngine, opts: StoreOptions = {}) {
    this.engine = engine;
    this.localUser = opts.localUser ?? { kind: 'user', peerId: 'local', name: 'You' };
    this.onHistory = opts.onHistory;
    this.history = opts.restoredHistory ?? new HistoryTree(engine.document(), this.localUser);
    // If a history was restored, the head snapshot is authoritative.
    if (opts.restoredHistory) {
      this.engine.load(this.history.head.snapshot);
      this.awaitingRestore = true;
    }
    this.state = {
      doc: this.engine.document(),
      revision: this.engine.revision(),
      selectedClipId: null,
      selectedClipIds: [],
      playheadUs: 0,
      playing: false,
      durationUs: this.engine.durationUs(),
      engineKind: engine.kind,
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      lastError: null,
      historyRev: 0,
      shots: {},
    };
  }

  // -- subscription (React: useSyncExternalStore) -----------------------

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): UiState => this.state;

  private emit(partial: Partial<UiState>) {
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((fn) => fn());
  }

  private syncFromEngine(extra: Partial<UiState> = {}) {
    const doc = this.engine.document();
    const live = new Set(doc.tracks.flatMap(track => track.clips.map(clip => clip.id)));
    const selectedClipIds = extra.selectedClipId === null ? [] : this.state.selectedClipIds.filter(id => live.has(id));
    const selectedClipId = selectedClipIds.includes(this.state.selectedClipId!) ? this.state.selectedClipId : selectedClipIds.at(-1) ?? null;
    if (!this.selectionAnchor || !live.has(this.selectionAnchor) || extra.selectedClipId === null) this.selectionAnchor = selectedClipId;
    this.emit({
      doc,
      selectedClipIds,
      selectedClipId,
      revision: this.engine.revision(),
      durationUs: this.engine.durationUs(),
      canUndo: this.history.canUndo(),
      canRedo: this.history.canRedo(),
      ...extra,
    });
  }

  private historyChanged() {
    this.onHistory?.(this.history);
    this.emit({ historyRev: this.state.historyRev + 1 });
  }

  // -- history access (for the board) -----------------------------------

  getHistory = (): HistoryTree => this.history;
  getLocalUser = (): Actor => this.localUser;
  setLocalName = (name: string) => {
    this.localUser = { ...this.localUser, name };
  };

  // -- command path (UI / agent shared) ---------------------------------

  /** `actor`/`prompt` attribute the edit on the history board; UI gestures
   *  omit them (default = the local user), the agent passes its identity. */
  dispatch = (cmd: Command, actor?: Actor, prompt?: string): Envelope => {
    // Validate the command shape at the boundary (protocol zod schema) so a
    // malformed command — e.g. from the LLM — yields a structured error the
    // agent can correct, instead of confusing the engine.
    const valid = validateCommand(cmd);
    if (!valid.ok) {
      this.emit({ lastError: `${valid.code}: ${valid.message}` });
      return { ok: false, error: { code: valid.code, message: valid.message } };
    }
    const resp = this.engine.apply(cmd);
    if (resp.ok) {
      this.history.record(
        cmd,
        this.engine.document(),
        actor ?? this.localUser,
        describeCommand(cmd),
        prompt,
      );
      this.syncFromEngine({ lastError: null });
      this.historyChanged();
    } else {
      this.emit({ lastError: `${resp.error.code}: ${resp.error.message}` });
    }
    return resp;
  };

  undo = (): Envelope => {
    const snap = this.history.undo();
    if (!snap) return { ok: false, error: { code: 'invalidArg', message: 'nothing to undo' } };
    this.engine.load(snap);
    this.syncFromEngine({ lastError: null });
    this.historyChanged();
    return { ok: true, revision: this.engine.revision(), events: [{ kind: 'documentReplaced' }] };
  };

  redo = (): Envelope => {
    const snap = this.history.redo();
    if (!snap) return { ok: false, error: { code: 'invalidArg', message: 'nothing to redo' } };
    this.engine.load(snap);
    this.syncFromEngine({ lastError: null });
    this.historyChanged();
    return { ok: true, revision: this.engine.revision(), events: [{ kind: 'documentReplaced' }] };
  };

  /** Check out any history node — its snapshot becomes the live document.
   *  Editing afterwards branches (the path you left is preserved). */
  jumpTo = (nodeId: string): Envelope => {
    const snap = this.history.jumpTo(nodeId);
    if (!snap) return { ok: false, error: { code: 'notFound', message: 'history node not found' } };
    this.engine.load(snap);
    this.syncFromEngine({ lastError: null, selectedClipId: null });
    this.historyChanged();
    return { ok: true, revision: this.engine.revision(), events: [{ kind: 'documentReplaced' }] };
  };

  evaluate = (timeUs: TimeUs): FrameGraph => this.engine.evaluate(timeUs);

  // -- CollabHost: external document replacement (restore / remote peer) --

  loadDocument = (doc: VDocument) => {
    this.engine.load(doc);
    if (this.history.isPristine()) {
      // Startup restore: seat the tree on the persisted document.
      this.history.rebaseRoot(doc);
    } else if (this.awaitingRestore) {
      // First load after a restored history = the collab restore echo. Align
      // head to it (no new node) — they describe the same edit.
      this.awaitingRestore = false;
      this.history.rebaseHead(doc);
    } else if (JSON.stringify(doc) !== JSON.stringify(this.history.head.snapshot)) {
      // Genuinely new state (a remote peer's edit) arrived as a whole-doc
      // rebuild — we can't see the command, so record one sync node. If it
      // matches head (the restore echo of our own persisted history), do
      // nothing — no spurious node on reload.
      this.history.record(
        null,
        doc,
        { kind: 'user', peerId: 'remote', name: 'Collaborator' },
        'Remote sync',
      );
    }
    this.syncFromEngine({ selectedClipId: null });
    this.historyChanged();
  };

  // -- UI-local state ----------------------------------------------------

  select = (clipId: string | null, mode: 'replace' | 'toggle' | 'range' = 'replace') => {
    if (clipId === null) {
      this.selectionAnchor = null;
      this.emit({ selectedClipId: null, selectedClipIds: [] });
      return;
    }
    const order = this.state.doc.tracks.flatMap(track => [...track.clips].sort((a, b) => a.startUs - b.startUs || a.id.localeCompare(b.id)).map(clip => clip.id));
    if (!order.includes(clipId)) return;
    let ids = [clipId];
    if (mode === 'toggle') {
      ids = this.state.selectedClipIds.includes(clipId) ? this.state.selectedClipIds.filter(id => id !== clipId) : [...this.state.selectedClipIds, clipId];
    } else if (mode === 'range' && this.selectionAnchor && order.includes(this.selectionAnchor)) {
      const a = order.indexOf(this.selectionAnchor), b = order.indexOf(clipId);
      ids = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
    if (mode !== 'range' || !this.selectionAnchor) this.selectionAnchor = clipId;
    this.emit({ selectedClipIds: order.filter(id => ids.includes(id)), selectedClipId: ids.includes(clipId) ? clipId : ids.at(-1) ?? null });
  };

  removeSelectedClips = () => this.state.selectedClipIds.length ? this.dispatch({
    type: 'batch', commands: this.state.selectedClipIds.map(clipId => ({ type: 'removeClip', clipId })),
  }) : undefined;

  /** Record a shot segmentation (from observe shots) for timeline overlay. */
  setShots = (assetId: string, analysis: ShotAnalysis) =>
    this.emit({ shots: { ...this.state.shots, [assetId]: analysis } });

  seek = (timeUs: TimeUs) => {
    const clamped = Math.max(0, Math.round(timeUs));
    this.emit({ playheadUs: clamped });
  };

  setPlaying = (playing: boolean) => this.emit({ playing });

  clearError = () => this.emit({ lastError: null });
}
