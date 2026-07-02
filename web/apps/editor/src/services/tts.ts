// services/tts.ts — glue for the generative narration pipeline.
//
// Synthesize one line of narration, then lay it down as a normal audio asset +
// clip (OPFS-backed PCM, like imported audio) so it mixes, exports, and undoes
// like everything else. Shared by the agent's velocut_tts tool and
// window.velocut.tts. Mirrors services/caption.ts.

import type { MediaLibrary, TextToSpeech } from '@velocut/render-sdk';
import type { Store } from '../state/store';

export interface TtsResult {
  ok: boolean;
  assetId?: string;
  clipId?: string;
  trackId?: string;
  durationUs?: number;
  atUs?: number;
  message?: string;
}

let audioCtx: AudioContext | null = null;

export async function synthesizeNarration(
  store: Store,
  media: MediaLibrary,
  tts: TextToSpeech,
  opts: { text: string; atUs?: number; trackId?: string; language?: string },
): Promise<TtsResult> {
  const text = opts.text?.trim();
  if (!text) return { ok: false, message: '旁白文本为空。' };

  const { samples, sampleRate } = await tts.synthesize(text, { language: opts.language });
  if (!samples?.length) return { ok: false, message: '语音合成无输出。' };
  const durationUs = Math.round((samples.length / sampleRate) * 1e6);

  // Waveform → AudioBuffer → OPFS PCM (the same path imported music takes).
  audioCtx ??= new AudioContext();
  const buffer = audioCtx.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);

  // Resolve the narration track (create one named 旁白 if absent).
  let trackId = opts.trackId;
  if (!trackId) {
    const existing = store.getState().doc.tracks.find((t) => t.kind === 'audio' && t.name === '旁白');
    if (existing) trackId = existing.id;
    else {
      const r = store.dispatch({ type: 'addTrack', kind: 'audio', name: '旁白' });
      const ev = r.ok ? r.events.find((e) => e.kind === 'trackAdded') : undefined;
      trackId = ev?.kind === 'trackAdded' ? ev.trackId : undefined;
    }
  }
  if (!trackId) return { ok: false, message: '无法创建旁白轨。' };

  // Placement: explicit atUs, else append after the track's last clip.
  const track = store.getState().doc.tracks.find((t) => t.id === trackId);
  const atUs = opts.atUs ?? Math.max(0, ...(track?.clips.map((c) => c.startUs + c.durationUs) ?? [0]));

  const aResp = store.dispatch({
    type: 'addAsset',
    kind: 'audio',
    src: `opfs://tts/${encodeURIComponent(text.slice(0, 24))}`,
    name: `旁白:${text.slice(0, 16)}`,
    durationUs,
    width: 0,
    height: 0,
    hasAudio: true,
  });
  const aEv = aResp.ok ? aResp.events.find((e) => e.kind === 'assetAdded') : undefined;
  const assetId = aEv?.kind === 'assetAdded' ? aEv.assetId : undefined;
  if (!assetId) return { ok: false, message: '登记音频素材失败。' };
  await media.attachAudio(assetId, buffer);

  const cResp = store.dispatch({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs });
  if (!cResp.ok) return { ok: false, message: `上轨失败:${cResp.error ?? ''}` };
  const cEv = cResp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;
  return { ok: true, assetId, clipId, trackId, durationUs, atUs };
}
