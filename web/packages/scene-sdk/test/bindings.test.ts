import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStage} from '../src/stage.ts';
import {applySceneEdits} from '../src/authoring.ts';
import {queryStageSpatial} from '../src/spatial.ts';
import {validateSceneSpec,type SceneSpec} from '../src/types.ts';
import {assertRenderableBindings} from '../src/binding-evaluator.ts';
import type {SceneBinding} from '../src/bindings.ts';

const manifest=readFileSync(new URL('../assets/manifest.json',import.meta.url),'utf8');
globalThis.fetch=async url=>{assert.ok(String(url).endsWith('/manifest.json'),String(url));return new Response(manifest,{headers:{'Content-Type':'application/json'}});};
const near=(a:number[],b:number[],epsilon=1e-6)=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<epsilon,`${a} != ${b}`));
const ref=(objectId:string,anchorId='joint')=>({objectId,anchorId});
const position:SceneBinding={type:'position',source:ref('column'),target:ref('beam')};
const base:SceneSpec={version:1,durationUs:2_000_000,environment:'env/void',props:[
  {id:'column',model:'prop/cube',position:{y:1},scale:{x:.4,y:2,z:.4},anchors:{joint:{position:[0,.5,0]}}},
  {id:'beam',model:'prop/cube',position:{x:5,y:5},scale:{x:2,y:.2,z:.3},anchors:{joint:{position:[0,-.5,0]}}},
]};
const distance=(stage:any,a='column',b='beam')=>(queryStageSpatial(stage,[{type:'distance',from:ref(a),to:ref(b)}]) as any)[0].distance;

test('position binding follows a taller column without rewriting authored transforms',async()=>{
  const spec=applySceneEdits(base,[
    {type:'add',kind:'group',object:{id:'ground',anchors:{joint:{position:[0,0,0]}}}},
    {type:'anchor.set',id:'column',anchorId:'bottom',anchor:{position:[0,-.5,0]}},
    {type:'binding.create',id:'base',binding:{type:'position',source:ref('ground'),target:ref('column','bottom')}},
    {type:'binding.create',id:'seat',binding:position},
  ]).spec;
  const serialized=JSON.stringify(spec),stage=await buildStage(spec);stage.poseAt(1);
  assert.ok(distance(stage)<1e-6);near(stage.props[1].root.position.toArray(),[0,2.1,0]);
  const taller=applySceneEdits(spec,[{type:'update',id:'column',patch:{scale:{x:.4,y:2.4,z:.4}}}]);
  assert.ok(taller.changedIds.includes('beam'));
  const changed=await buildStage(taller.spec);changed.poseAt(1);
  near(changed.props[1].root.position.toArray(),[0,2.5,0]);assert.ok(distance(changed)<1e-6);
  assert.ok((queryStageSpatial(changed,[{type:'distance',from:ref('ground'),to:ref('column','bottom')}]) as any)[0].distance<1e-6);
  assert.equal(JSON.stringify(spec),serialized);assert.deepEqual(taller.spec.props![1].position,{x:5,y:5});
});

test('authored motion needs opt-in and remains a deterministic offset from the chosen time',async()=>{
  const animated=structuredClone(base);animated.props![1].animation={timeOffset:.2,channels:{'position.y':[{t:0,v:9},{t:1,v:5,ease:'none'}]}};
  assert.throws(()=>applySceneEdits(animated,[{type:'binding.create',id:'seat',binding:position}]),/referenceTimeS/);
  const spec=applySceneEdits(animated,[{type:'binding.create',id:'seat',binding:{...position,motion:{referenceTimeS:1.2}}}]).spec;
  const stage=await buildStage(spec),samples=[];
  for(const t of [1.2,.2,.7,1.2,.7]){stage.poseAt(t);samples.push(stage.props[1].root.position.y);}
  near(samples,[2.1,6.1,4.1,2.1,4.1]);assert.deepEqual(spec.props![1].animation,animated.props![1].animation);
});

test('position and orientation solve target anchors under nonuniform rotated parent frames',async()=>{
  const spec=structuredClone(base);
  spec.groups=[{id:'outer',rotationX:17,scale:{x:1,y:2,z:.7}},{id:'g',parentId:'outer',rotationY:28,rotationZ:14,scale:{x:2,y:.7,z:1.3}}];
  spec.props![0].rotationX=25;spec.props![0].rotationZ=-12;
  spec.props![1].parentId='g';spec.props![1].scale={x:2,y:.3,z:.6};
  spec.props![1].anchors!.joint={position:[.3,-.5,.1],normal:[0,1,0],tangent:[1,0,0]};
  spec.bindings={seat:{...position,offset:[0,0,.02],offsetSpace:'source'},turn:{type:'orientation',source:ref('column'),target:ref('beam')}};
  const stage=await buildStage(spec);stage.poseAt(0);
  const frames=(queryStageSpatial(stage,[{type:'anchors',objectId:'column'},{type:'anchors',objectId:'beam'}]) as any).map((r:any)=>r.items[0]);
  near(frames[0].normal,frames[1].normal);near(frames[0].tangent,frames[1].tangent);
  near(frames[1].position,frames[0].position.map((v:number,i:number)=>v+frames[0].normal[i]*.02));
  assert.ok(stage.bindingStatuses!.every(s=>s.status==='valid'));
});

