import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tileGeometry } from './fixtures/tiles';
const sdkUrl = '/@fs' + resolve('packages/scene-sdk/src/index.ts');

test('MCP CodeAct creates 1000 linked tiles, preflights costs and preserves edits through undo/reload', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const client = new Client({ name: 'instance-test', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('packages/mcp/dist/velocut/scripts/server.cjs')], stderr: 'pipe' }));
  const tool = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args }) as any).structuredContent;
  try {
    await page.goto((await tool('velocut_connect')).url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId = (await tool('velocut_sessions')).sessions[0].sessionId;
    const made = await tool('velocut_scene_create', { sessionId, name: 'Shared tile test', spec: { version: 1, durationUs: 2_000_000, width: 640, height: 360, environment: 'env/void' } });
    expect(made.ok, JSON.stringify(made)).toBe(true);
    const assetId = made.assetId;
    const result = await tool('velocut_script', { sessionId, code: `
      const assetId=${JSON.stringify(assetId)}, geometry=${JSON.stringify(tileGeometry())};
      const check = r => {if (!r.ok) throw new Error(JSON.stringify(r)); return r;};
      const initial=check(await velocut.query({kind:'snapshot'}));
      let r=check(await velocut.sceneEdit({assetId,expectedRevision:initial.revision,includeSpec:false,edits:[
        {type:'geometry.create',id:'tile',geometry},
        {type:'add',kind:'group',object:{id:'roof',rotationY:15}}
      ]}));
      const samples=[];
      for(let start=0;start<1000;start+=250){
        const edits=Array.from({length:250},(_,j)=>{
          const i=start+j,row=Math.floor(i/40),col=i%40;
          return {type:'add',kind:'prop',object:{id:'tile_'+i,model:'prop/instance',geometryId:'tile',parentId:'roof',color:'#b65c29',
            position:{x:Number(((col-19.5)*0.27).toFixed(3)),y:Number((2+0.4*Math.cos(row/24*Math.PI/2)).toFixed(3)),z:Number(((row-12)*0.36).toFixed(3))}}};
        });
        const preview=check(await velocut.sceneEdit({assetId,expectedRevision:r.revision,edits,preflight:true}));
        if(preview.compiled!==false || preview.ready!==false) throw new Error('invalid preflight');
        r=check(await velocut.sceneEdit({assetId,expectedRevision:r.revision,edits,includeSpec:false}));
        samples.push(r.budget.used.instances);
      }
      return {samples,revision:r.revision,budget:r.budget};
    ` });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.result.samples).toEqual([250,500,750,1000]);
    expect(result.result.budget.used.instanceBatches).toBe(1);
    expect(result.result.budget.used.specBytes).toBeLessThan(262144);
    const performanceSample = await page.evaluate(async ({ assetId, sdkUrl }) => {
      const sdk=await import(sdkUrl), v=(window as any).velocut;
      const spec=JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec), start=performance.now();
      const stage=await sdk.buildStage(spec), buildMs=performance.now()-start;
      stage.poseAt(0);
      const T=stage.three, renderer=new T.WebGLRenderer({canvas:new OffscreenCanvas(640,360),antialias:false});
      renderer.setSize(640,360,false);
      const {camera}=sdk.constructionCamera(stage,640,360,'perspective');
      renderer.render(stage.scene,camera);
      const sample={instances:stage.props.length,drawCalls:renderer.info.render.calls,triangles:renderer.info.render.triangles,
        sharedGeometries:new Set(stage.props.map((p:any)=>p.root.geometry)).size,buildMs,frames:30,renderLoopMs:0};
      const renderStart=performance.now();
      for(let i=0;i<30;i++){stage.poseAt(i/30);renderer.render(stage.scene,camera);}
      renderer.getContext().finish(); sample.renderLoopMs=performance.now()-renderStart;
      renderer.dispose();renderer.forceContextLoss(); return sample;
    }, {assetId,sdkUrl});
    expect(performanceSample.drawCalls).toBe(1); expect(performanceSample.sharedGeometries).toBe(1);
    expect(performanceSample.triangles).toBe(tileGeometry().faces.length*1000);
    const performancePath = testInfo.outputPath('1000-instance-performance.json');
    await writeFile(performancePath, JSON.stringify(performanceSample, null, 2));
    await testInfo.attach('1000-instance-performance.json',{path:performancePath,contentType:'application/json'});
    const geometries = await tool('velocut_query', { sessionId, kind: 'sceneGeometries', assetId });
    expect(geometries.data.items[0].instanceCount).toBe(1000);
    expect(geometries.data.items[0].geometry).toBeUndefined();
    const last = await tool('velocut_query', { sessionId, kind: 'sceneObjects', assetId, offset: 901, limit: 100 });
    expect(last.data.nextOffset).toBeNull(); expect(last.data.items).toHaveLength(100);
    const overflow = await tool('velocut_scene_edit', { sessionId, assetId, preflight: true, edits: [{ type: 'duplicate', id: 'tile_0', newId: 'overflow' }] });
    expect(overflow.ok).toBe(false); expect(overflow.budget.violations[0].field).toBe('instances');
    const unique = await tool('velocut_scene_edit', { sessionId, assetId, expectedRevision: result.result.revision, includeSpec: false, edits: [
      { type: 'makeUnique', id: 'tile_0' },
      { type: 'transform', ids: ['tile_0'], relative: true, transform: { position: { y: 1 } } },
      { type: 'geometry.update', id: 'tile', geometry: { ...tileGeometry(), vertices: tileGeometry().vertices.map(([x,y,z]) => [x,y*2,z]) } },
    ] });
    expect(unique.ok, JSON.stringify(unique)).toBe(true); expect(unique.spec).toBeUndefined();
    expect(unique.budget.used.instances).toBe(999); expect(unique.budget.used.props).toBe(1);
    expect(unique.changedIds).toHaveLength(1000);
    const read = () => tool('velocut_query', { sessionId, kind: 'sceneGeometries', assetId });
    await tool('velocut_history', { sessionId, action: 'undo', expectedRevision: unique.revision });
    expect((await read()).data.items[0].instanceCount).toBe(1000);
    const snap = await read();
    await tool('velocut_history', { sessionId, action: 'redo', expectedRevision: snap.revision });
    const observed = await client.callTool({ name: 'velocut_observe', arguments: { sessionId, mode: 'scene', source: { assetId }, view: 'perspective', at: 0 } }) as any;
    expect(observed.isError, JSON.stringify(observed.structuredContent)).toBe(false);
    const picture = observed.content.find((c: any) => c.type === 'image'); expect(picture).toBeTruthy();
    const imagePath=testInfo.outputPath('1000-tiles.png');
    await writeFile(imagePath,Buffer.from(picture.data,'base64'));
    await testInfo.attach('1000-tiles.png', { path:imagePath, contentType:'image/png' });
    await testInfo.attach('scene-budget.json', { body: JSON.stringify(unique.budget), contentType: 'application/json' });
    await page.evaluate(() => (window as any).velocut.collab.flushNow());
    await page.reload(); await page.waitForFunction(() => (window as any).velocut?.query);
    const restored = await page.evaluate(assetId => {
      const v=(window as any).velocut;
      return {budget:v.query({kind:'sceneBudget',assetId}), objects:v.query({kind:'sceneObjects',assetId,ids:['tile_0','tile_999'],fields:['id','object']})};
    }, assetId);
    expect(restored.budget.data.used.instances).toBe(999);
    expect(restored.objects.data.items[0].object.model).toBe('prop/mesh');
    expect(restored.objects.data.items[0].object.vertices[4][1]).toBeCloseTo(0.065);
    expect(restored.objects.data.items[1].object.geometryId).toBe('tile');
  } finally { await client.close(); }
});

