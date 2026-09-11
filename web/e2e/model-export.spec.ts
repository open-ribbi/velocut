import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { modelFixture } from '../packages/scene-sdk/test/glb-fixture';
const sdkUrl = '/@fs' + resolve('packages/scene-sdk/src/index.ts');
const browserImport = async (page: any, url: string, bytes: number[]) =>
  page.evaluate(
    async ({ url, bytes }: any) => {
      const sdk = await import(url),
        T = await import(
          '/@fs' +
            url.split('/@fs')[1].split('/packages/')[0] +
            '/node_modules/three/build/three.module.js'
        );
      const data = new Uint8Array(bytes).buffer;
      sdk.validateGlb(data);
      const gltf = await sdk.parseSceneModel(data);
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o: any) => {
        if (o.isSkinnedMesh) o.skeleton.update();
      });
      const bounds = new T.Box3().setFromObject(gltf.scene, true);
      const json = JSON.parse(
        new TextDecoder().decode(new Uint8Array(data, 20, new DataView(data).getUint32(12, true))),
      );
      const pixels: number[][] = [];
      gltf.scene.traverse((o: any) => {
        const image = o.material?.map?.image;
        if (image) {
          const c = new OffscreenCanvas(image.width, image.height),
            ctx = c.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          pixels.push([...ctx.getImageData(0, 0, 1, 1).data]);
        }
      });
      return {
        min: bounds.min.toArray(),
        max: bounds.max.toArray(),
        json,
        pixels,
        animationCount: gltf.animations.length,
      };
    },
    { url, bytes },
  );

test('selection export keeps animated world transforms, hierarchy and materials without changing the project', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).velocut?.sceneExport);
  const r = await page.evaluate(async () => {
    const v = (window as any).velocut;
    const made = await v.sceneClip({
      spec: {
        version: 1,
        durationUs: 2_000_000,
        environment: 'env/grid',
        groups: [
          { id: 'parent', position: { x: 3 }, rotationY: 35, scale: { x: 2, y: 1, z: 0.7 } },
        ],
        props: [
          {
            id: 'cube',
            name: 'Selected cube',
            parentId: 'parent',
            model: 'prop/cube',
            position: {
              x: [
                { t: 0, v: 0 },
                { t: 1, v: 2 },
              ],
              y: 1,
            },
            rotationZ: 20,
            color: '#cc6622',
            material: { metalness: 0.7, roughness: 0.25 },
          },
          { id: 'unselected', model: 'prop/sphere', position: { x: 20 } },
        ],
      },
    });
    if (!made.ok) throw Error(made.message);
    const before = JSON.stringify(v.doc()),
      revision = v.store.getState().revision;
    const original = await v.sceneInspect({ assetId: made.assetId, timeS: 1 });
    const exported = await v.sceneExport({ assetId: made.assetId, timeS: 1, objectIds: ['cube'] });
    if (!exported.ok) throw Error(exported.message);
    const unknown = await v.sceneExport({ assetId: made.assetId, objectIds: ['missing'] });
    const stale = await v.sceneExport({ assetId: made.assetId, expectedRevision: revision - 1 });
    return {
      bytes: [...new Uint8Array(await exported.blob.arrayBuffer())],
      bounds: original.objects.find((o: any) => o.id === 'cube').bounds,
      unchanged: before === JSON.stringify(v.doc()) && revision === v.store.getState().revision,
      unknown,
      stale,
    };
  });
  expect(r.unchanged).toBe(true);
  expect(r.unknown.ok).toBe(false);
  expect(r.stale.ok).toBe(false);
  const imported = await browserImport(page, sdkUrl, r.bytes);
  imported.min.forEach((v: number, i: number) => expect(v).toBeCloseTo(r.bounds.min[i], 4));
  imported.max.forEach((v: number, i: number) => expect(v).toBeCloseTo(r.bounds.max[i], 4));
  expect(imported.json.meshes).toHaveLength(1);
  expect(imported.animationCount).toBe(0);
  expect(imported.json.nodes.some((n: any) => n.name === 'Selected cube')).toBe(true);
  expect(imported.json.materials[0].pbrMetallicRoughness.metallicFactor).toBeCloseTo(0.7);
  await writeFile(test.info().outputPath('selection.glb'), new Uint8Array(r.bytes));
  await writeFile(test.info().outputPath('selection-bounds.json'), JSON.stringify(r.bounds));
});

