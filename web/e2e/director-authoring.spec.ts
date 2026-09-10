import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
const sdkUrl = '/@fs' + resolve('packages/scene-sdk/src/index.ts');

test('authoring compiles atomically, exposes geometry, and survives history/reload', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const created = await v.sceneClip({ name: 'Authoring test', spec: {
      version: 1, durationUs: 2_000_000, width: 640, height: 360,
      groups: [{ id: 'assembly', position: { x: 3 }, rotationZ: 90 }],
      props: [{ id: 'block', parentId: 'assembly', model: 'prop/cube', position: { x: 1, y: 0, z: 0 }, scale: { x: 2, y: 1, z: 1 } }],
    } });
    if (!created.ok) throw new Error(created.message);
    const assetId = created.assetId;
    const before = await v.sceneInspect({ assetId, timeS: 0 });
    const failed = await v.sceneEdit({ assetId, expectedRevision: before.revision, edits: [{ type: 'update', id: 'block', patch: { model: 'prop/missing' } }] });
    const text = () => v.doc().assets.find((a: any) => a.id === assetId).spec;
    const afterFailure = text();
    const edit = await v.sceneEdit({ assetId, expectedRevision: before.revision, edits: [
      { type: 'update', id: 'block', patch: { material: { metalness: 0.9, roughness: 0.15 }, rotationX: 30 } },
      { type: 'duplicate', id: 'assembly', newId: 'copy', offset: { x: 4 } },
    ] });
    const stale = await v.sceneEdit({ assetId, expectedRevision: before.revision, edits: [{ type: 'update', id: 'block', patch: { color: '#ff0000' } }] });
    const edited = text(); v.undo(); const undone = text(); v.redo(); const redone = text();
    await v.collab.flushNow();
    return { assetId, before, failed, afterFailure, edit, stale, edited, undone, redone };
  });
  expect(r.before.ok).toBe(true);
  const block = r.before.objects.find((o: any) => o.id === 'block');
  expect(block.position[0]).toBeCloseTo(3); expect(block.position[1]).toBeCloseTo(1);
  expect(block.bounds.size[0]).toBeCloseTo(1); expect(block.bounds.size[1]).toBeCloseTo(2);
  expect(r.failed.ok).toBe(false); expect(r.failed.message).toMatch(/unknown prop/);
  expect(r.edit.ok).toBe(true); expect(r.edit.ready).toBe(true);
  expect(r.stale.ok).toBe(false); expect(r.stale.message).toMatch(/conflict/);
  expect(r.undone).toBe(r.afterFailure); expect(r.redone).toBe(r.edited);
  await page.reload(); await page.waitForFunction(() => (window as any).velocut?.sceneInspect);
  const restored = await page.evaluate(async (assetId) => (window as any).velocut.sceneInspect({ assetId }), r.assetId);
  expect(restored.ok).toBe(true);
  expect(restored.objects.map((o: any) => o.id)).toEqual(expect.arrayContaining(['assembly', 'block', 'copy', 'copy/block']));
});

test('construction views render real geometry without editing the shot', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 640, height: 360,
      props: [{ id: 'p', model: 'prop/cube', scale: { x: 3, y: 1, z: 0.5 }, color: '#ee5522', rotationZ: 20 }] } });
    if (!made.ok) throw new Error(made.message);
    const before = v.doc().assets.find((a: any) => a.id === made.assetId).spec;
    const images = [];
    for (const view of ['front', 'right', 'top', 'shot']) {
      const o = await v.observe({ mode: 'scene', source: { assetId: made.assetId }, view, objectId: 'p', at: 0 });
      if (!o.ok) throw new Error(o.summary);
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + o.images[0].base64)).blob());
      const c = new OffscreenCanvas(bitmap.width, bitmap.height); const ctx = c.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0); bitmap.close(); const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
      let redPixels = 0;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > pixels[i+1] * 1.4 && pixels[i] > pixels[i+2] * 1.4) redPixels++;
      images.push({ view, base64: o.images[0].base64, redPixels, width: c.width, height: c.height });
    }
    return { before, after: v.doc().assets.find((a: any) => a.id === made.assetId).spec, images };
  });
  expect(r.after).toBe(r.before);
  for (const image of r.images) { expect(image.redPixels).toBeGreaterThan(100); expect(image.width / image.height).toBeCloseTo(16 / 9); }
  expect(new Set(r.images.map((i) => i.base64)).size).toBe(4);
});

