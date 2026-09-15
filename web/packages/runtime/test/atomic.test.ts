import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ops, ref, ATOMIC_COMMAND_SCHEMAS } from '@velocut/protocol';
import { Store, TsEngineAdapter, atomicRuntime, createAtomicRuntime, dispatchSceneAware, editScene } from '../dist/index.js';

function setup() {
  const store = new Store(new TsEngineAdapter('Atomic', 320, 180, 30, 1));
  store.dispatch({ type: 'addTrack', kind: 'video' });
  store.dispatch({ type: 'addAsset', kind: 'video', src: 'opfs://fixture.mp4', name: 'Fixture', durationUs: 10_000_000, width: 320, height: 180 });
  const trackId = store.getState().doc.tracks[0].id, assetId = store.getState().doc.assets[0].id;
  store.dispatch({ type: 'addClip', trackId, assetId, startUs: 0, durationUs: 10_000_000 });
  const clipId = store.getState().doc.tracks[0].clips[0].id;
  const runtime = atomicRuntime(store);
  return { store, runtime, trackId, assetId, clipId, plan: { runtimeId: runtime.runtimeId, expectedRevision: store.getState().revision } };
}
function value(result: any) { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; }

test('geometry queries are projected and snapshot-scoped; budget preflight needs no renderer', async () => {
  const { store, runtime } = setup();
  const geometry = { vertices: [[0,0,0],[1,0,0],[0,1,0]], faces: [[0,1,2]] };
  store.dispatch({ type: 'addAsset', kind: 'video', name: 'Tiles', src: 'scene://tiles', durationUs: 1_000_000, width: 320, height: 180,
    spec: JSON.stringify({ version: 1, durationUs: 1_000_000, geometries: { tile: geometry }, props: [{ id: 'a', model: 'prop/instance', geometryId: 'tile' }] }) });
  const assetId = store.getState().doc.assets.at(-1)!.id;
  const snapshot = value(runtime.query({ kind: 'snapshot' }));
  const list = value(runtime.query({ kind: 'sceneGeometries', assetId }));
  assert.deepEqual(list.items, [{ id: 'tile', vertexCount: 3, triangleCount: 1, instanceCount: 1 }]);
  const read = value(runtime.query({ kind: 'sceneGeometries', assetId, fields: ['id', 'geometry'] }));
  assert.deepEqual(read.items[0].geometry, geometry);
  read.items[0].geometry.vertices[0][0] = 42;
  assert.equal(value(runtime.query({ kind: 'sceneGeometries', assetId, fields: ['geometry'] })).items[0].geometry.vertices[0][0], 0);
  assert.equal(value(runtime.query({ kind: 'sceneObjects', assetId })).items[0].geometryId, 'tile');
  const revision = store.getState().revision;
  const edits = [{ type: 'duplicate' as const, id: 'a', newId: 'b' }];
  const preview: any = await editScene(store, { assetId, edits, expectedRevision: revision, preflight: true });
  assert.equal(preview.ok, true); assert.equal(preview.compiled, false); assert.equal(preview.spec, undefined);
  assert.equal(preview.budget.used.instances, 2); assert.equal(store.getState().revision, revision);
  assert.equal((await editScene(store, { assetId, edits, preflight: true, dryRun: true })).ok, false);
  const stale = await editScene(store, { assetId, edits, expectedRevision: revision - 1, preflight: true });
  assert.equal(stale.ok, false);
  const rejected: any = await editScene(store, { assetId, preflight: true, edits: [{ type: 'geometry.update', id: 'tile', geometry: { ...geometry, name: 'x'.repeat(300000) } as any }] });
  assert.equal(rejected.ok, false); assert.equal(rejected.budget.withinLimits, false);
  store.undo();
  assert.equal(value(runtime.query({ kind: 'sceneBudget', assetId, snapshotId: snapshot.snapshotId })).used.instances, 1);
  assert.equal(runtime.query({ kind: 'sceneBudget', assetId }).ok, false);
  assert.equal(runtime.query({ kind: 'sceneBudget', assetId, fields: ['instances'] }).ok, false);
});

