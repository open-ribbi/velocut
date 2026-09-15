import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {detailedTileGeometry,tileGeometry} from './fixtures/tiles';
import {modelFixture} from '../packages/scene-sdk/test/glb-fixture';
const sdkUrl='/@fs'+resolve('packages/scene-sdk/src/index.ts');

test('CodeAct animates 1000 detailed tiles with shared curves; updates, snapshots and undo survive reload',async({page},testInfo)=>{
  test.setTimeout(120_000);
  const client=new Client({name:'curve-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const made=await call('velocut_script',{sessionId,code:`
      const r=await velocut.sceneClip({name:'Shared tile animation',spec:{version:1,durationUs:6_000_000,width:640,height:360,environment:'env/void',
        geometries:{tile:${JSON.stringify(detailedTileGeometry())}},materials:{gold:{color:'#c08b39',roughness:.38,metalness:.12,side:'double'}},
        curves:{grow:{keys:[{t:0,v:0},{t:.3,v:1,ease:'none'}]},fade:{keys:[{t:0,v:0},{t:.2,v:1,ease:'none'}]},show:{mode:'step',keys:[{t:0,v:0},{t:.01,v:1}]}},
        props:Array.from({length:1000},(_,i)=>({id:'tile_'+i,model:'prop/instance',geometryId:'tile',materialId:'gold',
          position:{x:(i%40-19.5)*.34,y:2,z:(Math.floor(i/40)-12)*.35},animation:{timeOffset:i*.004,channels:{'scale.y':{curveId:'grow'},opacity:{curveId:'fade'},visible:{curveId:'show'}}}}))}});
      if(!r.ok)throw new Error(r.message);return {assetId:r.assetId};`});
    expect(made.ok,JSON.stringify(made)).toBe(true);const assetId=made.result.assetId;
    const query=await call('velocut_query',{sessionId,kind:'sceneCurves',assetId});
    expect(query.ok,JSON.stringify(query)).toBe(true);expect(query.data.items).toHaveLength(3);
    expect(query.data.items.every((c:any)=>c.objectCount===1000&&c.curve===undefined)).toBe(true);
    const sample=await page.evaluate(async({sdkUrl,assetId})=>{
      const sdk=await import(sdkUrl),runtime=await import(sdkUrl.replace('/scene-sdk/','/runtime/')),v=(window as any).velocut;
      const spec=JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec),stage=await sdk.buildStage(spec,undefined,runtime.sceneResources(v.store));
      const snapshots=[];
      for(const t of [5,0,.15,5,.15]){stage.poseAt(t);snapshots.push({t,count:stage.instanceBatches[0].mesh.count,
        first:sdk.inspectStage(stage).find((o:any)=>o.id==='tile_0'),lastVisible:sdk.objectIsVisible(stage.props[999].root)});}
      const T=stage.three,renderer=new T.WebGLRenderer({canvas:new OffscreenCanvas(640,360)});renderer.setSize(640,360,false);
      stage.poseAt(5);const {camera}=sdk.constructionCamera(stage,640,360,'perspective');renderer.render(stage.scene,camera);
      const rendered={calls:renderer.info.render.calls,triangles:renderer.info.render.triangles,geometries:new Set(stage.props.map((p:any)=>p.root.geometry)).size};
      renderer.dispose();renderer.forceContextLoss();return {snapshots,rendered};
    },{sdkUrl,assetId});
    expect(sample.rendered).toEqual({calls:1,triangles:1000*detailedTileGeometry().faces.length,geometries:1});
    expect(sample.snapshots[0].count).toBe(1000);expect(sample.snapshots[1].count).toBe(0);
    expect(sample.snapshots[1].first.visible).toBe(false);expect(sample.snapshots[1].first.quaternion).toBeNull();
    expect(sample.snapshots[2].first.scale[1]).toBeCloseTo(.5);expect(sample.snapshots[2].first.opacity).toBeCloseTo(.75);
    expect(sample.snapshots[2].lastVisible).toBe(false);expect(sample.snapshots[2]).toEqual(sample.snapshots[4]);
    const snap=await call('velocut_query',{sessionId,kind:'snapshot'});
    const edit=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:snap.revision,includeSpec:false,
      edits:[{type:'curve.update',id:'grow',curve:{keys:[{t:0,v:0},{t:1,v:1,ease:'none'}]}}]});
    expect(edit.ok,JSON.stringify(edit)).toBe(true);expect(edit.curveIds).toEqual(['grow']);expect(edit.changedIds).toHaveLength(1000);
    const read=async(snapshotId?:string)=>call('velocut_query',{sessionId,kind:'sceneCurves',assetId,ids:['grow'],fields:['id','curve'],...(snapshotId?{snapshotId}:{})});
    expect((await read()).data.items[0].curve.keys[1].t).toBe(1);
    expect((await read(snap.data.snapshotId)).data.items[0].curve.keys[1].t).toBe(.3);
    const bad=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:edit.revision,preflight:true,edits:[{type:'curve.remove',id:'grow'}]});
    expect(bad.ok).toBe(false);expect(bad.message).toMatch(/referenced/);
    const undo=await call('velocut_history',{sessionId,action:'undo',expectedRevision:edit.revision});expect(undo.ok).toBe(true);
    expect((await read()).data.items[0].curve.keys[1].t).toBe(.3);
    const moved=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:undo.revision,includeSpec:false,edits:[
      {type:'update',id:'tile_0',patch:{animation:{timeOffset:2,channels:{'scale.y':{curveId:'grow'},opacity:{curveId:'fade'},visible:{curveId:'show'}}}}}]});
    expect(moved.ok,JSON.stringify(moved)).toBe(true);expect(moved.updateMode).toBe('transforms');
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneInspect);
    const restored=await page.evaluate(async assetId=>{
      const v=(window as any).velocut;const r=await v.sceneInspect({assetId,timeS:2.15});if(!r.ok)throw Error(r.message);
      return {curves:v.query({kind:'sceneCurves',assetId}).data.items,first:r.objects.find((o:any)=>o.id==='tile_0')};
    },assetId);
    expect(restored.first.scale[1]).toBeCloseTo(.5);expect(restored.first.visible).toBe(true);expect(restored.curves).toHaveLength(3);
    await testInfo.attach('shared-animation.json',{body:JSON.stringify(sample,null,2),contentType:'application/json'});
  }finally{await client.close();}
});

test('rendering, picking, inherited fades and GLB snapshots agree at arbitrary animation times',async({page},testInfo)=>{
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneClip);
  const r=await page.evaluate(async({sdkUrl,geometry,model})=>{
    const sdk=await import(sdkUrl),v=(window as any).velocut;
    const spec:any={version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void',geometries:{tile:geometry},
      curves:{grow:{keys:[{t:0,v:0},{t:1,v:1,ease:'none'}]}},groups:[{id:'g',opacity:.5,scale:{x:1.4,y:.8,z:1}}],
      props:[{id:'a',model:'prop/instance',geometryId:'tile',parentId:'g',position:{x:-.2,y:0},color:'#ff3300',material:{side:'double'},
        visible:[{t:0,v:false},{t:.1,v:true}],animation:{channels:{'scale.y':{curveId:'grow'},opacity:{curveId:'grow'}}}},
        {id:'b',model:'prop/instance',geometryId:'tile',position:{x:.2,y:0},color:'#22ff33',material:{side:'double'}},
        {id:'hidden',model:'prop/cube',position:{x:1000},visible:false}],lights:[{id:'lamp',parentId:'g',type:'point',intensity:10,position:{z:5}}]};
    const stage=await sdk.buildStage(spec),T=stage.three,renderer=new T.WebGLRenderer({canvas:new OffscreenCanvas(320,180),antialias:false});renderer.setSize(320,180,false);
    const camera=new T.PerspectiveCamera(40,320/180,.01,100);camera.position.set(0,.8,1.6);camera.lookAt(0,0,0);
    const pixels=()=>{const p=new Uint8Array(320*180*4),gl=renderer.getContext();gl.readPixels(0,0,320,180,gl.RGBA,gl.UNSIGNED_BYTE,p);return p;};
    stage.poseAt(.5);renderer.render(stage.scene,camera);const original=pixels();
    const measured=sdk.inspectStage(stage).find((o:any)=>o.id==='a'),framed=sdk.constructionCamera(stage,320,180,'front').target.toArray();
    const expanded=sdk.applySceneEdits(spec,[{type:'makeUnique',id:'a'},{type:'makeUnique',id:'b'}]).spec;
    const plain=await sdk.buildStage(expanded);plain.poseAt(.5);renderer.render(plain.scene,camera);const comparison=pixels();
    let different=0,colored=0;for(let i=0;i<original.length;i+=4){if(Math.max(...[0,1,2].map(c=>Math.abs(original[i+c]-comparison[i+c])))>3)different++;if(original[i]>original[i+2]*1.5||original[i+1]>original[i+2]*1.5)colored++;}
    stage.poseAt(0);const invisible=sdk.inspectStage(stage).find((o:any)=>o.id==='a');
    stage.poseAt(2);stage.poseAt(.5);renderer.render(stage.scene,camera);const repeated=pixels();
    const same=original.every((v,i)=>repeated[i]===v);
    const root=stage.props.find((p:any)=>p.spec.id==='a').root,point=new T.Vector3().setFromMatrixPosition(root.matrixWorld);
    const ray=new T.Raycaster(point.clone().add(new T.Vector3(0,1,0)),new T.Vector3(0,-1,0));
    const visibleHits=ray.intersectObject(root).filter((h:any)=>sdk.objectIsVisible(h.object)).length;
    stage.poseAt(0);const hiddenHits=ray.intersectObject(root).filter((h:any)=>sdk.objectIsVisible(h.object)).length;
    const out=await sdk.exportSceneGlb(spec,{timeS:.5,objectIds:['g']});const gltf=await sdk.parseSceneModel(await out.blob.arrayBuffer());
    const bounds=new T.Box3().setFromObject(gltf.scene,true),alphas:number[]=[];gltf.scene.traverse((o:any)=>{if(o.isMesh)alphas.push(o.material.opacity);});
    let hiddenError='';try{await sdk.exportSceneGlb(spec,{timeS:0,objectIds:['a']});}catch(e){hiddenError=String(e);}
    renderer.dispose();renderer.forceContextLoss();
    // GLB cache material isolation: an animated imported copy must not fade its sibling or a future load.
    const made=await v.sceneClip({spec:{version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void'}});
    const imported=await v.sceneImportModel({assetId:made.assetId,base64:model,kind:'prop'});if(!imported.ok)throw Error(imported.message);
    const document=JSON.parse(v.doc().assets.find((a:any)=>a.id===made.assetId).spec),id=document.props[0].id;
    const edited=sdk.applySceneEdits(document,[{type:'duplicate',id,newId:'copy'},{type:'update',id,patch:{opacity:.25}}]).spec;
    const runtime=await import(sdkUrl.replace('/scene-sdk/','/runtime/')),resources=runtime.sceneResources(v.store);
    const importedStage=await sdk.buildStage(edited,undefined,resources);importedStage.poseAt(1);
    const opacity=(entry:any)=>{let alpha=0;entry.root.traverse((o:any)=>{if(o.isMesh)alpha=o.material.opacity;});return alpha;};
    const importedAlpha=importedStage.props.map(opacity),fresh=await sdk.buildStage(document,undefined,resources);fresh.poseAt(0);
    return {different,colored,same,measured,invisible,framed,visibleHits,hiddenHits,lightIntensity:stage.lights[0].light.intensity,
      exportBounds:{min:bounds.min.toArray(),max:bounds.max.toArray()},alphas,hiddenError,importedAlpha,freshAlpha:opacity(fresh.props[0])};
  },{sdkUrl,geometry:tileGeometry(),model:Buffer.from(modelFixture()).toString('base64')});
  expect(r.different).toBeLessThan(100);expect(r.colored).toBeGreaterThan(50);expect(r.same).toBe(true);
  expect(r.measured.visible).toBe(true);expect(r.measured.opacity).toBe(.25);expect(r.invisible.visible).toBe(false);
  expect(Math.abs(r.framed[0])).toBeLessThan(2);expect(r.visibleHits).toBeGreaterThan(0);expect(r.hiddenHits).toBe(0);expect(r.lightIntensity).toBe(5);
  expect(r.alphas).toEqual([.25]);expect(r.hiddenError).toMatch(/no visible mesh/);
  r.exportBounds.min.forEach((n:number,i:number)=>expect(n).toBeCloseTo(r.measured.bounds.min[i],4));
  r.exportBounds.max.forEach((n:number,i:number)=>expect(n).toBeCloseTo(r.measured.bounds.max[i],4));
  expect(r.importedAlpha).toEqual([.25,1]);expect(r.freshAlpha).toBe(1);
  await testInfo.attach('animation-rendering.json',{body:JSON.stringify(r,null,2),contentType:'application/json'});
});

test('compact Director edits shared curve keys and per-object delays without breaking references',async({page},testInfo)=>{
  await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneClip);
  const assetId=await page.evaluate(async()=>{
    const v=(window as any).velocut,r=await v.sceneClip({spec:{version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void',props:[{id:'a',model:'prop/cube'}]}});
    if(!r.ok)throw Error(r.message);await v.directorSession({assetId:r.assetId,open:true,objectId:'a',timeS:.5,view:'front',playing:false});return r.assetId;
  });
  await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByText('Animation',{exact:true}).click();
  await page.getByRole('button',{name:'Create shared curve',exact:true}).click();
  await expect(page.getByLabel('Animation curve',{exact:true}).locator('option')).toHaveCount(2);
  await page.getByLabel('Animation curve',{exact:true}).selectOption('curve_1');
  const read=()=>page.evaluate(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec),assetId);
  await expect.poll(async()=>(await read()).props[0].animation?.channels?.['scale.y']?.curveId).toBe('curve_1');
  const keys=page.getByLabel('Shared curve keys',{exact:true});await keys.fill('[{"t":0,"v":0},{"t":2,"v":1,"ease":"none"}]');await keys.press('Tab');
  await expect.poll(async()=>(await read()).curves.curve_1.keys[1].t).toBe(2);
  const delay=page.locator('.prop-row').filter({hasText:'Object delay (s)'}).locator('input');await delay.fill('0.25');await delay.press('Tab');
  await expect.poll(async()=>(await read()).props[0].animation.timeOffset).toBe(.25);
  const inspected=await page.evaluate(async assetId=>(window as any).velocut.sceneInspect({assetId,timeS:1.25}),assetId);
  expect(inspected.objects[0].scale[1]).toBeCloseTo(.5);
  await page.getByLabel('Animation channel',{exact:true}).selectOption('visible');
  const value=page.getByLabel('Channel value or binding',{exact:true});await value.fill('[{"t":0,"v":0},{"t":1,"v":1}]');await value.press('Tab');
  await expect.poll(async()=>(await read()).props[0].animation.channels.visible?.length).toBe(2);
  // A hidden selection remains editable in the outliner/properties panel.
  await page.evaluate(assetId=>(window as any).velocut.directorSession({assetId,timeS:0,objectId:'a'}),assetId);
  await expect(page.getByLabel('Channel value or binding',{exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath('compact-animation.png')});
  // Switching from a mesh's opacity to a light must not leave a hidden,
  // unsupported opacity channel selected behind a different option label.
  await page.getByLabel('Animation channel',{exact:true}).selectOption('opacity');
  await page.evaluate(async assetId=>{
    const v=(window as any).velocut,r=await v.sceneEdit({assetId,edits:[{type:'add',kind:'light',object:{id:'lamp',type:'point'}}]});
    if(!r.ok)throw Error(r.message);await v.directorSession({assetId,objectId:'lamp'});
  },assetId);
  await expect(page.getByLabel('Animation channel',{exact:true})).toHaveValue('visible');
});
