import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Container } from './di/container';
import { TOKENS } from './di/tokens';
import type { Store, UiState } from './state/store';
import { Toolbar } from './ui/Toolbar';
import { PreviewPanel } from './ui/PreviewPanel';
import { TimelinePanel } from './ui/TimelinePanel';
import { InspectorPanel } from './ui/InspectorPanel';
import { AssetPanel } from './ui/AssetPanel';
import { AgentConsole } from './ui/AgentConsole';
import { HistoryPanel } from './ui/HistoryPanel';
import { ResizeHandle } from './ui/ResizeHandle';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const storedNum = (key: string, fallback: number): number => {
  const v = Number(localStorage.getItem(key));
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function useStore(store: Store): UiState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Split the selected clip (or the clip under the playhead) at the playhead. */
export function splitAtPlayhead(store: Store) {
  const s = store.getState();
  const t = s.playheadUs;
  let target = s.selectedClipId;
  if (target) {
    const clip = s.doc.tracks.flatMap((tr) => tr.clips).find((c) => c.id === target);
    if (!clip || t <= clip.startUs || t >= clip.startUs + clip.durationUs) target = null;
  }
  if (!target) {
    for (const track of [...s.doc.tracks].reverse()) {
      const clip = track.clips.find((c) => t > c.startUs && t < c.startUs + c.durationUs);
      if (clip) {
        target = clip.id;
        break;
      }
    }
  }
  if (target) store.dispatch({ type: 'splitClip', clipId: target, atUs: t });
}

export function App({ container }: { container: Container }) {
  const store = useMemo(() => container.resolve(TOKENS.Store), [container]);
  const playback = useMemo(() => container.resolve(TOKENS.Playback), [container]);
  const media = useMemo(() => container.resolve(TOKENS.Media), [container]);
  const renderer = useMemo(() => container.resolve(TOKENS.Renderer), [container]);
  const fonts = useMemo(() => container.resolve(TOKENS.Fonts), [container]);
  const transcriber = useMemo(() => container.resolve(TOKENS.Transcriber), [container]);
  const observer = useMemo(() => container.resolve(TOKENS.Observer), [container]);
  const tts = useMemo(() => container.resolve(TOKENS.Tts), [container]);
  const state = useStore(store);

  // Resizable panels — widths/height persisted per browser.
  const [assetW, setAssetW] = useState(() => storedNum('velocut.assetW', 200));
  const [inspW, setInspW] = useState(() => storedNum('velocut.inspW', 250));
  const [timelineH, setTimelineH] = useState(() => storedNum('velocut.timelineH', 230));
  useEffect(() => localStorage.setItem('velocut.assetW', String(assetW)), [assetW]);
  useEffect(() => localStorage.setItem('velocut.inspW', String(inspW)), [inspW]);
  useEffect(() => localStorage.setItem('velocut.timelineH', String(timelineH)), [timelineH]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.code === 'Space') {
        e.preventDefault();
        playback.toggle();
      } else if (e.key === 's' || e.key === 'S') {
        splitAtPlayhead(store);
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const id = store.getState().selectedClipId;
        if (id) {
          store.dispatch({ type: 'removeClip', clipId: id });
          store.select(null);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [store, playback]);

  return (
    <div className="app">
      <Toolbar
        store={store}
        playback={playback}
        media={media}
        state={state}
      />
      <div className="main-row">
        <AssetPanel store={store} media={media} state={state} width={assetW} />
        <ResizeHandle axis="x" onResize={(d) => setAssetW((w) => clamp(w + d, 140, 520))} />
        <PreviewPanel store={store} media={media} renderer={renderer} playback={playback} state={state} />
        <ResizeHandle axis="x" onResize={(d) => setInspW((w) => clamp(w - d, 180, 560))} />
        <InspectorPanel store={store} state={state} fonts={fonts} width={inspW} />
      </div>
      <ResizeHandle axis="y" onResize={(d) => setTimelineH((h) => clamp(h - d, 120, 640))} />
      <TimelinePanel store={store} state={state} media={media} height={timelineH} />
      <AgentConsole store={store} state={state} media={media} transcriber={transcriber} observer={observer} tts={tts} />
      <HistoryPanel store={store} state={state} />
      {state.lastError && (
        <div className="error-toast" onClick={store.clearError}>
          {state.lastError}
        </div>
      )}
    </div>
  );
}