test('XYZ physics parity, world-space character tracking and deterministic scrubbing', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async (url) => {
    const sdk = await import(url);
    const stage = await sdk.buildStage({ version: 1, durationUs: 1_000_000, environment: 'env/void', physics: { gravity: 0 },
      groups: [{ id: 'outer', position: { x: [{ t: 0, v: 4 }, { t: 1, v: 8 }] }, rotationY: 90 }, { id: 'inner', parentId: 'outer', position: { z: 2 } }],
      characters: [{ id: 'hero', model: 'char/mannequin', parentId: 'inner', position: { x: 1 } }],
      props: [
        { id: 'sim', model: 'prop/cube', position: { y: 3 }, rotationX: 35, rotationY: 20, rotationZ: 65, physics: 'dynamic' },
        { id: 'static', model: 'prop/cube', position: { y: 3 }, rotationX: 35, rotationY: 20, rotationZ: 65 },
      ],
    });
    stage.poseAt(0); const first = sdk.inspectStage(stage);
    stage.poseAt(0.7); stage.poseAt(0); const back = sdk.inspectStage(stage);
    return { first, back, character: stage.characterPosition('hero', 0), atOne: stage.characterPosition('hero', 1) };
  }, sdkUrl);
  const sim = r.first.find((o: any) => o.id === 'sim'), fixed = r.first.find((o: any) => o.id === 'static');
  for (let i = 0; i < 4; i++) expect(sim.quaternion[i]).toBeCloseTo(fixed.quaternion[i], 5);
  expect(r.back).toEqual(r.first);
  expect(r.character[0]).toBeCloseTo(6); expect(r.character[2]).toBeCloseTo(-1); expect(r.atOne[0]).toBeCloseTo(10);
});

test('human controls edit the same objects as scripts; concurrent edits cannot overwrite a newer scene', async ({ page }, testInfo) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const assetId = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ name: 'Modeling workshop', spec: { version: 1, durationUs: 2_000_000, width: 640, height: 360,
      groups: [{ id: 'table', name: 'Table assembly' }], props: [
        { id: 'top', parentId: 'table', model: 'prop/cube', scale: { x: 3, y: 0.2, z: 2 }, position: { y: 1.4 }, color: '#bb7744' },
        { id: 'vase', model: 'prop/lathe', points: [[0.15, 0], [0.3, 0.2], [0.12, 0.7], [0.18, 0.9]], position: { y: 1.5 }, color: '#66aabb' },
      ] } });
    if (!made.ok) throw new Error(made.message);
    v.store.select(made.clipId); return made.assetId;
  });
  await page.getByRole('button', { name: /Open Director/ }).click();
  await page.locator('.director-side').getByRole('button', { name: 'vase', exact: true }).click();
  const rotation = page.locator('.director-selcard .prop-row').filter({ hasText: 'Rotate X' }).locator('input');
  await rotation.fill('25'); await rotation.press('Tab');
  await expect.poll(() => page.evaluate((id) => JSON.parse((window as any).velocut.doc().assets.find((a: any) => a.id === id).spec).props.find((p: any) => p.id === 'vase').rotationX, assetId)).toBe(25);
  const metalness = page.locator('.director-selcard .prop-row').filter({ hasText: 'metalness' }).locator('input');
  await metalness.fill('0.7'); await metalness.press('Tab');
  await expect.poll(() => page.evaluate((id) => JSON.parse((window as any).velocut.doc().assets.find((a: any) => a.id === id).spec).props.find((p: any) => p.id === 'vase').material?.metalness, assetId)).toBe(0.7);
  await page.screenshot({ path: testInfo.outputPath('director-modeling.png') });
  const r = await page.evaluate(async (assetId) => {
    const v = (window as any).velocut;
    const inspected = await v.sceneInspect({ assetId });
    const script = await v.script(`return await velocut.sceneEdit({assetId:${JSON.stringify(assetId)}, expectedRevision:${inspected.revision}, edits:[{type:'duplicate', id:'vase', newId:'vase-copy', offset:{x:1}}]});`);
    const revision = (await v.sceneInspect({ assetId })).revision;
    const concurrent = await Promise.all([
      v.sceneEdit({ assetId, expectedRevision: revision, edits: [{ type: 'update', id: 'vase', patch: { rotationZ: 15 } }] }),
      v.sceneEdit({ assetId, expectedRevision: revision, edits: [{ type: 'update', id: 'vase', patch: { rotationZ: 45 } }] }),
    ]);
    return { script, concurrent, spec: JSON.parse(v.doc().assets.find((a: any) => a.id === assetId).spec) };
  }, assetId);
  expect(r.script.ok).toBe(true);
  expect(r.spec.props.find((p: any) => p.id === 'vase-copy').rotationX).toBe(25);
  expect(r.spec.props.find((p: any) => p.id === 'vase-copy').material.metalness).toBe(0.7);
  expect(r.concurrent.filter((r: any) => r.ok)).toHaveLength(1);
  expect(r.concurrent.find((r: any) => !r.ok).message).toMatch(/conflict/);
  await expect(page.locator('.director-side').getByRole('button', { name: 'vase-copy', exact: true })).toBeVisible();
});