test('scene export preserves embedded textures, sampled skin pose, lights and camera', async ({
  page,
}) => {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).velocut?.sceneExport);
  const r = await page.evaluate(
    async ({ base64, url }) => {
      const v = (window as any).velocut,
        sdk = await import(url);
      const made = await v.sceneClip({
        spec: {
          version: 1,
          durationUs: 2_000_000,
          environment: 'env/grid',
          characters: [{ id: 'fox', model: 'char/fox', actions: [{ clip: 'Walk', start: 0 }] }],
          lights: [
            { id: 'spot', type: 'spot', position: { y: 4, z: 3 }, rotationX: -50, intensity: 50 },
          ],
        },
      });
      const added = await v.sceneImportModel({
        assetId: made.assetId,
        base64,
        name: 'Textured cube',
      });
      if (!added.ok) throw Error(added.message);
      const pose = await v.sceneInspect({ assetId: made.assetId, timeS: 0.5 });
      const exported = await v.sceneExport({
        assetId: made.assetId,
        timeS: 0.5,
        objectIds: ['fox'],
      });
      if (!exported.ok) throw Error(exported.message);
      const all = await v.sceneExport({ assetId: made.assetId, timeS: 0.5 });
      if (!all.ok) throw Error(all.message);
      const noEnv = await v.sceneExport({
        assetId: made.assetId,
        timeS: 0.5,
        includeEnvironment: false,
        includeCamera: false,
      });
      if (!noEnv.ok) throw Error(noEnv.message);
      return {
        skin: [...new Uint8Array(await exported.blob.arrayBuffer())],
        all: [...new Uint8Array(await all.blob.arrayBuffer())],
        plain: [...new Uint8Array(await noEnv.blob.arrayBuffer())],
        bounds: pose.objects.find((o: any) => o.id === 'fox').bounds,
      };
    },
    {
      base64: Buffer.from(
        modelFixture((json: any) => {
          json.meshes[0].primitives[0].targets = [{ POSITION: 0 }];
          json.meshes[0].weights = [0.5];
        }, true),
      ).toString('base64'),
      url: sdkUrl,
    },
  );
  const skin = await browserImport(page, sdkUrl, r.skin);
  expect(skin.json.skins).toBeUndefined();
  expect(skin.animationCount).toBe(0);
  skin.min.forEach((v: number, i: number) => expect(v).toBeCloseTo(r.bounds.min[i], 3));
  skin.max.forEach((v: number, i: number) => expect(v).toBeCloseTo(r.bounds.max[i], 3));
  const all = await browserImport(page, sdkUrl, r.all);
  expect(all.json.images.length).toBeGreaterThan(0);
  expect(all.pixels.some((p: number[]) => p[0] > 200 && p[1] < 5 && p[2] < 5)).toBe(true);
  expect(all.json.meshes.every((m: any) => !m.weights)).toBe(true);
  expect(all.json.images.every((i: any) => Number.isInteger(i.bufferView))).toBe(true);
  expect(all.json.cameras.length).toBeGreaterThan(0);
  expect(all.json.extensions.KHR_lights_punctual.lights.some((l: any) => l.type === 'spot')).toBe(
    true,
  );
  expect(all.json.nodes.some((n: any) => n.name === 'stage-ground')).toBe(true);
  expect(all.json.nodes.some((n: any) => /GridHelper|TransformControls/.test(n.name ?? ''))).toBe(
    false,
  );
  const plain = await browserImport(page, sdkUrl, r.plain);
  expect(plain.min[0]).toBeCloseTo(-0.75, 4);
  expect(plain.max[0]).toBeCloseTo(0.75, 4);
  expect(plain.json.cameras).toBeUndefined();
  expect(plain.json.nodes.some((n: any) => n.name === 'stage-ground')).toBe(false);
  await writeFile(test.info().outputPath('skin-bounds.json'), JSON.stringify(r.bounds));
  for (const name of ['skin', 'all', 'plain'] as const)
    await writeFile(test.info().outputPath(name + '.glb'), new Uint8Array(r[name]));
});

