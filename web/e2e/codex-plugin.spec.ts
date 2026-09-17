import { test, expect } from './test-fixtures';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { modelFixture } from '../packages/scene-sdk/test/glb-fixture';

async function mcp() {
  const client = new Client({ name: 'velocut-browser-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs'), '--stdio'], stderr: 'pipe' }));
  const tool = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  return { client, tool };
}

test('CodeAct previews and commits batch copies/layout as one attributed undo step', async ({ page }) => {
  const { client, tool } = await mcp();
  try {
    await page.goto((await tool('velocut_connect')).structuredContent.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const made = (await tool('velocut_scene_create', { sessionId, spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180 } })).structuredContent;
    const assetId = made.assetId;
    const before = (await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent;
    const code = (dryRun: boolean) => `
      const copies = Array.from({length:3}, (_,i) => ({prefix:'seat'+i}));
      const edits = [
        {type:'assembly',id:'chair',recipe:{template:'chair'}},
        {type:'duplicateMany',ids:['chair'],copies},
        {type:'layout',ids:['chair',...copies.map(c=>c.prefix+'/chair')],layout:{mode:'radial',center:{},radius:3,facing:'inward'}},
        {type:'transform',ids:['seat0/chair'],relative:true,transform:{position:{y:0.25},rotation:{y:10}}}
      ];
      const result = await velocut.sceneEdit({assetId:${JSON.stringify(assetId)},expectedRevision:${before.revision},dryRun:${dryRun},edits});
      if (!result.ok) throw new Error(result.message);
      return result;
    `;
    const preview = (await tool('velocut_script', { sessionId, code: code(true) })).structuredContent;
    expect(preview.ok, JSON.stringify(preview)).toBe(true);
    expect(preview.result.preview).toBe(true); expect(preview.result.ready).toBe(false);
    expect(preview.result.revision).toBe(before.revision);
    const afterPreview = (await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent;
    expect(afterPreview.spec).toEqual(before.spec); expect(afterPreview.revision).toBe(before.revision);
    const committed = (await tool('velocut_script', { sessionId, code: code(false) })).structuredContent;
    expect(committed.ok, JSON.stringify(committed)).toBe(true);
    expect(committed.result.ready).toBe(true);
    expect(committed.result.createdIds).toHaveLength(28); // Four groups, six parts each.
    expect(committed.result.copies[0].idMap.chair).toBe('seat0/chair');
    const after = (await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent;
    const distributionPreview = await tool('velocut_scene_arrange', { sessionId, assetId, ids: ['chair', 'seat0/chair'], mode: 'distribute', axis: 'x', start: -6, gap: 0.2, dryRun: true, expectedRevision: after.revision });
    expect(distributionPreview.isError, JSON.stringify(distributionPreview.structuredContent)).toBe(false);
    expect(distributionPreview.structuredContent.preview).toBe(true);
    const seat = after.objects.find((o: any) => o.id === 'seat0/chair');
    expect(seat.position[0]).toBeCloseTo(3); expect(seat.position[1]).toBeCloseTo(0.25);
    expect(after.spec.groups.find((g: any) => g.id === 'seat0/chair').rotationY).toBe(280);
    const failed = await tool('velocut_scene_edit', { sessionId, assetId, expectedRevision: after.revision, edits: [
      { type: 'transform', ids: ['chair'], transform: { position: { x: 100 } } },
      { type: 'duplicateMany', ids: ['chair'], copies: [{ prefix: 'seat0' }] },
    ] });
    expect(failed.isError).toBe(true);
    expect((await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent.revision).toBe(after.revision);
    const image = await tool('velocut_observe', { sessionId, mode: 'scene', source: { assetId }, view: 'top' });
    expect(image.content.some((c: any) => c.type === 'image')).toBe(true);
    const history = await page.evaluate(() => (window as any).velocut.store.getHistory().all().filter((n: any) => n.actor.name === 'Codex'));
    expect(history).toHaveLength(2); // create + entire script batch; preview/failure add nothing.
    expect((await tool('velocut_history', { sessionId, expectedRevision: after.revision, action: 'undo' })).isError).toBe(false);
    expect((await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent.spec).toEqual(before.spec);
  } finally { await client.close(); }
});

test('packaged MCP drives the real editor, returns images and attributes edits to Codex', async ({ page }, testInfo) => {
  const { client, tool } = await mcp();
  try {
    const connection = (await tool('velocut_connect')).structuredContent;
    await page.goto(connection.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    expect(page.url()).not.toContain('velocut-codex');
    const sessions = (await tool('velocut_sessions')).structuredContent.sessions;
    expect(sessions).toHaveLength(1);
    const sessionId = sessions[0].sessionId;
    const vocabulary = await tool('velocut_scene_assets', { sessionId });
    expect(vocabulary.structuredContent.manifest.props['prop/mesh']).toBeTruthy();
    const created = await tool('velocut_scene_create', { sessionId, name: 'Codex workshop', spec: { version: 1, durationUs: 2_000_000, width: 640, height: 360 } });
    expect(created.isError).toBe(false);
    const assetId = created.structuredContent.assetId;
    const inspected = (await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent;
    const edit = await tool('velocut_scene_edit', { sessionId, assetId, expectedRevision: inspected.revision, edits: [
      { type: 'assembly', id: 'table', recipe: { template: 'table' } },
      { type: 'add', kind: 'light', object: { id: 'lamp', type: 'point', intensity: 25, position: { y: 3, z: 2 } } },
    ] });
    expect(edit.isError, JSON.stringify(edit.structuredContent)).toBe(false); expect(edit.structuredContent.ready).toBe(true);
    const scripted = await tool('velocut_script', { sessionId, code: `
      const r = await velocut.sceneEdit({assetId:${JSON.stringify(assetId)},edits:[{type:'duplicate',id:'table',newId:'second',offset:{x:2}}]});
      if (!r.ok) throw new Error(r.message); return {ready:r.ready};
    ` });
    expect(scripted.isError).toBe(false); expect(scripted.structuredContent.result.ready).toBe(true);
    const observed = await tool('velocut_observe', { sessionId, mode: 'scene', source: { assetId }, view: 'perspective' });
    expect(observed.isError).toBe(false);
    const image = observed.content.find((c: any) => c.type === 'image');
    expect(image.mimeType).toBe('image/png'); expect(Buffer.from(image.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(observed.content[0].text).not.toContain(image.data);
    await tool('velocut_director', { sessionId, options: { assetId, objectId: 'table', focusId: 'table' } });
    await expect(page.locator('.director-overlay')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('codex-director.png') });
    const beforeHuman = (await tool('velocut_document', { sessionId })).structuredContent.revision;
    const rotation = page.locator('.director-selcard .prop-row').filter({ hasText: 'Rotate Y' }).locator('input');
    await rotation.fill('30'); await rotation.press('Tab');
    await expect.poll(async () => (await tool('velocut_scene_inspect', { sessionId, assetId })).structuredContent.spec.groups.find((g: any) => g.id === 'table').rotationY).toBe(30);
    const stale = await tool('velocut_scene_edit', { sessionId, assetId, expectedRevision: beforeHuman, edits: [{ type: 'update', id: 'table', patch: { rotationY: 90 } }] });
    expect(stale.isError).toBe(true); expect(stale.structuredContent.message).toMatch(/conflict/);
    const forbidden = await tool('velocut_script', { sessionId, code: 'return await velocut.uploadFrame({timeUs:0});' });
    expect(forbidden.isError).toBe(true); expect(forbidden.structuredContent.error).toMatch(/not enabled/);
    const indirect = await tool('velocut_apply', { sessionId, command: { type: 'batch', commands: [{
      type: 'addAsset', kind: 'image', src: 'motion://not-local', name: 'Must not load', durationUs: 1000000,
      spec: JSON.stringify({ version: 1, durationUs: 1000000, layers: [{ type: 'image', src: 'https://external.invalid/image.png', w: 100, h: 100 }] }),
    }] } });
    expect(indirect.isError).toBe(true); expect(indirect.structuredContent.error.message).toMatch(/not exposed/);
    const attribution = await page.evaluate(() => (window as any).velocut.store.getHistory().all().map((n: any) => n.actor));
    expect(attribution.filter((a: any) => a.name === 'Codex' && a.kind === 'ai')).toHaveLength(3);
    await tool('velocut_director', { sessionId, options: { open: false } });
    await page.locator('.codex-status').click(); await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(page.locator('.codex-status')).toHaveClass(/disconnected/);
    await expect.poll(async () => (await tool('velocut_sessions')).structuredContent.sessions.length).toBe(0);
  } finally { await client.close(); }
});

test('MCP imports a local GLB and keeps simultaneous project sessions distinct', async ({ page, context }) => {
  const { client, tool } = await mcp();
  const directory = await mkdtemp(resolve(tmpdir(), 'velocut-mcp-model-'));
  try {
    const paired = (await tool('velocut_connect')).structuredContent.url;
    await page.goto(paired); await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const first = (await tool('velocut_sessions')).structuredContent.sessions[0];
    const made = (await tool('velocut_scene_create', { sessionId: first.sessionId, spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180 } })).structuredContent;
    const path = resolve(directory, 'cube.glb'); await writeFile(path, modelFixture());
    const imported = await tool('velocut_import_model', { sessionId: first.sessionId, assetId: made.assetId, path });
    expect(imported.isError).toBe(false); expect(imported.structuredContent.modelId).toMatch(/^model\//);
    const secondPage = await context.newPage();
    await secondPage.goto('http://localhost:5173'); await secondPage.waitForFunction(() => (window as any).velocut);
    await secondPage.evaluate(async () => { const v = (window as any).velocut; const project = await v.projects.create('Second MCP project'); await v.projects.open(project.id); });
    await secondPage.waitForFunction(() => (window as any).velocut?.projects.active().name === 'Second MCP project');
    await secondPage.goto(paired); await expect(secondPage.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const all = (await tool('velocut_sessions')).structuredContent.sessions;
    const second = all.find((s: any) => s.projectName === 'Second MCP project');
    expect(second, JSON.stringify(all)).toBeTruthy();
    expect(second.sessionId).not.toBe(first.sessionId);
    await tool('velocut_scene_create', { sessionId: second.sessionId, name: 'Only second', spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180, props: [{ id: 'ball', model: 'prop/sphere' }] } });
    const secondPath = resolve(directory, 'another.glb');
    await writeFile(secondPath, modelFixture((json) => { json.nodes[0].name = 'Another model'; }));
    const importedAfterSwitch = await tool('velocut_import_model', { sessionId: first.sessionId, assetId: made.assetId, path: secondPath });
    expect(importedAfterSwitch.isError, JSON.stringify(importedAfterSwitch.structuredContent)).toBe(false);
    const firstDoc = (await tool('velocut_document', { sessionId: first.sessionId })).structuredContent;
    const secondDoc = (await tool('velocut_document', { sessionId: second.sessionId })).structuredContent;
    expect(firstDoc.projectId).not.toBe(secondDoc.projectId);
    expect(firstDoc.document.assets.some((a: any) => a.name === 'Only second')).toBe(false);
    expect(secondDoc.document.assets.some((a: any) => a.name === 'Only second')).toBe(true);
  } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
});

test('disconnect prevents a delivered script from committing after its compilation finishes', async ({ page }) => {
  const { client, tool } = await mcp();
  let release!: () => void, arrived!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const requested = new Promise<void>((r) => { arrived = r; });
  await page.route('**/scene-assets/manifest.json', async (route) => { arrived(); await gate; await route.continue(); });
  try {
    await page.goto((await tool('velocut_connect')).structuredContent.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const pending = tool('velocut_script', { sessionId, code: 'return await velocut.sceneClip({spec:{version:1,durationUs:1000000,width:320,height:180}});' });
    await requested;
    const iframe = page.locator('iframe[sandbox="allow-scripts"]');
    await expect(iframe).toHaveCount(1);
    await page.locator('.codex-status').click(); await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    release();
    const response = await pending;
    expect(response.isError).toBe(true);
    await expect(iframe).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).velocut.doc().assets.length)).toBe(0);
  } finally { release(); await client.close(); }
});
