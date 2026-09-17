import {test,expect} from './test-fixtures';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {detailedTileGeometry,tileGeometry} from './fixtures/tiles';
const sdkUrl='/@fs'+resolve('packages/scene-sdk/src/index.ts');

test('compact Director can share an existing appearance and edit its material definition',async({page})=>{
  await page.setViewportSize({width:640,height:760});
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneClip);
  const assetId=await page.evaluate(async()=>{
    const v=(window as any).velocut,r=await v.sceneClip({spec:{version:1,durationUs:1_000_000,width:320,height:180,props:[{id:'a',model:'prop/cube',color:'#ff0000',material:{roughness:.38}}]}});
    if(!r.ok)throw Error(r.message);await v.directorSession({assetId:r.assetId,open:true,objectId:'a',view:'front'});return r.assetId;
  });
  await page.getByRole('button',{name:'Properties',exact:true}).click();
  await page.getByRole('button',{name:'Share this material',exact:true}).click();
  const read=()=>page.evaluate(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec),assetId);
  await expect.poll(async()=>(await read()).props[0].materialId).toBe('material_1');
  expect((await read()).materials.material_1).toMatchObject({color:'#ff0000',roughness:.38});
  expect((await read()).props[0].color).toBeUndefined();
  await page.getByText('Edit shared material',{exact:true}).click();
  await page.getByLabel('Shared material faces',{exact:true}).selectOption('double');
  await expect.poll(async()=>(await read()).materials.material_1.side).toBe('double');
  const roughness=page.locator('.prop-row').filter({hasText:'Shared roughness'}).locator('input');
  await roughness.fill('0.8');await roughness.press('Tab');
  await expect.poll(async()=>(await read()).materials.material_1.roughness).toBe(.8);
});

