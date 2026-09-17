import { test, expect, type Page } from './test-fixtures';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

async function clips(page: Page) {
  await page.waitForFunction(() => (window as any).velocut?.sceneClip);
  return page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ name: 'Reference scene', spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180 } });
    if (!made.ok) throw new Error(made.message);
    for (let i = 1; i <= 2; i++) await v.apply({ type: 'addClip', trackId: made.trackId, assetId: made.assetId, startUs: i * 1_000_000, durationUs: 1_000_000 });
    return { ids: v.doc().tracks[0].clips.map((c: any) => c.id), revision: v.store.getState().revision, doc: JSON.stringify(v.doc()) };
  });
}
async function clickClip(page: Page, index: number, options: { button?: 'left' | 'right'; modifiers?: ('Meta' | 'Control' | 'Shift')[] } = {}) {
  const canvas = page.locator('.timeline-panel canvas');
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: (box.width < 600 ? 92 : 130) + 50 + index * 100, y: 50 }, ...options });
}
const selected = (page: Page) => page.evaluate(() => (window as any).velocut.store.getState().selectedClipIds);

test('multi-clip right-click references are read through MCP, track staleness and clear on reconnect', async ({ page }, testInfo) => {
  const client = new Client({ name: 'reference-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')], stderr: 'pipe' }));
  const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  try {
    const url = (await tool('velocut_connect')).structuredContent.url;
    await page.goto(url); await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const session = (await tool('velocut_sessions')).structuredContent.sessions[0], sessionId = session.sessionId;
    const made = await clips(page);
    await clickClip(page, 0); await clickClip(page, 2, { modifiers: ['Meta'] });
    expect(await selected(page)).toEqual([made.ids[0], made.ids[2]]);
    await clickClip(page, 0, { button: 'right' });
    expect(await selected(page)).toEqual([made.ids[0], made.ids[2]]);
    await page.getByRole('button', { name: 'Reference 2 clips in Codex', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: '2 clips ready' })).toBeVisible();
    await expect.poll(async () => (await tool('velocut_sessions')).structuredContent.sessions[0].referenceCount).toBe(2);
    const r = (await tool('velocut_references', { sessionId })).structuredContent;
    expect(r.projectId).toBe(session.projectId); expect(r.revision).toBe(made.revision);
    expect(r.reference.clips.map((c: any) => c.captured.clipId)).toEqual([made.ids[0], made.ids[2]]);
    expect(r.reference.clips.map((c: any) => c.status)).toEqual(['unchanged', 'unchanged']);
    expect(r.reference.clips[1].captured.startUs).toBe(2_000_000);
    expect(await page.evaluate(() => JSON.stringify((window as any).velocut.doc()))).toBe(made.doc);
    await page.screenshot({ path: testInfo.outputPath('codex-clip-references.png') });
    // Changing the visual selection does not replace an explicitly shared batch.
    await clickClip(page, 1);
    expect((await tool('velocut_references', { sessionId })).structuredContent.reference.id).toBe(r.reference.id);
    await page.evaluate(ids => {
      const v = (window as any).velocut;
      v.apply({ type: 'setClipVolume', clipId: ids[0], volume: 0.5 });
      v.apply({ type: 'removeClip', clipId: ids[2] });
    }, made.ids);
    const stale = (await tool('velocut_references', { sessionId })).structuredContent.reference;
    expect(stale.clips.map((c: any) => c.status)).toEqual(['changed', 'deleted']);
    await page.getByLabel('Clear Codex references', { exact: true }).click();
    expect((await tool('velocut_references', { sessionId })).structuredContent.reference).toBeNull();
    await clickClip(page, 1, { button: 'right' }); await page.getByRole('button', { name: 'Reference in Codex', exact: true }).click();
    await page.evaluate(() => (window as any).velocut.codex.disconnect());
    await clickClip(page, 1, { button: 'right' }); await expect(page.getByRole('button', { name: 'Reference in Codex', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.evaluate(url => { void (window as any).velocut.codex.connect(url); }, url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const second = (await tool('velocut_sessions')).structuredContent.sessions.find((s: any) => s.sessionId !== sessionId);
    expect(second).toBeTruthy(); expect((await tool('velocut_references', { sessionId: second.sessionId })).structuredContent.reference).toBeNull();
  } finally { await client.close(); }
});

test('shift range, touch-friendly toggle selection and atomic multi-delete work in a narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 440, height: 760 }); await page.goto('/');
  const made = await clips(page);
  await clickClip(page, 0); await clickClip(page, 2, { modifiers: ['Shift'] });
  expect(await selected(page)).toEqual(made.ids);
  await page.getByLabel('Select multiple clips', { exact: true }).click();
  await clickClip(page, 1); expect(await selected(page)).toEqual([made.ids[0], made.ids[2]]);
  await clickClip(page, 2, { button: 'right' });
  await page.getByRole('button', { name: 'Delete 2 clips', exact: true }).click();
  expect(await page.evaluate(() => (window as any).velocut.doc().tracks[0].clips.map((c: any) => c.id))).toEqual([made.ids[1]]);
  expect(await selected(page)).toEqual([]);
  await page.evaluate(() => (window as any).velocut.undo());
  expect(await page.evaluate(() => JSON.stringify((window as any).velocut.doc()))).toBe(made.doc);
});
