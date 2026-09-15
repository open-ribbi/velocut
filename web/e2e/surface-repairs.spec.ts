import {test,expect} from '@playwright/test';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {tileGeometry} from './fixtures/tiles';

test('one local face edit preserves the 201-binding scene; only directly affected refs need atomic repair',async({page})=>{
  test.setTimeout(120_000);
  const client=new Client({name:'surface-repair-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const made=await call('velocut_script',{sessionId,code:`
      const ck=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;},vertices=[],faces=[],N=12;
      for(let z=0;z<=N;z++)for(let x=0;x<=N;x++){const a=-1.5+x*.25,b=-1.5+z*.25;vertices.push([a,.1*a*a+.05*b*b,b]);}
      for(let z=0;z<N;z++)for(let x=0;x<N;x++){const i=z*(N+1)+x;faces.push([i,i+N+1,i+1],[i+1,i+N+1,i+N+2]);}
      const made=ck(await velocut.sceneClip({spec:{version:1,durationUs:4_000_000,width:640,height:360,environment:'env/void',geometries:{roof:{vertices,faces},tile:${JSON.stringify(tileGeometry())}},materials:{gold:{color:'#c08b39',side:'double'}},curves:{drop:{keys:[{t:0,v:2},{t:1,v:0}]}},props:[
        {id:'roof',model:'prop/mesh',geometryId:'roof',position:{y:3}},
        {id:'column',model:'prop/cube',position:{x:-3,y:1},scale:{x:.4,y:2,z:.4},anchors:{top:{position:[0,.5,0]}}},
        {id:'beam',model:'prop/cube',anchors:{bottom:{position:[0,-.5,0]}}}
      ]}}));const assetId=made.assetId;
      const sampled=ck(await velocut.sceneSpatial({assetId,timeS:3,queries:Array.from({length:100},(_,i)=>({type:'raycast',origin:[(i%10-4.5)*.25,6,(Math.floor(i/10)-4.5)*.25],direction:[0,-1,0],objectIds:['roof']}))}));
      const edits=[{type:'binding.create',id:'beam',binding:{type:'position',source:{objectId:'column',anchorId:'top'},target:{objectId:'beam',anchorId:'bottom'}}}],indices=[];
      for(let i=0;i<100;i++){
        const hit=sampled.results[i].hit;if(!hit?.surfaceAnchor)throw Error('missing hit');indices.push(hit.triangleIndex);
        const id='tile_'+i,anchor={...hit.surfaceAnchor,name:'Seat '+i,tangent:[0,0,1]};
        // Simulate the live project's already-saved pre-upgrade references.
        delete anchor.surface.geometryKey;delete anchor.surface.vertexIndices;
        const source={objectId:'roof',anchorId:id},target={objectId:id,anchorId:'seat'};
        edits.push({type:'anchor.set',id:'roof',anchorId:id,anchor});
        edits.push({type:'add',kind:'prop',object:{id,model:'prop/instance',geometryId:'tile',materialId:'gold',color:i===0?'#0000ff':undefined,anchors:{seat:{position:[0,0,0],normal:[0,1,0],tangent:[0,0,1]}},animation:{timeOffset:.2+i*.005,channels:{'position.y':{curveId:'drop'}}}}});
        edits.push({type:'binding.create',id:id+'_pos',binding:{type:'position',source,target,offset:[0,0,.002],offsetSpace:'source',motion:{referenceTimeS:3}}});
        edits.push({type:'binding.create',id:id+'_rot',binding:{type:'orientation',source,target,twist:0}});
      }
      ck(await velocut.sceneEdit({assetId,expectedRevision:sampled.revision,edits,includeSpec:false}));
      return {assetId,indices};
    `});
    expect(made.ok,JSON.stringify(made)).toBe(true);const {assetId,indices}=made.result;
    expect(indices).not.toContain(0);
    const baseline=await page.evaluate(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec),assetId);
    const unused=await call('velocut_script',{sessionId,code:`
      const assetId=${JSON.stringify(assetId)},ck=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;};
      const read=ck(await velocut.sceneGeometry({assetId,geometryId:'roof',attribute:'faces',offset:0,limit:1})),f=read.items[0];
      ck(await velocut.sceneEdit({assetId,expectedRevision:read.revision,includeSpec:false,edits:[{type:'geometry.patch',id:'roof',attribute:'faces',updates:[{index:0,value:[f[0],f[2],f[1]]}]}]}));
      return ck(await velocut.sceneSpatial({assetId,timeS:3,queries:[{type:'bindings'},{type:'anchors',objectId:'roof',status:'invalid'}]}));
    `});
    expect(unused.ok,JSON.stringify(unused)).toBe(true);expect(unused.result.results[0].items).toHaveLength(201);
    expect(unused.result.results[0].items.every((s:any)=>s.status==='valid')).toBe(true);expect(unused.result.results[1].items).toEqual([]);
    const change=await call('velocut_script',{sessionId,code:`
      const assetId=${JSON.stringify(assetId)},index=${indices[0]},ck=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;};
      const read=ck(await velocut.sceneGeometry({assetId,geometryId:'roof',attribute:'faces',offset:index,limit:1})),f=read.items[0];
      ck(await velocut.sceneEdit({assetId,expectedRevision:read.revision,includeSpec:false,edits:[{type:'geometry.patch',id:'roof',attribute:'faces',updates:[{index,value:[f[0],f[2],f[1]]}]}]}));
      const state=ck(await velocut.sceneSpatial({assetId,timeS:3,queries:[{type:'bindings'},{type:'anchors',objectId:'roof',status:'invalid'}]}));
      const ids=state.results[1].items.map(a=>a.anchorId);
      const candidates=ck(await velocut.sceneSpatial({assetId,timeS:3,expectedRevision:state.revision,queries:ids.map(anchorId=>({type:'anchorRepair',objectId:'roof',anchorId,method:'face'}))}));
      return {state,candidates};
    `});
    expect(change.ok,JSON.stringify(change)).toBe(true);const {state,candidates}=change.result;
    const bad=state.results[1].items;
    expect(bad.length).toBeGreaterThan(0);expect(bad.length).toBeLessThan(100);
    expect(state.results[0].items.filter((s:any)=>s.status==='invalid')).toHaveLength(bad.length*2);
    expect(candidates.results.every((r:any)=>r.candidate?.windingReversed)).toBe(true);
    const edits=candidates.results.map((r:any)=>r.candidate.edit);
    const missing=await call('velocut_scene_edit',{sessionId,assetId,edits,preflight:true});expect(missing.ok).toBe(false);expect(missing.message).toMatch(/expectedRevision/);
    const beforePreview=await page.evaluate(()=>(window as any).velocut.store.getState().revision);
    const preflight=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:candidates.revision,edits,preflight:true});
    expect(preflight.ok,JSON.stringify(preflight)).toBe(true);expect(await page.evaluate(()=>(window as any).velocut.store.getState().revision)).toBe(beforePreview);
    const unrelated=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:preflight.revision,edits:[{type:'material.update',id:'gold',material:{color:'#c08b39',roughness:.45,side:'double'}}],includeSpec:false});expect(unrelated.ok).toBe(true);
    const stale=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:candidates.revision,edits,includeSpec:false});expect(stale.ok).toBe(false);expect(stale.message).toMatch(/conflict/);
    const fresh=await call('velocut_scene_spatial',{sessionId,assetId,timeS:3,queries:bad.map((a:any)=>({type:'anchorRepair',objectId:'roof',anchorId:a.anchorId,method:'face'}))});
    const commit=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:fresh.revision,edits:fresh.results.map((r:any)=>r.candidate.edit),includeSpec:false});
    expect(commit.ok,JSON.stringify(commit)).toBe(true);expect(commit.updateMode).toBe('transforms');
    const final=await page.evaluate(async assetId=>{
      const v=(window as any).velocut;return {spec:JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec),state:await v.sceneSpatial({assetId,timeS:3,queries:[{type:'bindings'}]})};
    },assetId);
    expect(final.state.results[0].items.every((s:any)=>s.status==='valid')).toBe(true);expect(final.spec.bindings).toEqual(baseline.bindings);expect(final.spec.props.slice(1)).toEqual(baseline.props.slice(1));
    const undo=await call('velocut_history',{sessionId,action:'undo',expectedRevision:commit.revision});expect(undo.ok).toBe(true);
    const undone=await call('velocut_scene_spatial',{sessionId,assetId,timeS:3,queries:[{type:'anchors',objectId:'roof',status:'invalid'}]});expect(undone.results[0].items).toHaveLength(bad.length);
    const redo=await call('velocut_history',{sessionId,action:'redo',expectedRevision:undo.revision});expect(redo.ok).toBe(true);
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
    const restored=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:3,queries:[{type:'bindings'}]}),assetId);
    expect(restored.results[0].items).toHaveLength(201);expect(restored.results[0].items.every((s:any)=>s.status==='valid')).toBe(true);
  }finally{await client.close();}
});

test('compact repair preview requires selecting a reversed-normal candidate before an undoable commit',async({page},testInfo)=>{
  await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const assetId=await page.evaluate(async()=>{
    const v=(window as any).velocut,ck=(r:any)=>{if(!r.ok)throw Error(r.message);return r;};
    const made=ck(await v.sceneClip({spec:{version:1,durationUs:2_000_000,width:320,height:180,environment:'env/void',geometries:{g:{vertices:[[-1,0,-1],[0,0,1],[1,0,-1]],faces:[[0,1,2]]}},props:[{id:'roof',model:'prop/mesh',geometryId:'g',position:{y:2}},{id:'tile',model:'prop/cube',scale:.2,anchors:{seat:{position:[0,0,0]}}}]}}));
    const assetId=made.assetId,hit=ck(await v.sceneSpatial({assetId,queries:[{type:'raycast',origin:[.2,4,0],direction:[0,-1,0],objectIds:['roof']}]})).results[0].hit;
    ck(await v.sceneEdit({assetId,edits:[{type:'anchor.set',id:'roof',anchorId:'seat',anchor:{...hit.surfaceAnchor,name:'Preserved name',tangent:[0,0,1]}},{type:'binding.create',id:'attach',binding:{type:'position',source:{objectId:'roof',anchorId:'seat'},target:{objectId:'tile',anchorId:'seat'}}},{type:'geometry.patch',id:'g',attribute:'faces',updates:[{index:0,value:[0,2,1]}]}]}));
    await v.directorSession({assetId,open:true,objectId:'roof',timeS:1,view:'front'});return assetId;
  });
  await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByText('Anchors',{exact:true}).click();
  const before=await page.evaluate(()=>(window as any).velocut.store.getState().revision);
  await page.getByRole('button',{name:'Preview face repairs',exact:true}).click();
  await expect(page.getByLabel('Use repair seat',{exact:true})).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Apply selected repairs (0)',exact:true})).toBeDisabled();
  await expect(page.locator('.director-selcard')).toContainText('face winding reversed');
  expect(await page.evaluate(()=>(window as any).velocut.store.getState().revision)).toBe(before);
  await page.getByLabel('Use repair seat',{exact:true}).check();
  await page.screenshot({path:testInfo.outputPath('repair-preview.png')});
  await page.getByRole('button',{name:'Apply selected repairs (1)',exact:true}).click();
  await expect(page.getByText(/1 invalid bindings/)).toHaveCount(0);
  const repaired=await page.evaluate(async assetId=>{
    const v=(window as any).velocut;return {state:await v.sceneSpatial({assetId,timeS:1,queries:[{type:'anchors',objectId:'roof'}]}),spec:JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec)};
  },assetId);
  expect(repaired.state.results[0].items[0].status).toBe('valid');expect(repaired.spec.props[0].anchors.seat.name).toBe('Preserved name');expect(repaired.spec.props[0].anchors.seat.tangent).toEqual([0,0,1]);
  await page.evaluate(()=>(window as any).velocut.undo());
  const old=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:1,queries:[{type:'anchors',objectId:'roof',status:'invalid'}]}),assetId);expect(old.results[0].items).toHaveLength(1);
});

test('legacy raw replacement is blocked; forged repairs fail before any batch writes',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const result=await page.evaluate(async()=>{
    const v=(window as any).velocut,ck=(r:any)=>{if(!r.ok)throw Error(r.message);return r;};
    const made=ck(await v.sceneClip({spec:{version:1,durationUs:2_000_000,width:320,height:180,geometries:{g:{vertices:[[0,0,0],[0,0,1],[1,0,0]],faces:[[0,1,2]]}},props:[{id:'mesh',model:'prop/mesh',geometryId:'g'}]}})),assetId=made.assetId;
    const hit=ck(await v.sceneSpatial({assetId,queries:[{type:'raycast',origin:[.2,3,.3],direction:[0,-1,0],objectIds:['mesh']}]})).results[0].hit;
    const legacy=structuredClone(hit.surfaceAnchor);delete legacy.surface.geometryKey;delete legacy.surface.vertexIndices;
    ck(await v.sceneEdit({assetId,edits:[{type:'anchor.set',id:'mesh',anchorId:'a',anchor:legacy}]}));
    const snapshot=v.query({kind:'snapshot'}),before=JSON.stringify(v.doc()),raw=JSON.parse(v.doc().assets.find((a:any)=>a.id===assetId).spec);
    delete raw.geometryResources;raw.geometries={g:{vertices:[[0,1,0],[0,1,1],[1,1,0]],faces:[[0,1,2]]}};
    const replaced=await v.transaction({action:'commit',runtimeId:snapshot.runtimeId,expectedRevision:snapshot.revision,requestId:'legacy-replace',operations:[{id:'replace',command:{type:'setAssetSpec',assetId,spec:JSON.stringify(raw)}}]});
    const unchanged=JSON.stringify(v.doc())===before;
    const proposed=ck(await v.sceneSpatial({assetId,queries:[{type:'anchorRepair',objectId:'mesh',anchorId:'a',method:'face'}]}));
    const edit=proposed.results[0].candidate.edit;edit.surface.geometryKey='0'.repeat(64);
    const forged=await v.sceneEdit({assetId,expectedRevision:proposed.revision,edits:[{type:'add',kind:'prop',object:{id:'should_not_exist',model:'prop/cube'}},edit]});
    return {replaced,unchanged,forged,stillUnchanged:JSON.stringify(v.doc())===before};
  });
  expect(result.replaced.ok).toBe(false);expect(JSON.stringify(result.replaced)).toMatch(/legacy surface anchor/);expect(result.unchanged).toBe(true);
  expect(result.forged.ok).toBe(false);expect(result.forged.message).toMatch(/candidate/);expect(result.stillUnchanged).toBe(true);
});
