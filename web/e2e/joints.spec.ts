import {test,expect} from './test-fixtures';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {resolve,dirname} from 'node:path';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const physicsVersion=JSON.parse(readFileSync(resolve(dirname(createRequire(resolve('packages/scene-sdk/package.json')).resolve('@dimforge/rapier3d-compat')),'package.json'),'utf8')).version;
const fixture={version:1,durationUs:3_000_000,width:320,height:180,environment:'env/void',physics:{gravity:0},props:[
  {id:'base',model:'prop/cube',scale:.2,position:{y:2},physics:'fixed'},
  {id:'arm',model:'prop/cube',position:{y:1.5},physics:{type:'dynamic',mass:1},anchors:{tip:{position:[0,.5,0]}}},
]};
const joint={type:'revolute',a:{objectId:'base',position:[0,0,0]},b:{objectId:'arm',anchorId:'tip'},axis:[0,0,1],limits:[-60,60],motor:{mode:'position',targetPosition:45,stiffness:100,damping:20}};

test('MCP and CodeAct author joints atomically, rebuild named anchors, remap copies and persist physics',async({page})=>{
  const client=new Client({name:'joint-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);
    const sessionId=(await call('velocut_sessions')).sessions[0].sessionId,created=await call('velocut_scene_create',{sessionId,spec:fixture});expect(created.ok).toBe(true);const assetId=created.assetId;
    const made=await call('velocut_script',{sessionId,code:`
      const opts={assetId:${JSON.stringify(assetId)},expectedRevision:${created.revision},edits:[{type:'joint.create',id:'hinge',joint:${JSON.stringify(joint)}}],includeSpec:false};
      const p=await velocut.sceneEdit({...opts,preflight:true});if(!p.ok)throw Error(p.message);
      const before=await velocut.query({kind:'sceneJoints',assetId:opts.assetId});
      const result=await velocut.sceneEdit(opts);return {preflight:p,before,result};
    `});
    expect(made.ok,JSON.stringify(made)).toBe(true);expect(made.result.before.data.total).toBe(0);expect(made.result.result.ok).toBe(true);expect(made.result.result.jointIds).toEqual(['hinge']);
    const defs=await call('velocut_query',{sessionId,kind:'sceneJoints',assetId,fields:['id','joint']});expect(defs.data.items[0].joint.motor.targetPosition).toBe(45);
    const sample=()=>call('velocut_scene_spatial',{sessionId,assetId,timeS:2,queries:[{type:'joints',ids:['hinge']},{type:'anchors',objectId:'arm',anchorIds:['tip']}]});
    const state=await sample();expect(state.results[0].engine.version).toBe(physicsVersion);expect(state.results[0].items[0].coordinate).toBeCloseTo(45,0);expect(state.results[0].items[0].linearErrorM).toBeLessThan(.005);
    const baseline=await page.evaluate(()=>JSON.stringify((window as any).velocut.doc()));
    const invalid=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:state.revision,edits:[{type:'add',kind:'prop',object:{id:'must_not_exist',model:'prop/cube'}},{type:'joint.update',id:'hinge',joint:{...joint,b:{objectId:'missing',position:[0,0,0]}}}]});expect(invalid.ok).toBe(false);expect(await page.evaluate(()=>JSON.stringify((window as any).velocut.doc()))).toBe(baseline);
    const anchor=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:state.revision,edits:[{type:'anchor.set',id:'arm',anchorId:'tip',anchor:{position:[0,.6,0]}}]});expect(anchor.ok).toBe(true);expect(anchor.updateMode).not.toBe('transforms');
    const after=await sample();const position=after.results[1].items[0].position;after.results[0].items[0].positionB.forEach((v:number,i:number)=>expect(v).toBeCloseTo(position[i],5));expect(after.results[0].items[0].linearErrorM).toBeLessThan(.005);
    const copied=await call('velocut_scene_edit',{sessionId,assetId,expectedRevision:after.revision,edits:[{type:'duplicateMany',ids:['base','arm'],copies:[{prefix:'copy',relative:true,transform:{position:{x:4}}}]}],includeSpec:false});expect(copied.ok).toBe(true);expect(copied.copies[0].jointIdMap.hinge).toBe('copy/hinge');
    const undo=await call('velocut_history',{sessionId,action:'undo',expectedRevision:copied.revision});expect(undo.ok).toBe(true);expect((await call('velocut_query',{sessionId,assetId,kind:'sceneJoints'})).data.total).toBe(1);
    const redo=await call('velocut_history',{sessionId,action:'redo',expectedRevision:undo.revision});expect(redo.ok).toBe(true);
    const view=await call('velocut_director',{sessionId,options:{assetId,objectId:'arm',jointView:'selected',timeS:2}});expect(view.state.jointView).toBe('selected');
    const exported=await page.evaluate(async({assetId,url})=>{
      const v=(window as any).velocut,before=JSON.stringify(v.doc()),r=await v.sceneExport({assetId,timeS:2,objectIds:['arm']});if(!r.ok)throw Error(r.message);
      const sdk=await import(url),gltf=await sdk.parseSceneModel(await r.blob.arrayBuffer());gltf.scene.updateMatrixWorld(true);
      const arm=gltf.scene.getObjectByName('arm');if(!arm)throw Error('exported joint body missing');
      const p=arm.position.clone(),q=arm.quaternion.clone(),s=arm.scale.clone();arm.matrixWorld.decompose(p,q,s);
      return {angle:2*Math.atan2(q.z,q.w)*180/Math.PI,hasGuides:!!gltf.scene.getObjectByName('__velocut_joints'),unchanged:before===JSON.stringify(v.doc())};
    },{assetId,url:'/@fs'+resolve('packages/scene-sdk/src/index.ts')});
    expect(exported.angle).toBeCloseTo(45,0);expect(exported.hasGuides).toBe(false);expect(exported.unchanged).toBe(true);
    await page.evaluate(()=>(window as any).velocut.collab.flushNow());await page.reload();await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
    const restored=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:2,queries:[{type:'joints'}]}),assetId);expect(restored.results[0].total).toBe(2);for(const j of restored.results[0].items)expect(j.coordinate).toBeCloseTo(45,0);
  }finally{await client.close();}
});

