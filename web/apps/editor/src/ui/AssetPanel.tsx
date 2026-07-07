import { useEffect, useState } from 'react';
import type { Store, UiState } from '../state/store';
import type { MediaLibrary } from '@velocut/render-sdk';
import type { Envelope, TrackKind } from '@velocut/protocol';

const ICON: Record<string, string> = { video: '🎬', image: '🖼', audio: '🎵' };

const sameSet = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Tooltip for an asset the document references but whose media isn't loaded. */
function unloadedHint(src: string): string {
  return src.startsWith('motion://')
    ? 'Motion graphic not restored — lost on reload, needs to be regenerated'
    : 'Asset file not loaded, possibly missing — re-import a file with the same name to restore it';
}

/**
 * Assets the document references but whose media isn't actually loaded — an OPFS
 * file gone missing, a local:// import lost on reload, or a motion clip whose
 * draw program didn't survive a reload. Their clips render a silent black frame
 * with no other signal, so the panel flags them. Attachment lives in the media
 * worker (not the store), so we poll hasAsset(); a normal restore is async and
 * lands within a second or two, so an asset is flagged only after several
 * consecutive misses — a still-loading asset never flashes a false warning.
 */
function useUnloadedAssets(media: MediaLibrary, assetKey: string, assets: readonly { id: string; src: string }[]): Set<string> {
  const [unloaded, setUnloaded] = useState<Set<string>>(new Set());
  useEffect(() => {
    const misses = new Map<string, number>();
    let polls = 0;
    let timer = 0;
    const tick = () => {
      const next = new Set<string>();
      let anyPending = false;
      for (const a of assets) {
        if (!a.src || media.hasAsset(a.id)) {
          misses.delete(a.id);
          continue;
        }
        anyPending = true; // unattached — keep polling so a late restore clears it
        const n = (misses.get(a.id) ?? 0) + 1;
        misses.set(a.id, n);
        if (n >= 4) next.add(a.id); // ~5s of misses → not just a slow restore
      }
      setUnloaded((prev) => (sameSet(prev, next) ? prev : next));
      if (anyPending && ++polls < 20) timer = window.setTimeout(tick, 1200);
    };
    timer = window.setTimeout(tick, 1200);
    return () => window.clearTimeout(timer);
  }, [media, assetKey]); // re-evaluate whenever the asset set / srcs change
  return unloaded;
}

