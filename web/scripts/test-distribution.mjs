import { browserOptions } from './browser-options.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, cp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer as createPortReservation } from 'node:net';
import { execFileSync } from 'node:child_process';
import { npm } from './npm.mjs';
import { chromium } from '@playwright/test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = resolve(web, '../artifacts');
const manifest = JSON.parse(await readFile(resolve(artifacts, 'manifest.json'), 'utf8'));
const workspace = await realpath(await mkdtemp(join(tmpdir(), 'velocut-consumer-')));
console.log(`Independent consumer: ${workspace}`);
const run = (code) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: workspace,
    encoding: 'utf8',
  });
let browser, studio, preview, client, devServer, consumerEsbuild;
try {
  await writeFile(
    resolve(workspace, 'package.json'),
    JSON.stringify({ name: 'velocut-independent-consumer', private: true, type: 'module' }),
  );
  // One install resolves every exact-version local dependency from tarballs,
  // rather than falling back to workspace symlinks or an unpublished registry name.
  npm(
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...manifest.packages.map((p) => resolve(artifacts, p.file)),
      'vite@5.4.11',
      'typescript@5.9.3',
    ],
    { cwd: workspace, stdio: 'inherit', timeout: 180_000 },
  );
  consumerEsbuild = await import(pathToFileURL(resolve(workspace, 'node_modules/esbuild/lib/main.js')));
  for (const p of manifest.packages)
    assert.ok((await realpath(resolve(workspace, 'node_modules', p.name))).startsWith(workspace));
  const output = run(
    `import {TsEngine} from '@velocut/core-ts';import {validateCommand, BRIDGE_PROTOCOL_VERSION} from '@velocut/protocol';import {normalizeSceneSpec,applySceneEdits} from '@velocut/scene-sdk';import {Store,TsEngineAdapter} from '@velocut/runtime';const e=new TsEngine('packed',320,180,30,1);if(!e.apply({type:'addTrack',kind:'video'}).ok)throw Error('apply');const s=new Store(new TsEngineAdapter('runtime',320,180,30,1));s.dispatch({type:'addTrack',kind:'video'});s.undo();if(s.getState().doc.tracks.length)throw Error('undo');if(BRIDGE_PROTOCOL_VERSION!==2)throw Error('protocol');console.log('node sdk ok');`,
  );
  assert.match(output, /node sdk ok/);
  await writeFile(
    resolve(workspace, 'types.ts'),
    `import {TsEngine} from '@velocut/core-ts';import {RendererClient,MediaLibrary} from '@velocut/render-sdk';import {SceneSpec} from '@velocut/scene-sdk';import {Store,TsEngineAdapter,configureSceneStorage} from '@velocut/runtime';const e=new TsEngine('typecheck',320,180,30,1);const s:SceneSpec={version:1,durationUs:1000000};const m:MediaLibrary=new MediaLibrary();const r:RendererClient=new RendererClient();const store=new Store(new TsEngineAdapter('runtime',320,180,30,1));void [e,s,m,r,store,configureSceneStorage];`,
  );
  await writeFile(
    resolve(workspace, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
      },
      include: ['types.ts'],
    }),
  );
  execFileSync(
    process.execPath,
    [resolve(workspace, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'],
    { cwd: workspace, stdio: 'inherit' },
  );
  const portable = resolve(workspace, 'portable');
  await cp(resolve(artifacts, `velocut-${manifest.version}`), portable, { recursive: true });
  const portableDoctor = JSON.parse(
    execFileSync(process.execPath, [resolve(portable, 'start-studio.mjs'), 'doctor', '--json'], {
      cwd: tmpdir(),
      encoding: 'utf8',
    }),
  );
  assert.equal(portableDoctor.ok, true);
  const market = JSON.parse(
    await readFile(resolve(portable, '.agents/plugins/marketplace.json'), 'utf8'),
  );
  assert.equal(market.plugins[0].source.path, './plugins/velocut');
  const pluginClient = new Client({ name: 'relocated-plugin-test', version: '1.0.0' });
  try {
    await pluginClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(portable, 'plugins/velocut/scripts/server.cjs')],
        cwd: tmpdir(),
        stderr: 'pipe',
      }),
    );
    assert.ok((await pluginClient.listTools()).tools.some((t) => t.name === 'velocut_scene_edit'));
  } finally {
    await pluginClient.close();
  }
  const cliRoot = resolve(workspace, 'node_modules/@velocut/cli/dist');
  const doctor = JSON.parse(
    execFileSync(process.execPath, [resolve(cliRoot, 'cli.mjs'), 'doctor', '--json'], {
      cwd: workspace,
      encoding: 'utf8',
    }),
  );
  assert.equal(doctor.ok, true);
  const { startStudio } = await import(pathToFileURL(resolve(cliRoot, 'server.mjs')));
  studio = await startStudio({ port: 0, open: false });
  const health = await fetch(studio.url + '/__velocut/health');
  assert.equal((await health.json()).bridgeProtocol, 2);
  const index = await fetch(studio.url);
  assert.equal(index.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.match(await index.text(), /<html/);
  const range = await fetch(studio.url + '/scene-assets/manifest.json', {
    headers: { Range: 'bytes=0-15' },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  assert.equal((await fetch(studio.url + '/%2e%2e%2fpackage.json')).status, 403);
  console.log('Browser graphics configuration:', JSON.stringify(browserOptions));
  browser = await chromium.launch(browserOptions);
  const page = await browser.newPage();
  await page.goto(studio.url);
  await page.waitForFunction(() => window.velocut?.sceneEdit);
  client = new Client({ name: 'external-distribution-test', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(workspace, 'node_modules/@velocut/mcp/dist/cli.cjs')],
      stderr: 'pipe',
    }),
  );
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.structuredContent;
  };
  const pairing = await call('velocut_connect', { editorUrl: studio.url });
  await page.goto(pairing.url);
  await page.waitForFunction(() => document.querySelector('.codex-status.connected'));
  const sessions = (await call('velocut_sessions')).sessions;
  assert.equal(sessions.length, 1);
  const sessionId = sessions[0].sessionId;
  const created = await call('velocut_scene_create', {
    sessionId,
    spec: {
      version: 1,
      durationUs: 1000000,
      width: 320,
      height: 180,
      environment: 'env/void',
      props: [{ id: 'cube', model: 'prop/cube', color: '#ff2222' }],
    },
  });
  const observed = await client.callTool({
    name: 'velocut_observe',
    arguments: { sessionId, mode: 'scene', source: { assetId: created.assetId }, view: 'front' },
  });
  assert.equal(observed.isError, false);
  assert.ok(observed.content.some((c) => c.type === 'image' && c.data.length > 100));
  console.log('Packed CLI + MCP + scene authoring/vision passed');
  await client.close();
  client = null;
  await page.close();
  await studio.close();
  studio = null;
  // Production Vite consumer with no aliases to Velocut source. Assets come
  // from the installed scene SDK; both workers come from the render SDK.
  await mkdir(resolve(workspace, 'public'), { recursive: true });
  await cp(
    resolve(workspace, 'node_modules/@velocut/scene-sdk/assets'),
    resolve(workspace, 'public/custom-scenes'),
    { recursive: true },
  );
  await writeFile(
    resolve(workspace, 'index.html'),
    '<html><body style="margin:0"><canvas id="render" width="320" height="180"></canvas><script type="module" src="/main.js"></script></body></html>',
  );
  await writeFile(
    resolve(workspace, 'main.js'),
    `
import {RendererClient,MediaLibrary} from '@velocut/render-sdk';
import {TsEngine} from '@velocut/core-ts';
import {Store,TsEngineAdapter,bindSceneAuthoring,createSceneClip,disposeSceneAuthoring,directorController} from '@velocut/runtime';
import {directorSession} from '@velocut/runtime/director-session';
import workerUrl from '@velocut/render-sdk/workers/media?url';
window.probe=(async()=>{
 const worker=new Worker(workerUrl,{type:'module'});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('media worker timeout')),10000);worker.onerror=reject;worker.onmessage=e=>{if(e.data.type==='exportFrame'){clearTimeout(timer);resolve();}};worker.postMessage({type:'frameAt',id:'missing',reqId:1,timeUs:0});});worker.terminate();
 const a=new Store(new TsEngineAdapter('A',320,180,30,1)), b=new Store(new TsEngineAdapter('B',320,180,30,1));
 const mediaA=new MediaLibrary(),mediaB=new MediaLibrary('B',{workerUrl});bindSceneAuthoring(a,mediaA,{assetBase:'/custom-scenes'});bindSceneAuthoring(b,mediaB,{assetBase:'/custom-scenes'});
 const make=(color)=>({spec:{version:1,durationUs:1000000,width:320,height:180,environment:'env/void',props:[{id:'cube',model:'prop/cube',color}]}});
 const ca=await createSceneClip(a,mediaA,make('#ff2222')), cb=await createSceneClip(b,mediaB,make('#2222ff'));if(!ca.ok||!cb.ok)throw Error(JSON.stringify([ca,cb]));
 if(ca.assetId!==cb.assetId)throw Error('expected identical ids across projects');
 directorSession(a,{assetId:ca.assetId});if(directorController(a).getSnapshot()?.assetId!==ca.assetId)throw Error('duplicate runtime session modules');
 disposeSceneAuthoring(b);mediaB.dispose();
 const frame=await mediaA.frameFor(ca.assetId,0);if(!frame)throw Error('project A renderer was disposed by B');
 const engine=new TsEngine('pixels',320,180,30,1);engine.apply({type:'addAsset',id:'red',kind:'image',src:'local://red',name:'Red',durationUs:1000000,width:320,height:180,hasAudio:false});engine.apply({type:'addTrack',kind:'video'});engine.apply({type:'addClip',trackId:engine.document().tracks[0].id,assetId:'red',startUs:0,durationUs:1000000});
 const red=new OffscreenCanvas(320,180);const ctx=red.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,320,180);mediaA.attachImage('red',new VideoFrame(red,{timestamp:0}));
 const renderer=new RendererClient();await renderer.init(document.querySelector('#render'));renderer.render(engine.evaluate(0),mediaA);
 window.cleanup=()=>{renderer.dispose();disposeSceneAuthoring(a);mediaA.dispose();};return {ok:true,worker:workerUrl};
})().catch(e=>({ok:false,error:String(e),stack:e.stack}));`,
  );
  await writeFile(
    resolve(workspace, 'vite.config.mjs'),
    "import {velocutVite} from '@velocut/render-sdk/vite'; export default {plugins:[velocutVite()],build:{target:'esnext'}};",
  );
  execFileSync(process.execPath, [resolve(workspace, 'node_modules/vite/bin/vite.js'), 'build'], {
    cwd: workspace,
    stdio: 'inherit',
  });
  const vite = await import(
    pathToFileURL(resolve(workspace, 'node_modules/vite/dist/node/index.js'))
  );
  preview = await vite.preview({
    root: workspace,
    configFile: resolve(workspace, 'vite.config.mjs'),
    preview: { port: 0, host: '127.0.0.1' },
  });
  const consumer = await browser.newPage({ viewport: { width: 320, height: 180 } });
  await consumer.goto(preview.resolvedUrls.local[0]);
  console.log('Verifying production SDK render probe');
  const result = await consumer.evaluate(() => Promise.race([window.probe, new Promise(resolve => setTimeout(() => resolve({ok:false,error:'GPU/worker probe exceeded 45 seconds'}),45_000))]));
  assert.equal(result.ok, true, JSON.stringify(result));
  await consumer.waitForTimeout(400);
  const screenshot = (await consumer.screenshot()).toString('base64');
  const redPixels = await consumer.evaluate(async (base64) => {
    const image = await createImageBitmap(
      await (await fetch('data:image/png;base64,' + base64)).blob(),
    );
    const c = new OffscreenCanvas(image.width, image.height),
      ctx = c.getContext('2d');
    ctx.drawImage(image, 0, 0);
    image.close();
    const data = ctx.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i] > 150 && data[i + 1] < 60 && data[i + 2] < 60) red++;
    return red;
  }, screenshot);
  assert.ok(redPixels > 10000, `Expected rendered red pixels, got ${redPixels}`);
  await consumer.evaluate(() => window.cleanup());
  console.log(
    'Installed render/scene/runtime SDKs: types, workers, WebGPU pixels and project isolation passed',
  );
  const reservation=createPortReservation();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const devPort=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
  devServer = await vite.createServer({root:workspace,configFile:resolve(workspace,'vite.config.mjs'),server:{port:devPort,strictPort:true,host:'127.0.0.1',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'}}});
  await devServer.listen();
  const devPage = await browser.newPage();
  await devPage.goto(devServer.resolvedUrls.local[0]);
  console.log('Verifying development SDK render probe');
  const devResult = await devPage.evaluate(()=>Promise.race([window.probe,new Promise(resolve=>setTimeout(()=>resolve({ok:false,error:'Dev GPU/worker probe exceeded 45 seconds'}),45_000))]));
  assert.equal(devResult?.ok,true,JSON.stringify(devResult));
  await devPage.evaluate(()=>window.cleanup());
  console.log('Installed SDK Vite development mode and shared subpath state passed');

  await writeFile(
    resolve(artifacts, 'distribution-verification.json'),
    JSON.stringify(
      {
        ok: true,
        platform: process.platform,
        node: process.versions.node,
        packages: manifest.packages.map((p) => ({ name: p.name, sha256: p.sha256 })),
        checks: [
          'node-import',
          'types',
          'cli-doctor',
          'http-headers-ranges',
          'mcp-stdio',
          'scene-vision',
          'vite-production-consumer',
          'media-worker',
          'render-worker-webgpu-pixels',
          'runtime-project-isolation',
          'vite-development-consumer',
      'shared-runtime-subpaths',
      'portable-launcher-relocation',
          'plugin-marketplace-relocation',
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error('Distribution verification failed:', error);
  throw error;
} finally {
  console.log('Closing distribution browser and build services');
  const cleanupDeadline = setTimeout(() => { console.error('Distribution cleanup exceeded 20 seconds'); process.exit(1); }, 20_000);
  cleanupDeadline.unref();
  await client?.close();
  await browser?.close();
  await studio?.close();
  await devServer?.close();
  if (preview) await new Promise((resolve) => { preview.httpServer.close(resolve); preview.httpServer.closeAllConnections(); });
  // Vite retains esbuild's service even after closing its HTTP servers.
  // Release the executable before deleting it on Windows.
  consumerEsbuild?.stop();
  if (process.env.VELOCUT_KEEP_CONSUMER !== '1')
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  clearTimeout(cleanupDeadline);
}