test('1000 animated detailed tiles keep original material; independent geometry stays a compact resource',async({page})=>{
  test.setTimeout(120_000);
  const client=new Client({name:'material-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const made=await page.evaluate(async({sdkUrl,geometry})=>{
      const sdk=await import(sdkUrl),v=(window as any).velocut,R=(x:number)=>Math.round(x*10000)/10000;
      const props=[];
      for(let side=0;side<2;side++)for(let row=0;row<25;row++)for(let col=0;col<20;col++){
        const z=(side===0?1:-1)*(.22+row*.31),a=Math.abs(z),y=4.9-.54*a+.023*a*a,t=R(side*5.3+row*.17+col*.012);
        props.push({id:`tile_${side}_${String(row).padStart(2,'0')}_${String(col).padStart(2,'0')}`,model:'prop/instance',geometryId:'tile',materialId:'tile',position:{x:R((col-9.5)*.342),y:[{t,v:R(y+7)},{t:R(t+.65),v:R(y),ease:'power2.out'}],z:R(z)},rotationX:R((side===0?1:-1)*Math.atan(.54-.046*a)*180/Math.PI)});
      }
      const material={color:'#c08b39',roughness:.38,metalness:.12,side:'double'},spec={version:1,durationUs:16_000_000,width:1280,height:720,geometries:{tile:geometry},materials:{tile:material},props};
      const inline={...spec,materials:undefined,props:props.map(({materialId,...p})=>({...p,color:material.color,material:{roughness:.38,metalness:.12,side:'double'}}))};
      const sharedBudget=sdk.sceneBudget(spec),inlineBudget=sdk.sceneBudget(inline);
      const r=await v.sceneClip({spec});if(!r.ok)throw Error(r.message);
      return {assetId:r.assetId,inline,sharedBudget,inlineBudget};
    },{sdkUrl,geometry:detailedTileGeometry()});
    expect(made.sharedBudget.used.specBytes).toBeLessThan(262144);expect(made.inlineBudget.used.specBytes).toBeGreaterThan(262144);
    expect(made.inlineBudget.limits.specBytes).toBeNull();expect(made.inlineBudget.withinLimits).toBe(true);
    const createdLarge=await call('velocut_scene_create',{sessionId,name:'Large inline-material scene',spec:made.inline,atUs:16_000_000});
    expect(createdLarge.ok,JSON.stringify(createdLarge)).toBe(true);
    const largeId=createdLarge.assetId;
    const large=await call('velocut_query',{sessionId,kind:'assets',ids:[largeId],fields:['spec']});
    expect(large.ok,JSON.stringify(large.error)).toBe(true);
    const largeSpec=JSON.parse(large.data.items[0].spec);expect(large.data.items[0].spec.length).toBeGreaterThan(262144);
    largeSpec.props[0].name='Edited large scene';
    const editedLarge=await call('velocut_transaction',{sessionId,action:'commit',runtimeId:large.runtimeId,expectedRevision:large.revision,requestId:'large-scene-edit',operations:[
      {id:'edit',command:{type:'setAssetSpec',assetId:largeId,spec:JSON.stringify(largeSpec)}}
    ]});
    expect(editedLarge.ok,JSON.stringify(editedLarge.error)).toBe(true);
    const assetId=made.assetId,before=await call('velocut_query',{sessionId,kind:'sceneBudget',assetId});
    const materials=await call('velocut_query',{sessionId,kind:'sceneMaterials',assetId,fields:['id','objectCount','material']});
    expect(materials.data.items[0].objectCount).toBe(1000);expect(materials.data.items[0].material.side).toBe('double');
    const original=await call('velocut_query',{sessionId,kind:'sceneGeometries',assetId,fields:['id','resource']});const source=original.data.items[0].resource.src;
    const isolated=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:before.revision,includeSpec:false,edits:[
      {type:'makeUnique',id:'tile_0_00_00',geometryId:'private'},
      {type:'update',id:'tile_0_00_00',patch:{color:'#0000ff'}},
    ]});
    expect(isolated.ok,JSON.stringify(isolated)).toBe(true);
    expect(isolated.budget.used.specBytes-before.data.used.specBytes).toBeLessThan(1000);
    const clone=await call('velocut_query',{sessionId,kind:'sceneGeometries',assetId,ids:['private'],fields:['resource','instanceCount','objectCount']});
    expect(clone.data.items[0]).toMatchObject({resource:{src:source},instanceCount:0,objectCount:1});
    const modified=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:isolated.revision,includeSpec:false,edits:[
      {type:'geometry.patch',id:'private',attribute:'vertices',updates:[{index:16,value:[0,.19,-.27]}]},
      {type:'material.update',id:'tile',material:{color:'#00ff00',roughness:.38,metalness:.12,side:'double'}},
    ]});
    expect(modified.ok,JSON.stringify(modified)).toBe(true);
    const vertex=await call('velocut_scene_geometry',{sessionId,assetId,geometryId:'private',offset:16,limit:1});
    expect(vertex.items[0][1]).toBe(.19);expect(vertex.resource.src).not.toBe(source);
    const unchanged=await call('velocut_scene_geometry',{sessionId,assetId,geometryId:'tile',offset:16,limit:1});expect(unchanged.resource.src).toBe(source);expect(unchanged.items[0][1]).toBe(.175);
    await call('velocut_history',{sessionId,action:'undo',expectedRevision:modified.revision});
    const undo=await call('velocut_scene_geometry',{sessionId,assetId,geometryId:'private',offset:16,limit:1});expect(undo.resource.src).toBe(source);
    await call('velocut_history',{sessionId,action:'redo',expectedRevision:undo.revision});
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.query);
    const restored=await page.evaluate(({assetId,sdkUrl})=>import(sdkUrl).then(sdk=>{const v=(window as any).velocut,s=JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec);return {private:sdk.resolvePropAppearance(s,s.props[0]),other:sdk.resolvePropAppearance(s,s.props[1]),spec:s};}),{assetId,sdkUrl});
    expect(restored.private.color).toBe('#0000ff');expect(restored.other.color).toBe('#00ff00');expect(restored.spec.props[0].vertices).toBeUndefined();
    expect(restored.spec.geometryResources.private.src).not.toBe(restored.spec.geometryResources.tile.src);
    const restoredLarge=await page.evaluate(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec),largeId);
    expect(restoredLarge.props[0].name).toBe('Edited large scene');expect(restoredLarge.props[0].material).toEqual({roughness:.38,metalness:.12,side:'double'});
  }finally{await client.close();}
});