test('instance rendering matches independent meshes, preserves picking and exports selected geometry', async ({ page }, testInfo) => {
  await page.goto('/'); await page.waitForFunction(() => (window as any).velocut?.sceneEdit);
  const result = await page.evaluate(async ({ sdkUrl, geometry }) => {
    const sdk = await import(sdkUrl);
    const spec:any = { version:1, durationUs:2_000_000, width:320, height:180, environment:'env/void', geometries:{tile:geometry},
      groups:[{id:'g',rotationY:25,scale:{x:1.4,y:0.8,z:1}}],
      props:[{id:'a',model:'prop/instance',geometryId:'tile',parentId:'g',position:{x:-0.2,y:0,z:0},color:'#ff3300',material:{side:'double'}},
        {id:'b',model:'prop/instance',geometryId:'tile',parentId:'g',position:{x:[{t:0,v:0.2},{t:1,v:0.5}],y:0,z:0},color:'#22ff33',material:{side:'double'}}],
      camera:{position:{x:0,y:0.8,z:1.6},lookAt:{x:0,y:0,z:0}} };
    const stage = await sdk.buildStage(spec); stage.poseAt(1);
    const T=stage.three, canvas=new OffscreenCanvas(320,180), renderer=new T.WebGLRenderer({canvas,antialias:false}); renderer.setSize(320,180,false);
    const camera=new T.PerspectiveCamera(40,320/180,0.01,100); sdk.applySpecCamera(camera,spec,stage,1);
    const pixels = () => { const p=new Uint8Array(320*180*4); renderer.getContext().readPixels(0,0,320,180,renderer.getContext().RGBA,renderer.getContext().UNSIGNED_BYTE,p); return p; };
    renderer.render(stage.scene,camera); const a=pixels(), calls=renderer.info.render.calls;
    const expanded = sdk.applySceneEdits(spec,[{type:'makeUnique',id:'a'},{type:'makeUnique',id:'b'}]).spec;
    const other=await sdk.buildStage(expanded); other.poseAt(1); renderer.render(other.scene,camera); const b=pixels();
    let different=0,colored=0;
    for(let i=0;i<a.length;i+=4){if(Math.max(Math.abs(a[i]-b[i]),Math.abs(a[i+1]-b[i+1]),Math.abs(a[i+2]-b[i+2]))>3)different++;
      if(a[i]>a[i+2]*1.5||a[i+1]>a[i+2]*1.5)colored++;}
    const before=sdk.inspectStage(stage).find((o:any)=>o.id==='b');
    stage.poseAt(0); stage.poseAt(1); const after=sdk.inspectStage(stage).find((o:any)=>o.id==='b');
    const out=await sdk.exportSceneGlb(spec,{timeS:1,objectIds:['b']});
    const gltf=await sdk.parseSceneModel(await out.blob.arrayBuffer());
    const bounds=new T.Box3().setFromObject(gltf.scene,true);
    const ids:string[]=[]; gltf.scene.traverse((o:any)=>{if(o.userData.velocutObjectId)ids.push(o.userData.velocutObjectId);});
    renderer.dispose(); renderer.forceContextLoss();
    const v=(window as any).velocut, made=await v.sceneClip({spec}); if(!made.ok)throw new Error(made.message);
    await v.directorSession({assetId:made.assetId,open:true,objectId:'b',view:'front',focusId:'b',playing:false});
    return {assetId:made.assetId,different,colored,calls,before,after,exportBounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},ids};
  }, {sdkUrl,geometry:tileGeometry()});
  expect(result.calls).toBe(1); expect(result.colored).toBeGreaterThan(200);
  expect(result.different).toBeLessThan(100);
  expect(result.before.bounds).toEqual(result.after.bounds);
  result.exportBounds.min.forEach((n:number,i:number)=>expect(n).toBeCloseTo(result.before.bounds.min[i],4));
  result.exportBounds.max.forEach((n:number,i:number)=>expect(n).toBeCloseTo(result.before.bounds.max[i],4));
  expect(result.ids).toContain('b'); expect(result.ids).not.toContain('a');
  await page.setViewportSize({width:640,height:760});
  // The ordinary properties panel edits the selected logical instance.
  await page.getByRole('button',{name:'Properties',exact:true}).click();
  await expect(page.getByRole('button',{name:'Make geometry unique',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Make geometry unique',exact:true}).click();
  await page.waitForFunction(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec).props.find((p:any)=>p.id==='b').model==='prop/mesh',result.assetId);
  await testInfo.attach('instance-rendering.json',{body:JSON.stringify(result),contentType:'application/json'});
});
