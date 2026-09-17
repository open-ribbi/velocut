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
let browser, browserServer, studio, preview, client, devServer, consumerEsbuild;
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
    `import {TsEngine} from '@velocut/core-ts';import {validateCommand, BRIDGE_PROTOCOL_VERSION} from '@velocut/protocol';import {normalizeSceneSpec,applySceneEdits} from '@velocut/scene-sdk';import {Store,TsEngineAdapter,atomicRuntime} from '@velocut/runtime';import {ops,ref} from '@velocut/protocol';const e=new TsEngine('packed',320,180,30,1);if(!e.apply({type:'addTrack',kind:'video'}).ok)throw Error('apply');const s=new Store(new TsEngineAdapter('runtime',320,180,30,1));s.dispatch({type:'addTrack',kind:'video'});s.undo();if(s.getState().doc.tracks.length)throw Error('undo');if(BRIDGE_PROTOCOL_VERSION!==2)throw Error('protocol');const a=atomicRuntime(s);const snap=a.query({kind:'snapshot'});if(!snap.ok)throw Error('snapshot');const result=await a.transaction({action:'commit',requestId:'packed-atomic',runtimeId:snap.runtimeId,expectedRevision:snap.revision,operations:[{id:'track',command:ops.addTrack({kind:'text'})},{id:'title',command:ops.addTextClip({trackId:ref('track','trackId'),startUs:0,durationUs:1000000,text:{content:'Packed'}})}]});if(!result.ok||!result.data.results.title.clipId)throw Error('atomic composition');if(!a.capabilities({name:'splitClip'}).data.inputSchema)throw Error('atomic schema');console.log('node sdk ok');`,
  );
  assert.match(output, /node sdk ok/);
  // Build a third-party package against installed public declarations, outside the checkout.
  const providerExample=resolve(workspace,'consumer-provider');
  await cp(resolve(web,'../examples/provider-example'),providerExample,{recursive:true});
  execFileSync(process.execPath,[resolve(workspace,'node_modules/typescript/bin/tsc'),'-p',resolve(providerExample,'tsconfig.json')],{cwd:workspace,stdio:'inherit'});
  const providersOutput=run(`
    import assert from 'node:assert/strict';
    import {ProviderRegistry} from '@velocut/provider-sdk';
    import {asVideoGenerator} from '@velocut/provider-sdk/video';
    import {taskApiProvider,arkVideoProvider} from '@velocut/provider-task-api';
    import {minimaxProvider,minimaxVideoProvider,minimaxMusicProvider} from '@velocut/provider-minimax';
    import {modelPreset,parameterDefaults} from '@velocut/provider-sdk/catalog';
    import {exampleProvider} from './consumer-provider/dist/index.js';
    const registry=new ProviderRegistry().register(exampleProvider).register(taskApiProvider).register(minimaxProvider).register(arkVideoProvider).register(minimaxVideoProvider).register(minimaxMusicProvider);
    let posts=0,reads=0;
    const provider=registry.create({id:'external',provider:'example-video',config:{endpoint:'https://external.invalid'},credentials:{apiKey:{store:'host',key:'test'}}},{resolveCredential:async()=>{reads++;return 'test-key'},fetch:async(url,init)=>{
      if(init?.method==='POST'){posts++;return Response.json({id:'external-task',region:'west'})}
      assert.match(String(url),/region=west/);return Response.json({status:'done',url:'https://cdn.invalid/video.mp4'});
    }});
    assert.equal(registry.list().length,6);assert.equal(modelPreset('seedance-2').model,'seedance-2.0');assert.equal(parameterDefaults({presetId:'minimax-h3'}).resolution,'2K');assert.equal(provider.describe().models[0].id,'example-1');assert.equal(reads,0);
    const video=asVideoGenerator(provider),receipt=await video.submit({model:'example-1',prompt:'Independent provider'});
    assert.equal(receipt.handle.region,'west');const done=await video.poll(receipt.taskId,undefined,JSON.parse(JSON.stringify(receipt.handle)));assert.equal(done.state,'succeeded');assert.equal(done.result.videoUrl,'https://cdn.invalid/video.mp4');assert.equal(posts,1);
    const speech=registry.create({id:'audio',provider:'minimax',config:{endpoint:'https://speech.invalid',model:'test-speech'}},{resolveCredential:async()=>undefined,fetch:async()=>Response.json({data:{audio:'494433'}})});
    const audio=await speech.execute({capability:'audio.synthesize',model:'test-speech',input:{text:'Hello'}});assert.equal(audio.outputs[0].source.kind,'bytes');assert.equal(globalThis.AudioContext,undefined);
    const native=registry.create({id:'native',provider:'minimax-video',config:{baseUrl:'https://native.invalid/v1',modelSettings:{presetId:'hailuo-2.3'}},credentials:{apiKey:{store:'test',key:'native'}}},{resolveCredential:async()=> 'fake',fetch:async(url,init)=>{if(init?.method==='POST'){assert.equal(String(url),'https://native.invalid/v1/video_generation');return Response.json({task_id:'native-task'})}return Response.json(String(url).includes('/query/')?{status:'Success',file_id:'native-file'}:{file:{download_url:'https://cdn.invalid/native.mp4'}})}});
    const task=await native.submit({capability:'video.generate',model:'MiniMax-Hailuo-2.3',input:{prompt:'Lake',durationS:6,resolution:'1080P'}}),polled=await native.poll(task);assert.equal(polled.state,'ready');assert.equal((await native.collect(polled.receipt)).outputs[0].kind,'video');
    console.log('independent providers ok');
  `);
  assert.match(providersOutput,/independent providers ok/);
  const declarativeOutput=run(`import assert from 'node:assert/strict';import{parseModelSpec,modelInput}from'@velocut/provider-sdk/declarative';const spec=parseModelSpec({version:1,id:'external',capability:'audio.synthesize',inputSchema:{type:'object',properties:{voice:{type:'object',properties:{speed:{type:'number',default:1}}}}},execution:{type:'sync-http',auth:{type:'none'},submit:{method:'POST',path:'/speak',body:{$input:''}},outputs:[{kind:'audio',base64:'$.audio'}]}});assert.deepEqual(modelInput(spec,{voice:{}}),{voice:{speed:1}});console.log('declarative SDK ok');`);
  assert.match(declarativeOutput,/declarative SDK ok/);

  const resourceOutput = run(`
    import { Store, TsEngineAdapter, atomicRuntime, configureMediaResources } from '@velocut/runtime';
    import { ops, ref } from '@velocut/protocol';
    const store = new Store(new TsEngineAdapter('resource-consumer',320,180,30,1)), files = new Map();
    configureMediaResources(store,{storage:{write:async(n,b)=>{files.set(n,b)},read:async n=>files.get(n)??null,remove:async n=>{files.delete(n)}},
      probe:async()=>({kind:'image',format:'png',width:1,height:1,durationUs:0,hasAudio:false,tracks:[]})});
    const api=atomicRuntime(store), runtimeId=api.runtimeId;
    async function done(id){for(let i=0;i<1000;i++){const j=api.jobs({action:'get',runtimeId,jobId:id}).data;if(j.state==='succeeded')return j.result;if(j.state==='failed')throw Error(j.error.message);await new Promise(r=>setTimeout(r,1));}throw Error('job timeout')}
    const imported=await api.resources({action:'import',runtimeId,requestId:'resource',file:new File(['fixture'],'fixture.bin')});
    if(!imported.ok)throw Error(imported.error.message);
    const resource=(await done(imported.data.id)).resource;
    const probe=api.jobs({action:'submit',runtimeId,requestId:'probe',task:'media.probe',resourceId:resource.id});await done(probe.data.id);
    if(store.getState().doc.assets.length)throw Error('implicit registration');
    const result=await api.transaction({action:'commit',runtimeId,expectedRevision:store.getState().revision,requestId:'register',operations:[
      {id:'asset',command:ops.registerAsset({resourceId:resource.id,probeId:probe.data.id})},
      {id:'track',command:ops.addTrack({kind:'video'})},
      {id:'clip',command:ops.addClip({assetId:ref('asset','assetId'),trackId:ref('track','trackId'),startUs:0,durationUs:1000000})},
      {id:'copy',command:ops.duplicateClip({clipId:ref('clip','clipId')})}
    ]});
    if(!result.ok||store.getState().doc.tracks[0].clips.length!==2)throw Error(JSON.stringify(result));
    console.log('resource jobs and duplication ok');
  `);
  assert.match(resourceOutput, /resource jobs and duplication ok/);
  const generationOutput=run(`
    import assert from 'node:assert/strict';
    import {Store,TsEngineAdapter,atomicRuntime,configureGeneration,generation} from '@velocut/runtime';
    import {ops,ref,CURRENT_FORMAT_VERSION} from '@velocut/protocol';
    const store=new Store(new TsEngineAdapter('generated',320,180,30,1)),api=atomicRuntime(store);
    const made=await api.transaction({action:'commit',runtimeId:api.runtimeId,expectedRevision:0,requestId:'slot',operations:[
      {id:'track',command:ops.addTrack({kind:'video'})},
      {id:'slot',command:ops.addGenerationSlot({trackId:ref('track','trackId'),startUs:0,durationUs:1000000,request:{channel:'mock',model:'mock',prompt:'Packed generation'}})}
    ]});
    assert.ok(made.ok);const slotId=made.data.results.slot.slotId;
    assert.deepEqual(store.evaluate(0).pendingGenerationIds,[slotId]);assert.equal(CURRENT_FORMAT_VERSION,5);
    assert.ok(api.capabilities({name:'generation'}).data.inputSchema);
    let ledger=null,posts=0,mutex=Promise.resolve();
    const manager=configureGeneration(store,{
      projectId:'packed',channels:()=>[{id:'mock',models:['mock']}],binding:()=> 'mock',
      read:async()=>structuredClone(ledger),write:async value=>{ledger=structuredClone(value)},
      lock:work=>{const next=mutex.then(work);mutex=next.catch(()=>{});return next},lead:async work=>work(),
      submit:async()=>({taskId:'task_'+(++posts)}),poll:async()=>({state:'succeeded',status:'completed',result:{videoUrl:'https://mock.invalid/clip.mp4'}}),
      download:async()=>({src:'opfs://mock.mp4',name:'Mock',durationUs:2000000,width:320,height:180,hasAudio:false,size:5}),
      prepareReference:async()=>{throw Error('unused')},capture:async()=>{throw Error('unused')},saveReference:async()=>{throw Error('unused')},referenceBlob:async()=>new Blob(),mediaBlob:async()=>new Blob(['mock']),attach:async()=>{},pollIntervalMs:1,
    });
    try{
      const input={action:'submit',slotId,intentVersion:1,requestId:'paid-once'};
      const first=await generation(store,input),again=await generation(store,input);assert.ok(first.ok);assert.equal(first.job.id,again.job.id);
      let ready=false;for(let i=0;i<300;i++){const r=await generation(store,{action:'get',jobId:first.job.id});if(r.job?.state==='succeeded'){ready=true;break}await new Promise(r=>setTimeout(r,5));}
      assert.ok(ready);assert.equal(posts,1);assert.equal(store.getState().doc.assets.length,0);
      const adopted=await generation(store,{action:'adopt',slotId,jobId:first.job.id,intentVersion:1,expectedRevision:store.getState().revision});assert.ok(adopted.ok);
      assert.equal(store.getState().doc.tracks[0].clips[0].durationUs,1000000);assert.equal(store.evaluate(0).pendingGenerationIds,undefined);
      store.undo();store.redo();assert.equal(posts,1);console.log('generation sdk ok');
    }finally{manager.dispose()}
  `);
  assert.match(generationOutput,/generation sdk ok/);
  const instanceOutput = run(`
    import assert from 'node:assert/strict';
    import {applySceneEdits,sceneBudget,sampleObjectTransform} from '@velocut/scene-sdk';
    import {Store,TsEngineAdapter,atomicRuntime,editScene,HistoryTree} from '@velocut/runtime';
    const geometry={vertices:[[0,0,0],[1,0,0],[0,1,0]],faces:[[0,1,2]]};
    const made=applySceneEdits({version:1,durationUs:1000000},[
      {type:'geometry.create',id:'tile',geometry},
      {type:'material.create',id:'red',material:{color:'#ff0000',roughness:.38}},
      {type:'curve.create',id:'grow',curve:{keys:[{t:0,v:0},{t:1,v:1,ease:'none'}]}},
      {type:'add',kind:'prop',object:{id:'a',model:'prop/instance',geometryId:'tile',materialId:'red',animation:{channels:{'scale.y':{curveId:'grow'},opacity:{curveId:'grow'}}}}},
      {type:'anchor.set',id:'a',anchorId:'seat',anchor:{position:[0,0,0]}},
      {type:'duplicate',id:'a',newId:'b',offset:{x:2}}
    ]);
    assert.equal(sceneBudget(made.spec).used.instanceBatches,1);
    const store=new Store(new TsEngineAdapter('instances',320,180,30,1));
    const registered=store.dispatch({type:'addAsset',kind:'image',name:'Tiles',src:'scene://tiles',durationUs:1000000,width:320,height:180,spec:JSON.stringify(made.spec)});
    assert.ok(registered.ok);const assetId=store.getState().doc.assets[0].id,api=atomicRuntime(store);
    const geometries=api.query({kind:'sceneGeometries',assetId});assert.ok(geometries.ok);assert.equal(geometries.data.items[0].instanceCount,2);
    const preview=await editScene(store,{assetId,preflight:true,edits:[{type:'makeUnique',id:'b'}]});
    assert.ok(preview.ok);assert.equal(preview.compiled,false);assert.equal(preview.budget.used.instances,1);
    assert.ok(preview.spec===undefined);assert.ok(preview.geometryIds.length);
    assert.equal(api.query({kind:'sceneMaterials',assetId}).data.items[0].objectCount,2);
    const curves=api.query({kind:'sceneCurves',assetId});assert.ok(curves.ok);assert.equal(curves.data.items[0].objectCount,2);
    assert.equal(curves.data.items[0].curve,undefined);assert.deepEqual(made.curveIds,['grow']);
    const pose=sampleObjectTransform(made.spec.props[1],.5,made.spec);assert.equal(pose.scale[1],.5);assert.equal(pose.opacity,.5);
    assert.equal(api.capabilities().data.sceneLimits.curves,null);
    assert.deepEqual(made.spec.props[1].anchors.seat.position,[0,0,0]);
    assert.ok(api.capabilities({name:'sceneSpatial'}).data.inputSchema.properties.queries);
    const linked=applySceneEdits(made.spec,[{type:'binding.create',id:'follow',binding:{type:'position',source:{objectId:'a',anchorId:'seat'},target:{objectId:'b',anchorId:'seat'}}}]);
    assert.deepEqual(linked.bindingIds,['follow']);assert.equal(sceneBudget(linked.spec).limits.bindings,null);
    const packed=store.getHistory().serializeCompact();const restored=HistoryTree.deserialize(JSON.parse(JSON.stringify(packed)));
    assert.equal(restored.all().length,store.getHistory().all().length);assert.equal(packed.historyEncoding,'spec-table-v1');
    console.log('shared geometry sdk ok');
  `);
  assert.match(instanceOutput, /shared geometry sdk ok/);
  const largeSpecOutput = run(`
    import assert from 'node:assert/strict';
    import {validateCommand,MAX_SPEC_BYTES} from '@velocut/protocol';
    import {Store,TsEngineAdapter,atomicRuntime} from '@velocut/runtime';
    const store=new Store(new TsEngineAdapter('large spec',320,180,30,1)),api=atomicRuntime(store);
    const spec=JSON.stringify({value:'a'.repeat(400000)});
    const command={type:'addAsset',kind:'image',src:'opfs://fixture.png',name:'Large',width:16,height:16,spec};
    assert.equal(MAX_SPEC_BYTES,null);assert.ok(validateCommand(command).ok);
    const result=await api.transaction({action:'commit',runtimeId:api.runtimeId,expectedRevision:0,requestId:'large',operations:[{id:'asset',command}]});
    assert.ok(result.ok);const read=api.query({kind:'assets',fields:['spec']});assert.ok(read.ok);assert.equal(read.data.items[0].spec,spec);
    console.log('large spec roundtrip ok');
  `);
  assert.match(largeSpecOutput,/large spec roundtrip ok/);

  await writeFile(
    resolve(workspace, 'types.ts'),
    `import {TsEngine} from '@velocut/core-ts';import {RendererClient,MediaLibrary} from '@velocut/render-sdk';import {SceneSpec} from '@velocut/scene-sdk';import {Store,TsEngineAdapter,configureSceneStorage,type AtomicQuery} from '@velocut/runtime';import {ops,ref,type AtomicPlan} from '@velocut/protocol';const q:AtomicQuery={kind:'clips',fields:['id']};const plan:AtomicPlan={runtimeId:'runtime',expectedRevision:0,operations:[{id:'clip',command:ops.addClip({trackId:ref('track','trackId'),assetId:'asset',startUs:0})}]};void [q,plan];const e=new TsEngine('typecheck',320,180,30,1);const s:SceneSpec={version:1,durationUs:1000000};const m:MediaLibrary=new MediaLibrary();const r:RendererClient=new RendererClient();const store=new Store(new TsEngineAdapter('runtime',320,180,30,1));void [e,s,m,r,store,configureSceneStorage];`,
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
    const tools=(await pluginClient.listTools()).tools;
    assert.ok(tools.some((t) => t.name === 'velocut_scene_edit'));
    assert.ok(tools.some((t) => t.name === 'velocut_generation'));
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
  process.env.VELOCUT_MODEL_HOME=resolve(workspace,'model-configuration');
  studio = await startStudio({ port: 0, open: false });
  const modelApi=async value=>{const response=await fetch(studio.url+'/__velocut/models',{method:'POST',headers:{origin:studio.url,'content-type':'application/json'},body:JSON.stringify(value)});const result=await response.json();assert.equal(result.ok,true,JSON.stringify(result));return result.data;};
  const declarativeSpec={version:1,id:'independent-model',capability:'video.generate',inputSchema:{type:'object',properties:{camera:{type:'object',properties:{speeds:{type:'array',items:{type:'number'}}}}}},execution:{type:'async-http',submit:{method:'POST',path:'/tasks',body:{$input:''}},receipt:{id:'$.id'},poll:{method:'GET',path:'/tasks/{receipt.id}',status:'$.status',states:{running:['running'],succeeded:['done'],failed:['failed']}},outputs:[{kind:'video',url:'$.video'}]}};
  const savedModel=await modelApi({action:'upsert',definition:declarativeSpec});assert.ok(savedModel.revision);
  await modelApi({action:'connections',connection:{id:'independent-model-channel',modelId:'independent-model',baseUrl:'https://fixture.invalid'}});
  const previewedModel=await modelApi({action:'preview',connectionId:'independent-model-channel',input:{camera:{speeds:[0.2,1]}}});assert.deepEqual(previewedModel.request.body,{camera:{speeds:[0.2,1]}});
  assert.match((await modelApi({action:'get',id:'independent-model'})).yaml,/independent-model/);
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
  browserServer = await chromium.launchServer(browserOptions);
  browser = await chromium.connect(browserServer.wsEndpoint());
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
  const geometryEdit = await call('velocut_scene_edit', {sessionId,assetId:created.assetId,includeSpec:false,edits:[
    {type:'geometry.create',id:'tile',geometry:{vertices:[[0,0,0],[1,0,0],[0,1,0],[1,1,0]],faces:[[0,1,2],[1,3,2]]}},
    {type:'anchor.set',id:'cube',anchorId:'top',anchor:{position:[0,.5,0]}},
    {type:'add',kind:'prop',object:{id:'tile',model:'prop/instance',geometryId:'tile',position:{x:2},color:'#ff2222'}},
  ]});
  assert.ok(geometryEdit.ok);
  const spatial=await call('velocut_scene_spatial',{sessionId,assetId:created.assetId,expectedRevision:geometryEdit.revision,queries:[{type:'distance',from:{objectId:'cube',anchorId:'top'},to:{position:[0,1,0]}}]});
  assert.ok(spatial.ok);assert.equal(spatial.results[0].distance,0);
  const vertex = await call('velocut_scene_geometry', {sessionId,assetId:created.assetId,geometryId:'tile',offset:1,limit:1});
  assert.deepEqual(vertex.items,[[1,0,0]]);assert.match(vertex.resource.src,/scene-geometry-.*\.vmesh$/);
  const moved = await call('velocut_scene_edit',{sessionId,assetId:created.assetId,includeSpec:false,expectedRevision:vertex.revision,
    edits:[{type:'transform',ids:['tile'],transform:{position:{x:3}}}]});
  assert.ok(moved.ok);assert.equal(moved.updateMode,'transforms');
  const anchored=await call('velocut_scene_edit',{sessionId,assetId:created.assetId,expectedRevision:moved.revision,includeSpec:false,edits:[{type:'anchor.set',id:'tile',anchorId:'seat',anchor:{position:[0,0,0]}},{type:'binding.create',id:'follow',binding:{type:'position',source:{objectId:'cube',anchorId:'top'},target:{objectId:'tile',anchorId:'seat'}}}]});
  assert.ok(anchored.ok);assert.deepEqual(anchored.bindingIds,['follow']);
  const bound=await call('velocut_scene_spatial',{sessionId,assetId:created.assetId,queries:[{type:'bindings'},{type:'distance',from:{objectId:'cube',anchorId:'top'},to:{objectId:'tile',anchorId:'seat'}}]});
  assert.ok(bound.ok);assert.equal(bound.results[0].items[0].status,'valid');assert.equal(bound.results[1].distance,0);
  const bindingList=await call('velocut_query',{sessionId,kind:'sceneBindings',assetId:created.assetId});assert.equal(bindingList.data.total,1);
  const sampled=await call('velocut_scene_spatial',{sessionId,assetId:created.assetId,queries:[{type:'surface',objectId:'tile',triangleIndex:0,barycentric:[.2,.3,.5]}]});
  const surfaceAnchor=sampled.results[0].surface.surfaceAnchor;
  assert.match(surfaceAnchor.surface.geometryKey,/^[0-9a-f]{64}$/);assert.deepEqual(surfaceAnchor.surface.vertexIndices,[0,1,2]);
  const attached=await call('velocut_scene_edit',{sessionId,assetId:created.assetId,expectedRevision:sampled.revision,includeSpec:false,edits:[
    {type:'anchor.set',id:'tile',anchorId:'surface',anchor:{...surfaceAnchor,name:'Keep this name',tangent:[1,0,0]}},
    {type:'geometry.patch',id:'tile',attribute:'faces',updates:[{index:1,value:[1,2,3]}]},
  ]});
  assert.ok(attached.ok);
  const unaffected=await call('velocut_scene_spatial',{sessionId,assetId:created.assetId,queries:[{type:'anchors',objectId:'tile',status:'invalid'}]});
  assert.equal(unaffected.results[0].items.length,0);
  await call('velocut_scene_edit',{sessionId,assetId:created.assetId,expectedRevision:unaffected.revision,includeSpec:false,edits:[
    {type:'geometry.patch',id:'tile',attribute:'faces',updates:[{index:0,value:[0,2,1]}]},
  ]});
  const repairs=await call('velocut_scene_spatial',{sessionId,assetId:created.assetId,queries:[{type:'anchorRepair',objectId:'tile',anchorId:'surface',method:'face'}]});
  const repair=repairs.results[0];assert.equal(repair.currentStatus,'invalid');assert.equal(repair.status,'candidate');
  assert.equal(repair.candidate.orientationChanged,true);assert.deepEqual(repair.candidate.edit.surface.barycentric,[.2,.5,.3]);
  const fixed=await call('velocut_scene_edit',{sessionId,assetId:created.assetId,expectedRevision:repairs.revision,includeSpec:false,edits:[repair.candidate.edit]});
  assert.ok(fixed.ok);assert.equal(fixed.updateMode,'transforms');
  const repaired=await call('velocut_scene_spatial',{sessionId,assetId:created.assetId,queries:[{type:'anchors',objectId:'tile'},{type:'bindings'}]});
  const resultAnchor=repaired.results[0].items.find(a=>a.anchorId==='surface');
  assert.equal(resultAnchor.status,'valid');assert.equal(resultAnchor.anchor.name,'Keep this name');assert.deepEqual(resultAnchor.anchor.tangent,[1,0,0]);
  assert.equal(repaired.results[1].items[0].status,'valid');
  console.log('Packed surface references: local face invalidation, preview and atomic rebind passed');
  const observed = await client.callTool({
    name: 'velocut_observe',
    arguments: { sessionId, mode: 'scene', source: { assetId: created.assetId }, view: 'front' },
  });
  assert.equal(observed.isError, false);
  assert.ok(observed.content.some((c) => c.type === 'image' && c.data.length > 100));
  const exportedPath = resolve(workspace, 'roundtrip.glb');
  const exported = await call('velocut_export_model', { sessionId, assetId: created.assetId, path: exportedPath });
  assert.equal(exported.base64, undefined);
  const exportedBytes = await readFile(exportedPath);
  assert.equal(exportedBytes.subarray(0, 4).toString(), 'glTF');
  const roundtrip = await call('velocut_import_model', { sessionId, assetId: created.assetId, path: exportedPath });
  assert.ok(roundtrip.objectId);
  console.log('Packed CLI + MCP + scene authoring/vision passed');
  const physicsScene=await call('velocut_scene_create',{sessionId,atUs:1_000_000,spec:{version:1,durationUs:3_000_000,width:320,height:180,environment:'env/grid',props:[
    {id:'platform',model:'prop/extrude',points:[[-1,-1],[1,-1],[1,1],[-1,1]],holes:[[[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]],depth:.2,rotationX:-90,position:{y:1.2},physics:'fixed'},
    {id:'ball',model:'prop/sphere',scale:.2,position:{y:2.8},physics:{type:'dynamic',mass:.1,restitution:0},anchors:{center:{position:[0,0,0]}}},
  ]}});
  const physical=await call('velocut_scene_spatial',{sessionId,assetId:physicsScene.assetId,timeS:2,queries:[{type:'colliders',objectIds:['platform']},{type:'anchors',objectId:'ball'},{type:'colliderGeometry',objectId:'platform',colliderId:'default',limit:2}]});
  assert.equal(physical.results[0].items[0].effectiveShape,'mesh');assert.ok(Math.abs(physical.results[1].items[0].position[1]-.1)<.005);assert.equal(physical.results[2].items.length,2);
  await call('velocut_scene_edit',{sessionId,assetId:physicsScene.assetId,expectedRevision:physical.revision,edits:[{type:'collider.update',id:'platform',colliderId:'default',collider:{shape:'convexHull'}}]});
  const held=await call('velocut_scene_spatial',{sessionId,assetId:physicsScene.assetId,timeS:2,queries:[{type:'anchors',objectId:'ball'}]});assert.ok(Math.abs(held.results[0].items[0].position[1]-1.4)<.005);
  const colliderView=await call('velocut_director',{sessionId,options:{assetId:physicsScene.assetId,objectId:'platform',colliderView:'selected'}});assert.equal(colliderView.state.colliderView,'selected');
  console.log('Packed collision shapes: hole preservation, atomic shape edits and wireframe queries passed');
  const jointScene=await call('velocut_scene_create',{sessionId,atUs:4_000_000,spec:{version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void',physics:{gravity:0},props:[
    {id:'base',model:'prop/cube',scale:.2,position:{y:2},physics:'fixed'},
    {id:'arm',model:'prop/cube',position:{y:1.5},physics:{type:'dynamic',mass:1},anchors:{tip:{position:[0,.5,0]}}},
  ]}});
  const jointEdit=await call('velocut_scene_edit',{sessionId,assetId:jointScene.assetId,expectedRevision:jointScene.revision,edits:[{type:'joint.create',id:'hinge',joint:{type:'revolute',a:{objectId:'base',position:[0,0,0]},b:{objectId:'arm',anchorId:'tip'},axis:[0,0,1],limits:[-60,60],motor:{mode:'position',targetPosition:30,stiffness:100,damping:20}}}]});
  assert.deepEqual(jointEdit.jointIds,['hinge']);
  const jointDefs=await call('velocut_query',{sessionId,assetId:jointScene.assetId,kind:'sceneJoints',fields:['id','joint']});assert.equal(jointDefs.data.items[0].joint.motor.targetPosition,30);
  const jointState=await call('velocut_scene_spatial',{sessionId,assetId:jointScene.assetId,timeS:2,queries:[{type:'joints',ids:['hinge']}]});
  assert.ok(Math.abs(jointState.results[0].items[0].coordinate-30)<.5);assert.ok(jointState.results[0].items[0].linearErrorM<.005);
  const actualVersion=run(`import{createRequire}from'node:module';import{dirname,join}from'node:path';import{readFileSync}from'node:fs';const r=createRequire(import.meta.url),sdk=r.resolve('@velocut/scene-sdk'),physics=createRequire(sdk).resolve('@dimforge/rapier3d-compat');console.log(JSON.parse(readFileSync(join(dirname(physics),'package.json'),'utf8')).version);`).trim();
  assert.equal(jointState.results[0].engine.version,actualVersion);
  const jointView=await call('velocut_director',{sessionId,options:{assetId:jointScene.assetId,objectId:'arm',jointView:'selected'}});assert.equal(jointView.state.jointView,'selected');
  console.log('Packed joints: atomic edits, motor/limit simulation, solver version and guide session passed');
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
      'atomic-query-transaction',
      'resource-probe-register-duplicate',
      'generation-slots-durable-jobs-and-adoption',
      'independent-provider-package-and-encoded-speech',
      'configured-model-catalog-and-native-video',
      'shared-geometry-instances',
      'geometry-resource-and-incremental-transform',
      'surface-local-invalidation-and-atomic-repair',
      'collision-shapes-and-compound-body-inspection',
      'physical-joints-motors-and-solver-version',
      'shared-material-and-compact-history',
      'large-spec-no-byte-ceiling',
          'types',
          'cli-doctor',
          'http-headers-ranges',
          'mcp-stdio',
          'scene-vision',
        'model-export-roundtrip',
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
  await browserServer?.kill();
  console.log('Distribution browser process stopped');
  await studio?.close();
  consumerEsbuild?.stop();
  await devServer?.close();
  console.log('Distribution development server stopped');
  if (preview) await new Promise((resolve) => { preview.httpServer.close(resolve); preview.httpServer.closeAllConnections(); });
  console.log('Distribution preview server stopped');
  if (process.env.VELOCUT_KEEP_CONSUMER !== '1')
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  clearTimeout(cleanupDeadline);
}