test('sweeps create volumetric paths and extruded holes remain open in rendered geometry', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async (url) => {
    const sdk = await import(url);
    const stage = await sdk.buildStage({ version: 1, durationUs: 1_000_000, environment: 'env/void', props: [
      { id: 'window', model: 'prop/extrude', position: { y: 0 }, points: [[-2, -2], [2, -2], [2, 2], [-2, 2]],
        holes: [[[-1, -1], [-1, 1], [1, 1], [1, -1]]], depth: 0.3, bevel: 0.05 },
      { id: 'rail', model: 'prop/tube', path: [[0, 0, 0], [0, 2, 0], [2, 2, 0]], radius: 0.1, position: { x: 5, y: 0 } },
    ] });
    stage.poseAt(0); stage.scene.updateMatrixWorld(true);
    const T = stage.three;
    const throughHole = new T.Raycaster(new T.Vector3(0, 0, 5), new T.Vector3(0, 0, -1)).intersectObject(stage.props[0].root, true).length;
    const throughFrame = new T.Raycaster(new T.Vector3(1.5, 0, 5), new T.Vector3(0, 0, -1)).intersectObject(stage.props[0].root, true).length;
    return { throughHole, throughFrame, rail: sdk.inspectStage(stage).find((o: any) => o.id === 'rail') };
  }, sdkUrl);
  expect(r.throughHole).toBe(0); expect(r.throughFrame).toBeGreaterThan(0);
  expect(r.rail.bounds.size[0]).toBeGreaterThan(2); expect(r.rail.bounds.size[1]).toBeGreaterThan(2);
  expect(r.rail.bounds.size[2]).toBeCloseTo(0.2, 2);
});