test('shared material pixels and GLB match inline materials; compact history restores all nodes',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneEdit);
  const r=await page.evaluate(async({sdkUrl,geometry})=>{
    const sdk=await import(sdkUrl),v=(window as any).velocut;
    const material={color:'#ff3300',roughness:.38,metalness:.12,side:'double'};
    const spec:any={version:1,durationUs:1_000_000,width:320,height:180,environment:'env/void',geometries:{tile:geometry},materials:{tile:material},props:[{id:'a',model:'prop/instance',geometryId:'tile',materialId:'tile'}],camera:{position:{x:0,y:1.4,z:2},lookAt:{x:0,y:.5,z:0}}};
    const inline={...spec,materials:undefined,props:[{id:'a',model:'prop/instance',geometryId:'tile',color:material.color,material:{roughness:.38,metalness:.12,side:'double'}}]};
    const frames=[];for(const s of [spec,inline]){const c=sdk.compileSceneSpec(s,{width:320,height:180,fps:30});await c.load();const f=c.render(0),canvas=new OffscreenCanvas(320,180),ctx=canvas.getContext('2d')!;ctx.drawImage(f,0,0);frames.push(ctx.getImageData(0,0,320,180).data);f.close();c.dispose();}
    let maxDifference=0;for(let i=0;i<frames[0].length;i++)maxDifference=Math.max(maxDifference,Math.abs(frames[0][i]-frames[1][i]));
    const glb=await sdk.exportSceneGlb(spec,{objectIds:['a']}),model=await sdk.parseSceneModel(await glb.blob.arrayBuffer());let exported:any;
    model.scene.traverse((o:any)=>{if(o.isMesh)exported={color:o.material.color.getHexString(),roughness:o.material.roughness,metalness:o.material.metalness,side:o.material.side};});
    const made=await v.sceneClip({spec});if(!made.ok)throw Error(made.message);
    for(let i=0;i<8;i++){const result=await v.sceneEdit({assetId:made.assetId,edits:[{type:'transform',ids:['a'],transform:{position:{x:i*.01}}}]});if(!result.ok)throw Error(result.message);}
    await v.collab.flushNow();return {assetId:made.assetId,maxDifference,exported,nodes:v.store.getHistory().all().length};
  },{sdkUrl,geometry:tileGeometry()});
  expect(r.maxDifference).toBeLessThanOrEqual(2);expect(r.exported).toMatchObject({color:'ff3300',roughness:.38,metalness:.12,side:2});
  // Observe durable history completion; a fixed delay can race a busy browser.
  let packed:any;
  await expect.poll(async()=>{packed=await page.evaluate(async()=>{const db=await new Promise<IDBDatabase>(resolve=>{const r=indexedDB.open('velocut');r.onsuccess=()=>resolve(r.result)});const key=(localStorage.getItem('velocut.project')==='default'?'history':'history:'+localStorage.getItem('velocut.project'))+':compact-v1';const bytes=await new Promise<Uint8Array>(resolve=>{const r=db.transaction('kv').objectStore('kv').get(key);r.onsuccess=()=>resolve(r.result)});db.close();if(!bytes)return null;const h=JSON.parse(new TextDecoder().decode(bytes));return {encoding:h.historyEncoding,nodes:h.nodes.length,specs:h.specs.length};});return packed?.nodes;}).toBe(r.nodes);
  expect(packed.encoding).toBe('spec-table-v1');expect(packed.nodes).toBe(r.nodes);
  await page.reload();await page.waitForFunction(()=>(window as any).velocut?.doc().assets.length>0);
  expect(await page.evaluate(()=>(window as any).velocut.store.getHistory().all().length)).toBe(r.nodes);
});
