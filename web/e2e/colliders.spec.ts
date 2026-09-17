import {test,expect} from './test-fixtures';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

const fixture={version:1,durationUs:3_000_000,width:320,height:180,environment:'env/grid',props:[
  {id:'platform',model:'prop/extrude',points:[[-1,-1],[1,-1],[1,1],[-1,1]],holes:[[[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]],depth:.2,rotationX:-90,position:{y:1.2},physics:'fixed'},
  {id:'ball',model:'prop/sphere',scale:.2,position:{y:2.8},physics:{type:'dynamic',mass:.1,restitution:0},anchors:{center:{position:[0,0,0]}}},
]};

test('MCP collider edits fix a real hole, reject invalid compound edits atomically, and survive undo/reload',async({page})=>{
  const client=new Client({name:'colliders-test',version:'1'});
  await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const created=await call('velocut_scene_create',{sessionId,spec:fixture});expect(created.ok,JSON.stringify(created)).toBe(true);const assetId=created.assetId;
    const sample=()=>call('velocut_scene_spatial',{sessionId,assetId,timeS:2,queries:[{type:'colliders',objectIds:['platform']},{type:'anchors',objectId:'ball'},{type:'colliderGeometry',objectId:'platform',colliderId:'default',limit:3}]});
    const initial=await sample();expect(initial.results[0].items[0].effectiveShape).toBe('mesh');expect(initial.results[1].items[0].position[1]).toBeCloseTo(.1,2);expect(initial.results[2].items).toHaveLength(3);expect(initial.results[2].nextOffset).toBe(3);
    const hull=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:initial.revision,edits:[{type:'collider.update',id:'platform',colliderId:'default',collider:{shape:'convexHull'}}]});expect(hull.ok).toBe(true);
    const blocked=await sample();expect(blocked.results[1].items[0].position[1]).toBeCloseTo(1.4,2);
    const snapshot=await page.evaluate(() => JSON.stringify((window as any).velocut.doc()));
    const invalid=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:blocked.revision,edits:[{type:'add',kind:'prop',object:{id:'must_not_exist',model:'prop/cube'}},{type:'collider.update',id:'ball',colliderId:'default',collider:{shape:'mesh'}}]});expect(invalid.ok).toBe(false);expect(invalid.message).toMatch(/dynamic/);expect(await page.evaluate(()=>JSON.stringify((window as any).velocut.doc()))).toBe(snapshot);
    const repair=await call('velocut_script',{sessionId,code:`return await velocut.sceneEdit({assetId:${JSON.stringify(assetId)},expectedRevision:${blocked.revision},edits:[{type:'collider.reset',id:'platform'}],includeSpec:false});`});expect(repair.result.ok).toBe(true);expect((await sample()).results[1].items[0].position[1]).toBeCloseTo(.1,2);
    const undo=await call('velocut_history',{sessionId,action:'undo',expectedRevision:repair.result.revision});expect(undo.ok).toBe(true);expect((await sample()).results[1].items[0].position[1]).toBeCloseTo(1.4,2);
    const redo=await call('velocut_history',{sessionId,action:'redo',expectedRevision:undo.revision});expect(redo.ok).toBe(true);
    const beforeView=await page.evaluate(()=>JSON.stringify((window as any).velocut.doc()));
    const view=await call('velocut_director',{sessionId,options:{assetId,objectId:'platform',timeS:2,view:'front',colliderView:'selected'}});expect(view.ok).toBe(true);expect(view.state.colliderView).toBe('selected');
    expect(await page.evaluate(()=>JSON.stringify((window as any).velocut.doc()))).toBe(beforeView);
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
    const restored=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:2,queries:[{type:'colliders'},{type:'anchors',objectId:'ball'}]}),assetId);
    expect(restored.results[0].items.find((c:any)=>c.objectId==='platform').effectiveShape).toBe('mesh');expect(restored.results[1].items[0].position[1]).toBeCloseTo(.1,2);
  }finally{await client.close();}
});

test('compact collider controls edit individual parts and wireframes stay outside shot views and undo history',async({page},testInfo)=>{
  await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const assetId=await page.evaluate(async spec=>{const v=(window as any).velocut,r=await v.sceneClip({spec});if(!r.ok)throw Error(r.message);await v.directorSession({assetId:r.assetId,objectId:'platform',view:'perspective',timeS:2});return r.assetId;},fixture);
  await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByText('Physics & colliders',{exact:true}).click();
  await expect(page.getByLabel('Collider shape')).toHaveValue('auto');await page.getByLabel('Collider shape').selectOption('convexHull');
  await expect.poll(()=>page.evaluate(assetId=>{const p=JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec).props[0];return p.physics.colliders?.default?.shape;},assetId)).toBe('convexHull');
  await page.getByRole('button',{name:'Inspect colliders',exact:true}).click();await expect(page.locator('.director-selcard')).toContainText('Convex hull fills holes');
  const revision=await page.evaluate(()=>(window as any).velocut.store.getState().revision);
  await page.getByLabel('Collider wireframe').selectOption('selected');
  const teal=()=>page.evaluate(async()=>{
    const canvas=document.querySelector('.director-canvas') as HTMLCanvasElement;
    // Read in the render frame, before WebGL's non-preserved drawing buffer
    // is cleared by presentation. Do not force persistent GPU buffers in UI.
    const url=await new Promise<string>(resolve=>requestAnimationFrame(()=>resolve(canvas.toDataURL())));
    const img=new Image();img.src=url;await img.decode();
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d')!;ctx.drawImage(img,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let count=0;
    for(let i=0;i<d.length;i+=4)if(d[i]<150&&d[i+1]>170&&d[i+2]>150&&d[i+1]>d[i]+40)count++;return count;
  });
  await expect.poll(teal).toBeGreaterThan(50);await page.screenshot({path:testInfo.outputPath('collider-panel.png')});
  expect(await page.evaluate(()=>(window as any).velocut.store.getState().revision)).toBe(revision);
  await page.evaluate(()=>(window as any).velocut.directorSession({view:'shot'}));await expect.poll(teal).toBeLessThan(10);
  await page.evaluate(()=>(window as any).velocut.directorSession({view:'perspective'}));
  await page.getByRole('button',{name:'Add box collider',exact:true}).click();await expect(page.getByLabel('Selected collider')).toHaveValue('collider_1');
  await expect.poll(()=>page.evaluate(assetId=>Object.keys(JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec).props[0].physics.colliders).length,assetId)).toBe(2);
  await page.getByRole('button',{name:'Remove collider',exact:true}).click();await expect(page.getByLabel('Selected collider')).toHaveValue('default');
  await page.getByRole('button',{name:'Reset automatic collider',exact:true}).click();await expect(page.getByLabel('Collider shape')).toHaveValue('auto');
  const final=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:2,queries:[{type:'anchors',objectId:'ball'}]}),assetId);expect(final.results[0].items[0].position[1]).toBeCloseTo(.1,2);
});
