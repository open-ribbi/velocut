// services/caption.ts — glue for the auto-caption pipeline.
//
// Resolves the target asset, pulls its audio through the MediaLibrary, runs the
// Transcriber, and lays the segments down as a caption track via applyCaptions.
// Shared by the Toolbar button and the agent's velocut_transcribe tool so both
// produce identical, hand-editable caption clips.

import { type MediaLibrary, type Transcriber, transcribeAsset, applyCaptions, mapCaptionsToClip } from '@velocut/render-sdk';
import type { Store } from '../state/store';

export interface CaptionRunResult {
  ok: boolean;
  trackId?: string;
  count?: number;
  message?: string;
}

export async function captionAsset(
  store: Store,
  media: MediaLibrary,
  transcriber: Transcriber,
  opts: {
    assetId?: string;
    clipId?: string;
    fontSize?: number;
    color?: string;
    language?: string;
    onProgress?: (frac: number, label: string) => void;
  } = {},
): Promise<CaptionRunResult> {
  const state = store.getState();
  const doc = state.doc;
  const clips = doc.tracks.flatMap(track => track.clips);
  const selected = clips.find(clip => clip.id === (opts.clipId ?? state.selectedClipId));
  if (opts.clipId && !selected) return { ok: false, message: `Clip ${opts.clipId} no longer exists.` };
  if (opts.clipId && opts.assetId && selected?.assetId !== opts.assetId)
    return { ok: false, message: 'clipId and assetId refer to different media.' };
  const matches = clips.filter(clip => opts.assetId
    ? clip.assetId === opts.assetId
    : doc.assets.some(asset => asset.id === clip.assetId && asset.hasAudio));
  const target = selected && (!opts.assetId || selected.assetId === opts.assetId) &&
    doc.assets.some(asset => asset.id === selected.assetId && asset.hasAudio)
    ? selected : opts.clipId ? selected : matches.length === 1 ? matches[0] : undefined;
  if (!target && matches.length > 1)
    return { ok: false, message: 'Select one audio/video clip or supply clipId to place captions on its timeline range.' };
  const clip = target ? structuredClone(target) : undefined;
  const asset = doc.assets.find(asset => asset.id === (clip?.assetId ?? opts.assetId)) ??
    (!clip && !opts.assetId ? doc.assets.find(asset => asset.hasAudio) : undefined);
  if (!asset) return { ok: false, message: 'No audio asset to transcribe; import a video or audio file with sound first.' };
  if (!asset.hasAudio) return { ok: false, message: `Asset ${asset.id} has no audio track.` };
  if (asset.durationUs <= 0) return { ok: false, message: 'Asset duration is unknown.' };

  const sourceInUs = clip?.sourceInUs ?? 0;
  const sourceDurationUs = Math.min(asset.durationUs - sourceInUs, clip ? clip.durationUs * clip.speed : asset.durationUs);
  if (sourceDurationUs <= 0) return { ok: false, message: 'Clip contains no source audio.' };
  const segments = await transcribeAsset(media, transcriber, asset.id, sourceDurationUs, {
    fromUs: sourceInUs,
    language: opts.language,
    onProgress: opts.onProgress,
  });
  // ASR can take minutes. Never attach results using stale trim/speed/placement.
  const current = store.getState().doc;
  const liveAsset = current.assets.find(item => item.id === asset.id);
  const live = clip && current.tracks.flatMap(track => track.clips).find(item => item.id === clip.id);
  if (current.id !== doc.id || liveAsset?.src !== asset.src || liveAsset?.durationUs !== asset.durationUs ||
      (clip && (!live || ['assetId', 'startUs', 'durationUs', 'sourceInUs', 'speed'].some(key =>
        live[key as keyof typeof live] !== clip[key as keyof typeof clip]))))
    return { ok: false, message: 'Source clip changed during transcription. Run captions again for the current edit.' };
  opts.onProgress?.(0.95, 'Generating caption track');
  const res = applyCaptions(store.dispatch, current, clip ? mapCaptionsToClip(segments, clip) : segments, {
    fontSize: opts.fontSize,
    color: opts.color,
  });
  if (!res) return { ok: false, message: 'No speech detected.' };
  return { ok: true, trackId: res.trackId, count: res.count };
}
