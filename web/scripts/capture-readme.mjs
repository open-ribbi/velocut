/** Reproducible README screenshots. Uses an isolated browser profile and the
 * real MCP bridge; never reads an existing project or fabricates chat output. */
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { startStudio } from '../packages/cli/dist/server.mjs';
import { browserOptions } from './browser-options.mjs';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  out = resolve(web, '../docs/media');
await mkdir(out, { recursive: true });
const app = await startStudio({ port: 0, open: false });
const client = new Client({ name: 'velocut-documentation', version: '0.0.1' });
let browser, browserServer;
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(web, 'packages/mcp/dist/cli.cjs')],
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    if (r.isError) throw Error(JSON.stringify(r.structuredContent));
    return r.structuredContent;
  };
  browserServer = await chromium.launchServer({ ...browserOptions, headless: process.platform === 'win32' ? false : browserOptions.headless });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 940 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(app.url);
  await page.waitForFunction(() => window.velocut);
  await page.locator('.project-current').click();
  await page.getByRole('button', { name: 'Rename Current…' }).click();
  await page.getByRole('textbox', { name: 'Project name' }).fill('Sunroom / Studio study');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  const pairing = await call('velocut_connect', { editorUrl: app.url });
  await page.goto(pairing.url);
  await page.locator('.codex-status.connected').waitFor();
  const { sessionId } = (await call('velocut_sessions')).sessions[0];
  const props = [];
  const box = (id, name, pos, scale, color) =>
    props.push({
      id,
      name,
      model: 'prop/cube',
      position: { x: pos[0], y: pos[1], z: pos[2] },
      scale: { x: scale[0], y: scale[1], z: scale[2] },
      color,
    });
  box('floor', 'Stone floor', [0, -0.13, 0], [6.2, 0.25, 5], '#c5b7a1');
  box('back-wall', 'Gallery wall', [0, 1.55, -2.45], [6.2, 3.1, 0.16], '#d4c8b6');
  box('side-wall', 'Sage wall', [-3, 1.55, 0], [0.16, 3.1, 5], '#768782');
  // Geometric wall relief and a small object pedestal.
  box('art-panel', 'Terracotta relief', [0.9, 1.75, -2.29], [1.6, 1.5, 0.1], '#a75f40');
  props.push({
    id: 'relief-ring',
    name: 'Wall ring',
    model: 'prop/torus',
    position: { x: 0.9, y: 1.75, z: -2.15 },
    rotationX: 90,
    scale: 0.54,
    color: '#dbc28f',
    material: { metalness: 0.35, roughness: 0.4 },
  });
  box('plinth', 'Sculpture plinth', [2, 0.43, -0.75], [0.95, 0.86, 0.95], '#ddd0b9');
  props.push({
    id: 'sculpture',
    name: 'Amber sculpture',
    model: 'prop/torus',
    position: { x: 2, y: 1.25, z: -0.75 },
    rotationX: 70,
    rotationZ: 18,
    scale: 0.52,
    color: '#dca554',
    material: { metalness: 0.65, roughness: 0.24 },
  });
  props.push({
    id: 'pot',
    name: 'Ceramic planter',
    model: 'prop/pillar',
    position: { x: -2.1, y: 0.3, z: -1.55 },
    scale: { x: 0.45, y: 0.6, z: 0.45 },
    color: '#ac6849',
  });
  for (let i = 0; i < 5; i++)
    props.push({
      id: `leaf-${i}`,
      name: `Foliage ${i + 1}`,
      model: 'prop/sphere',
      position: {
        x: -2.1 + Math.sin(i * 1.7) * 0.28,
        y: 0.9 + (i % 3) * 0.2,
        z: -1.55 + Math.cos(i * 1.7) * 0.25,
      },
      scale: { x: 0.32, y: 0.55, z: 0.28 },
      color: i % 2 ? '#58736b' : '#75896b',
    });
  props.push({
    id: 'pendant',
    name: 'Pendant shade',
    model: 'prop/sphere',
    position: { x: -0.1, y: 2.45, z: 0.2 },
    scale: { x: 0.52, y: 0.22, z: 0.52 },
    color: '#e8d8b3',
    material: { metalness: 0.25, roughness: 0.35 },
  });
  props.push({
    id: 'cable',
    name: 'Pendant cable',
    model: 'prop/pillar',
    position: { x: -0.1, y: 2.88, z: 0.2 },
    scale: { x: 0.012, y: 0.62, z: 0.012 },
    color: '#484b45',
  });
  const spec = {
    version: 1,
    durationUs: 4_000_000,
    width: 1280,
    height: 720,
    environment: 'env/void',
    lighting: 'indoor',
    props,
    camera: { position: { x: 6.5, y: 4.5, z: 8 }, lookAt: { x: 0, y: 1.1, z: 0 }, fov: 37 },
  };
  const wide = await call('velocut_scene_create', { sessionId, name: '01 · Sunroom wide', spec });
  await call('velocut_scene_edit', {
    sessionId,
    assetId: wide.assetId,
    edits: [
      {
        type: 'assembly',
        id: 'table',
        recipe: {
          template: 'table',
          parameters: { width: 1.7, depth: 1, height: 0.78, thickness: 0.07 },
        },
      },
      { type: 'update', id: 'table', patch: { name: 'Oak table', position: { x: -0.15, z: 0.3 } } },
      { type: 'assembly', id: 'chair-a', recipe: { template: 'chair' } },
      {
        type: 'update',
        id: 'chair-a',
        patch: { name: 'Chair · left', position: { x: -1.35, z: 0.3 }, rotationY: 90 },
      },
      { type: 'assembly', id: 'chair-b', recipe: { template: 'chair' } },
      {
        type: 'update',
        id: 'chair-b',
        patch: { name: 'Chair · front', position: { x: 0.1, z: 1.45 }, rotationY: 180 },
      },
    ],
  });
  const assembled = (await call('velocut_scene_inspect', { sessionId, assetId: wide.assetId }))
    .spec;
  await call('velocut_scene_create', {
    sessionId,
    name: '02 · Material detail',
    atUs: 4_000_000,
    spec: {
      ...assembled,
      durationUs: 3_000_000,
      camera: {
        position: { x: 3.8, y: 2.1, z: 2.5 },
        lookAt: { x: 1.9, y: 1.15, z: -0.7 },
        fov: 34,
      },
    },
  });
  await call('velocut_scene_create', {
    sessionId,
    name: '03 · Closing frame',
    atUs: 7_000_000,
    spec: {
      ...assembled,
      durationUs: 4_000_000,
      camera: { position: { x: 4, y: 3.4, z: 8 }, lookAt: { x: 0, y: 1.05, z: -0.2 }, fov: 42 },
    },
  });
  await page.evaluate(({ clipId }) => {
    const v = window.velocut;
    const t = v.apply({ type: 'addTrack', kind: 'text', name: 'Titles' });
    if (!t.ok) throw Error(JSON.stringify(t));
    const track = v.doc().tracks.find((t) => t.kind === 'text');
    const r = v.apply({
      type: 'addTextClip',
      trackId: track.id,
      startUs: 0,
      durationUs: 4_000_000,
      text: { content: 'S U N R O O M', fontSize: 42, color: '#f6eedf', align: 'center' },
    });
    if (!r.ok) throw Error(JSON.stringify(r));
    const textClip = v.doc().tracks.find((t) => t.kind === 'text').clips[0];
    v.apply({
      type: 'setTransform',
      clipId: textClip.id,
      transform: { ...textClip.transform, y: 245 },
    });
    v.store.select(clipId);
    v.seek(1_000_000);
  }, wide);
  await page.getByRole('button', { name: 'Fit timeline', exact: true }).click();
  await page.mouse.move(720, 70);
  await page.waitForTimeout(1200);
  if (await page.locator('.preview-error').count()) throw new Error('Preview rendering failed; screenshots were not updated.');
  await page.screenshot({ path: resolve(out, 'editor.png') });
  await call('velocut_director', {
    sessionId,
    options: {
      assetId: wide.assetId,
      objectId: 'table',
      view: 'perspective',
      camera: {
        projection: 'perspective',
        position: [6.5, 4.5, 8],
        target: [0, 1.1, 0],
        up: [0, 1, 0],
        fov: 40,
      },
    },
  });
  await page.locator('.director-canvas').waitFor();
  await page.getByLabel('Search scene objects').fill('table');
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(out, 'director.png') });
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.waitForTimeout(150);
  await page.screenshot({ path: resolve(out, 'history.png') });
  await page.getByRole('button', { name: 'Close history', exact: true }).click();
  await page.setViewportSize({ width: 440, height: 760 });
  await page.waitForTimeout(250);
  await page.mouse.move(430, 740);
  await page.screenshot({ path: resolve(out, 'compact.png') });
  console.log(`Captured editor, Director, history and compact workspace in ${out}`);
} finally {
  await client.close();
  await browserServer?.kill();
  await app.close();
}
