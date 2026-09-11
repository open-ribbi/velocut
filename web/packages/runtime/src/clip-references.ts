import type { Store } from './store';

function describeClip(store: Store, id: string) {
  const doc = store.getState().doc;
  const track = doc.tracks.find(t => t.clips.some(c => c.id === id));
  const clip = track?.clips.find(c => c.id === id);
  if (!clip || !track) return null;
  const asset = doc.assets.find(a => a.id === clip.assetId);
  return {
    clipId: id, assetId: clip.assetId, trackId: track.id, trackName: track.name,
    name: asset?.name ?? clip.text?.content ?? id, kind: track.kind,
    startUs: clip.startUs, durationUs: clip.durationUs, endUs: clip.startUs + clip.durationUs,
    sourceInUs: clip.sourceInUs, speed: clip.speed,
  };
}

/** One explicit, replaceable reference batch per paired page. Never chat delivery. */
export function createClipReferences(store: Store) {
  let batch: { id: string; sessionId: string; capturedAt: string; revision: number; clips: NonNullable<ReturnType<typeof describeClip>>[] } | null = null;
  // Fingerprints stay inside the page; detect edits beyond the compact summary.
  let fingerprints = new Map<string, string>();
  const fingerprint = (id: string) => {
    const doc = store.getState().doc;
    const track = doc.tracks.find(t => t.clips.some(c => c.id === id));
    const clip = track?.clips.find(c => c.id === id);
    return JSON.stringify([clip, track?.name, track?.muted, track?.locked, doc.assets.find(a => a.id === clip?.assetId)]);
  };
  return {
    summary: () => ({ referenceCount: batch?.clips.length ?? 0, referenceId: batch?.id ?? null }),
    clear: () => { batch = null; fingerprints.clear(); },
    capture(ids: string[], sessionId: string) {
      try {
        if (!sessionId || !Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length)
          throw new Error('reference 1..200 unique clips from the connected project');
        const clips = ids.map(id => { const clip = describeClip(store, id); if (!clip) throw new Error(`clip '${id}' no longer exists`); return clip; });
        batch = { id: crypto.randomUUID(), sessionId, capturedAt: new Date().toISOString(), revision: store.getState().revision, clips };
        fingerprints = new Map(ids.map(id => [id, fingerprint(id)]));
        return { ok: true as const, referenceId: batch.id, count: clips.length };
      } catch (error) { return { ok: false as const, message: error instanceof Error ? error.message : String(error) }; }
    },
    read(sessionId: string) {
      if (!batch || batch.sessionId !== sessionId) return { ok: true as const, reference: null };
      return { ok: true as const, reference: {
        id: batch.id, capturedAt: batch.capturedAt, capturedRevision: batch.revision,
        clips: batch.clips.map(captured => ({ captured: { ...captured },
          status: !describeClip(store, captured.clipId) ? 'deleted' : fingerprints.get(captured.clipId) === fingerprint(captured.clipId) ? 'unchanged' : 'changed',
          current: describeClip(store, captured.clipId),
        })),
      } };
    },
  };
}
