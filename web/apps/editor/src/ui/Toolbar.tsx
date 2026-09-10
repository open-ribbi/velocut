import { Icon } from './primitives/Icon';
import { Dialog } from './primitives/Dialog';
import { CodexPanel } from './CodexPanel';
import type { CodexConnection } from '../services/codex-connection';
import { useRef, useState, type RefObject } from 'react';
import type { Store, UiState } from '../state/store';
import {
  type MediaLibrary,
  type Playback,
  Exporter,
  type AudioClipPlan,
  type VideoCodecFamily,
} from '@velocut/render-sdk';
import { importMediaFiles } from '../services/import';
import { ProjectMenu } from './ProjectMenu';
import { splitAtPlayhead } from '../App';

function fmtTime(us: number): string {
  const s = Math.max(0, us) / 1e6;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}

/** Export quality presets → bits-per-pixel-per-frame. The encoder has no app cap;
 *  these just set a sensible target the user (or 'custom' Mbps) can override. */
type ExportQuality = 'standard' | 'high' | 'ultra' | 'custom';
const QUALITY_BPP: Record<Exclude<ExportQuality, 'custom'>, number> = {
  standard: 0.08,
  high: 0.12,
  ultra: 0.2,
};
const CODEC_LABEL: Record<VideoCodecFamily, string> = {
  avc: 'H.264',
  hevc: 'H.265',
  av1: 'AV1',
};

