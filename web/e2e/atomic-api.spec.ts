import { test, expect } from './test-fixtures';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

test('MCP CodeAct discovers schemas, queries a snapshot and composes an idempotent undoable cut', async ({ page }) => {
  const client = new Client({ name: 'atomic-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')], stderr: 'pipe' }));
  const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  try {
    await page.goto((await tool('velocut_connect')).structuredContent.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const capabilities = (await tool('velocut_capabilities', { sessionId, name: 'splitClip' })).structuredContent;
    expect(capabilities.data.inputSchema.properties.type.const).toBe('splitClip');
    const made = (await tool('velocut_scene_create', { sessionId, spec: { version: 1, durationUs: 10_000_000, width: 320, height: 180 } })).structuredContent;
    const snapshot = (await tool('velocut_query', { sessionId, kind: 'snapshot' })).structuredContent;
    const fromWindow = await page.evaluate(snapshotId => (window as any).velocut.query({ kind: 'clips', snapshotId, fields: ['id', 'durationUs'] }), snapshot.data.snapshotId);
    expect(fromWindow.runtimeId).toBe(snapshot.runtimeId); expect(fromWindow.data.items[0].id).toBe(made.clipId);
    const code = `
      const snapshot = await velocut.query({kind:'snapshot'});
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      const clips = await velocut.query({kind:'clips',snapshotId:snapshot.data.snapshotId,fields:['id']});
      const clipId=clips.data.items[0].id;
      const operations=[
        {id:'a',command:velocut.ops.splitClip({clipId,atUs:2000000})},
        {id:'b',command:velocut.ops.splitClip({clipId:velocut.ref('a','rightClipId'),atUs:4000000})},
        {id:'c',command:velocut.ops.removeClip({clipId:velocut.ref('b','leftClipId')})},
        {id:'d',command:velocut.ops.moveClip({clipId:velocut.ref('b','rightClipId'),startUs:2000000})}
      ];
      const plan={runtimeId:snapshot.runtimeId,expectedRevision:snapshot.revision,operations};
      const validation=await velocut.transaction({action:'validate',...plan});
      if(!validation.ok)throw new Error(validation.error.message);
      const commit=await velocut.transaction({action:'commit',requestId:'cut-test',...plan});
      return {validation,commit,plan};
    `;
    const scripted = (await tool('velocut_script', { sessionId, code })).structuredContent;
    expect(scripted.ok, JSON.stringify(scripted)).toBe(true);
    const { commit, plan, validation } = scripted.result;
    expect(validation.data.state).toBe('validated'); expect(commit.data.state).toBe('committed');
    const replay = (await tool('velocut_transaction', { sessionId, action: 'commit', requestId: 'cut-test', ...plan })).structuredContent;
    expect(replay.data).toEqual(commit.data); expect(replay.revision).toBe(commit.revision);
    const ids = (await tool('velocut_query', { sessionId, kind: 'clips' })).structuredContent.data.items;
    expect(ids.map((c: any) => [c.startUs, c.durationUs])).toEqual([[0, 2_000_000], [2_000_000, 6_000_000]]);
    const status = (await tool('velocut_transaction', { sessionId, action: 'status', runtimeId: plan.runtimeId, requestId: 'cut-test' })).structuredContent;
    expect(status.data.result.ok).toBe(true);
    const actors = await page.evaluate(() => (window as any).velocut.store.getHistory().all().filter((n: any) => n.actor.name === 'Codex'));
    expect(actors).toHaveLength(2); // scene creation + one composed cut
    await tool('velocut_history', { sessionId, action: 'undo', expectedRevision: commit.revision });
    expect((await tool('velocut_query', { sessionId, kind: 'clips' })).structuredContent.data.items).toHaveLength(1);
    const observed = await tool('velocut_observe', { sessionId, mode: 'shots', source: { assetId: 'missing' } });
    expect(observed.isError).toBe(true); // mode reaches the host instead of failing MCP schema validation
    expect(JSON.stringify(observed)).not.toMatch(/Input validation error/);
    await page.reload(); await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const nextSession = (await tool('velocut_sessions')).structuredContent.sessions.find((s: any) => s.sessionId !== sessionId);
    const stale = (await tool('velocut_transaction', { sessionId: nextSession.sessionId, action: 'commit', requestId: 'cut-test', ...plan })).structuredContent;
    expect(stale.error.code).toBe('staleRuntime'); expect(stale.error.outcome).toBe('unknown');
  } finally { await client.close(); }
});

