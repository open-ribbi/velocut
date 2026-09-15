import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, TsEngineAdapter, atomicRuntime, configureMediaResources } from '../dist/index.js';
import { ops, ref } from '@velocut/protocol';

const info = { kind: 'image' as const, format: 'png', width: 16, height: 16, durationUs: 0, hasAudio: false, tracks: [] };
function fixture(options: { write?: (name: string, data: Blob) => Promise<void>; probe?: (file: File, signal: AbortSignal) => Promise<typeof info> } = {}) {
  const store = new Store(new TsEngineAdapter('Resources', 320, 180, 30, 1));
  const files = new Map<string, Blob>();
  configureMediaResources(store, { storage: {
    write: async (name, data) => { files.set(name, data); await options.write?.(name, data); },
    read: async name => files.get(name) ?? null,
    remove: async name => { files.delete(name); },
  }, probe: options.probe ?? (async () => info) });
  const api = atomicRuntime(store);
  return { store, files, api, runtimeId: api.runtimeId };
}
function data(r: any): any { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; }
async function finish(api: ReturnType<typeof atomicRuntime>, jobId: string) {
  for (let i = 0; i < 300; i++) {
    const job = data(api.jobs({ action: 'get', runtimeId: api.runtimeId, jobId }));
    if (['succeeded', 'failed', 'cancelled'].includes(job.state)) return job;
    await new Promise(r => setTimeout(r, 1));
  }
  throw new Error('job did not finish');
}
async function imported(f: ReturnType<typeof fixture>, requestId = 'import') {
  const job = data(await f.api.resources({ action: 'import', runtimeId: f.runtimeId, requestId, file: new File(['image bytes'], 'same.png', { type: 'image/png' }) }));
  const done = await finish(f.api, job.id); assert.equal(done.state, 'succeeded');
  return { job, resource: done.result.resource };
}

test('import/probe/register/insert are independent; registration and duplicate compose in one transaction', async () => {
  const f = fixture(), { resource } = await imported(f);
  assert.equal(f.store.getState().doc.assets.length, 0); assert.equal(f.store.getHistory().all().length, 1);
  const probe = data(f.api.jobs({ action: 'submit', runtimeId: f.runtimeId, requestId: 'probe', task: 'media.probe', resourceId: resource.id }));
  const done = await finish(f.api, probe.id); assert.equal(done.state, 'succeeded');
  assert.equal(done.result.metadata.width, 16); assert.equal(f.store.getState().doc.tracks.length, 0);
  const before = JSON.stringify(f.store.getState().doc), expectedRevision = f.store.getState().revision;
  const operations = [
    { id: 'asset', command: ops.registerAsset({ resourceId: resource.id, probeId: probe.id }) },
    { id: 'track', command: ops.addTrack({ kind: 'video' }) },
    { id: 'clip', command: ops.addClip({ assetId: ref('asset', 'assetId'), trackId: ref('track', 'trackId'), startUs: 0, durationUs: 1_000_000 }) },
    { id: 'style', command: ops.setClipVolume({ clipId: ref('clip', 'clipId'), volume: 0.7 }) },
    { id: 'copy', command: ops.duplicateClip({ clipId: ref('clip', 'clipId') }) },
  ];
  data(await f.api.transaction({ action: 'validate', runtimeId: f.runtimeId, expectedRevision, operations }));
  assert.equal(JSON.stringify(f.store.getState().doc), before);
  const committed = data(await f.api.transaction({ action: 'commit', runtimeId: f.runtimeId, expectedRevision, requestId: 'edit', operations }));
  assert.notEqual(committed.results.copy.clipId, committed.results.clip.clipId);
  assert.equal(f.store.getState().doc.tracks[0].clips[1].volume, 0.7);
  assert.equal(f.store.getState().doc.assets[0].src, resource.src);
  f.store.undo(); assert.equal(JSON.stringify(f.store.getState().doc), before);
  assert.equal(f.files.size, 1); // Undo never deletes imported source bytes.
});