test('binding validation rejects cycles, duplicate writers and incompatible targets atomically',()=>{
  const bound={...base,bindings:{seat:position}};
  for(const binding of [position,{...position,source:ref('beam'),target:ref('column')},
    {...position,source:ref('missing')},{...position,motion:{referenceTimeS:4}}])
    assert.throws(()=>applySceneEdits(bound,[{type:'binding.create',id:'bad',binding}]));
  assert.throws(()=>applySceneEdits({...base,props:[{...base.props![0]},{...base.props![1],physics:'dynamic'}]},[{type:'binding.create',id:'seat',binding:position}]),/non-physics/);
  assert.equal(validateSceneSpec({...bound,bindings:{seat:position,off:{...position,enabled:false}}}),null);
  const cycle:SceneSpec={...base,groups:[{id:'g',anchors:{joint:{position:[0,0,0]}}}],props:[{...base.props![0],parentId:'g'}],bindings:{cycle:{type:'position',source:ref('column'),target:ref('g')}}};
  assert.match(validateSceneSpec(cycle)!,/cycle/);
  assert.equal(base.bindings,undefined);
});

test('controlled fields are explicit; disable/remove allows manual edits and cascade clears references',()=>{
  const bound=applySceneEdits(base,[{type:'binding.create',id:'seat',binding:position}]).spec;
  assert.throws(()=>applySceneEdits(bound,[{type:'transform',ids:['beam'],transform:{position:{y:2}}}]),/owns position/);
  assert.throws(()=>applySceneEdits(bound,[{type:'update',id:'beam',patch:{position:{y:2}}}]),/owns position/);
  assert.throws(()=>applySceneEdits(bound,[{type:'remove',id:'column'}]),/references/);
  assert.throws(()=>applySceneEdits(bound,[{type:'anchor.remove',id:'column',anchorId:'joint'}]),/reference/);
  const disabled=applySceneEdits(bound,[{type:'binding.update',id:'seat',binding:{...position,enabled:false}},{type:'transform',ids:['beam'],transform:{position:{y:2}}}]).spec;
  assert.equal(disabled.props![1].position!.y,2);
  const removed=applySceneEdits(bound,[{type:'remove',id:'column',cascade:true}]);
  assert.deepEqual(removed.bindingIds,['seat']);assert.deepEqual(removed.spec.bindings,{});assert.ok(removed.spec.props!.some(p=>p.id==='beam'));
  assert.ok(applySceneEdits(base,[{type:'binding.create',id:'toString',binding:position}]).spec.bindings!.toString);
});

test('copied subtrees remap bindings while standalone copies retain explicit external sources',async()=>{
  const spec:SceneSpec={...base,groups:[{id:'g'}],props:base.props!.map(p=>({...p,parentId:'g'})),bindings:{seat:position}};
  const copied=applySceneEdits(spec,[{type:'duplicate',id:'g',newId:'copy',offset:{x:4}}]);
  const id=copied.copies[0].bindingIdMap!.seat,b=copied.spec.bindings![id];
  assert.equal(b.source.objectId,'copy/column');assert.equal(b.target.objectId,'copy/beam');
  const stage=await buildStage(copied.spec);stage.poseAt(1);assert.ok(distance(stage,'copy/column','copy/beam')<1e-6);
  assert.throws(()=>applySceneEdits(spec,[{type:'duplicate',id:'beam',newId:'standalone',offset:{x:2}}]),/owns position/);
  const standalone=applySceneEdits(spec,[{type:'duplicate',id:'beam',newId:'standalone'}]);
  assert.equal(standalone.spec.bindings![standalone.copies[0].bindingIdMap!.seat].source.objectId,'column');
});

async function surfaceScene(){
  const raw:SceneSpec={...base,geometries:{roof:{vertices:[[-1,0,-1],[0,0,1],[1,0,-1]],faces:[[0,1,2]]}},props:[
    {id:'roof',model:'prop/mesh',geometryId:'roof',position:{y:3}},
    {id:'tile',model:'prop/cube',anchors:{joint:{position:[0,-.5,0]}}},
  ]};
  const stage=await buildStage(raw);stage.poseAt(1);
  const hit=(queryStageSpatial(stage,[{type:'raycast',origin:[0,5,0],direction:[0,-1,0],objectIds:['roof']}]) as any)[0].hit;
  assert.equal(hit.surfaceAnchor.kind,'surface');
  return applySceneEdits(raw,[{type:'anchor.set',id:'roof',anchorId:'joint',anchor:hit.surfaceAnchor},
    {type:'anchor.set',id:'roof',anchorId:'fixed_snapshot',anchor:hit.local},
    {type:'binding.create',id:'seat',binding:{type:'position',source:ref('roof'),target:ref('tile')}},
    {type:'binding.create',id:'turn',binding:{type:'orientation',source:ref('roof'),target:ref('tile')}}]).spec;
}

