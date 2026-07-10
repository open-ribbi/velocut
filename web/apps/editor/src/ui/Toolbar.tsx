import { useRef, useState } from 'react';
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
const CODEC_LABEL: Record<VideoCodecFamily, string> = { avc: 'H.264', hevc: 'H.265', av1: 'AV1' };

export function Toolbar({
  store,
  playback,
  media,
  state,
}: {
  store: Store;
  playback: Playback;
  media: MediaLibrary;
  state: UiState;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [exportPct, setExportPct] = useState<{ frac: number; label: string } | null>(null);
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
        : Math.round(doc.width * doc.height * (doc.fpsNum / doc.fpsDen) * QUALITY_BPP[exportQuality]);

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
      if ((e as Error)?.name !== 'AbortError') console.error('[velocut] export failed', e);
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
    <div className="toolbar">
      <span className="brand">Velocut</span>
      <ProjectMenu />
      <button onClick={() => fileRef.current?.click()}>Import Media</button>
      <input
        ref={fileRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov,.m4v,image/*,audio/*"
        multiple
        hidden
        onChange={(e) => {
          // Copy before resetting: clearing value empties the live FileList.
          const files = Array.from(e.target.files ?? []);
          e.target.value = ''; // allow re-importing the same file
          importFiles(files);
        }}
      />
      <span className="divider" />
      <button onClick={() => playback.toggle()}>{state.playing ? '⏸ Pause' : '▶ Play'}</button>
      <button onClick={() => splitAtPlayhead(store)} title="Shortcut: S">
        ✂ Split
      </button>
      <button disabled={!state.canUndo} onClick={() => store.undo()} title="Cmd/Ctrl+Z">
        ↩ Undo
      </button>
      <button disabled={!state.canRedo} onClick={() => store.redo()} title="Cmd/Ctrl+Shift+Z">
        ↪ Redo
      </button>
      {selected && (
        <>
          <span className="divider" />
          <label className="speed-label">
            Speed
            <select
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
                  {v}x
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <span className="spacer" />
      <select
        className="export-opt"
        value={exportCodec}
        disabled={!!exportPct}
        title="Export codec (H.265/AV1 need less bitrate at the same quality and support beyond 4K; some platform encoders may fall back to H.264)"
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
      <select
        className="export-opt"
        value={exportQuality}
        disabled={!!exportPct}
        title="Export quality (sets the target bitrate)"
        onChange={(e) => {
          const v = e.target.value as ExportQuality;
          setExportQuality(v);
          localStorage.setItem('velocut.exportQuality', v);
        }}
      >
        <option value="standard">Standard</option>
        <option value="high">High</option>
        <option value="ultra">Ultra</option>
        <option value="custom">Custom</option>
      </select>
      {exportQuality === 'custom' && (
        <input
          className="export-mbps"
          type="number"
          min={1}
          max={2000}
          value={customMbps}
          disabled={!!exportPct}
          title="Target bitrate (Mbps)"
          onChange={(e) => {
            const v = Math.max(1, Math.min(2000, Number(e.target.value) || 1));
            setCustomMbps(v);
            localStorage.setItem('velocut.exportMbps', String(v));
          }}
        />
      )}
      <button onClick={runExport} disabled={!!exportPct || state.durationUs <= 0} title="Export MP4">
        ⬇ Export
      </button>
      <span className="timecode">
        {fmtTime(state.playheadUs)} / {fmtTime(state.durationUs)}
      </span>
      <span className={`engine-badge engine-${state.engineKind}`}>
        engine: {state.engineKind === 'wasm' ? 'Rust/WASM' : 'TS fallback'}
      </span>

      {exportPct && (
        <div className="export-modal">
          <div className="export-card">
            <div className="export-title">Exporting — {exportPct.label}</div>
            <div className="export-bar">
              <div className="export-fill" style={{ width: `${Math.round(exportPct.frac * 100)}%` }} />
            </div>
            <div className="export-pct">{Math.round(exportPct.frac * 100)}%</div>
            <button className="export-cancel" onClick={() => exportAbort.current?.abort()}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
