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
  if (!text) return { ok: false, message: 'Narration text is empty.' };

  const { samples, sampleRate } = await tts.synthesize(text, { language: opts.language });
  if (!samples?.length) return { ok: false, message: 'Speech synthesis produced no output.' };
  const durationUs = Math.round((samples.length / sampleRate) * 1e6);

  // Waveform → AudioBuffer → OPFS PCM (the same path imported music takes).
  audioCtx ??= new AudioContext();
  const buffer = audioCtx.createBuffer(1, samples.length, sampleRate);
  buffer.getChannelData(0).set(samples);

  // Resolve the narration track (create one named Narration if absent). Also
  // match '\u65c1\u767d' ("pangbai" — the legacy Chinese "Narration" track
  // name) so documents created before the English rename keep working.
  let trackId = opts.trackId;
  if (!trackId) {
    const existing = store
      .getState()
      .doc.tracks.find((t) => t.kind === 'audio' && (t.name === 'Narration' || t.name === '\u65c1\u767d'));
    if (existing) trackId = existing.id;
    else {
      const r = store.dispatch({ type: 'addTrack', kind: 'audio', name: 'Narration' });
      const ev = r.ok ? r.events.find((e) => e.kind === 'trackAdded') : undefined;
      trackId = ev?.kind === 'trackAdded' ? ev.trackId : undefined;
    }
  }
  if (!trackId) return { ok: false, message: 'Failed to create the Narration track.' };

  // Placement: explicit atUs, else append after the track's last clip.
  const track = store.getState().doc.tracks.find((t) => t.id === trackId);
  const atUs = opts.atUs ?? Math.max(0, ...(track?.clips.map((c) => c.startUs + c.durationUs) ?? [0]));

  const aResp = store.dispatch({
    type: 'addAsset',
    kind: 'audio',
    src: `opfs://tts/${encodeURIComponent(text.slice(0, 24))}`,
    name: `Narration: ${text.slice(0, 16)}`,
    durationUs,
    width: 0,
    height: 0,
    hasAudio: true,
  });
  const aEv = aResp.ok ? aResp.events.find((e) => e.kind === 'assetAdded') : undefined;
  const assetId = aEv?.kind === 'assetAdded' ? aEv.assetId : undefined;
  if (!assetId) return { ok: false, message: 'Failed to register the audio asset.' };
  await media.attachAudio(assetId, buffer);

  const cResp = store.dispatch({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs });
  if (!cResp.ok) return { ok: false, message: `Failed to place the clip on the track: ${cResp.error ?? ''}` };
  const cEv = cResp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;
  return { ok: true, assetId, clipId, trackId, durationUs, atUs };
}
