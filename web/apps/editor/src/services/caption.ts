// services/caption.ts — glue for the auto-caption pipeline.
//
// Resolves the target asset, pulls its audio through the MediaLibrary, runs the
// Transcriber, and lays the segments down as a caption track via applyCaptions.
// Shared by the Toolbar button and the agent's velocut_transcribe tool so both
// produce identical, hand-editable caption clips.

import { type MediaLibrary, type Transcriber, transcribeAsset, applyCaptions } from '@velocut/render-sdk';
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
    fontSize?: number;
    color?: string;
    language?: string;
    onProgress?: (frac: number, label: string) => void;
  } = {},
): Promise<CaptionRunResult> {
  const doc = store.getState().doc;
  const asset = opts.assetId
    ? doc.assets.find((a) => a.id === opts.assetId)
    : doc.assets.find((a) => a.hasAudio);
  if (!asset) return { ok: false, message: 'No audio asset to transcribe; import a video or audio file with sound first.' };
  if (!asset.hasAudio) return { ok: false, message: `Asset ${asset.id} has no audio track.` };
  if (asset.durationUs <= 0) return { ok: false, message: 'Asset duration is unknown.' };

  const segments = await transcribeAsset(media, transcriber, asset.id, asset.durationUs, {
    language: opts.language,
    onProgress: opts.onProgress,
  });
  opts.onProgress?.(0.95, 'Generating caption track');
  const res = applyCaptions(store.dispatch, store.getState().doc, segments, {
    fontSize: opts.fontSize,
    color: opts.color,
  });
  if (!res) return { ok: false, message: 'No speech detected.' };
  return { ok: true, trackId: res.trackId, count: res.count };
}
