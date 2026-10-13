import { evalKeyframes } from '@velocut/core-ts';
import type { VDocument } from '@velocut/protocol';
import type { AudioClipPlan } from '@velocut/render-sdk';

/** Capture immutable audio settings at export start, including volume automation. */
export function exportAudioPlan(doc: VDocument): AudioClipPlan[] {
  const assets = new Map(doc.assets.map(asset => [asset.id, asset]));
  return doc.tracks.filter(track => !track.muted).flatMap(track => track.clips.flatMap(clip => {
    const asset = clip.assetId ? assets.get(clip.assetId) : null;
    if (!asset?.hasAudio || !['video', 'audio'].includes(asset.kind)) return [];
    const volume = clip.volume;
    const keyframes = structuredClone(clip.keyframes.volume ?? []);
    return [{
      assetId: asset.id, startUs: clip.startUs, durationUs: clip.durationUs,
      sourceInUs: clip.sourceInUs, speed: clip.speed, gain: volume,
      ...(keyframes.length ? { gainAt: (localUs: number) => evalKeyframes(keyframes, localUs) ?? volume } : {}),
    }];
  }));
}
