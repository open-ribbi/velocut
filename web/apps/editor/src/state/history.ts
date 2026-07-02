// state/history.ts — a branching edit history (git-style).
//
// Every successful command becomes a node whose snapshot is the document AFTER
// it ran. Nodes form a tree: jumping back to an earlier node and editing again
// spawns a NEW child (a branch) without destroying the path you left — so no
// history is ever lost, and any node can be checked out and continued from.
//
// This lives at the store layer (not the engine): the engine stays a pure
// reducer, and the store drives undo/redo/jump by loading a node's snapshot.
// Each node also records WHO made the edit (a human peer or the AI) so the
// history board can attribute every change.

import type { Command, VDocument } from '@velocut/protocol';

export interface Actor {
  kind: 'user' | 'ai';
  /** Stable per-browser peer id (persisted). */
  peerId: string;
  /** Editable display name. */
  name: string;
  /** For ai edits: the model that produced them. */
  model?: string;
}

export interface HistoryNode {
  id: string;
  parentId: string | null;
  /** Wall-clock ms. */
  ts: number;
  actor: Actor;
  /** null only for the root. */
  command: Command | null;
  /** Human-readable one-liner. */
  label: string;
  /** For ai edits: the chat turn that triggered this (for grouping). */
  prompt?: string;
  /** Document state immediately AFTER this command (KB-scale). */
  snapshot: VDocument;
}

export interface HistorySerialized {
  nodes: HistoryNode[];
  rootId: string;
  headId: string;
  seq: number;
}

let MONO = 0;

export class HistoryTree {
  /** Cap on total nodes — each carries a full doc snapshot (see prune). */
  private static readonly MAX_NODES = 400;
  private nodes = new Map<string, HistoryNode>();
  private rootId: string;
  private headId: string;
  private seq = 0;

  constructor(rootDoc: VDocument, rootActor: Actor) {
    const id = this.mintId();
    const root: HistoryNode = {
      id,
      parentId: null,
      ts: Date.now(),
      actor: rootActor,
      command: null,
      label: '初始',
      snapshot: structuredClone(rootDoc),
    };
    this.nodes.set(id, root);
    this.rootId = id;
    this.headId = id;
  }

  private mintId(): string {
    // Unique without Math.random reliance: time + monotonic counter.
    return `h${Date.now().toString(36)}_${(MONO++).toString(36)}_${(this.seq++).toString(36)}`;
  }

  get head(): HistoryNode {
    return this.nodes.get(this.headId)!;
  }
  get rootNodeId(): string {
    return this.rootId;
  }
  getNode(id: string): HistoryNode | undefined {
    return this.nodes.get(id);
  }
  all(): HistoryNode[] {
    return [...this.nodes.values()];
  }

  /** Children of a node, oldest-first (insertion order). */
  childrenOf(id: string): HistoryNode[] {
    return this.all()
      .filter((n) => n.parentId === id)
      .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  }

