import { test, expect } from '@playwright/test';
import { modelFixture } from '../packages/scene-sdk/test/glb-fixture';

const bytes = Buffer.from(modelFixture());

test('human GLB import persists through edits, history and reload, and scripts can use it', async ({ page }, testInfo) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneImportModel);
  const assetId = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const r = await v.sceneClip({ spec: { version: 1, durationUs: 2_000_000, width: 640, height: 360 } });
    v.directorSession({ assetId: r.assetId }); return r.assetId;
  });
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import GLB', exact: true }).click();
  await (await chooser).setFiles({ name: 'My sculpture.glb', mimeType: 'model/gltf-binary', buffer: bytes });
  await expect(page.locator('.director-selcard')).toContainText('My sculpture.glb');
  const roughness = page.locator('.director-selcard .prop-row').filter({ hasText: 'roughness' });
  await roughness.getByRole('button', { name: 'Inherited · override' }).click();
  await expect(roughness.locator('input')).toHaveValue('0.6');
  const r = await page.evaluate(async (assetId) => {
    const v = (window as any).velocut;
    const inspected = await v.sceneInspect({ assetId });
    const id = inspected.objects[0].id;
    const modelId = inspected.spec.props[0].model;
    const edit = await v.script(`return await velocut.sceneEdit({assetId:${JSON.stringify(assetId)},edits:[{type:'update',id:${JSON.stringify(id)},patch:{material:{metalness:0.7},rotationZ:45}},{type:'duplicate',id:${JSON.stringify(id)},newId:'copy',offset:{x:2}}]});`);
    const after = await v.sceneInspect({ assetId });
    v.undo(); const undo = JSON.parse(v.doc().assets.find((a: any) => a.id === assetId).spec);
    v.redo(); await v.collab.flushNow();
    return { inspected, modelId, edit, after, undo };
  }, assetId);
  expect(r.edit.ok).toBe(true); expect(r.inspected.objects[0].bounds.size).toEqual([1, 1, 1]);
  expect(r.after.objects).toHaveLength(2); expect(r.undo.props).toHaveLength(1);
  expect(r.inspected.spec.models[r.modelId].src).toMatch(/^opfs:\/\/scene-model-[a-f0-9]{64}\.glb$/);
  await page.screenshot({ path: testInfo.outputPath('imported-model.png') });
  await page.reload(); await page.waitForFunction(() => (window as any).velocut?.sceneInspect);
  const restored = await page.evaluate(async (assetId) => {
    const v = (window as any).velocut;
    return { inspection: await v.sceneInspect({ assetId }), observation: await v.observe({ mode: 'scene', source: { assetId }, view: 'front' }) };
  }, assetId);
  expect(restored.inspection.ok).toBe(true); expect(restored.inspection.objects).toHaveLength(2);
  expect(restored.inspection.objects[0].bounds.size[0]).toBeCloseTo(Math.sqrt(2), 5);
  expect(restored.observation.ok).toBe(true); expect(restored.observation.images[0].base64.length).toBeGreaterThan(1000);
});

test('animated GLB imports expose clips and sample deterministically; incomplete GLBs never commit', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneImportModel);
  const r = await page.evaluate(async ({ base64, external }) => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 2_000_000, width: 320, height: 180 } });
    const imported = await v.sceneImportModel({ assetId: made.assetId, base64, kind: 'character', name: 'Animated cube' });
    const at0 = await v.sceneInspect({ assetId: made.assetId, timeS: 0 });
    const atHalf = await v.sceneInspect({ assetId: made.assetId, timeS: 0.5 });
    const at0Again = await v.sceneInspect({ assetId: made.assetId, timeS: 0 });
    const before = v.doc().assets.find((a: any) => a.id === made.assetId).spec;
    const bad = await v.sceneImportModel({ assetId: made.assetId, base64: external });
    return { imported, at0, atHalf, at0Again, bad, unchanged: before === v.doc().assets.find((a: any) => a.id === made.assetId).spec };
  }, { base64: bytes.toString('base64'), external: Buffer.from(modelFixture((j) => { j.buffers[0].uri = 'https://example.com/data.bin'; })).toString('base64') });
  expect(r.imported.ok).toBe(true); expect(r.imported.clips).toEqual(['Move']);
  expect(r.atHalf.objects[0].bounds.center[0] - r.at0.objects[0].bounds.center[0]).toBeCloseTo(1, 5);
  expect(r.at0Again.objects).toEqual(r.at0.objects);
  expect(r.bad.ok).toBe(false); expect(r.bad.message).toMatch(/external URIs/); expect(r.unchanged).toBe(true);
});