test('agent session navigation opens, selects, focuses, scrubs and plays without authoring changes', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.directorSession);
  const made = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 640, height: 360,
      props: [{ id: 'p', model: 'prop/cube', rotationZ: 20, position: { x: [{ t: 0, v: 0 }, { t: 1, v: 2 }] } }] } });
    const before = v.doc().assets.find((a: any) => a.id === made.assetId).spec;
    const opened = await v.script(`return await velocut.directorSession({assetId:${JSON.stringify(made.assetId)}, objectId:'p', focusId:'p', view:'top', timeS:0.3});`);
    return { ...made, before, opened };
  });
  expect(made.opened.ok).toBe(true);
  await expect(page.locator('.director-overlay')).toBeVisible();
  await expect(page.getByLabel('Director view')).toHaveValue('top');
  await expect(page.locator('.director-time')).toContainText('0.30s');
  await expect(page.locator('.director-selcard')).toBeVisible();
  await page.getByLabel('Director view').selectOption('front');
  expect(await page.evaluate(() => (window as any).velocut.directorSession().state.view)).toBe('front');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).velocut.directorSession().state.playing)).toBe(false);
  await expect(page.locator('.director-time')).toContainText('1.00s');
  const result = await page.evaluate(async (assetId) => {
    const v = (window as any).velocut;
    const after = v.doc().assets.find((a: any) => a.id === assetId).spec;
    const invalid = v.directorSession({ objectId: 'missing' });
    const sessionAfterInvalid = v.directorSession().state;
    await v.sceneEdit({ assetId, edits: [{ type: 'remove', id: 'p' }] });
    const cleared = v.directorSession().state;
    v.directorSession({ open: false }); return { after, invalid, sessionAfterInvalid, cleared };
  }, made.assetId);
  expect(result.after).toBe(made.before);
  expect(result.invalid.ok).toBe(false);
  expect(result.sessionAfterInvalid.objectId).toBe('p');
  expect(result.cleared.objectId).toBeNull(); expect(result.cleared.focusId).toBeNull();
  await expect(page.locator('.director-overlay')).toHaveCount(0);
});

test('parametric assemblies and world-bounds arrangement work with rotated/scaled parents', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneArrange);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({ spec: { version: 1, durationUs: 2_000_000, width: 640, height: 360,
      groups: [{ id: 'container', rotationZ: 35, scale: { x: 2, y: 1.5, z: 1 }, position: { x: 4, y: 3 } }],
      props: [{ id: 'cup', model: 'prop/sphere', parentId: 'container', scale: 0.2, position: { x: [{ t: 0, v: 1 }, { t: 1, v: 2 }] } }],
    } });
    const assetId = made.assetId;
    const edit = await v.sceneEdit({ assetId, edits: [
      { type: 'assembly', id: 'table', recipe: { template: 'table', parameters: { height: 1.5 } } },
      { type: 'assembly', id: 'stairs', recipe: { template: 'stairs', parameters: { steps: 4 } } },
      { type: 'update', id: 'stairs', patch: { position: { x: -3 } } },
    ] });
    const placed = await v.sceneArrange({ assetId, ids: ['cup'], mode: 'on', referenceId: 'table/top', gap: 0.01, expectedRevision: edit.revision });
    const inspection = await v.sceneInspect({ assetId });
    const afterOn = inspection.objects.find((o: any) => o.id === 'cup');
    const target = inspection.objects.find((o: any) => o.id === 'table/top');
    const ground = await v.sceneArrange({ assetId, ids: ['cup'], mode: 'ground' });
    const afterGround = (await v.sceneInspect({ assetId })).objects.find((o: any) => o.id === 'cup');
    const aligned = await v.sceneArrange({ assetId, ids: ['cup'], mode: 'align', referenceId: 'stairs', axis: 'x', edge: 'min' });
    const final = await v.sceneInspect({ assetId });
    return { edit, placed, afterOn, target, ground, afterGround, aligned, final };
  });
  expect(r.edit.ok).toBe(true); expect(r.placed.ok).toBe(true);
  expect(r.afterOn.bounds.min[1]).toBeCloseTo(r.target.bounds.max[1] + 0.01, 5);
  expect(r.afterOn.bounds.center[0]).toBeCloseTo(r.target.bounds.center[0], 5);
  expect(r.afterOn.bounds.center[2]).toBeCloseTo(r.target.bounds.center[2], 5);
  expect(r.ground.ok).toBe(true); expect(r.afterGround.bounds.min[1]).toBeCloseTo(0, 5);
  expect(r.aligned.ok).toBe(true);
  const cup = r.final.objects.find((o: any) => o.id === 'cup'), stairs = r.final.objects.find((o: any) => o.id === 'stairs');
  expect(cup.bounds.min[0]).toBeCloseTo(stairs.bounds.min[0], 5);
  const path = r.final.spec.props.find((p: any) => p.id === 'cup').position.x;
  expect(path).toHaveLength(2); expect(path[1].v - path[0].v).toBeCloseTo(1);
});

