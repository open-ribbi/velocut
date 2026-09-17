import {test,expect} from './test-fixtures';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {tileGeometry} from './fixtures/tiles';
import {modelFixture} from '../packages/scene-sdk/test/glb-fixture';
const sdkUrl='/@fs'+resolve('packages/scene-sdk/src/index.ts');

test('CodeAct binds a column joint and 100 tiles; source edits update every placement while retaining animation and overrides',async({page},testInfo)=>{
  test.setTimeout(120_000);
  const client=new Client({name:'binding-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const created=await call('velocut_script',{sessionId,code:`
      const check=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;};
      const vertices=[],faces=[];for(let z=0;z<9;z++)for(let x=0;x<9;x++){const a=(x-4)*.4,b=(z-4)*.4;vertices.push([a,.05*(a*a+b*b),b]);}
      for(let z=0;z<8;z++)for(let x=0;x<8;x++){const i=z*9+x;faces.push([i,i+9,i+1],[i+1,i+9,i+10]);}
      const made=check(await velocut.sceneClip({spec:{version:1,durationUs:6_000_000,width:640,height:360,environment:'env/void',geometries:{roof:{vertices,faces},tile:${JSON.stringify(tileGeometry())}},
        materials:{gold:{color:'#c08b39',side:'double'}},curves:{drop:{keys:[{t:0,v:2},{t:1,v:0,ease:'none'}]},grow:{keys:[{t:0,v:0},{t:1,v:1,ease:'none'}]}},props:[
          {id:'roof',model:'prop/mesh',geometryId:'roof',position:{y:4}},
          {id:'column',model:'prop/cube',position:{x:-3,y:1},scale:{x:.4,y:2,z:.4},anchors:{joint:{position:[0,.5,0]}}},
          {id:'beam',model:'prop/cube',position:{x:-3,y:2.1},scale:{x:1.5,y:.2,z:.3},anchors:{joint:{position:[0,-.5,0]}}}
        ]}}));
      const assetId=made.assetId,rays=Array.from({length:100},(_,i)=>({type:'raycast',origin:[(i%10-4.5)*.25,8,(Math.floor(i/10)-4.5)*.25],direction:[0,-1,0],objectIds:['roof']}));
      const sampled=check(await velocut.sceneSpatial({assetId,timeS:3,queries:rays})),edits=[{type:'binding.create',id:'beam_seat',binding:{type:'position',source:{objectId:'column',anchorId:'joint'},target:{objectId:'beam',anchorId:'joint'}}}];
      for(let i=0;i<100;i++){
        const hit=sampled.results[i].hit;if(!hit?.surfaceAnchor)throw Error('missing live surface anchor');
        const id='tile_'+i,source={objectId:'roof',anchorId:id},target={objectId:id,anchorId:'seat'};
        edits.push({type:'anchor.set',id:'roof',anchorId:id,anchor:{...hit.surfaceAnchor,tangent:[0,0,1]}});
        edits.push({type:'add',kind:'prop',object:{id,model:'prop/instance',geometryId:'tile',materialId:'gold',...(i===0?{color:'#0000ff'}:{}),
          position:{x:hit.position[0],y:hit.position[1],z:hit.position[2]},anchors:{seat:{position:[0,0,0],normal:[0,1,0],tangent:[0,0,1]}},
          animation:{timeOffset:.4+i*.005,channels:{'position.y':{curveId:'drop',valueOffset:hit.position[1]},'scale.x':{curveId:'grow'},'scale.y':{curveId:'grow'},'scale.z':{curveId:'grow'}}}}});
        edits.push({type:'binding.create',id:id+'_seat',binding:{type:'position',source,target,offset:[0,0,.002],offsetSpace:'source',motion:{referenceTimeS:3}}});
        edits.push({type:'binding.create',id:id+'_turn',binding:{type:'orientation',source,target}});
      }
      const edited=check(await velocut.sceneEdit({assetId,expectedRevision:sampled.revision,includeSpec:false,edits}));
      return {assetId,revision:edited.revision};
    `});
    expect(created.ok,JSON.stringify(created)).toBe(true);const assetId=created.result.assetId;
    const before=await page.evaluate(async assetId=>{
      const v=(window as any).velocut,r=await v.sceneSpatial({assetId,timeS:1,queries:[{type:'anchors',objectId:'roof',anchorIds:['tile_0']},{type:'anchors',objectId:'tile_0'}]});
      if(!r.ok)throw Error(r.message);const [roof,tile]=r.results.map((x:any)=>x.items[0]);
      return {motion:tile.position[1]-roof.position[1]-.002*roof.normal[1],tile:JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec).props.find((p:any)=>p.id==='tile_0')};
    },assetId);
    const updated=await call('velocut_script',{sessionId,code:`
      const assetId=${JSON.stringify(assetId)},check=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;};
      const geometry=check(await velocut.sceneGeometry({assetId,geometryId:'roof',attribute:'vertices'}));
      const edits=[{type:'update',id:'column',patch:{scale:{x:.4,y:2.4,z:.4}}},{type:'geometry.patch',id:'roof',attribute:'vertices',updates:geometry.items.map((p,index)=>({index,value:[p[0],p[1]+.12*p[0]*p[0]+.03*p[2]*p[2],p[2]]}))}];
      const changed=check(await velocut.sceneEdit({assetId,expectedRevision:geometry.revision,edits,includeSpec:false}));
      const queries=[{type:'bindings'},{type:'distance',from:{objectId:'column',anchorId:'joint'},to:{objectId:'beam',anchorId:'joint'}},
        ...Array.from({length:100},(_,i)=>({type:'distance',from:{objectId:'roof',anchorId:'tile_'+i},to:{objectId:'tile_'+i,anchorId:'seat'}}))];
      const sampled=check(await velocut.sceneSpatial({assetId,timeS:3,queries}));
      return {revision:changed.revision,affected:changed.changedIds,states:sampled.results[0].items,beamGap:sampled.results[1].distance,maxGapError:Math.max(...sampled.results.slice(2).map(r=>Math.abs(r.distance-.002)))};
    `});
    expect(updated.ok,JSON.stringify(updated)).toBe(true);expect(updated.result.states).toHaveLength(201);
    expect(updated.result.states.every((s:any)=>s.status==='valid')).toBe(true);expect(updated.result.beamGap).toBeLessThan(1e-6);expect(updated.result.maxGapError).toBeLessThan(1e-6);
    expect(updated.result.affected).toContain('beam');expect(updated.result.affected).toContain('tile_99');
    const after=await page.evaluate(async assetId=>{
      const v=(window as any).velocut,r=await v.sceneSpatial({assetId,timeS:1,queries:[{type:'anchors',objectId:'roof',anchorIds:['tile_0']},{type:'anchors',objectId:'tile_0'}]});
      const [roof,tile]=r.results.map((x:any)=>x.items[0]);
      return {motion:tile.position[1]-roof.position[1]-.002*roof.normal[1],tile:JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec).props.find((p:any)=>p.id==='tile_0')};
    },assetId);
    expect(after.tile).toEqual(before.tile);expect(after.motion).toBeCloseTo(before.motion,6);
    const undo=await call('velocut_history',{sessionId,action:'undo',expectedRevision:updated.result.revision});expect(undo.ok).toBe(true);
    const redo=await call('velocut_history',{sessionId,action:'redo',expectedRevision:undo.revision});expect(redo.ok).toBe(true);
    const summary=await call('velocut_query',{sessionId,kind:'sceneBindings',assetId,limit:100});
    expect(summary.ok,JSON.stringify(summary)).toBe(true);expect(summary.data.total).toBe(201);expect(summary.data.items[0].binding).toBeUndefined();
    const picture=await client.callTool({name:'velocut_observe',arguments:{sessionId,mode:'scene',source:{assetId},at:3_000_000,view:'perspective'}}) as any;
    expect(picture.isError,JSON.stringify(picture.structuredContent)).toBe(false);
    const image=picture.content.find((c:any)=>c.type==='image');expect(image).toBeTruthy();
    const picturePath=testInfo.outputPath('bound-roof.png');await writeFile(picturePath,Buffer.from(image.data,'base64'));
    await testInfo.attach('bound-roof.png',{path:picturePath,contentType:'image/png'});
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
    const restored=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:3,queries:[{type:'bindings'},{type:'distance',from:{objectId:'column',anchorId:'joint'},to:{objectId:'beam',anchorId:'joint'}}]}),assetId);
    expect(restored.results[0].items.every((s:any)=>s.status==='valid')).toBe(true);expect(restored.results[1].distance).toBeLessThan(1e-6);
  }finally{await client.close();}
});

test('topology invalidation is visible, rejects false measurements/exports, and repairs through the anchor editor',async({page},testInfo)=>{
  await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const result=await page.evaluate(async sdkUrl=>{
    const v=(window as any).velocut,check=(r:any)=>{if(!r.ok)throw Error(r.message);return r;};
    const made=check(await v.sceneClip({spec:{version:1,durationUs:2_000_000,width:320,height:180,environment:'env/void',geometries:{roof:{vertices:[[-1,0,-1],[0,0,1],[1,0,-1]],faces:[[0,1,2]]}},props:[
      {id:'roof',model:'prop/mesh',geometryId:'roof',position:{y:2}},{id:'tile',model:'prop/cube',scale:.2,anchors:{seat:{position:[0,-.5,0]}}}
    ]}}));const assetId=made.assetId;
    const hit=check(await v.sceneSpatial({assetId,queries:[{type:'raycast',origin:[0,4,0],direction:[0,-1,0],objectIds:['roof']}]})).results[0].hit;
    const source={objectId:'roof',anchorId:'seat'},target={objectId:'tile',anchorId:'seat'};
    check(await v.sceneEdit({assetId,edits:[{type:'anchor.set',id:'roof',anchorId:'seat',anchor:hit.surfaceAnchor},{type:'binding.create',id:'seat',binding:{type:'position',source,target}},{type:'binding.create',id:'turn',binding:{type:'orientation',source,target}}]}));
    check(await v.sceneEdit({assetId,edits:[{type:'geometry.patch',id:'roof',attribute:'faces',updates:[{index:0,value:[0,2,1]}]}]}));
    const measured=await v.sceneSpatial({assetId,queries:[{type:'distance',from:source,to:target}]});
    const states=check(await v.sceneSpatial({assetId,queries:[{type:'anchors',objectId:'roof'},{type:'bindings'}]}));
    const sdk=await import(sdkUrl),runtime=await import(sdkUrl.replace('/scene-sdk/','/runtime/')),spec=JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec),resources=runtime.sceneResources(v.store);
    let exportError='';try{await sdk.exportSceneGlb(spec,{objectIds:['tile'],resources});}catch(e){exportError=String(e);}
    const independent=await sdk.exportSceneGlb(spec,{objectIds:['roof'],resources});
    const fresh=check(await v.sceneSpatial({assetId,queries:[{type:'raycast',origin:[0,4,0],direction:[0,-1,0],objectIds:['roof']}]})).results[0].hit.surfaceAnchor;
    await v.directorSession({assetId,open:true,objectId:'roof',timeS:1,view:'front'});
    return {assetId,measured,states,exportError,independent:independent.blob.size,fresh};
  },sdkUrl);
  expect(result.measured.ok).toBe(false);expect(result.measured.message).toMatch(/invalid anchor/);
  expect(result.states.results[0].items[0].position).toBeNull();expect(result.exportError).toMatch(/binding.*invalid/);expect(result.independent).toBeGreaterThan(100);
  await expect(page.getByText(/2 invalid bindings/)).toBeVisible();
  await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByText('Anchors',{exact:true}).click();
  await expect(page.locator('.director-selcard')).toContainText('surface · invalid');
  const picturePath=testInfo.outputPath('invalid-bindings.png');await page.screenshot({path:picturePath});
  await testInfo.attach('invalid-bindings.png',{path:picturePath,contentType:'image/png'});
  const input=page.getByLabel('Object-local anchors',{exact:true});await input.fill(JSON.stringify({seat:result.fresh}));await input.press('Tab');
  await expect(page.getByText(/2 invalid bindings/)).toHaveCount(0);
  const fixed=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:1,queries:[{type:'bindings'},{type:'distance',from:{objectId:'roof',anchorId:'seat'},to:{objectId:'tile',anchorId:'seat'}}]}),result.assetId);
  expect(fixed.ok).toBe(true);expect(fixed.results[0].items.every((s:any)=>s.status==='valid')).toBe(true);expect(fixed.results[1].distance).toBeLessThan(1e-6);
});

test('a live surface attachment follows imported animation and invalidates a replaced model source',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const result=await page.evaluate(async({first,second})=>{
    const v=(window as any).velocut,check=(r:any)=>{if(!r.ok)throw Error(r.message);return r;};
    const made=check(await v.sceneClip({spec:{version:1,durationUs:2_000_000,width:320,height:180,environment:'env/void'}})),assetId=made.assetId;
    const model=check(await v.sceneImportModel({assetId,base64:first,kind:'character'}));
    const hit=check(await v.sceneSpatial({assetId,timeS:.5,queries:[{type:'raycast',origin:[1,3,0],direction:[0,-1,0],objectIds:[model.objectId]}]})).results[0].hit;
    const source={objectId:model.objectId,anchorId:'surface'},target={objectId:'cap',anchorId:'seat'};
    check(await v.sceneEdit({assetId,edits:[{type:'anchor.set',id:model.objectId,anchorId:'surface',anchor:hit.surfaceAnchor},{type:'add',kind:'prop',object:{id:'cap',model:'prop/cube',scale:.1,anchors:{seat:{position:[0,-.5,0]}}}},{type:'binding.create',id:'follow',binding:{type:'position',source,target}}]}));
    const samples=[];for(const timeS of [0,.5,0]){const r=check(await v.sceneSpatial({assetId,timeS,queries:[{type:'anchors',objectId:'cap'},{type:'distance',from:source,to:target}]}));samples.push({position:r.results[0].items[0].position,distance:r.results[1].distance});}
    const replacement=check(await v.sceneImportModel({assetId,base64:second,kind:'character'}));
    check(await v.sceneEdit({assetId,edits:[{type:'update',id:model.objectId,patch:{model:replacement.modelId}}]}));
    const invalid=check(await v.sceneSpatial({assetId,timeS:.5,queries:[{type:'anchors',objectId:model.objectId},{type:'bindings'}]}));
    return {samples,invalid};
  },{first:Buffer.from(modelFixture()).toString('base64'),second:Buffer.from(modelFixture(j=>{j.materials[0].pbrMetallicRoughness.baseColorFactor=[0,1,0,1];})).toString('base64')});
  expect(result.samples.every((s:any)=>s.distance<1e-6)).toBe(true);expect(result.samples[1].position[0]-result.samples[0].position[0]).toBeCloseTo(1);expect(result.samples[2]).toEqual(result.samples[0]);
  expect(result.invalid.results[0].items[0].status).toBe('invalid');expect(result.invalid.results[0].items[0].message).toMatch(/source was replaced/);expect(result.invalid.results[1].items[0].status).toBe('invalid');
});