test('editable meshes render, reject bad topology atomically, and independent animated lights change actual pixels', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const result = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 2_000_000, width: 320, height: 180, lighting: 'none',
      props: [{ id: 'mesh', model: 'prop/mesh', vertices: [[-1,0,0], [1,0,0], [1,2,0], [-1,2,0]], faces: [[0,1,2],[0,2,3]] }],
      lights: [{ id: 'key', type: 'point', position: { y: 1.5, z: 3 }, intensity: [{ t: 0, v: 0 }, { t: 1, v: 60 }] }],
    } });
    if (!made.ok) throw new Error(made.message);
    const assetId = made.assetId;
    const brightness = async (at: number) => {
      const observed = await v.observe({ mode: 'scene', source: { assetId }, view: 'front', objectId: 'mesh', at });
      if (!observed.ok) throw new Error(observed.summary);
      const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + observed.images[0].base64)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0); image.close(); const data = ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let sum = 0; for (let i=0;i<data.length;i+=4) sum += data[i]+data[i+1]+data[i+2];
      return sum / (data.length / 4 * 3);
    };
    const dark = await brightness(0), lit = await brightness(1_000_000), again = await brightness(0);
    const inspected = await v.sceneInspect({ assetId, timeS: 1 });
    const bad = await v.sceneEdit({ assetId, edits: [{ type: 'update', id: 'mesh', patch: { faces: [[0,1,99]] } }] });
    const afterBad = await v.sceneInspect({ assetId });
    const edit = await v.sceneEdit({ assetId, edits: [{ type: 'update', id: 'mesh', patch: { vertices: [[-1,0,0],[1,0,0],[1,3,0],[-1,3,0]] } }] });
    v.directorSession({ assetId, objectId: 'key', focusId: 'key' });
    return { dark, lit, again, inspected, bad, afterBad, edit, after: await v.sceneInspect({ assetId }) };
  });
  expect(result.lit).toBeGreaterThan(result.dark + 20); expect(result.again).toBe(result.dark);
  expect(result.inspected.objects.find((o: any) => o.id === 'key').light.intensity).toBe(60);
  expect(result.bad.ok).toBe(false); expect(result.afterBad.revision).toBe(result.inspected.revision);
  expect(result.edit.ok).toBe(true); expect(result.after.objects.find((o: any) => o.id === 'mesh').bounds.size[1]).toBeCloseTo(3);
  await expect(page.locator('.director-selcard')).toContainText('Light type');
  await expect(page.locator('.director-selcard')).toContainText('Intensity');
});

