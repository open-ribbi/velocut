import { test, expect } from './test-fixtures';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve } from 'node:path';

test('MCP imports a real MP4, probes it, then CodeAct composes registration/copy/trim without implicit edits', async ({ page }) => {
  const client = new Client({ name: 'resource-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')], stderr: 'pipe' }));
  const tool = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;
  try {
    await page.goto((await tool('velocut_connect')).structuredContent.url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const snapshot = (await tool('velocut_query', { sessionId, kind: 'snapshot' })).structuredContent;
    const runtimeId = snapshot.runtimeId;
    const waitJob = async (jobId: string) => {
      let job: any;
      await expect.poll(async () => {
        const r = (await tool('velocut_jobs', { sessionId, runtimeId, action: 'get', jobId })).structuredContent;
        expect(r.ok, JSON.stringify(r)).toBe(true); job = r.data; return job.state;
      }).toMatch(/^(succeeded|failed|cancelled)$/);
      expect(job.state, JSON.stringify(job)).toBe('succeeded'); return job;
    };
    const imported = (await tool('velocut_import_media', { sessionId, runtimeId, requestId: 'mp4-import', path: resolve('e2e/fixtures/red-tone.mp4') })).structuredContent;
    expect(imported.ok, JSON.stringify(imported)).toBe(true);
    const resource = (await waitJob(imported.data.id)).result.resource;
    expect((await tool('velocut_query', { sessionId, kind: 'assets' })).structuredContent.data.total).toBe(0);
    const probe = (await tool('velocut_jobs', { sessionId, runtimeId, action: 'submit', requestId: 'probe', task: 'media.probe', resourceId: resource.id })).structuredContent;
    const probed = (await waitJob(probe.data.id)).result;
    expect(probed.metadata.width).toBe(96); expect(probed.metadata.height).toBe(64);
    expect(probed.metadata.hasAudio).toBe(true); expect(probed.metadata.tracks.map((t: any) => t.kind)).toEqual(['video', 'audio']);
    expect(probed.metadata.tracks[1].sampleRate).toBe(48000);
    expect((await tool('velocut_query', { sessionId, kind: 'clips' })).structuredContent.data.total).toBe(0);
    const code = `
      const snap=await velocut.query({kind:'snapshot'});
      const operations=[
        {id:'asset',command:velocut.ops.registerAsset({resourceId:${JSON.stringify(resource.id)},probeId:${JSON.stringify(probe.data.id)}})},
        {id:'track',command:velocut.ops.addTrack({kind:'video'})},
        {id:'clip',command:velocut.ops.addClip({assetId:velocut.ref('asset','assetId'),trackId:velocut.ref('track','trackId'),startUs:0,sourceInUs:250000,durationUs:1000000})},
        {id:'fx',command:velocut.ops.addEffect({clipId:velocut.ref('clip','clipId'),effect:'brightnessContrast',params:{brightness:0.1}})},
        {id:'key',command:velocut.ops.setKeyframe({clipId:velocut.ref('clip','clipId'),property:'opacity',keyframe:{timeUs:0,value:0.8,easing:{kind:'linear'}}})},
        {id:'copy',command:velocut.ops.duplicateClip({clipId:velocut.ref('clip','clipId')})},
        {id:'trim',command:velocut.ops.trimClip({clipId:velocut.ref('copy','clipId'),edge:'out',toUs:1750000})},
        {id:'move',command:velocut.ops.moveClip({clipId:velocut.ref('copy','clipId'),startUs:2000000})}
      ];
      return await velocut.transaction({action:'commit',runtimeId:snap.runtimeId,expectedRevision:snap.revision,requestId:'edit',operations});
    `;
    const edited = (await tool('velocut_script', { sessionId, code })).structuredContent;
    expect(edited.ok).toBe(true); expect(edited.result.ok, JSON.stringify(edited)).toBe(true);
    const result = edited.result, assetId = result.data.results.asset.assetId;
    await page.waitForFunction(id => (window as any).velocut.media.hasAsset(id), assetId);
    const rows = (await tool('velocut_query', { sessionId, kind: 'clips', fields: ['id', 'startUs', 'durationUs', 'sourceInUs', 'effects', 'keyframes'] })).structuredContent.data.items;
    expect(rows.map((c: any) => [c.startUs, c.durationUs, c.sourceInUs])).toEqual([[0, 1000000, 250000], [2000000, 750000, 250000]]);
    expect(rows[1].effects[0].id).not.toBe(rows[0].effects[0].id);
    expect(rows[1].effects[0].params).toEqual(rows[0].effects[0].params); expect(rows[1].keyframes).toEqual(rows[0].keyframes);
    const observed = await tool('velocut_observe', { sessionId, mode: 'frame', source: { assetId }, at: 500000 });
    expect(observed.isError, JSON.stringify(observed.structuredContent)).toBe(false);
    const image = observed.content.find((c: any) => c.type === 'image'); expect(image).toBeTruthy();
    const red = await page.evaluate(async image => {
      const bitmap = await createImageBitmap(await (await fetch(`data:${image.mimeType};base64,${image.data}`)).blob());
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0); bitmap.close();
      return [...ctx.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
    }, image);
    expect(red[0]).toBeGreaterThan(180); expect(red[1]).toBeLessThan(60);
    const historyCount = await page.evaluate(() => (window as any).velocut.store.getHistory().all().filter((n: any) => n.actor.name === 'Codex').length);
    expect(historyCount).toBe(1);
    await tool('velocut_history', { sessionId, action: 'undo', expectedRevision: result.revision });
    expect((await tool('velocut_query', { sessionId, kind: 'assets' })).structuredContent.data.total).toBe(0);
    const state = (await tool('velocut_query', { sessionId, kind: 'document' })).structuredContent;
    await tool('velocut_history', { sessionId, action: 'redo', expectedRevision: state.revision });
    await page.evaluate(() => (window as any).velocut.collab.flushNow());
    await page.reload(); await page.waitForFunction(() => (window as any).velocut?.jobs);
    await page.waitForFunction(id => (window as any).velocut.media.hasAsset(id), assetId);
    expect(await page.evaluate(() => (window as any).velocut.doc().tracks[0].clips.length)).toBe(2);
    await page.locator('.timeline-panel canvas').click({ button: 'right', position: { x: 180, y: 50 } });
    await page.getByRole('button', { name: 'Duplicate at track end', exact: true }).click();
    expect(await page.evaluate(() => (window as any).velocut.doc().tracks[0].clips.map((c: any) => c.startUs))).toEqual([0, 2000000, 2750000]);
    await page.evaluate(() => (window as any).velocut.undo());
    const stale = await page.evaluate(({ runtimeId, jobId }) => (window as any).velocut.jobs({ action: 'get', runtimeId, jobId }), { runtimeId, jobId: imported.data.id });
    expect(stale.ok).toBe(false); expect(stale.error.code).toBe('staleRuntime');
  } finally { await client.close(); }
});

