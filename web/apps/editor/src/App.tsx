import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { DirectorPanel } from './ui/DirectorPanel';
import { directorController } from './services/director-session';
import { createSceneClip } from './services/scene';
import { Icon, type IconName } from './ui/primitives/Icon';
import { useViewport } from './ui/useViewport';
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
  const director = useMemo(() => directorController(store), [store]);
  const session = useSyncExternalStore(
    director.subscribe,
    director.getSnapshot,
    director.getSnapshot,
  );
  const directorAsset = session
    ? state.doc.assets.find((a) => a.id === session.assetId)
    : undefined;
  useEffect(() => {
    if (session && !directorAsset) director.update({ open: false });
  }, [session, directorAsset, director]);

  // Resizable panels — widths/height persisted per browser.
  const [assetW, setAssetW] = useState(() => storedNum('velocut.assetW', 232));
  const [inspW, setInspW] = useState(() => storedNum('velocut.inspW', 288));
  const [timelineH, setTimelineH] = useState(() => storedNum('velocut.timelineH', 220));
  useEffect(() => localStorage.setItem('velocut.assetW', String(assetW)), [assetW]);
  useEffect(() => localStorage.setItem('velocut.inspW', String(inspW)), [inspW]);
  useEffect(() => localStorage.setItem('velocut.timelineH', String(timelineH)), [timelineH]);

  const { compact, height: viewportHeight } = useViewport();
  const [showMedia, setShowMedia] = useState(true),
    [showInspector, setShowInspector] = useState(true);
  const [drawer, setDrawer] = useState<'media' | 'inspector' | null>(null);
  const [aux, setAux] = useState<'assistant' | 'history' | null>(null);
  const [timelineCollapsed, setTimelineCollapsed] = useState(false);
  const [creating, setCreating] = useState(false),
    [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const selectPanel = (panel: 'media' | 'inspector' | 'assistant' | 'history') => {
    if (panel === 'assistant' || panel === 'history') {
      setAux((a) => (a === panel ? null : panel));
      setDrawer(null);
    } else {
      setAux(null);
      if (compact) setDrawer((d) => (d === panel ? null : panel));
      else if (panel === 'media') setShowMedia((v) => !v);
      else setShowInspector((v) => !v);
    }
  };
  const closePanel = (panel: 'media' | 'inspector') => {
    if (compact) setDrawer(null);
    else if (panel === 'media') setShowMedia(false);
    else setShowInspector(false);
  };
  const openDirector = async (create = false) => {
    if (creating) return;
    const selected = state.doc.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === state.selectedClipId)?.assetId;
    const existing =
      state.doc.assets.find((a) => a.id === selected && a.src.startsWith('scene://')) ??
      state.doc.assets.find((a) => a.src.startsWith('scene://'));
    if (existing && !create) {
      director.update({ assetId: existing.id, open: true });
      setDrawer(null);
      return;
    }
    setCreating(true);
    setWorkspaceError(null);
    try {
      const r = await createSceneClip(store, media, {
        name: `Scene ${state.doc.assets.filter((a) => a.src.startsWith('scene://')).length + 1}`,
        atUs: state.durationUs,
        spec: {
          version: 1,
          durationUs: 5_000_000,
          environment: 'env/grid',
          lighting: 'indoor',
        },
      });
      if (!r.ok) throw new Error(r.message);
      if (r.clipId) store.select(r.clipId);
      director.update({ assetId: r.assetId, open: true });
      setDrawer(null);
    } catch (e) {
      setWorkspaceError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };
  useEffect(() => {
    if (!compact) setDrawer(null);
  }, [compact]);
  useEffect(() => {
    if (session?.assetId) setDrawer(null);
  }, [session?.assetId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open], .ctx-menu, .tool-menu[open]')) return;
      if (e.key === 'Escape' && (drawer || aux)) {
        setDrawer(null);
        setAux(null);
        return;
      }
      const tag = (e.target as HTMLElement)?.tagName;
      if (
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        (e.target as HTMLElement)?.isContentEditable
      )
        return;
      if (e.code === 'Space' && tag === 'BUTTON') return;
      if (
        director.getSnapshot() &&
        (e.code === 'Space' ||
          e.key === 'Escape' ||
          e.key === 'Delete' ||
          e.key === 'Backspace' ||
          e.key.toLowerCase() === 's')
      ) {
        e.preventDefault();
        if (e.code === 'Space') director.update({ playing: !director.getSnapshot()!.playing });
        if (e.key === 'Escape') director.update({ open: false });
        return;
      }
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
  }, [store, playback, director, drawer, aux]);

  const mediaVisible = compact ? drawer === 'media' : showMedia;
  const inspectorVisible = compact ? drawer === 'inspector' : showInspector;
  const panels: Array<{
    key: 'media' | 'inspector' | 'history' | 'assistant';
    icon: IconName;
    label: string;
    active: boolean;
  }> = [
    {
      key: 'media',
      icon: session ? 'layers' : 'media',
      label: session ? 'Objects' : 'Media',
      active: mediaVisible,
    },
    {
      key: 'inspector',
      icon: 'inspector',
      label: 'Properties',
      active: inspectorVisible,
    },
    {
      key: 'history',
      icon: 'history',
      label: 'History',
      active: aux === 'history',
    },
    {
      key: 'assistant',
      icon: 'sparkles',
      label: 'Assistant',
      active: aux === 'assistant',
    },
  ];
  return (
    <div className="app" data-compact={compact}>
      <Toolbar
        store={store}
        playback={playback}
        media={media}
        state={state}
        codex={container.resolve(TOKENS.CodexConnection)}
        importInputRef={importInputRef}
        directorActive={!!session}
        onEdit={() => director.update({ open: false })}
        onDirector={() => void openDirector()}
      />
      <div className="workspace">
        <nav className="workspace-nav" aria-label="Workspace panels">
          {panels.map((p) => (
            <button
              key={p.key}
              className={
                'nav-button' +
                (p.active ? ' active' : '') +
                (p.key === 'assistant' ? ' agent-fab' : p.key === 'history' ? ' hist-fab' : '')
              }
              aria-label={p.label}
              aria-pressed={p.active}
              title={p.label}
              onClick={() => selectPanel(p.key)}
            >
              <Icon name={p.icon} size={20} />
              <span>{p.label}</span>
            </button>
          ))}
          <span className="nav-spacer" />
          <span className="nav-wordmark" aria-hidden="true">
            V.
          </span>
        </nav>
        <div className="work-area">
          <div className="edit-workspace" hidden={!!session}>
            <div className="main-row">
              <div className="panel-slot media-slot" hidden={!mediaVisible}>
                <div className="panel-close-row">
                  <span>Media library</span>
                  <button
                    className="icon-button"
                    aria-label="Close media library"
                    onClick={() => closePanel('media')}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <AssetPanel
                  store={store}
                  media={media}
                  state={state}
                  width={compact ? undefined : assetW}
                  onNewScene={() => void openDirector(true)}
                  onImport={() => importInputRef.current?.click()}
                  creating={creating}
                />
              </div>
              {!compact && showMedia && (
                <ResizeHandle axis="x" onResize={(d) => setAssetW((w) => clamp(w + d, 180, 360))} />
              )}
              <div className="preview-column">
                <div className="view-heading">
                  <span>
                    <Icon name="video" size={15} /> Program monitor
                  </span>
                  <span className="view-spec">
                    {state.doc.width} × {state.doc.height} <i />{' '}
                    {Math.round(state.doc.fpsNum / state.doc.fpsDen)} fps
                  </span>
                </div>
                <PreviewPanel
                  store={store}
                  media={media}
                  renderer={renderer}
                  playback={playback}
                  state={state}
                />
                {state.doc.assets.length === 0 && !state.doc.tracks.some((t) => t.clips.length) && (
                  <div className="workspace-empty">
                    <div className="empty-art">
                      <Icon name="camera" size={36} />
                      <span />
                      <span />
                    </div>
                    <span className="eyebrow">A NEW PERSPECTIVE</span>
                    <h1>Make room for your story.</h1>
                    <p>
                      Bring in footage or build a scene.
                      <br />
                      Shape every frame, together with AI.
                    </p>
                    <div className="empty-actions">
                      <button
                        className="primary"
                        onClick={() => void openDirector(true)}
                        disabled={creating}
                      >
                        <Icon name="cube" />
                        {creating ? 'Creating scene…' : 'Create 3D scene'}
                      </button>
                      <button onClick={() => importInputRef.current?.click()}>
                        <Icon name="upload" />
                        Import media
                      </button>
                    </div>
                    <span className="empty-footnote">Built for the browser. Ready for Codex.</span>
                  </div>
                )}
              </div>
              {!compact && showInspector && (
                <ResizeHandle axis="x" onResize={(d) => setInspW((w) => clamp(w - d, 240, 380))} />
              )}
              <div className="panel-slot inspector-slot" hidden={!inspectorVisible}>
                <div className="panel-close-row">
                  <span>Properties</span>
                  <button
                    className="icon-button"
                    aria-label="Close properties"
                    onClick={() => closePanel('inspector')}
                  >
                    <Icon name="close" />
                  </button>
                </div>
                <InspectorPanel
                  store={store}
                  state={state}
                  fonts={fonts}
                  width={compact ? undefined : inspW}
                />
              </div>
            </div>
            {!compact && !timelineCollapsed && (
              <ResizeHandle
                axis="y"
                onResize={(d) =>
                  setTimelineH((h) => clamp(h - d, 140, Math.max(180, viewportHeight * 0.55)))
                }
              />
            )}
            <TimelinePanel
              store={store}
              state={state}
              media={media}
              height={
                timelineCollapsed
                  ? 38
                  : compact
                    ? Math.min(158, viewportHeight * 0.24)
                    : Math.min(timelineH, viewportHeight * 0.5)
              }
              collapsed={timelineCollapsed}
              onToggle={() => setTimelineCollapsed((v) => !v)}
            />
          </div>
          {session && directorAsset && (
            <DirectorPanel
              key={session.assetId}
              store={store}
              asset={directorAsset}
              session={session}
              onClose={() => director.update({ open: false })}
              compact={compact}
              showObjects={mediaVisible}
              showInspector={inspectorVisible}
              onClosePanel={() => {
                if (compact) setDrawer(null);
                else {
                  setShowMedia(false);
                  setShowInspector(false);
                }
              }}
              onInspect={() => {
                if (compact) setDrawer('inspector');
                else setShowInspector(true);
              }}
            />
          )}
        </div>
      </div>
      <footer className="status-bar">
        <span>
          <i className="status-dot" /> Local project{' '}
          <span className="status-detail">· On-device workspace</span>
        </span>
        <span className="status-center">{session ? '3D DIRECTOR' : 'TIMELINE EDITOR'}</span>
        <span className={`engine-badge engine-${state.engineKind}`}>
          engine: {state.engineKind === 'wasm' ? 'Rust/WASM' : 'TS fallback'}
        </span>
        <span className="status-brand">Ribbi</span>
      </footer>
      <AgentConsole
        store={store}
        state={state}
        media={media}
        transcriber={transcriber}
        observer={observer}
        tts={tts}
        open={aux === 'assistant'}
        onOpenChange={(open) => {
          setAux(open ? 'assistant' : null);
          if (open) setDrawer(null);
        }}
      />
      <HistoryPanel
        store={store}
        state={state}
        open={aux === 'history'}
        onOpenChange={(open) => {
          setAux(open ? 'history' : null);
          if (open) setDrawer(null);
        }}
      />
      {(state.lastError || workspaceError) && (
        <div className="error-toast" role="alert">
          <span>{workspaceError ?? state.lastError}</span>
          <button
            className="icon-button"
            aria-label="Dismiss error"
            onClick={() => {
              store.clearError();
              setWorkspaceError(null);
            }}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </div>
  );
}
