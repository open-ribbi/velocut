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
  if (!asset) return { ok: false, message: '没有可识别的音频素材;请先导入带声音的视频或音频。' };
  if (!asset.hasAudio) return { ok: false, message: `素材 ${asset.id} 没有音轨。` };
  if (asset.durationUs <= 0) return { ok: false, message: '素材时长未知。' };

  const segments = await transcribeAsset(media, transcriber, asset.id, asset.durationUs, {
    language: opts.language,
    onProgress: opts.onProgress,
  });
  opts.onProgress?.(0.95, '生成字幕轨');
  const res = applyCaptions(store.dispatch, store.getState().doc, segments, {
    fontSize: opts.fontSize,
    color: opts.color,
  });
  if (!res) return { ok: false, message: '未识别到语音内容。' };
  return { ok: true, trackId: res.trackId, count: res.count };
}
