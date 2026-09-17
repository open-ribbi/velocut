import { test, expect } from './test-fixtures';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { tileGeometry } from './fixtures/tiles';
const sdkUrl='/@fs'+resolve('packages/scene-sdk/src/index.ts');

test('geometry versions survive patch, undo and reload; moving instances keeps both renderers alive',async({page})=>{
  await page.addInitScript(()=>{
    (window as any).__glRequests=0;
    for(const proto of [HTMLCanvasElement.prototype,OffscreenCanvas.prototype]) {
      const original=proto.getContext;
      (proto as any).getContext=function(type:string,...args:any[]){
        if(type==='webgl'||type==='webgl2') (window as any).__glRequests++;
        return (original as any).call(this,type,...args);
      };
    }
  });
  const client=new Client({name:'geometry-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const tool=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try {
    await page.goto((await tool('velocut_connect')).url);
    await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await tool('velocut_sessions')).sessions[0].sessionId;
    const made=await tool('velocut_scene_create',{sessionId,spec:{version:1,durationUs:2_000_000,width:320,height:180,geometries:{tile:tileGeometry()},
      camera:{position:{x:0,y:2,z:3},lookAt:{x:0,y:0.5,z:0}},
      groups:[{id:'roof'}],props:[{id:'tile',model:'prop/instance',geometryId:'tile',parentId:'roof',color:'#ff4400'}]}});
    expect(made.ok,JSON.stringify(made)).toBe(true);const assetId=made.assetId;
    await tool('velocut_director',{sessionId,options:{assetId,open:true,objectId:'tile',view:'front'}});
    await page.waitForFunction(()=>(window as any).__glRequests>=2);
    await page.evaluate(()=>new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r()))));
    const before=await page.evaluate(()=> (window as any).__glRequests);
    const centroid=()=>page.evaluate(assetId=>{
      const source=(window as any).velocut.media.motionSources.get(assetId),frame=source.render(0);
      const canvas=new OffscreenCanvas(frame.displayWidth,frame.displayHeight),ctx=canvas.getContext('2d')!;
      ctx.drawImage(frame,0,0);frame.close();const data=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let count=0,x=0;for(let i=0;i<data.length;i+=4)if(data[i]>100&&data[i]>data[i+1]*1.5&&data[i]>data[i+2]*1.5){count++;x+=(i/4)%canvas.width;}
      return {count,x:x/Math.max(1,count)};
    },assetId);
    const originalPixels=await centroid();
    const modes=await page.evaluate(async assetId=>{
      const v=(window as any).velocut,modes=[];
      for(let i=0;i<8;i++) {
        const r=await v.sceneEdit({assetId,includeSpec:false,edits:[{type:'transform',ids:['tile'],transform:{position:{x:i*0.1}}}]});
        if(!r.ok)throw new Error(r.message);modes.push(r.updateMode);
      }
      v.undo();await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
      v.redo();await new Promise<void>(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r())));
      return modes;
    },assetId);
    expect(modes).toEqual(Array(8).fill('transforms'));
    expect(await page.evaluate(()=> (window as any).__glRequests)).toBe(before);
    const movedPixels=await centroid();
    expect(originalPixels.count).toBeGreaterThan(5);expect(movedPixels.count).toBeGreaterThan(5);
    expect(movedPixels.x-originalPixels.x).toBeGreaterThan(5);
    const read=await tool('velocut_scene_geometry',{sessionId,assetId,geometryId:'tile',attribute:'vertices',offset:4,limit:1});
    expect(read.ok,JSON.stringify(read)).toBe(true);expect(read.items[0][1]).toBeCloseTo(0.065);
    const source=read.resource.src;
    const patch=await tool('velocut_script',{sessionId,code:`return await velocut.sceneEdit({assetId:${JSON.stringify(assetId)},includeSpec:false,expectedRevision:${read.revision},edits:[{type:'geometry.patch',id:'tile',attribute:'vertices',updates:[{index:4,value:[0,0.12,-0.22]}]}]});`});
    expect(patch.result.ok,JSON.stringify(patch)).toBe(true);expect(patch.result.updateMode).toBe('rebuild');
    const patched=await tool('velocut_scene_geometry',{sessionId,assetId,geometryId:'tile',offset:4,limit:1});
    expect(patched.items[0][1]).toBe(0.12);expect(patched.resource.src).not.toBe(source);
    await tool('velocut_history',{sessionId,action:'undo',expectedRevision:patch.result.revision});
    const undone=await tool('velocut_scene_geometry',{sessionId,assetId,geometryId:'tile',offset:4,limit:1});
    expect(undone.resource.src).toBe(source);expect(undone.items[0][1]).toBeCloseTo(0.065);
    await tool('velocut_history',{sessionId,action:'redo',expectedRevision:undone.revision});
    const saved=await page.evaluate(async assetId=>{
      const v=(window as any).velocut;await v.collab.flushNow();
      return {spec:JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec),hasInlineHistory:v.store.getHistory().all().some((n:any)=>n.snapshot.assets.some((a:any)=>a.spec?.includes('"vertices"')))};
    },assetId);
    expect(saved.spec.geometries).toBeUndefined();expect(saved.hasInlineHistory).toBe(false);
    await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneGeometry);
    const restored=await page.evaluate(assetId=>(window as any).velocut.sceneGeometry({assetId,geometryId:'tile',offset:4,limit:1}),assetId);
    expect(restored.ok).toBe(true);expect(restored.items[0][1]).toBe(0.12);
  }finally{await client.close();}
});

