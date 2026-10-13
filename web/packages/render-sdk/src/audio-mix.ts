import type { TimeUs } from '@velocut/protocol';

export interface AudioClipPlan {
  assetId: string;
  startUs: TimeUs;
  durationUs: TimeUs;
  sourceInUs: TimeUs;
  gain: number;
  /** Constant source/timeline rate. Varispeed changes pitch as well as tempo. */
  speed?: number;
  /** Evaluated volume at clip-local timeline time; replaces gain when supplied. */
  gainAt?: (localUs: TimeUs) => number;
}

export interface AudioPcmSource {
  requestPcm(assetId: string, fromUs: number, durationUs: number): Promise<{
    startUs: number; sampleRate: number; channels: number;
    frames: number; planes: Float32Array[];
  }>;
}

/** Mix one bounded output window. Decoder padding is addressed by its timestamp,
 * not appended to the preceding window. Source reads stay bounded even at high speeds. */
export async function mixAudioWindow(
  media: AudioPcmSource, clips: AudioClipPlan[], startFrame: number, frames: number,
  sampleRate: number, channels: number, signal?: AbortSignal,
): Promise<Float32Array[]> {
  const output = Array.from({ length: channels }, () => new Float32Array(frames));
  const usPerFrame = 1e6 / sampleRate;
  for (const clip of clips) {
    const speed = clip.speed ?? 1;
    if (!Number.isFinite(speed) || speed <= 0) throw new Error('Audio clip speed must be positive and finite');
    const first = Math.max(startFrame, Math.ceil(clip.startUs / usPerFrame));
    const end = Math.min(startFrame + frames, Math.ceil((clip.startUs + clip.durationUs) / usPerFrame));
    // At most one second of source PCM per request, plus interpolation padding.
    const blockFrames = Math.max(1, Math.floor(sampleRate / speed));
    for (let a = first; a < end; a += blockFrames) {
      signal?.throwIfAborted();
      const b = Math.min(end, a + blockFrames);
      const sourceUs = clip.sourceInUs + (a * usPerFrame - clip.startUs) * speed;
      const pcm = await media.requestPcm(clip.assetId, sourceUs, (b - a - 1) * usPerFrame * speed + 1000);
      signal?.throwIfAborted();
      if (!pcm.frames || !pcm.channels) continue;
      for (let frame = a; frame < b; frame++) {
        const localUs = frame * usPerFrame - clip.startUs;
        const position = (clip.sourceInUs + localUs * speed - pcm.startUs) * pcm.sampleRate / 1e6;
        // startUs is rounded to µs by some decoders; tolerate sub-sample rounding.
        if (position < -pcm.sampleRate / 1e6 || position >= pcm.frames) continue;
        const pos = Math.max(0, position), i = Math.floor(pos), fraction = pos - i;
        const gain = Math.max(0, clip.gainAt?.(localUs) ?? clip.gain);
        for (let ch = 0; ch < channels; ch++) {
          const source = pcm.planes[Math.min(ch, pcm.channels - 1)];
          const sample = source[i] * (1 - fraction) + source[Math.min(i + 1, pcm.frames - 1)] * fraction;
          output[ch][frame - startFrame] += sample * gain;
        }
      }
    }
  }
  return output;
}