  /** Root → head, the currently checked-out branch. */
  pathToHead(): HistoryNode[] {
    const path: HistoryNode[] = [];
    let cur: HistoryNode | undefined = this.head;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentId ? this.nodes.get(cur.parentId) : undefined;
    }
    return path;
  }

  canUndo(): boolean {
    return this.head.parentId != null;
  }
  canRedo(): boolean {
    return this.childrenOf(this.headId).length > 0;
  }

  /** Replace the root's snapshot — used once at startup to seat the tree on
   *  the persisted/restored document (only meaningful while the tree is just
   *  the root). */
  rebaseRoot(doc: VDocument): void {
    this.nodes.get(this.rootId)!.snapshot = structuredClone(doc);
  }

  /** Align the head node's snapshot to an externally-loaded document — used to
   *  absorb the collab restore "echo" on startup (the Yjs rebuild can differ
   *  from the persisted snapshot by nextId/ordering) without adding a node. */
  rebaseHead(doc: VDocument): void {
    this.head.snapshot = structuredClone(doc);
  }

  /** True while nothing has been recorded yet (fresh tree). */
  isPristine(): boolean {
    return this.nodes.size === 1 && this.headId === this.rootId;
  }

  /** Append a node under head and move head onto it (branches if head already
   *  had children — the old children remain as sibling branches). command is
   *  null for non-command nodes (root, remote sync). */
  record(command: Command | null, snapshot: VDocument, actor: Actor, label: string, prompt?: string): HistoryNode {
    const node: HistoryNode = {
      id: this.mintId(),
      parentId: this.headId,
      ts: Date.now(),
      actor,
      command,
      label,
      prompt,
      snapshot: structuredClone(snapshot),
    };
    this.nodes.set(node.id, node);
    this.headId = node.id;
    this.prune();
    return node;
  }

  /** Bound the tree (each node carries a full doc snapshot). Keeps the most
   *  recent slice of the current branch — re-rooting to drop ancient history
   *  (like a bounded undo depth) — then prunes any now-unreachable old branches
   *  and finally the oldest off-path leaves if still over budget. */
  private prune(): void {
    const MAX = HistoryTree.MAX_NODES;
    if (this.nodes.size <= MAX) return;

    // 1. Cap the root→head lineage to the most recent MAX; re-root above it.
    const path = this.pathToHead();
    if (path.length > MAX) {
      const newRoot = path[path.length - MAX];
      newRoot.parentId = null;
      this.rootId = newRoot.id;
    }

    // 2. Drop everything no longer reachable from the (possibly new) root.
    const reachable = new Set<string>();
    const stack = [this.rootId];
    while (stack.length) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const c of this.childrenOf(id)) stack.push(c.id);
    }
    for (const id of [...this.nodes.keys()]) if (!reachable.has(id)) this.nodes.delete(id);

    // 3. Still over budget (many live branches) → drop oldest off-path leaves.
    const keep = new Set(this.pathToHead().map((n) => n.id));
    keep.add(this.rootId);
    while (this.nodes.size > MAX) {
      const leaf = this.all()
        .filter((n) => !keep.has(n.id) && this.childrenOf(n.id).length === 0)
        .sort((a, b) => a.ts - b.ts)[0];
      if (!leaf) break;
      this.nodes.delete(leaf.id);
    }
  }

  /** Move head to parent; returns the snapshot to load (or null at root). */
  undo(): VDocument | null {
    const p = this.head.parentId;
    if (!p) return null;
    this.headId = p;
    return this.head.snapshot;
  }

  /** Move head onto the most-recently-created child of the current branch. */
  redo(): VDocument | null {
    const kids = this.childrenOf(this.headId);
    if (!kids.length) return null;
    const next = kids[kids.length - 1]; // newest branch
    this.headId = next.id;
    return next.snapshot;
  }

  /** Check out any node; returns its snapshot. */
  jumpTo(id: string): VDocument | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    this.headId = id;
    return n.snapshot;
  }

  serialize(): HistorySerialized {
    return { nodes: this.all(), rootId: this.rootId, headId: this.headId, seq: this.seq };
  }

  static deserialize(data: HistorySerialized): HistoryTree {
    const t = Object.create(HistoryTree.prototype) as HistoryTree;
    t.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    t.rootId = data.rootId;
    t.headId = data.nodes.some((n) => n.id === data.headId) ? data.headId : data.rootId;
    t.seq = data.seq ?? data.nodes.length;
    return t;
  }
}

// ---------------------------------------------------------------- labels

const trackKindLabel: Record<string, string> = { video: '视频', audio: '音频', text: '文字' };
const us = (n?: number | null) => (n == null ? '?' : (Math.round(n / 1e5) / 10).toFixed(1) + 's');

/** A short human description of a command for the history board. */
export function describeCommand(cmd: Command): string {
  switch (cmd.type) {
    case 'addAsset':
      return `导入${trackKindLabel[cmd.kind] ?? ''}「${cmd.name}」`;
    case 'addTrack':
      return `新增${trackKindLabel[cmd.kind] ?? ''}轨`;
    case 'removeTrack':
      return '删除轨道';
    case 'moveTrack':
      return '重排轨道';
    case 'addClip':
      return `素材上轨 @${us(cmd.startUs)}`;
    case 'addTextClip':
      return `加文字「${(cmd.text?.content ?? '').slice(0, 8)}」`;
    case 'removeClip':
      return '删除片段';
    case 'moveClip':
      return `移动片段 → ${us(cmd.startUs)}`;
    case 'trimClip':
      return `裁剪 ${cmd.edge === 'in' ? '头' : '尾'} → ${us(cmd.toUs)}`;
    case 'splitClip':
      return `分割 @${us(cmd.atUs)}`;
    case 'setClipSpeed':
      return `变速 ${cmd.speed}x`;
    case 'setTransform':
      return '调整变换';
    case 'setClipVolume':
      return `音量 ${Math.round(cmd.volume * 100)}%`;
    case 'setText':
      return '改文字样式';
    case 'setTransition':
      return cmd.transition ? `转场·${cmd.transition.kind === 'fadeBlack' ? '转黑' : '溶解'}` : '移除转场';
    case 'setKeyframe':
      return `关键帧·${cmd.property}`;
    case 'removeKeyframe':
      return `删关键帧·${cmd.property}`;
    case 'addEffect':
      return cmd.effect === 'colorGrade' ? '调色' : `加特效·${cmd.effect}`;
    case 'setEffectParams':
      return '调特效参数';
    case 'removeEffect':
      return '删除特效';
    case 'setTrackMuted':
      return cmd.muted ? '静音轨道' : '取消静音';
    case 'setTrackLocked':
      return cmd.locked ? '锁定轨道' : '解锁轨道';
    case 'batch': {
      const inner = cmd.commands;
      if (inner.length === 1) return describeCommand(inner[0]);
      const first = inner[0] ? describeCommand(inner[0]) : '';
      return `批量 ×${inner.length}:${first}…`;
    }
    default:
      return (cmd as { type: string }).type;
  }
}