test('large geometry bypasses manifest size via resources; incremental poses keep GPU geometry and source reads stable',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneGeometry);
  const result=await page.evaluate(async sdkUrl=>{
    const sdk=await import(sdkUrl),runtime=await import(sdkUrl.replace('/scene-sdk/','/runtime/')),v=(window as any).velocut;
    const g={vertices:Array.from({length:4096},(_,i)=>[Math.sin(i)*0.123456789012345,i*0.0123456789012345,Math.cos(i)*0.987654321098765]),faces:Array.from({length:4094},(_,i)=>[i,i+1,i+2])};
    const spec:any={version:1,durationUs:2_000_000,width:320,height:180,geometries:{a:g,b:g},groups:[{id:'g',rotationY:25}],props:[{id:'a',model:'prop/instance',geometryId:'a',parentId:'g'}]};
    const rawBytes=new TextEncoder().encode(JSON.stringify(spec)).length;
    const made=await v.sceneClip({spec});if(!made.ok)throw new Error(made.message);
    const saved=JSON.parse(v.doc().assets.find((a:any)=>a.id===made.assetId).spec),base=runtime.sceneResources(v.store);let reads=0;
    const stage=await sdk.buildStage(saved,undefined,{...base,geometryBytes:async(src:string)=>{reads++;return base.geometryBytes(src)}});
    stage.poseAt(0);const geometry=stage.props[0].root.geometry,mesh=stage.instanceBatches[0].mesh,initialReads=reads;
    const moved=sdk.applySceneEdits(saved,[{type:'transform',ids:['g'],transform:{rotation:{y:90}}},{type:'transform',ids:['a'],transform:{position:{x:2,y:0}}}]).spec;
    const updated=stage.updateTransforms(moved);stage.poseAt(0);
    const position=stage.props[0].root.getWorldPosition(new stage.three.Vector3()).toArray();
    const materialChange=sdk.applySceneEdits(moved,[{type:'update',id:'a',patch:{material:{roughness:0.1}}}]).spec;
    const rebuild=!stage.canUpdateTransforms(materialChange);
    const afterReads=reads;
    // Legacy inline specs still load, then move to file references on editing.
    const legacy={version:1,durationUs:2_000_000,width:320,height:180,geometries:{tile:{vertices:[[0,0,0],[1,0,0],[0,1,0]],faces:[[0,1,2]]}},props:[{id:'t',model:'prop/instance',geometryId:'tile'}]};
    const raw=await v.apply({type:'setAssetSpec',assetId:made.assetId,spec:JSON.stringify(legacy)});if(!raw.ok)throw new Error(JSON.stringify(raw));
    const upgraded=await v.sceneEdit({assetId:made.assetId,edits:[{type:'transform',ids:['t'],transform:{position:{x:1}}}]});
    if(!upgraded.ok)throw new Error(upgraded.message);
    return {rawBytes,manifestBytes:JSON.stringify(saved).length,sameFile:saved.geometryResources.a.src===saved.geometryResources.b.src,
      updated,position,sameGeometry:geometry===stage.props[0].root.geometry,sameBatch:mesh===stage.instanceBatches[0].mesh,initialReads,afterReads,rebuild,upgraded:upgraded.spec};
  },sdkUrl);
  expect(result.rawBytes).toBeGreaterThan(262144);expect(result.manifestBytes).toBeLessThan(1500);expect(result.sameFile).toBe(true);
  expect(result.updated).toBe(true);expect(result.sameGeometry).toBe(true);expect(result.sameBatch).toBe(true);expect(result.afterReads).toBe(result.initialReads);
  expect(result.position[0]).toBeCloseTo(0);expect(result.position[2]).toBeCloseTo(-2);expect(result.rebuild).toBe(true);
  expect(result.upgraded.geometryResources.tile.src).toMatch(/\.vmesh$/);expect(result.upgraded.geometries).toBeUndefined();
});