export function AssetPanel({ store, media, state, width }: { store: Store; media: MediaLibrary; state: UiState; width?: number }) {
  const assetKey = state.doc.assets.map((a) => `${a.id}:${a.src}`).join('|');
  const unloaded = useUnloadedAssets(media, assetKey, state.doc.assets);
  /** Select the first clip an envelope created (so it's immediately editable). */
  const selectNewClip = (resp: Envelope) => {
    if (!resp.ok) return;
    const ev = resp.events.find((e) => e.kind === 'clipAdded');
    if (ev && ev.kind === 'clipAdded') store.select(ev.clipId);
  };

  /** Fit (contain) media into the canvas — a 4K clip on a 720p doc otherwise
   *  draws at native pixels (6× the canvas) and only its centre shows. ids are
   *  minted deterministically (<kind>_<nextId>), so we can scale the new clip
   *  in the SAME batch (one undo). */
  const fitCmds = (asset: { kind: string; width: number; height: number }, clipId: string) => {
    if (asset.kind === 'audio' || !asset.width || !asset.height) return [];
    const scale = Math.min(state.doc.width / asset.width, state.doc.height / asset.height);
    if (Math.abs(scale - 1) < 0.001) return [];
    return [
      {
        type: 'setTransform' as const,
        clipId,
        transform: { x: 0, y: 0, scaleX: scale, scaleY: scale, rotation: 0, opacity: 1 },
      },
    ];
  };

  const addToTimeline = (assetId: string) => {
    const doc = state.doc;
    const asset = doc.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const trackKind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
    const dur = asset.durationUs > 0 ? asset.durationUs : 3_000_000; // images: 3s
    const track = doc.tracks.find((t) => t.kind === trackKind && !t.locked);
    if (!track) {
      const trackId = `track_${doc.nextId}`;
      const clipId = `clip_${doc.nextId + 1}`; // minted after the track
      selectNewClip(
        store.dispatch({
          type: 'batch',
          commands: [
            // Video renders bottom→top in array order: put it at the bottom so
            // text/subtitle tracks always composite above. Audio is unordered.
            { type: 'addTrack', kind: trackKind, index: trackKind === 'video' ? 0 : undefined },
            { type: 'addClip', trackId, assetId, startUs: 0, durationUs: dur },
            ...fitCmds(asset, clipId),
          ],
        }),
      );
      return;
    }
    // Place at playhead if free, else append at track end.
    const end = track.clips.reduce((m, c) => Math.max(m, c.startUs + c.durationUs), 0);
    const collides = track.clips.some(
      (c) => state.playheadUs < c.startUs + c.durationUs && c.startUs < state.playheadUs + dur,
    );
    const clipId = `clip_${doc.nextId}`;
    selectNewClip(
      store.dispatch({
        type: 'batch',
        commands: [
          { type: 'addClip', trackId: track.id, assetId, startUs: collides ? end : state.playheadUs, durationUs: dur },
          ...fitCmds(asset, clipId),
        ],
      }),
    );
  };

  const addTextLayer = () => {
    const doc = state.doc;
    const textTrack = doc.tracks.find((t) => t.kind === 'text' && !t.locked);
    const text = { content: 'Double-click to edit text', fontSize: 72, color: '#ffffff' };
    if (!textTrack) {
      const trackId = `track_${doc.nextId}`;
      selectNewClip(
        store.dispatch({
          type: 'batch',
          commands: [
            { type: 'addTrack', kind: 'text', name: 'Text' },
            { type: 'addTextClip', trackId, startUs: state.playheadUs, durationUs: 3_000_000, text },
          ],
        }),
      );
    } else {
      selectNewClip(
        store.dispatch({
          type: 'addTextClip',
          trackId: textTrack.id,
          startUs: state.playheadUs,
          durationUs: 3_000_000,
          text,
        }),
      );
    }
  };

  const addTrack = (kind: TrackKind, name: string) =>
    store.dispatch({ type: 'addTrack', kind, name, index: kind === 'video' ? 0 : undefined });

  return (
    <div className="asset-panel" style={width ? { width } : undefined}>
      <div className="panel-title">Assets</div>
      {state.doc.assets.length === 0 && (
        <div className="empty-hint">Import video / images / audio to start editing</div>
      )}
      {state.doc.assets.map((a) => (
        <div
          key={a.id}
          className="asset-item"
          onClick={(e) => e.detail <= 1 && addToTimeline(a.id)}
          title="Click to add to timeline"
        >
          <span className={`asset-kind asset-${a.kind}`}>{ICON[a.kind] ?? '📄'}</span>
          <span className="asset-name">{a.name}</span>
          {unloaded.has(a.id) && (
            <span className="asset-warn" title={unloadedHint(a.src)} onClick={(e) => e.stopPropagation()}>
              !
            </span>
          )}
          {a.durationUs > 0 && <span className="asset-dur">{(a.durationUs / 1e6).toFixed(1)}s</span>}
        </div>
      ))}
      <div className="panel-foot">
        <button className="add-text-btn" onClick={addTextLayer}>
          + Text Layer
        </button>
        <div className="add-track-row">
          <span className="add-track-label">Add Track</span>
          <button onClick={() => addTrack('video', 'Video')} title="Add video track">
            Video
          </button>
          <button onClick={() => addTrack('audio', 'Audio')} title="Add audio track">
            Audio
          </button>
          <button onClick={() => addTrack('text', 'Text')} title="Add text track">
            Text
          </button>
        </div>
      </div>
    </div>
  );
}