test('scene transaction validation compiles resources and never leaves tracks/assets behind on failure', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.transaction);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const s = v.query({ kind: 'snapshot' });
    const plan = (model: string) => ({ runtimeId: s.runtimeId, expectedRevision: s.revision, operations: [
      { id: 'track', command: v.ops.addTrack({ kind: 'video' }) },
      { id: 'asset', command: v.ops.addAsset({ kind: 'image', name: 'Atomic scene', src: 'scene://atomic', durationUs: 1_000_000, width: 320, height: 180, spec: JSON.stringify({ version: 1, durationUs: 1_000_000, width: 320, height: 180, props: [{ id: 'cube', model }] }) }) },
      { id: 'clip', command: v.ops.addClip({ trackId: v.ref('track', 'trackId'), assetId: v.ref('asset', 'assetId'), startUs: 0, durationUs: 1_000_000 }) },
    ] });
    const before = JSON.stringify(v.doc()), history = v.store.getHistory().all().length;
    const failed = await v.transaction({ action: 'commit', requestId: 'bad-scene', ...plan('prop/missing') });
    const preview = await v.transaction({ action: 'validate', ...plan('prop/cube') });
    const unchanged = JSON.stringify(v.doc()), historyAfter = v.store.getHistory().all().length;
    const committed = await v.transaction({ action: 'commit', requestId: 'scene', ...plan('prop/cube') });
    const assetId = committed.data.results.asset.assetId;
    const inspection = await v.sceneInspect({ assetId });
    v.undo(); return { before, failed, preview, unchanged, history, historyAfter, committed, inspection, undone: JSON.stringify(v.doc()) };
  });
  expect(r.failed.ok).toBe(false); expect(r.failed.error.outcome).toBe('not_committed');
  expect(r.failed.error.message).toMatch(/unknown prop/);
  expect(r.preview.ok, JSON.stringify(r.preview)).toBe(true); expect(r.unchanged).toBe(r.before); expect(r.historyAfter).toBe(r.history);
  expect(r.committed.ok).toBe(true); expect(r.inspection.objects.some((o: any) => o.id === 'cube')).toBe(true); expect(r.undone).toBe(r.before);
});

test('disconnect cancels a compiling transaction and its receipt remains queryable in the same runtime', async ({ page }) => {
  const client = new Client({ name: 'atomic-cancel', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')], stderr: 'pipe' }));
  const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const requested = new Promise<void>(r => { arrived = r; });
  await page.route('**/scene-assets/manifest.json', async route => { arrived(); await gate; await route.continue(); });
  try {
    await page.goto((await tool('velocut_connect')).structuredContent.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const snap = (await tool('velocut_query', { sessionId, kind: 'snapshot' })).structuredContent;
    const pending = tool('velocut_transaction', { sessionId, action: 'commit', runtimeId: snap.runtimeId, expectedRevision: snap.revision, requestId: 'cancel-scene', operations: [{
      id: 'asset', command: { type: 'addAsset', kind: 'image', name: 'Pending', src: 'scene://pending', durationUs: 1_000_000,
        spec: JSON.stringify({ version: 1, durationUs: 1_000_000, width: 320, height: 180 }) },
    }] });
    await requested;
    const status = await page.evaluate(runtimeId => (window as any).velocut.transaction({ action: 'status', runtimeId, requestId: 'cancel-scene' }), snap.runtimeId);
    expect(status.data.state).toBe('pending');
    await page.evaluate(() => (window as any).velocut.codex.disconnect());
    release(); expect((await pending).isError).toBe(true);
    await expect.poll(() => page.evaluate(async runtimeId => (await (window as any).velocut.transaction({ action: 'status', runtimeId, requestId: 'cancel-scene' })).data.state, snap.runtimeId)).toBe('completed');
    const final = await page.evaluate(async runtimeId => ({
      status: await (window as any).velocut.transaction({ action: 'status', runtimeId, requestId: 'cancel-scene' }),
      doc: (window as any).velocut.doc(),
    }), snap.runtimeId);
    expect(final.status.data.result.ok).toBe(false);
    expect(final.status.data.result.error.outcome).toBe('not_committed');
    expect(final.doc.assets).toHaveLength(0);
  } finally { release(); await client.close(); }
});