test('world-space gizmo drag under a rotated parent commits one undoable local translation', async ({ page }) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.directorSession);
  const assetId = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const r = await v.sceneClip({ spec: { version: 1, durationUs: 1_000_000, width: 640, height: 360,
      groups: [{ id: 'g', rotationY: 90 }], props: [{ id: 'cube', model: 'prop/cube', parentId: 'g', position: { x: 0, y: 0.5, z: 0 } }] } });
    v.directorSession({ assetId: r.assetId, objectId: 'cube', focusId: 'cube', view: 'front', mode: 'translate' });
    return r.assetId;
  });
  const canvas = page.locator('.director-canvas'); await expect(canvas).toBeVisible();
  // Wait until its viewport is actually rendered, not just mounted.
  await expect.poll(() => canvas.evaluate((c: HTMLCanvasElement) => c.width)).toBeGreaterThan(300);
  const box = (await canvas.boundingBox())!;
  const x = box.x + box.width / 2 + 65, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 80, y, { steps: 12 }); await page.mouse.up();
  await expect.poll(() => page.evaluate((assetId) => JSON.parse((window as any).velocut.doc().assets.find((a: any) => a.id === assetId).spec).props[0].position.z, assetId)).toBeGreaterThan(0.1);
  const result = await page.evaluate((assetId) => {
    const v = (window as any).velocut;
    const beforeUndo = JSON.parse(v.doc().assets.find((a: any) => a.id === assetId).spec).props[0];
    v.undo(); return { beforeUndo, afterUndo: JSON.parse(v.doc().assets.find((a: any) => a.id === assetId).spec).props[0] };
  }, assetId);
  expect(result.beforeUndo.parentId).toBe('g'); expect(result.beforeUndo.position.x).toBeCloseTo(0);
  expect(result.afterUndo.position).toEqual({ x: 0, y: 0.5, z: 0 });
});

test('export VideoFrames match shot observation and remain stable after out-of-order seeks', async ({ page }) => {
  await page.goto('/');
  const r = await page.evaluate(async (url) => {
    const sdk = await import(url);
    const compiled = sdk.compileSceneSpec({ version: 1, durationUs: 1_000_000, width: 320, height: 180,
      groups: [{ id: 'g', rotationY: [{ t: 0, v: 0 }, { t: 1, v: 70 }] }],
      props: [{ id: 'p', model: 'prop/extrude', parentId: 'g', points: [[-1, 0], [1, 0], [0, 1.5]], bevel: 0.03,
        rotationZ: 25, color: '#aa6622', material: { metalness: 0.2, roughness: 0.4 } }],
    }, { width: 320, height: 180, fps: 30 });
    await compiled.load();
    const canvas = new OffscreenCanvas(320, 180), ctx = canvas.getContext('2d')!;
    const pixels = (source: CanvasImageSource) => { ctx.clearRect(0, 0, 320, 180); ctx.drawImage(source, 0, 0); return ctx.getImageData(0, 0, 320, 180).data; };
    try {
      const frame = compiled.render(15); const exported = pixels(frame); frame.close();
      const image = await createImageBitmap(await compiled.capture({ view: 'shot', timeS: 15 * compiled.frameDurUs / 1e6 }));
      const observed = pixels(image); image.close();
      compiled.render(29).close(); compiled.render(0).close();
      const again = compiled.render(15); const repeated = pixels(again); again.close();
      let difference = 0, repeatDifference = 0;
      for (let i = 0; i < exported.length; i++) { difference += Math.abs(exported[i] - observed[i]); repeatDifference += Math.abs(exported[i] - repeated[i]); }
      return { difference: difference / exported.length, repeatDifference: repeatDifference / exported.length };
    } finally { compiled.dispose(); }
  }, sdkUrl);
  expect(r.difference).toBeLessThan(1); expect(r.repeatDifference).toBe(0);
});
