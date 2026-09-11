import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, TsEngineAdapter } from '../dist/index.js';
import { createClipReferences } from '../dist/clip-references.js';

function fixture() {
  const store = new Store(new TsEngineAdapter('refs', 320, 180, 30, 1));
  store.dispatch({ type: 'addTrack', kind: 'video', name: 'Footage' });
  store.dispatch({ type: 'addAsset', kind: 'video', src: 'opfs://movie.mp4', name: 'Movie', durationUs: 12_000_000, width: 320, height: 180 });
  const trackId = store.getState().doc.tracks[0].id, assetId = store.getState().doc.assets[0].id;
  for (let i = 0; i < 4; i++) store.dispatch({ type: 'addClip', trackId, assetId, startUs: i * 2_000_000, durationUs: 2_000_000 });
  return { store, ids: store.getState().doc.tracks[0].clips.map(c => c.id) };
}

test('clip selection supports toggles and anchored ranges without document/history changes', () => {
  const { store, ids } = fixture();
  const before = JSON.stringify(store.getState().doc), revision = store.getState().revision;
  store.select(ids[0]); store.select(ids[2], 'toggle');
  assert.deepEqual(store.getState().selectedClipIds, [ids[0], ids[2]]);
  store.select(ids[0], 'toggle'); assert.deepEqual(store.getState().selectedClipIds, [ids[2]]);
  store.select(ids[0]); store.select(ids[3], 'range'); store.select(ids[2], 'range');
  assert.deepEqual(store.getState().selectedClipIds, ids.slice(0, 3));
  assert.equal(store.getState().selectedClipId, ids[2]);
  assert.equal(JSON.stringify(store.getState().doc), before); assert.equal(store.getState().revision, revision);
  store.select(null); assert.deepEqual(store.getState().selectedClipIds, []);
});

test('multi-delete is one undo step and selection drops removed clips', () => {
  const { store, ids } = fixture();
  store.select(ids[0]); store.select(ids[2], 'toggle');
  assert.equal(store.removeSelectedClips()!.ok, true);
  assert.deepEqual(store.getState().doc.tracks[0].clips.map(c => c.id), [ids[1], ids[3]]);
  assert.deepEqual(store.getState().selectedClipIds, []); assert.equal(store.getState().selectedClipId, null);
  store.undo(); assert.deepEqual(store.getState().doc.tracks[0].clips.map(c => c.id), ids);
  store.select(ids[0]); store.select(ids[1], 'toggle');
  store.dispatch({ type: 'setTrackLocked', trackId: store.getState().doc.tracks[0].id, locked: true });
  assert.equal(store.removeSelectedClips()!.ok, false);
  assert.deepEqual(store.getState().selectedClipIds, ids.slice(0, 2));
});

test('references capture stable metadata, detect edits/deletion, and remain session/project scoped', () => {
  const { store, ids } = fixture();
  const refs = createClipReferences(store), other = createClipReferences(fixture().store);
  const before = store.getState().revision;
  assert.equal(refs.capture(ids.slice(0, 3), 'session-a').ok, true);
  assert.equal(store.getState().revision, before);
  assert.equal(refs.read('session-b').reference, null); assert.equal(other.read('session-a').reference, null);
  let batch = refs.read('session-a').reference!;
  assert.equal(batch.capturedRevision, before); assert.equal(batch.clips.length, 3);
  assert.equal(batch.clips[0].captured.name, 'Movie'); assert.equal(batch.clips[1].captured.startUs, 2_000_000);
  assert.equal(refs.capture(['missing'], 'session-a').ok, false);
  assert.equal(refs.read('session-a').reference!.id, batch.id);
  // Content edits not visible in the compact timing metadata must still be marked.
  store.dispatch({ type: 'setClipVolume', clipId: ids[0], volume: 0.3 });
  store.dispatch({ type: 'removeClip', clipId: ids[1] });
  batch = refs.read('session-a').reference!;
  assert.deepEqual(batch.clips.map(c => c.status), ['changed', 'deleted', 'unchanged']);
  assert.equal(batch.clips[1].current, null);
  assert.equal(batch.clips[1].captured.clipId, ids[1]);
  batch.clips[0].captured.name = 'mutated result';
  assert.equal(refs.read('session-a').reference!.clips[0].captured.name, 'Movie');
  refs.capture([ids[3]], 'session-a'); assert.equal(refs.summary().referenceCount, 1);
  refs.clear(); assert.equal(refs.read('session-a').reference, null); assert.equal(refs.summary().referenceCount, 0);
});
