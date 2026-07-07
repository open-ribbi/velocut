// ui/HistoryPanel.tsx — the branching history board.
//
// Renders the edit tree (state/history.ts): a flat vertical spine that indents
// only at branch points, every node attributed to who made it (you / AI /
// peer). The current checkout is highlighted; clicking any node checks it out
// (loads its snapshot) — editing afterwards spawns a new branch, so nothing is
// ever lost.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Store, UiState } from '../state/store';
import type { HistoryNode } from '../state/history';
import { useFloatingDock } from './useDraggable';

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5000) return 'just now';
  if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  const t = new Date(ts);
  return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
}

function actorClass(n: HistoryNode): string {
  if (n.actor.kind === 'ai') return 'hist-ai';
  if (n.actor.peerId === 'remote') return 'hist-peer';
  return 'hist-user';
}
function actorLabel(n: HistoryNode): string {
  return n.actor.kind === 'ai' ? 'AI' : n.actor.name;
}

export function HistoryPanel({ store, state }: { store: Store; state: UiState }) {
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const dock = useFloatingDock('velocut.histDockPos', open, () => setOpen(true));
  // On expand, jump to the latest (bottom) edit instead of the root.
  useEffect(() => {
    if (open) requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
  }, [open]);
  // state.historyRev in deps via the parent re-render; read the live tree.
  void state.historyRev;
  const tree = store.getHistory();
  const headId = tree.head.id;

  if (!open) {
    return (
      <button
        ref={dock.fabRef}
        className="hist-fab"
        style={dock.fabStyle}
        onPointerDown={dock.onFabPointerDown}
        title="Drag to move · Click to open the history board"
      >
        🕘 History
      </button>
    );
  }

  const headPath = new Set(tree.pathToHead().map((n) => n.id));
  const root = tree.getNode(tree.rootNodeId)!;

  // Render a node and recurse: linear chains stay flat; forks indent each branch.
  const renderChain = (node: HistoryNode): ReactNode => {
    const kids = tree.childrenOf(node.id);
    const isHead = node.id === headId;
    const onHeadPath = headPath.has(node.id);
    const row = (
      <div
        key={node.id}
        className={`hist-node ${actorClass(node)}${isHead ? ' hist-head' : ''}${onHeadPath ? ' hist-onpath' : ''}`}
        title={node.prompt ? `"${node.prompt}"` : node.command ? node.label : ''}
        onClick={() => {
          if (!isHead) store.jumpTo(node.id);
        }}
      >
        <span className="hist-dot" />
        <span className={`hist-chip ${actorClass(node)}`}>{actorLabel(node)}</span>
        <span className="hist-label">{node.label}</span>
        {node.actor.kind === 'ai' && node.actor.model && (
          <span className="hist-model">{node.actor.model.replace(/^claude-/, '')}</span>
        )}
        <span className="hist-time">{relTime(node.ts)}</span>
        {isHead && <span className="hist-now">current</span>}
        {kids.length > 1 && <span className="hist-fork">⑂{kids.length}</span>}
      </div>
    );

    let children: ReactNode = null;
    if (kids.length === 1) {
      children = renderChain(kids[0]);
    } else if (kids.length > 1) {
      // Order the branch leading to HEAD first so the current line reads top-down.
      const ordered = [...kids].sort((a, b) => (headPath.has(b.id) ? 1 : 0) - (headPath.has(a.id) ? 1 : 0));
      children = (
        <div className="hist-branches">
          {ordered.map((k) => (
            <div className="hist-branch" key={k.id}>
              {renderChain(k)}
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="hist-chain" key={`c-${node.id}`}>
        {row}
        {children}
      </div>
    );
  };

  return (
    <div className="hist-panel" ref={dock.panelRef} style={dock.panelStyle}>
      <div className="hist-head-bar" onPointerDown={dock.onPanelDragStart}>
        <span className="drag-grip" title="Drag to move">⠿</span>
        <span>History</span>
        <span className="hist-hint">Drag the title to move · Click any node to restore that state · Editing after going back starts a new branch</span>
        <button onClick={() => setOpen(false)}>×</button>
      </div>
      <div className="hist-list" ref={listRef}>{renderChain(root)}</div>
    </div>
  );
}
