import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

test('editor and Director preview rates stay separate, fit compact UI and leave the document unchanged', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 440, height: 760 });
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.previewSession);
  await expect(page.getByLabel('Editor preview speed')).toBeVisible(); // No selection needed.
  await page.getByLabel('Editor preview speed').selectOption('2');
  const made = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 20_000_000, width: 320, height: 180, props: [{ id: 'cube', model: 'prop/cube' }] } });
    if (!made.ok) throw new Error(made.message);
    v.store.select(made.clipId);
    return { ...made, document: JSON.stringify(v.doc()), revision: v.store.getState().revision };
  });
  await expect(page.getByLabel('Clip speed')).toHaveValue('1');
  const fits = async (label: string) => {
    const b = await page.getByLabel(label).boundingBox();
    expect(b).toBeTruthy(); expect(b!.x).toBeGreaterThanOrEqual(0); expect(b!.x + b!.width).toBeLessThanOrEqual(440);
  };
  await fits('Editor preview speed'); await fits('Clip speed');
  await page.screenshot({ path: testInfo.outputPath('editor-preview-speed.png') });
  // Human gesture enables the real AudioContext, even when this scene is silent.
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  // The browser's audio output clock can start after resume() resolves under
  // software/CI audio. Measure steady playback, not device startup latency.
  await expect.poll(() => page.evaluate(() => (window as any).velocut.previewSession().state.timeUs)).toBeGreaterThan(100_000);
  const elapsed = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const first = v.previewSession().state.timeUs, wall = performance.now();
    await new Promise(r => setTimeout(r, 450));
    const last = v.previewSession().state.timeUs;
    return (last - first) / ((performance.now() - wall) * 1000);
  });
  expect(elapsed).toBeGreaterThan(1.7); expect(elapsed).toBeLessThan(2.3);
  await page.getByLabel('Editor preview speed').selectOption('0.5');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await page.evaluate(() => (window as any).velocut.previewSession().state.timeUs);
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).velocut.previewSession().state.timeUs)).toBe(paused);
  await page.evaluate(assetId => {
    const v = (window as any).velocut;
    v.previewSession({ playing: true });
    v.directorSession({ assetId });
  }, made.assetId);
  await expect.poll(() => page.evaluate(() => (window as any).velocut.previewSession().state.playing)).toBe(false);
  await expect(page.getByLabel('Director preview speed')).toHaveValue('1');
  await page.getByLabel('Director preview speed').selectOption('4'); await fits('Director preview speed');
  await page.screenshot({ path: testInfo.outputPath('director-preview-speed.png') });
  const rate = await page.evaluate(async () => {
    const v = (window as any).velocut;
    v.directorSession({ playing: true, timeS: 0 });
    // Allow initial layout/render work before measuring the animation loop.
    await new Promise(r => setTimeout(r, 200));
    // Director time advances in rAF. Sampling from timers can compare a stale
    // start pose to a fresh end pose when another test holds the GPU, inflating
    // the measured speed. Read both endpoints after the Director's frame tick.
    const frame = () => new Promise<{timeS:number;wall:number}>(resolve => requestAnimationFrame(wall => {
      resolve({timeS:v.directorSession().state.timeS,wall});
    }));
    const start = await frame();
    await new Promise(r => setTimeout(r, 400));
    const end = await frame();
    v.directorSession({ playing: false });
    return (end.timeS - start.timeS) / ((end.wall - start.wall) / 1000);
  });
  expect(rate).toBeGreaterThan(3); expect(rate).toBeLessThan(5);
  const result = await page.evaluate(() => {
    const v = (window as any).velocut;
    const before = v.directorSession().state;
    const invalid = v.directorSession({ rate: 2, timeS: -1 });
    const unchanged = v.directorSession().state;
    v.directorSession({ timeS: 19.9, playing: true });
    return { before, invalid, unchanged, doc: JSON.stringify(v.doc()), revision: v.store.getState().revision };
  });
  expect(result.invalid.ok).toBe(false); expect(result.unchanged).toEqual(result.before);
  expect(result.doc).toBe(made.document); expect(result.revision).toBe(made.revision);
  await expect.poll(() => page.evaluate(() => (window as any).velocut.directorSession().state.playing)).toBe(false);
  expect(await page.evaluate(() => (window as any).velocut.directorSession().state.timeS)).toBe(20);
  await page.evaluate(() => (window as any).velocut.directorSession({ open: false }));
  await expect(page.getByLabel('Editor preview speed')).toHaveValue('0.5');
  await page.reload(); await page.waitForFunction(() => (window as any).velocut?.previewSession);
  await expect(page.getByLabel('Editor preview speed')).toHaveValue('1');
});

test('packaged MCP and CodeAct can control both preview transports without history entries', async ({ page }) => {
  const client = new Client({ name: 'preview-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')], stderr: 'pipe' }));
  const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  try {
    await page.goto((await tool('velocut_connect')).structuredContent.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const made = (await tool('velocut_scene_create', { sessionId, spec: { version: 1, durationUs: 10_000_000, width: 320, height: 180 } })).structuredContent;
    const before = (await tool('velocut_document', { sessionId })).structuredContent;
    const preview = (await tool('velocut_preview', { sessionId, rate: 2, timeUs: 2_000_000 })).structuredContent;
    expect(preview.ok).toBe(true); expect(preview.state.rate).toBe(2);
    await expect(page.getByLabel('Editor preview speed')).toHaveValue('2');
    const invalid = await tool('velocut_preview', { sessionId, rate: 0.5, timeUs: 20_000_000 });
    expect(invalid.isError).toBe(true);
    expect((await tool('velocut_preview', { sessionId })).structuredContent.state).toEqual(preview.state);
    const scripted = (await tool('velocut_script', { sessionId, code: `
      const preview = await velocut.previewSession({rate:4,playing:false,timeUs:3000000});
      if (!preview.ok) throw new Error(preview.message);
      const director = await velocut.directorSession({assetId:${JSON.stringify(made.assetId)},rate:0.25,timeS:1});
      if (!director.ok) throw new Error(director.message);
      return {preview,director};
    ` })).structuredContent;
    expect(scripted.ok, JSON.stringify(scripted)).toBe(true);
    expect(scripted.result.preview.state.rate).toBe(4);
    expect(scripted.result.director.state.rate).toBe(0.25);
    await expect(page.getByLabel('Director preview speed')).toHaveValue('0.25');
    const after = (await tool('velocut_document', { sessionId })).structuredContent;
    expect(after.document).toEqual(before.document); expect(after.revision).toBe(before.revision);
    await page.evaluate(async () => {
      const v = (window as any).velocut;
      const p = await v.projects.create('Fresh preview session'); await v.projects.open(p.id);
    });
    await page.waitForFunction(() => (window as any).velocut?.projects.active().name === 'Fresh preview session');
    expect(await page.evaluate(() => (window as any).velocut.previewSession().state.rate)).toBe(1);
  } finally { await client.close(); }
});
