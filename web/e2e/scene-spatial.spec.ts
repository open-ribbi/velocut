import {test,expect} from './test-fixtures';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {modelFixture} from '../packages/scene-sdk/test/glb-fixture';
import {tileGeometry} from './fixtures/tiles';

test('CodeAct composes roof sampling, anchors and measured tile placement without query renderers',async({page})=>{
  const client=new Client({name:'spatial-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  const requests:string[]=[];page.on('request',r=>requests.push(r.url()));
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const created=await call('velocut_scene_create',{sessionId,spec:{version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void',
      geometries:{roof:{vertices:[[-2,0,-2],[0,0,2],[2,0,-2]],faces:[[0,1,2]],uvs:[[0,0],[.5,1],[1,0]]},tile:tileGeometry()},
      props:[{id:'roof',model:'prop/mesh',geometryId:'roof',position:{y:5},rotationX:20,scale:{x:2,y:1,z:2}},
        {id:'column',model:'prop/cube',position:{y:1.5},scale:{x:.4,y:3,z:.4},anchors:{top:{position:[0,.5,0]}}},
        {id:'beam',model:'prop/cube',position:{y:3.1},scale:{x:2.5,y:.2,z:.3},anchors:{bottom:{position:[0,-.5,0]}}}]}});
    expect(created.ok,JSON.stringify(created)).toBe(true);const assetId=created.assetId;
    const capability=await call('velocut_capabilities',{sessionId,name:'sceneSpatial'});
    expect(capability.data.category).toBe('query');expect(capability.data.inputSchema.required).toContain('queries');
    const result=await call('velocut_script',{sessionId,code:`
      const assetId=${JSON.stringify(assetId)},check=r=>{if(!r.ok)throw Error(JSON.stringify(r));return r;};
      const read=check(await velocut.sceneSpatial({assetId,timeS:1,queries:[
        {type:'distance',from:{objectId:'column',anchorId:'top'},to:{objectId:'beam',anchorId:'bottom'}},
        {type:'raycast',origin:[0,10,0],direction:[0,-1,0],objectIds:['roof']}
      ]}));
      const hit=read.results[1].hit;if(!hit?.local)throw Error('missing roof surface');
      const p=hit.position.map((v,i)=>v+hit.normal[i]*.02);
      const edited=check(await velocut.sceneEdit({assetId,expectedRevision:read.revision,includeSpec:false,edits:[
        {type:'anchor.set',id:'roof',anchorId:'seat',anchor:hit.local},
        {type:'curve.create',id:'grow',curve:{keys:[{t:0,v:0},{t:1,v:1}]}},
        {type:'add',kind:'prop',object:{id:'tile',model:'prop/instance',geometryId:'tile',position:{x:p[0],y:p[1],z:p[2]},
          rotationX:Math.atan2(hit.normal[2],hit.normal[1])*180/Math.PI,anchors:{seat:{position:[0,0,0]}},
          animation:{timeOffset:.2,channels:{'scale.y':{curveId:'grow'}}}}}
      ]}));
      const measured=check(await velocut.sceneSpatial({assetId,timeS:1.2,expectedRevision:edited.revision,queries:[
        {type:'distance',from:{objectId:'roof',anchorId:'seat'},to:{objectId:'tile',anchorId:'seat'}},
        {type:'anchors',objectId:'tile'}
      ]}));
      const stale=await velocut.sceneSpatial({assetId,expectedRevision:read.revision,queries:[{type:'anchors',objectId:'roof'}]});
      return {read,measured,stale};
    `});
    expect(result.ok,JSON.stringify(result)).toBe(true);const {read,measured,stale}=result.result;
    expect(read.results[0].distance).toBeCloseTo(0,7);expect(read.results[1].hit.position[1]).toBeCloseTo(5);
    expect(read.results[1].hit.uv).toEqual([.5,.5]);expect(read.spec).toBeUndefined();
    expect(measured.results[0].distance).toBeCloseTo(.02,6);expect(measured.results[1].items[0].normal[2]).toBeCloseTo(Math.sin(Math.PI/9));
    expect(stale.ok).toBe(false);expect(stale.message).toMatch(/revision changed/);
    const probe=await page.evaluate(async assetId=>{
      const v=(window as any).velocut,before=JSON.stringify(v.doc()),revision=v.store.getState().revision;
      let contexts=0;const original=OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext=function(...args:any[]){contexts++;return original.apply(this,args as any);} as any;
      try{
        const r=await v.sceneSpatial({assetId,timeS:1.2,queries:[{type:'anchors',objectId:'roof'},{type:'angle',a:{position:[1,0,0]},vertex:{position:[0,0,0]},b:{position:[0,1,0]}}]});
        return {r,contexts,unchanged:JSON.stringify(v.doc())===before&&v.store.getState().revision===revision};
      }finally{OffscreenCanvas.prototype.getContext=original;}
    },assetId);
    expect(probe.r.ok).toBe(true);expect(probe.contexts).toBe(0);expect(probe.unchanged).toBe(true);expect(probe.r.results[1].degrees).toBe(90);
    expect(requests.some(url=>url.includes('/packages/scene-sdk/src/'))).toBe(true);
    expect(requests.filter(url=>url.includes('/packages/scene-sdk/dist/'))).toEqual([]);
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
    const restored=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:1.2,queries:[{type:'distance',from:{objectId:'roof',anchorId:'seat'},to:{objectId:'tile',anchorId:'seat'}}]}),assetId);
    expect(restored.results[0].distance).toBeCloseTo(.02,6);
  }finally{await client.close();}
});