export function Toolbar({
  store,
  playback,
  media,
  state,
  codex,
  importInputRef,
  directorActive = false,
  onEdit,
  onDirector,
}: {
  store: Store;
  playback: Playback;
  media: MediaLibrary;
  state: UiState;
  codex?: CodexConnection;
  importInputRef: RefObject<HTMLInputElement>;
  directorActive?: boolean;
  onEdit: () => void;
  onDirector: () => void;
}) {
  const [exportOpen, setExportOpen] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const fileRef = importInputRef;
  const [exportPct, setExportPct] = useState<{
    frac: number;
    label: string;
  } | null>(null);
  const exportAbort = useRef<AbortController | null>(null);
  // Export codec/quality — persisted per browser; plumbed into Exporter.export.
  const [exportCodec, setExportCodec] = useState<VideoCodecFamily>(
    () => (localStorage.getItem('velocut.exportCodec') as VideoCodecFamily) || 'avc',
  );
  const [exportQuality, setExportQuality] = useState<ExportQuality>(
    () => (localStorage.getItem('velocut.exportQuality') as ExportQuality) || 'high',
  );
  const [customMbps, setCustomMbps] = useState<number>(
    () => Number(localStorage.getItem('velocut.exportMbps')) || 20,
  );

  const runExport = async () => {
    const doc = store.getState().doc;
    const durationUs = state.durationUs;
    if (durationUs <= 0 || exportPct) return;
    if (state.playing) playback.toggle();

    // Audio plan: speed-1 clips on un-muted tracks whose asset has audio.
    const audioClips: AudioClipPlan[] = [];
    for (const track of doc.tracks) {
      if (track.muted) continue;
      for (const clip of track.clips) {
        const asset = clip.assetId ? doc.assets.find((a) => a.id === clip.assetId) : null;
        if (!asset?.hasAudio || clip.speed !== 1) continue;
        audioClips.push({
          assetId: asset.id,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
          sourceInUs: clip.sourceInUs,
          gain: clip.volume,
        });
      }
    }

    // Target bitrate: 'custom' uses the explicit Mbps; presets scale with the
    // pixel rate (bpp × w × h × fps). No cap — passed straight to the encoder.
    const videoBitrate =
      exportQuality === 'custom'
        ? Math.max(1_000_000, Math.round(customMbps * 1e6))
        : Math.round(
            doc.width * doc.height * (doc.fpsNum / doc.fpsDen) * QUALITY_BPP[exportQuality],
          );

    setExportError(null);
    const abort = new AbortController();
    exportAbort.current = abort;
    setExportPct({ frac: 0, label: 'Preparing' });
    try {
      const blob = await new Exporter(media).export({
        width: doc.width,
        height: doc.height,
        fpsNum: doc.fpsNum,
        fpsDen: doc.fpsDen,
        durationUs,
        evaluate: (t) => store.evaluate(t),
        audioClips,
        videoBitrate,
        videoCodec: exportCodec,
        signal: abort.signal,
        onProgress: (frac, label) => setExportPct({ frac, label }),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${doc.name || 'velocut'}.mp4`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError')
        setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExportPct(null);
      exportAbort.current = null;
    }
  };

  const importFiles = (files: File[]) => void importMediaFiles(store, media, files);

  const selected = state.selectedClipId
    ? state.doc.tracks.flatMap((t) => t.clips).find((c) => c.id === state.selectedClipId)
    : null;

  return (
    <header className="toolbar">
      <div className="project-bar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            velocut<small>STUDIO</small>
          </span>
        </div>
        <span className="header-divider" />
        <ProjectMenu />
        <div className="workspace-modes" role="tablist" aria-label="Workspace">
          <button role="tab" aria-selected={!directorActive} onClick={onEdit}>
            <Icon name="timeline" size={16} />
            <span>Edit</span>
          </button>
          <button role="tab" aria-selected={directorActive} onClick={onDirector}>
            <Icon name="cube" size={16} />
            <span>Director</span>
          </button>
        </div>
        <span className="spacer" />
        {codex && <CodexPanel connection={codex} />}
        <button
          className="primary export-trigger"
          aria-label="Export"
          onClick={() => setExportOpen(true)}
        >
          <Icon name="download" size={16} />
          <span className="button-label">Export</span>
        </button>
      </div>
      <div className={'edit-bar' + (directorActive ? ' director-active' : '')}>
        <div className="tool-group">
          <button
            className="import-trigger"
            aria-label="Import Media"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" size={16} />
            <span>Import Media</span>
          </button>
          <button
            className="icon-button"
            disabled={!state.canUndo}
            onClick={() => store.undo()}
            title="Undo · ⌘Z"
            aria-label="Undo"
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-button"
            disabled={!state.canRedo}
            onClick={() => store.redo()}
            title="Redo · ⇧⌘Z"
            aria-label="Redo"
          >
            <Icon name="redo" />
          </button>
        </div>
        {!directorActive && (
          <>
            <span className="header-divider" />
            <div className="tool-group">
              <button
                className="icon-button play-button"
                aria-label={state.playing ? 'Pause' : 'Play'}
                onClick={() => playback.toggle()}
                title="Play / pause · Space"
              >
                <Icon name={state.playing ? 'pause' : 'play'} />
              </button>
              <button
                className="icon-button"
                onClick={() => splitAtPlayhead(store)}
                title="Split at playhead · S"
                aria-label="Split"
              >
                <Icon name="cut" />
              </button>
            </div>
            <span className="timecode">
              {fmtTime(state.playheadUs)}
              <span> / {fmtTime(state.durationUs)}</span>
            </span>
            {selected && (
              <label className="speed-label">
                <span>Speed</span>
                <select
                  aria-label="Clip speed"
                  value={String(selected.speed)}
                  onChange={(e) =>
                    store.dispatch({
                      type: 'setClipSpeed',
                      clipId: selected.id,
                      speed: Number(e.target.value),
                    })
                  }
                >
                  {[0.25, 0.5, 1, 1.5, 2, 4].map((v) => (
                    <option key={v} value={v}>
                      {v}×
                    </option>
                  ))}
                </select>
              </label>
            )}
          </>
        )}
        <span className="spacer" />
        <span className="toolbar-hint">
          {directorActive ? 'Scene workspace' : 'Your story, frame by frame'}
        </span>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov,.m4v,image/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          importFiles(files);
        }}
      />
      <Dialog
        open={exportOpen}
        title="Export film"
        className="export-dialog"
        onClose={() => {
          if (exportPct) exportAbort.current?.abort();
          setExportOpen(false);
        }}
      >
        <p className="dialog-description">Create an MP4 of your timeline, ready to share.</p>
        <div className="export-summary">
          <Icon name="video" size={28} />
          <div>
            <strong>{state.doc.name}</strong>
            <span>
              {state.doc.width} × {state.doc.height} · {state.doc.fpsNum / state.doc.fpsDen} fps ·{' '}
              {fmtTime(state.durationUs)}
            </span>
          </div>
        </div>
        <label className="form-field">
          <span>Format</span>
          <select
            className="export-opt"
            aria-label="Export codec"
            value={exportCodec}
            disabled={!!exportPct}
            onChange={(e) => {
              const v = e.target.value as VideoCodecFamily;
              setExportCodec(v);
              localStorage.setItem('velocut.exportCodec', v);
            }}
          >
            {(['avc', 'hevc', 'av1'] as VideoCodecFamily[]).map((c) => (
              <option key={c} value={c}>
                {CODEC_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field">
          <span>Quality</span>
          <select
            className="export-opt"
            aria-label="Export quality"
            value={exportQuality}
            disabled={!!exportPct}
            onChange={(e) => {
              const v = e.target.value as ExportQuality;
              setExportQuality(v);
              localStorage.setItem('velocut.exportQuality', v);
            }}
          >
            <option value="standard">Standard</option>
            <option value="high">High</option>
            <option value="ultra">Ultra</option>
            <option value="custom">Custom bitrate</option>
          </select>
        </label>
        {exportQuality === 'custom' && (
          <label className="form-field">
            <span>Bitrate · Mbps</span>
            <input
              className="export-mbps"
              type="number"
              aria-label="Target bitrate"
              min={1}
              max={2000}
              value={customMbps}
              disabled={!!exportPct}
              onChange={(e) => {
                const v = Math.max(1, Math.min(2000, Number(e.target.value) || 1));
                setCustomMbps(v);
                localStorage.setItem('velocut.exportMbps', String(v));
              }}
            />
          </label>
        )}
        {exportError && (
          <p className="scene-error" role="alert">
            {exportError}
          </p>
        )}
        {exportPct ? (
          <div className="export-progress" role="status">
            <div className="export-title">{exportPct.label}</div>
            <div className="export-bar">
              <div
                className="export-fill"
                style={{ width: `${Math.round(exportPct.frac * 100)}%` }}
              />
            </div>
            <div className="export-pct">{Math.round(exportPct.frac * 100)}%</div>
            <button onClick={() => exportAbort.current?.abort()}>Cancel export</button>
          </div>
        ) : (
          <button
            className="primary full-width"
            onClick={runExport}
            disabled={state.durationUs <= 0}
          >
            <Icon name="download" />
            Export MP4
          </button>
        )}
        {state.durationUs <= 0 && (
          <p className="empty-hint">Add a clip to your timeline to export.</p>
        )}
      </Dialog>
    </header>
  );
}