test('legacy mixed command batches compile scene changes before publishing any command', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const result = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180, props: [{ id: 'p', model: 'prop/cube' }] } });
    const before = JSON.stringify(v.doc());
    const spec = JSON.parse(v.doc().assets.find((a: any) => a.id === made.assetId).spec);
    const invalid = await v.apply({ type: 'batch', commands: [
      { type: 'addTrack', kind: 'video', name: 'Must not land' },
      { type: 'setAssetSpec', assetId: made.assetId, spec: JSON.stringify({ ...spec, props: [{ id: 'p', model: 'prop/missing' }] }) },
    ] });
    const unchanged = before === JSON.stringify(v.doc());
    const valid = await v.apply({ type: 'batch', commands: [
      { type: 'addTrack', kind: 'video', name: 'Committed with scene' },
      { type: 'setAssetSpec', assetId: made.assetId, spec: JSON.stringify({ ...spec, props: [{ id: 'p', model: 'prop/cube', scale: 2 }] }) },
    ] });
    const after = await v.sceneInspect({ assetId: made.assetId });
    v.undo(); return { invalid, unchanged, valid, after, tracksAfterUndo: v.doc().tracks.map((t: any) => t.name) };
  });
  expect(result.invalid.ok).toBe(false); expect(result.invalid.error.message).toMatch(/unknown prop/); expect(result.unchanged).toBe(true);
  expect(result.valid.ok).toBe(true); expect(result.after.objects[0].bounds.size).toEqual([2,2,2]);
  expect(result.tracksAfterUndo).not.toContain('Committed with scene');
});

test('imported model colliders bake deterministically and project storage does not leak into another project', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneImportModel);
  const result = await page.evaluate(async (base64) => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 3_000_000, width: 320, height: 180 } });
    const imported = await v.sceneImportModel({ assetId: made.assetId, base64 });
    const edit = await v.sceneEdit({ assetId: made.assetId, edits: [{ type: 'update', id: imported.objectId, patch: { position: { y: 3 }, physics: 'dynamic' } }] });
    const a = await v.sceneInspect({ assetId: made.assetId, timeS: 2.5 });
    const b = await v.sceneInspect({ assetId: made.assetId, timeS: 0 });
    const c = await v.sceneInspect({ assetId: made.assetId, timeS: 2.5 });
    await v.collab.flushNow(); return { edit, a, b, c, spec: c.spec };
  }, bytes.toString('base64'));
  expect(result.edit.ok).toBe(true);
  expect(result.a.objects[0].bounds.min[1]).toBeCloseTo(0, 1);
  expect(result.b.objects[0].position[1]).toBeCloseTo(3);
  expect(result.a.objects).toEqual(result.c.objects);
  await page.locator('.project-current').click();
  await page.getByRole('button', { name: 'New Project', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Isolated model project');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.locator('.project-current')).toContainText('Isolated model project');
  await page.waitForFunction(() => (window as any).velocut?.sceneClip);
  const isolated = await page.evaluate(async (spec) => (window as any).velocut.sceneClip({ spec }), result.spec);
  expect(isolated.ok).toBe(false); expect(isolated.message).toMatch(/missing from this project/);
});

test('AI can set and inspect a free orthographic camera without changing authored camera state', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.directorSession);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180,
      props: [{ id: 'p', model: 'prop/cube', color: '#ee4433', scale: { x: 1, y: 2, z: 0.4 } }] } });
    const before = v.doc().assets.find((a: any) => a.id === made.assetId).spec;
    const camera = { position: [0, 0.5, -5], target: [0,0.5,0], projection: 'orthographic', height: 3 };
    const opened = v.directorSession({ assetId: made.assetId, objectId: 'p', camera });
    const observed = await v.observe({ mode: 'scene', source: { assetId: made.assetId }, camera });
    const invalid = v.directorSession({ camera: { position: [0,0,0], target: [0,0,0] } });
    const afterInvalid = v.directorSession().state;
    return { opened, observed, invalid, afterInvalid, unchanged: before === v.doc().assets.find((a: any) => a.id === made.assetId).spec };
  });
  expect(r.opened.ok).toBe(true); expect(r.opened.state.camera.projection).toBe('orthographic');
  expect(r.observed.ok).toBe(true); expect(r.observed.images[0].base64.length).toBeGreaterThan(1000);
  expect(r.invalid.ok).toBe(false); expect(r.afterInvalid.camera).toEqual(r.opened.state.camera); expect(r.unchanged).toBe(true);
  await page.getByLabel('Director view').selectOption('top');
  expect(await page.evaluate(() => (window as any).velocut.directorSession().state.camera)).toBeUndefined();
});