test('compact Director downloads selected GLB and MCP writes only to a new explicit path', async ({
  page,
}) => {
  const dir = await mkdtemp(resolve(tmpdir(), 'velocut-export-')),
    client = new Client({ name: 'export-test', version: '1' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')],
        stderr: 'pipe',
      }),
    );
    const tool = (name: string, args: any = {}) =>
      client.callTool({ name, arguments: args }) as Promise<any>;
    const pairing = (await tool('velocut_connect')).structuredContent.url;
    await page.setViewportSize({ width: 400, height: 700 });
    await page.goto(pairing);
    await page.locator('.codex-status.connected').waitFor();
    const sessionId = (await tool('velocut_sessions')).structuredContent.sessions[0].sessionId;
    const made = (
      await tool('velocut_scene_create', {
        sessionId,
        spec: { version: 1, durationUs: 1_000_000, props: [{ id: 'box', model: 'prop/cube' }] },
      })
    ).structuredContent;
    await tool('velocut_director', {
      sessionId,
      options: { assetId: made.assetId, objectId: 'box' },
    });
    await page.getByLabel('More Director tools').click();
    await page.getByRole('button', { name: 'Export GLB…', exact: true }).click();
    await expect(page.getByLabel('GLB export scope')).toHaveValue('selection');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download GLB', exact: true }).click();
    const downloaded = await download;
    expect(downloaded.suggestedFilename()).toMatch(/\.glb$/);
    await downloaded.saveAs(resolve(dir, 'ui.glb'));
    await expect(page.getByRole('status')).toContainText('Download started');
    await page.keyboard.press('Escape');
    const path = resolve(dir, 'export.glb');
    const result = await tool('velocut_export_model', {
      sessionId,
      assetId: made.assetId,
      objectIds: ['box'],
      path,
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent.base64).toBeUndefined();
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 4).toString()).toBe('glTF');
    const duplicate = await tool('velocut_export_model', {
      sessionId,
      assetId: made.assetId,
      path,
    });
    expect(duplicate.isError).toBe(true);
    expect(await readFile(path)).toEqual(bytes);
    const relative = await tool('velocut_export_model', {
      sessionId,
      assetId: made.assetId,
      path: 'relative.glb',
    });
    expect(relative.isError).toBe(true);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('environment filtering cannot delete a same-named authored object, and invalid/cancelled requests fail', async ({page}) => {
  await page.goto('/');
  const result = await page.evaluate(async url => {
    const sdk = await import(url);
    const spec = {version:1,durationUs:1000000,environment:'env/void',props:[{id:'floor-name',name:'stage-ground',model:'prop/cube'}]};
    const output = await sdk.exportSceneGlb(spec,{includeEnvironment:false,includeCamera:false});
    const bytes = await output.blob.arrayBuffer();
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,20,new DataView(bytes).getUint32(12,true))));
    let invalid = false, cancelled = false;
    try { await sdk.exportSceneGlb(spec,{objectIds:[]}); } catch { invalid = true; }
    const abort = new AbortController(); abort.abort();
    try { await sdk.exportSceneGlb(spec,{signal:abort.signal}); } catch { cancelled = true; }
    return {meshes:json.meshes.length,invalid,cancelled};
  },sdkUrl);
  expect(result).toEqual({meshes:1,invalid:true,cancelled:true});
});