test('surface anchors and driven objects follow vertex deformation; topology changes invalidate rather than returning stale zero',async()=>{
  const spec=await surfaceScene();
  const changed=applySceneEdits(spec,[{type:'geometry.patch',id:'roof',attribute:'vertices',updates:[{index:1,value:[0,1,1]}]}]).spec;
  const stage=await buildStage(changed);stage.poseAt(1);
  const a=(queryStageSpatial(stage,[{type:'anchors',objectId:'roof'}]) as any)[0].items[0];
  assert.equal(a.status,'valid');assert.ok(a.position[1]>3.4);assert.ok(distance(stage,'roof','tile')<1e-6);
  const fixedPoint=(queryStageSpatial(stage,[{type:'anchors',objectId:'roof',anchorIds:['fixed_snapshot']}]) as any)[0].items[0];
  assert.equal(fixedPoint.kind,'local');assert.equal(fixedPoint.position[1],3);
  const invalid=applySceneEdits(changed,[{type:'geometry.update',id:'roof',geometry:{vertices:[[-1,0,-1],[0,1,1],[1,0,-1]],faces:[[0,2,1]]}}]).spec;
  const bad=await buildStage(invalid);bad.poseAt(1);
  const old=(queryStageSpatial(bad,[{type:'anchors',objectId:'roof'}]) as any)[0].items[0];
  assert.equal(old.status,'invalid');assert.equal(old.position,null);assert.match(old.message,/topology/);
  assert.ok(bad.bindingStatuses!.every(s=>s.status==='invalid'));
  assert.throws(()=>distance(bad,'roof','tile'),/invalid anchor/);assert.throws(()=>assertRenderableBindings(bad),/binding/);
  const hit=(queryStageSpatial(bad,[{type:'raycast',origin:[0,5,0],direction:[0,-1,0],objectIds:['roof']}]) as any)[0].hit;
  const fixed=applySceneEdits(invalid,[{type:'anchor.set',id:'roof',anchorId:'joint',anchor:hit.surfaceAnchor}]).spec;
  const recovered=await buildStage(fixed);recovered.poseAt(1);assert.ok(distance(recovered,'roof','tile')<1e-6);
});

test('orientation keeps its authored rotation delta and twist; invalid dependencies propagate downstream',async()=>{
  let spec=await surfaceScene();
  spec.props![1].rotationY=[{t:0,v:0},{t:1,v:90,ease:'none'}];
  spec.bindings!.turn={...spec.bindings!.turn,motion:{referenceTimeS:1}};
  const stage=await buildStage(spec),frames=[];
  for(const time of [1,0,1]){stage.poseAt(time);frames.push((queryStageSpatial(stage,[{type:'anchors',objectId:'tile'}]) as any)[0].items[0]);}
  near(frames[0].tangent,frames[2].tangent);
  const dot=frames[0].tangent.reduce((sum:number,n:number,i:number)=>sum+n*frames[1].tangent[i],0);assert.ok(Math.abs(dot)<1e-6);
  const twisted=applySceneEdits(spec,[{type:'binding.update',id:'turn',binding:{...spec.bindings!.turn,type:'orientation',twist:30}}]).spec;
  const turned=await buildStage(twisted);turned.poseAt(1);
  const tangent=(queryStageSpatial(turned,[{type:'anchors',objectId:'tile'}]) as any)[0].items[0].tangent;
  const cosine=frames[0].tangent.reduce((sum:number,n:number,i:number)=>sum+n*tangent[i],0);assert.ok(Math.abs(cosine-Math.cos(Math.PI/6))<1e-6);
  spec=applySceneEdits(spec,[
    {type:'add',kind:'prop',object:{id:'follower',model:'prop/cube',anchors:{joint:{position:[0,0,0]}}}},
    {type:'binding.create',id:'follow',binding:{type:'position',source:ref('tile'),target:ref('follower')}},
    {type:'geometry.patch',id:'roof',attribute:'faces',updates:[{index:0,value:[0,2,1]}]},
  ]).spec;
  const bad=await buildStage(spec);bad.poseAt(1);
  assert.ok(bad.invalidBindingObjects!.has('follower'));assert.equal(bad.bindingStatuses!.find(b=>b.id==='follow')!.status,'invalid');
  assert.throws(()=>distance(bad,'tile','follower'),/invalid anchor/);
});

test('zero-scale animation suspends a binding deterministically and recovers on reverse seeks',async()=>{
  const spec=await surfaceScene();spec.props![1].animation={channels:{'scale.y':[{t:0,v:0},{t:1,v:1}]}};
  const stage=await buildStage(spec);
  stage.poseAt(1);const end=stage.props[1].root.position.toArray();
  stage.poseAt(0);assert.ok(stage.bindingStatuses!.every(s=>s.status==='suspended'));assert.doesNotThrow(()=>assertRenderableBindings(stage));
  stage.poseAt(1);near(stage.props[1].root.position.toArray(),end);assert.ok(stage.bindingStatuses!.every(s=>s.status==='valid'));
});