test('the built-in agent loop authors through the real host, receives vision, and records AI attribution', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  await page.evaluate(() => {
    const w = window as any;
    w.__velocutAgentStream = undefined;
    let step = 0;
    w.__velocutAgentTransport = async (params: any) => {
      const n = step++;
      let content: any[];
      if (n === 0) content = [{ type: 'tool_use', id: 'build', name: 'velocut_script', input: { code: `
        const vocabulary = await velocut.sceneAssets();
        if (!vocabulary.manifest.props['prop/mesh']) throw new Error('mesh vocabulary is missing');
        const made = await velocut.sceneClip({spec:{version:1,durationUs:1000000,width:320,height:180}});
        if (!made.ok) throw new Error(made.message);
        const edited = await velocut.sceneEdit({assetId:made.assetId,edits:[
          {type:'assembly',id:'table',recipe:{template:'table'}},
          {type:'add',kind:'light',object:{id:'fill',type:'point',position:{y:3,z:2},intensity:20}}
        ]});
        if (!edited.ok) throw new Error(edited.message);
        return {assetId:made.assetId,ready:edited.ready};
      ` } }];
      else if (n === 1) content = [{ type: 'tool_use', id: 'see', name: 'velocut_observe', input: {
        mode: 'scene', source: { assetId: w.velocut.doc().assets[0].id }, view: 'front',
      } }];
      else {
        w.__directorSawVision = params.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) =>
          b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c: any) => c.type === 'image' && c.source.media_type === 'image/png')));
        content = [{ type: 'text', text: 'Director host and vision verified.' }];
      }
      return { id: `response-${n}`, type: 'message', role: 'assistant', model: 'fixture', content,
        stop_reason: n < 2 ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    };
  });
  await page.locator('.agent-fab').click();
  const input = page.getByPlaceholder('Describe your editing intent; Enter to send. Paste/drop media to import & reference it.');
  await input.fill('Build a table with a fill light, then inspect the result.'); await input.press('Enter');
  await expect(page.locator('.agent-console')).toContainText('Director host and vision verified.');
  const result = await page.evaluate(() => {
    const w = window as any;
    return { sawVision: w.__directorSawVision, history: w.velocut.store.getHistory().all().map((n: any) => ({ actor: n.actor.kind, label: n.label })) };
  });
  expect(result.sawVision).toBe(true); expect(result.history.filter((n: any) => n.actor === 'ai')).toHaveLength(2);
});


test('embedded GLB textures remain visible after a project reload', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneImportModel);
  const assetId = await page.evaluate(async (base64) => {
    const v = (window as any).velocut;
    const scene = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 320, height: 180 } });
    const imported = await v.sceneImportModel({ assetId: scene.assetId, base64 });
    if (!imported.ok) throw new Error(imported.message);
    await v.collab.flushNow(); return scene.assetId;
  }, Buffer.from(modelFixture(undefined, true)).toString('base64'));
  await page.reload(); await page.waitForFunction(() => (window as any).velocut?.sceneInspect);
  const redPixels = await page.evaluate(async (assetId) => {
    const observed = await (window as any).velocut.observe({ mode: 'scene', source: { assetId }, view: 'front' });
    if (!observed.ok) throw new Error(observed.summary);
    const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + observed.images[0].base64)).blob());
    const canvas = new OffscreenCanvas(image.width,image.height), ctx = canvas.getContext('2d')!;
    ctx.drawImage(image,0,0); image.close(); const pixels = ctx.getImageData(0,0,canvas.width,canvas.height).data;
    let count = 0; for (let i=0;i<pixels.length;i+=4) if (pixels[i] > 2*pixels[i+1] && pixels[i] > 2*pixels[i+2]) count++;
    return count;
  }, assetId);
  expect(redPixels).toBeGreaterThan(1000);
});