test('compact joint controls draft, create, inspect, disable and remove through the shared edit path',async({page},testInfo)=>{
  await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.sceneSpatial);
  const assetId=await page.evaluate(async spec=>{const v=(window as any).velocut,r=await v.sceneClip({spec});if(!r.ok)throw Error(r.message);v.directorSession({assetId:r.assetId,objectId:'base',timeS:2,view:'front'});return r.assetId;},fixture);
  await page.getByRole('button',{name:'Properties',exact:true}).click();await page.getByText('Physics joints · 0',{exact:true}).click();
  const before=await page.evaluate(()=>(window as any).velocut.store.getState().revision);
  await page.getByLabel('Physics joint type').selectOption('rope');
  expect(await page.evaluate(()=>(window as any).velocut.store.getState().revision)).toBe(before);
  await page.getByRole('button',{name:'Create joint',exact:true}).click();await expect(page.getByLabel('Selected physics joint')).toHaveValue('joint_1');
  await page.getByRole('button',{name:'Inspect joint',exact:true}).click();await expect(page.locator('.director-selcard')).toContainText('anchor separation');
  const revision=await page.evaluate(()=>(window as any).velocut.store.getState().revision);
  await page.getByLabel('Joint guides').selectOption('selected');expect(await page.evaluate(()=>(window as any).velocut.store.getState().revision)).toBe(revision);
  await page.screenshot({path:testInfo.outputPath('joint-panel.png')});
  await page.getByLabel('Enable physics joint',{exact:true}).click();
  await expect(page.getByLabel('Enable physics joint',{exact:true})).not.toBeChecked();
  await expect.poll(()=>page.evaluate(assetId=>JSON.parse((window as any).velocut.doc().assets.find((a:any)=>a.id===assetId).spec).joints?.joint_1?.enabled,assetId)).toBe(false);
  const state=await page.evaluate(assetId=>(window as any).velocut.sceneSpatial({assetId,timeS:2,queries:[{type:'joints'}]}),assetId);expect(state.results[0].items[0].status).toBe('disabled');
  await page.getByRole('button',{name:'Remove joint',exact:true}).click();await expect(page.getByLabel('Selected physics joint')).toHaveValue('');
  await page.evaluate(()=>(window as any).velocut.undo());await expect(page.getByLabel('Selected physics joint')).toHaveValue('joint_1');
});