test('catalog schemas come from protocol and do not expose functions; builders only create data', () => {
  const { runtime, store } = setup();
  const revision = store.getState().revision;
  const list = value(runtime.capabilities({ namespace: 'commands' }));
  assert.deepEqual(list.items.map((c: any) => c.name).sort(), Object.keys(ATOMIC_COMMAND_SCHEMAS).sort());
  const split = value(runtime.capabilities({ name: 'splitClip' }));
  assert.equal(split.inputSchema.properties.type.const, 'splitClip');
  assert.ok(split.inputSchema.required.includes('atUs'));
  assert.ok(split.inputSchema.properties.clipId.anyOf.some((s: any) => s.properties?.$ref));
  assert.deepEqual(split.resultSchema.required, ['leftClipId', 'rightClipId']);
  assert.ok(value(runtime.capabilities({ name: 'transaction' })).inputSchema);
  assert.equal(value(runtime.capabilities({ name: 'videoGen' })).available, false);
  assert.equal(value(runtime.capabilities({ name: 'motionClip' }, { transport: 'editor-script' })).available, true);
  assert.equal(value(runtime.capabilities({ name: 'motionClip' }, { transport: 'mcp' })).available, false);
  const command = ops.moveClip({ clipId: ref('split', 'rightClipId'), startUs: 3 });
  assert.deepEqual(command, { type: 'moveClip', clipId: { $ref: { operationId: 'split', field: 'rightClipId' } }, startUs: 3 });
  assert.equal(store.getState().revision, revision);
});

test('snapshot pagination/projection stays stable after edits and returned objects cannot mutate state', () => {
  const { runtime, store, clipId } = setup();
  const snapshot = runtime.query({ kind: 'snapshot' });
  const snapshotId = value(snapshot).snapshotId;
  store.dispatch({ type: 'splitClip', clipId, atUs: 3_000_000 });
  const old = runtime.query({ kind: 'clips', snapshotId, fields: ['id', 'durationUs'] });
  assert.equal(old.revision, snapshot.revision);
  assert.deepEqual(value(old).items, [{ id: clipId, durationUs: 10_000_000 }]);
  const page = value(runtime.query({ kind: 'clips', limit: 1, fields: ['id', 'transform'] }));
  assert.equal(page.total, 2); assert.equal(page.nextOffset, 1);
  page.items[0].transform.x = 999;
  assert.equal(store.getState().doc.tracks[0].clips[0].transform.x, 0);
  assert.equal(value(runtime.query({ kind: 'clips', fromUs: 3_000_000 })).items.length, 1);
  assert.equal(value(runtime.query({ kind: 'clips', toUs: 3_000_000 })).items.length, 1);
  assert.equal(runtime.query({ kind: 'assets', fields: ['password'] }).ok, false);
  assert.equal(runtime.query({ kind: 'selection', snapshotId }).ok, false);
  for (let i = 0; i < 8; i++) value(runtime.query({ kind: 'snapshot' }));
  const expired: any = runtime.query({ kind: 'clips', snapshotId });
  assert.equal(expired.error.code, 'snapshotExpired');
});

test('dependent splits and removal validate without mutations, commit once and undo as one step', async () => {
  const { runtime, store, clipId, plan } = setup();
  const before = JSON.stringify(store.getState().doc), count = store.getHistory().all().length;
  const operations = [
    { id: 'start', command: ops.splitClip({ clipId, atUs: 2_000_000 }) },
    { id: 'end', command: ops.splitClip({ clipId: ref('start', 'rightClipId'), atUs: 4_000_000 }) },
    { id: 'remove', command: ops.removeClip({ clipId: ref('end', 'leftClipId') }) },
    { id: 'close', command: ops.moveClip({ clipId: ref('end', 'rightClipId'), startUs: 2_000_000 }) },
  ];
  const preview = value(await runtime.transaction({ action: 'validate', ...plan, operations }));
  assert.equal(preview.state, 'validated');
  assert.equal(JSON.stringify(store.getState().doc), before); assert.equal(store.getHistory().all().length, count);
  const request = { action: 'commit', requestId: 'cut-1', ...plan, operations };
  const [one, two] = await Promise.all([runtime.transaction(request), runtime.transaction(request)]);
  assert.deepEqual(one, two); assert.equal(value(one).state, 'committed');
  assert.deepEqual(value(one).results, preview.results);
  assert.equal(store.getHistory().all().length, count + 1);
  assert.deepEqual(store.getState().doc.tracks[0].clips.map(c => [c.startUs, c.durationUs, c.sourceInUs]), [[0, 2_000_000, 0], [2_000_000, 6_000_000, 4_000_000]]);
  const status = value(await runtime.transaction({ action: 'status', runtimeId: plan.runtimeId, requestId: 'cut-1' }));
  assert.deepEqual(status.result, one);
  store.undo(); assert.equal(JSON.stringify(store.getState().doc), before);
  assert.deepEqual(await runtime.transaction(request), one);
  assert.equal(JSON.stringify(store.getState().doc), before); // Retry never redoes an undone write.
  const mismatch: any = await runtime.transaction({ ...request, expectedRevision: store.getState().revision });
  assert.equal(mismatch.error.code, 'requestConflict');
});