test('assembly resize keeps human edits and anchors through undo, UI editing and reload',async({page},testInfo)=>{
  await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const made=await page.evaluate(async()=>{
    const v=(window as any).velocut,r=await v.sceneClip({spec:{version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void'}});
    const check=(r:any)=>{if(!r.ok)throw Error(r.message);return r;};check(r);
    check(await v.sceneEdit({assetId:r.assetId,edits:[
      {type:'assembly',id:'table',recipe:{template:'table'}},
      {type:'material.create',id:'wood',material:{color:'#884422'}},
      {type:'curve.create',id:'grow',curve:{keys:[{t:0,v:0},{t:1,v:1}]}},
      {type:'update',id:'table/top',patch:{name:'Hand finish',materialId:'wood',opacity:.6,visible:true,animation:{timeOffset:.3,channels:{'scale.y':{curveId:'grow'}}}}},
      {type:'anchor.set',id:'table/top',anchorId:'joint',anchor:{position:[0,.5,0]}}
    ]}));
    const changed=check(await v.sceneEdit({assetId:r.assetId,edits:[{type:'assembly',id:'table',recipe:{template:'table',parameters:{width:3}}}]}));
    const current=()=>JSON.parse(v.doc().assets.find((a:any)=>a.id===r.assetId).spec).props.find((p:any)=>p.id==='table/top');
    const after=current();v.undo();const undo=current();v.redo();
    await v.directorSession({assetId:r.assetId,open:true,objectId:'table/top',timeS:1.5,playing:false});
    return {assetId:r.assetId,after,undo,revision:changed.revision};
  });
  expect(made.after.scale.x).toBe(3);expect(made.after.name).toBe('Hand finish');expect(made.after.materialId).toBe('wood');
  expect(made.after.opacity).toBe(.6);expect(made.after.animation.timeOffset).toBe(.3);expect(made.after.anchors.joint.position).toEqual([0,.5,0]);
  expect(made.undo.scale.x).not.toBe(3);expect(made.undo.animation).toEqual(made.after.animation);
  await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByText('Anchors',{exact:true}).click();
  await page.getByRole('button',{name:'Add anchor',exact:true}).click();
  await expect.poll(()=>page.evaluate(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec).props.find((p:any)=>p.id==='table/top').anchors.anchor_1,made.assetId)).toEqual({position:[0,0,0]});
  await page.screenshot({path:testInfo.outputPath('compact-anchors.png')});
  await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const anchors=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:1.5,queries:[{type:'anchors',objectId:'table/top'}]}),made.assetId);
  expect(anchors.ok).toBe(true);expect(anchors.results[0].items).toHaveLength(2);
});

test('imported GLB surface handles follow the sampled animation pose',async({page})=>{
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const result=await page.evaluate(async base64=>{
    const v=(window as any).velocut,check=(r:any)=>{if(!r.ok)throw Error(r.message);return r;};
    const made=check(await v.sceneClip({spec:{version:1,durationUs:2_000_000,width:320,height:180,environment:'env/void'}}));
    const imported=check(await v.sceneImportModel({assetId:made.assetId,base64,kind:'character'}));
    const read=check(await v.sceneSpatial({assetId:made.assetId,timeS:.5,queries:[{type:'raycast',origin:[1,3,0],direction:[0,-1,0],objectIds:[imported.objectId]}]}));
    const hit=read.results[0].hit;if(!hit)throw Error('missing imported surface');
    const query={type:'surface',objectId:hit.objectId,meshPath:hit.meshPath,triangleIndex:hit.triangleIndex,barycentric:hit.barycentric};
    const at0=check(await v.sceneSpatial({assetId:made.assetId,timeS:0,expectedRevision:read.revision,queries:[query]}));
    const again=check(await v.sceneSpatial({assetId:made.assetId,timeS:.5,queries:[query]}));
    return {hit,at0:at0.results[0].surface,again:again.results[0].surface};
  },Buffer.from(modelFixture()).toString('base64'));
  expect(result.hit.meshPath.length).toBeGreaterThan(0);expect(result.hit.position[0]-result.at0.position[0]).toBeCloseTo(1);
  expect(result.hit.position).toEqual(result.again.position);expect(result.hit.normal).toEqual(result.again.normal);
});