test('resource/job request IDs are idempotent, filenames cannot overwrite earlier imports and old handles are scoped', async () => {
  const f = fixture(), a = await imported(f);
  const again = await imported(f); assert.equal(again.job.id, a.job.id); assert.equal(f.files.size, 1);
  const b = await imported(f, 'another'); assert.notEqual(a.resource.src, b.resource.src); assert.equal(f.files.size, 2);
  const collision: any = await f.api.resources({ action: 'import', runtimeId: f.runtimeId, requestId: 'import', file: new File(['different bytes'], 'same.png', { type: 'image/png' }) });
  assert.equal(collision.error.code, 'requestConflict');
  const other = fixture();
  assert.equal((await other.api.resources({ action: 'get', runtimeId: f.runtimeId, resourceId: a.resource.id }) as any).error.code, 'staleRuntime');
  assert.equal((await other.api.resources({ action: 'get', runtimeId: other.runtimeId, resourceId: a.resource.id }) as any).error.code, 'notFound');
  data(f.api.jobs({ action: 'cancel', runtimeId: f.runtimeId, jobId: a.job.id })); assert.equal(f.files.size, 2);
});

test('cancelled imports remove partial bytes and never publish a resource or document entity', async () => {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const f = fixture({ write: async () => gate });
  const job = data(await f.api.resources({ action: 'import', runtimeId: f.runtimeId, requestId: 'cancel', file: new File(['bytes'], 'clip.bin') }));
  await new Promise(r => setTimeout(r, 0));
  assert.equal(f.files.size, 1);
  const cancelled = data(f.api.jobs({ action: 'cancel', runtimeId: f.runtimeId, jobId: job.id }));
  assert.equal(cancelled.state, 'cancel_requested'); release();
  assert.equal((await finish(f.api, job.id)).state, 'cancelled'); assert.equal(f.files.size, 0);
  assert.equal(data(await f.api.resources({ action: 'list', runtimeId: f.runtimeId })).total, 0);
  assert.equal(f.store.getState().doc.assets.length, 0);
});

test('queued probe cancellation does not start work; failed probes cannot register assets', async () => {
  let release!: () => void, probes = 0;
  const gate = new Promise<void>(r => { release = r; });
  const f = fixture({ probe: async () => { probes++; await gate; throw new Error('corrupt media'); } });
  const { resource } = await imported(f);
  const submit = (requestId: string) => data(f.api.jobs({ action: 'submit', runtimeId: f.runtimeId, requestId, task: 'media.probe', resourceId: resource.id }));
  const a = submit('a'), b = submit('b'), c = submit('c');
  await new Promise(r => setTimeout(r, 10));
  assert.equal(data(f.api.jobs({ action: 'cancel', runtimeId: f.runtimeId, jobId: c.id })).state, 'cancelled');
  release(); assert.equal((await finish(f.api, a.id)).state, 'failed'); await finish(f.api, b.id); assert.equal(probes, 2);
  const result: any = await f.api.transaction({ action: 'commit', runtimeId: f.runtimeId, expectedRevision: f.store.getState().revision, requestId: 'register', operations: [{ id: 'asset', command: ops.registerAsset({ resourceId: resource.id, probeId: a.id }) }] });
  assert.equal(result.ok, false); assert.equal(result.error.outcome, 'not_committed'); assert.equal(f.store.getState().doc.assets.length, 0);
});

test('registration rechecks resource bytes and failed storage never leaves a partial file', async () => {
  const f = fixture(), { resource } = await imported(f);
  const probe = data(f.api.jobs({ action: 'submit', runtimeId: f.runtimeId, requestId: 'probe', task: 'media.probe', resourceId: resource.id })); await finish(f.api, probe.id);
  f.files.set(resource.src.slice(7), new Blob(['modified']));
  const rejected: any = await f.api.transaction({ action: 'validate', runtimeId: f.runtimeId, expectedRevision: 0, operations: [{ id: 'asset', command: ops.registerAsset({ resourceId: resource.id, probeId: probe.id }) }] });
  assert.equal(rejected.error.code, 'resourceChanged');
  const failed = fixture({ write: async () => { throw new Error('storage quota'); } });
  const j = data(await failed.api.resources({ action: 'import', runtimeId: failed.runtimeId, requestId: 'fail', file: new File(['bytes'], 'file') }));
  assert.equal((await finish(failed.api, j.id)).state, 'failed'); assert.equal(failed.files.size, 0);
});