test('creation results include track, clip, asset and effect IDs without predicting nextId', async () => {
  const { runtime, plan } = setup();
  const data = value(await runtime.transaction({ action: 'commit', requestId: 'create', ...plan, operations: [
    { id: 'asset', command: ops.addAsset({ kind: 'image', src: 'opfs://image.png', name: 'Image' }) },
    { id: 'track', command: ops.addTrack({ kind: 'video' }) },
    { id: 'clip', command: ops.addClip({ assetId: ref('asset', 'assetId'), trackId: ref('track', 'trackId'), startUs: 0, durationUs: 1_000_000 }) },
    { id: 'effect', command: ops.addEffect({ clipId: ref('clip', 'clipId'), effect: 'blur', params: { radius: 4 } }) },
    { id: 'update', command: ops.setEffectParams({ clipId: ref('clip', 'clipId'), effectId: ref('effect', 'effectId'), params: { radius: 2 } }) },
  ] }));
  assert.ok(data.results.effect.effectId);
  assert.ok(data.changes.assets.created.includes(data.results.asset.assetId));
  assert.ok(data.changes.clips.created.includes(data.results.clip.clipId));
});

test('bad references, locked edits, schema errors and restrictions never partially commit', async () => {
  const { store, runtime, clipId, trackId, plan } = setup();
  const before = JSON.stringify(store.getState().doc);
  const bad = [
    { id: 'second', command: ops.removeClip({ clipId: ref('future', 'clipId') }) },
    { id: 'second', command: { type: 'batch', commands: [] } },
    { id: 'second', command: { type: 'setClipVolume', clipId, volum: 2 } },
    { id: 'second', command: ops.addAsset({ name: 'Remote', kind: 'image', src: 'https://example.com/file' }) },
    { id: 'second', command: { type: 'removeClip', clipId: { $ref: { operationId: 'first', field: '__proto__' } } } },
  ];
  for (const [i, operation] of bad.entries()) {
    const r: any = await runtime.transaction({ action: 'commit', requestId: `bad-${i}`, ...plan, operations: [{ id: 'first', command: ops.setClipVolume({ clipId, volume: 0.2 }) }, operation] });
    assert.equal(r.ok, false); assert.equal(r.error.operationIndex, 1); assert.equal(r.error.operationId, 'second');
    assert.equal(r.error.outcome, 'not_committed'); assert.equal(JSON.stringify(store.getState().doc), before);
  }
  store.dispatch(ops.setTrackLocked({ trackId, locked: true }) as any);
  const locked: any = await runtime.transaction({ action: 'commit', requestId: 'locked', ...plan, expectedRevision: store.getState().revision, operations: [{ id: 'remove', command: ops.removeClip({ clipId }) }] });
  assert.equal(locked.error.code, 'locked');
});

test('runtime guards, stale revisions and competing requests preserve explicit outcomes', async () => {
  const { store, runtime, clipId, plan } = setup();
  const operations = [{ id: 'edit', command: ops.setClipVolume({ clipId, volume: 0.4 }) }];
  const replies = await Promise.all(['a', 'b'].map(requestId => runtime.transaction({ ...plan, action: 'commit', requestId, operations })));
  assert.equal(replies.filter(r => r.ok).length, 1);
  assert.equal((replies.find(r => !r.ok) as any).error.code, 'conflict');
  const other = createAtomicRuntime(store);
  const stale: any = await other.transaction({ ...plan, action: 'commit', requestId: 'a', operations });
  assert.equal(stale.error.code, 'staleRuntime'); assert.equal(stale.error.outcome, 'unknown');
  assert.equal(value(await other.transaction({ action: 'status', runtimeId: other.runtimeId, requestId: 'a' })).state, 'unknown');
  const abort = new AbortController(); abort.abort();
  const cancelled: any = await runtime.transaction({ ...plan, expectedRevision: store.getState().revision, action: 'commit', requestId: 'cancel', operations }, { signal: abort.signal });
  assert.equal(cancelled.ok, false); assert.equal(cancelled.error.outcome, 'not_committed');
});

test('dry-run rejects malformed commands, while uncertain post-commit failures are retained without replay', async () => {
  const { runtime, store, clipId, trackId, plan } = setup();
  const malformed = await dispatchSceneAware(store, { type: 'setTrackLocked', trackId, locked: 'yes' } as any, undefined, { dryRun: true });
  assert.equal(malformed.ok, false); assert.equal(store.getState().revision, plan.expectedRevision);
  const request = { ...plan, action: 'commit', requestId: 'uncertain', operations: [{ id: 'volume', command: ops.setClipVolume({ clipId, volume: 0.7 }) }] };
  let writes = 0;
  const options = { dispatch: (c: any) => { writes++; store.dispatch(c); throw new Error('result delivery failed'); } };
  const result: any = await runtime.transaction(request, options);
  assert.equal(result.ok, false); assert.equal(result.error.outcome, 'unknown');
  assert.equal(store.getState().doc.tracks[0].clips[0].volume, 0.7);
  assert.deepEqual(await runtime.transaction(request, options), result); assert.equal(writes, 1);
});