test('image/audio probes return metadata without registration; cancelling a probe retains the imported resource', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.resources);
  // Make real test files in the browser so no platform CLI/codec encoder is needed.
  const result = await page.evaluate(async () => {
    const v = (window as any).velocut, runtimeId = v.query({ kind: 'document' }).runtimeId;
    const wait = async (jobId: string) => {
      for (let i = 0; i < 500; i++) { const j = v.jobs({ action: 'get', runtimeId, jobId }).data; if (['succeeded', 'failed', 'cancelled'].includes(j.state)) return j; await new Promise(r => setTimeout(r, 10)); }
      throw new Error('job timeout');
    };
    const canvas = new OffscreenCanvas(16, 12); canvas.getContext('2d')!.fillRect(0, 0, 16, 12);
    const image = new File([await canvas.convertToBlob()], 'image.png', { type: 'image/png' });
    const imported = await v.resources({ action: 'import', runtimeId, requestId: 'image', file: image });
    const resource = (await wait(imported.data.id)).result.resource;
    const probe = v.jobs({ action: 'submit', runtimeId, requestId: 'image-probe', task: 'media.probe', resourceId: resource.id });
    const imageResult = await wait(probe.data.id);
    const wav = new ArrayBuffer(44 + 16000), bytes = new Uint8Array(wav), view = new DataView(wav);
    const write = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
    write(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true); write(8, 'WAVEfmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, 16000, true);
    const audio = await v.resources({ action: 'import', runtimeId, requestId: 'audio', file: new File([wav], 'audio.wav', { type: 'audio/wav' }) });
    const audioResource = (await wait(audio.data.id)).result.resource;
    const ap = v.jobs({ action: 'submit', runtimeId, requestId: 'audio-probe', task: 'media.probe', resourceId: audioResource.id });
    const audioResult = await wait(ap.data.id);
    const original = v.media.probeImage.bind(v.media); let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    v.media.probeImage = async (file: File) => { await gate; return original(file); };
    const cancelled = v.jobs({ action: 'submit', runtimeId, requestId: 'cancel', task: 'media.probe', resourceId: resource.id });
    await new Promise(r => setTimeout(r, 30));
    v.jobs({ action: 'cancel', runtimeId, jobId: cancelled.data.id }); release();
    const cancellation = await wait(cancelled.data.id); v.media.probeImage = original;
    return { imageResult, audioResult, cancellation, resources: (await v.resources({ action: 'list', runtimeId })).data.total, assets: v.doc().assets.length, tracks: v.doc().tracks.length };
  });
  expect(result.imageResult.state).toBe('succeeded'); expect(result.imageResult.result.metadata.width).toBe(16);
  expect(result.audioResult.state, JSON.stringify(result.audioResult)).toBe('succeeded'); expect(result.audioResult.result.metadata.durationUs).toBe(1000000);
  expect(result.audioResult.result.metadata.tracks[0].codec).toBeNull();
  expect(result.cancellation.state).toBe('cancelled'); expect(result.resources).toBe(2); expect(result.assets).toBe(0); expect(result.tracks).toBe(0);
});
