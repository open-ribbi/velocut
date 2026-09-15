import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStage} from '../src/stage.ts';
import {applySceneEdits} from '../src/authoring.ts';
import {validateSceneSpec,type SceneSpec} from '../src/types.ts';
import {type SceneJoint} from '../src/joints.ts';
import {queryStageSpatial} from '../src/spatial.ts';
import {readStageJoints,createJointOverlay} from '../src/joint-spatial.ts';
import {sceneStructureKey} from '../src/incremental.ts';
import {sceneBudget} from '../src/geometry.ts';

const manifest=readFileSync(new URL('../assets/manifest.json',import.meta.url),'utf8');
globalThis.fetch=async url=>{assert.ok(String(url).endsWith('/manifest.json'));return new Response(manifest);};
const endpoints={a:{objectId:'base',position:[0,0,0] as [number,number,number]},b:{objectId:'arm',anchorId:'tip'}};
const fixture=(joint:SceneJoint):SceneSpec=>({version:1,durationUs:3e6,environment:'env/void',physics:{gravity:0},joints:{link:joint},props:[
  {id:'base',model:'prop/cube',scale:.2,position:{y:2},physics:'fixed'},
  {id:'arm',model:'prop/cube',position:{y:1.5},physics:{type:'dynamic',mass:1,restitution:0},anchors:{tip:{position:[0,.5,0]}}},
]});
const near=(a:number,b:number,tol=1e-3)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);

test('fixed and spherical joints constrain actual gravity motion and preserve sampled results',async()=>{
  for(const type of ['fixed','spherical'] as const){
    const spec=fixture({type,...endpoints});delete spec.physics;
    const stage=await buildStage(spec);stage.poseAt(2);
    const r=readStageJoints(stage).items[0];near(r.anchorDistanceM,0,.005);assert.equal(r.status,'enabled');
    const before=stage.props[1].root.position.toArray();stage.poseAt(.1);stage.poseAt(2);assert.deepEqual(stage.props[1].root.position.toArray(),before);
    const disabled=await buildStage(applySceneEdits(spec,[{type:'joint.update',id:'link',joint:{...spec.joints!.link,enabled:false}}]).spec);disabled.poseAt(2);
    assert.ok(disabled.props[1].root.position.y<-10);assert.equal(readStageJoints(disabled).items[0].status,'disabled');
  }
});

test('hinge motors use degrees and slider motors use meters; limits constrain motion',async()=>{
  for(const type of ['revolute','prismatic'] as const){
    const target=type==='revolute'?45:.6,limits:[number,number]=type==='revolute'?[-60,60]:[-.2,.8];
    const joint:SceneJoint={...endpoints,type,axis:type==='revolute'?[0,0,1]:[1,0,0],limits,motor:{mode:'position',targetPosition:target,stiffness:100,damping:20}};
    const stage=await buildStage(fixture(joint));stage.poseAt(3);const r=readStageJoints(stage).items[0];
    near(r.coordinate!,target,type==='revolute'?.5:.01);near(r.linearErrorM!,0,.005);assert.equal(r.limitError,0);assert.equal(r.unit,type==='revolute'?'degrees':'meters');
    const velocity=await buildStage(fixture({...joint,motor:{mode:'velocity',targetVelocity:type==='revolute'?90:3,damping:10}}));velocity.poseAt(3);
    const limited=readStageJoints(velocity).items[0];near(limited.coordinate!,limits[1],type==='revolute'?.5:.01);
  }
});

test('ropes permit slack and springs extend under load without acting as rigid locks',async()=>{
  for(const type of ['rope','spring'] as const){
    const j:SceneJoint=type==='rope'?{...endpoints,type,length:1}:{...endpoints,type,length:.5,stiffness:100,damping:10};
    const spec=fixture(j);delete spec.physics;spec.props![1].anchors!.tip={position:[0,0,0]};
    const stage=await buildStage(spec);stage.poseAt(3);const r=readStageJoints(stage).items[0];
    near(r.coordinate!,type==='rope'?1:.5+9.81/100,.015);
    if(type==='spring'){assert.ok(r.extensionM!>.08);assert.equal(r.linearErrorM,null);}
  }
});

test('generic locked axes leave the declared translation free and lock the other coordinates',async()=>{
  const spec=fixture({...endpoints,type:'generic',axis:[1,0,0],lockedAxes:['y','z','rotationX','rotationY','rotationZ']});
  spec.props![1].physics={type:'dynamic',mass:1,velocity:[1,0,0]};
  const stage=await buildStage(spec);stage.poseAt(2);const r=readStageJoints(stage).items[0];
  near(r.relativeTranslation![0],2,.02);near(r.linearErrorM!,0,.005);near(stage.props[1].root.position.y,1.5,.005);
});

test('scaled anchor references and fixed local frames survive body rotation; anchor edits invalidate the bake key',async()=>{
  const spec=fixture({...endpoints,type:'fixed',rotationA:[0,0,-90]});spec.props![0].rotationZ=90;spec.props![1].scale=2;spec.props![1].position={y:1};
  const stage=await buildStage(spec);stage.poseAt(2);near(readStageJoints(stage).items[0].anchorDistanceM,0,.005);near(readStageJoints(stage).items[0].angularErrorDeg!,0,.01);
  const changed=applySceneEdits(spec,[{type:'anchor.set',id:'arm',anchorId:'tip',anchor:{position:[0,.75,0]}}]).spec;
  assert.notEqual(sceneStructureKey(changed),sceneStructureKey(spec));assert.equal(stage.canUpdateTransforms(changed),false);
  assert.throws(()=>applySceneEdits(spec,[{type:'anchor.remove',id:'arm',anchorId:'tip'}]),/local anchorId/);
});

test('joint CRUD, internal-copy remapping, external-link omission and cascade removal are atomic',()=>{
  const spec=fixture({...endpoints,type:'fixed'}),original=JSON.stringify(spec);
  const copied=applySceneEdits(spec,[{type:'duplicateMany',ids:['base','arm'],copies:[{prefix:'copy',relative:true,transform:{position:{x:4}}}]}]);
  const id=copied.copies[0].jointIdMap!.link;assert.equal(copied.spec.joints![id].a.objectId,'copy/base');assert.equal(copied.spec.joints![id].b.objectId,'copy/arm');assert.deepEqual(copied.jointIds,[id]);
  const single=applySceneEdits(spec,[{type:'duplicate',id:'arm',newId:'loose',offset:{x:2}}]);assert.deepEqual(single.copies[0].omittedJointIds,['link']);assert.equal(Object.keys(single.spec.joints!).length,1);
  assert.throws(()=>applySceneEdits(spec,[{type:'remove',id:'arm'}]),/references/);
  const removed=applySceneEdits(spec,[{type:'remove',id:'arm',cascade:true}]);assert.deepEqual(removed.spec.joints,{});assert.ok(removed.changedIds.includes('base'));
  assert.throws(()=>applySceneEdits(spec,[{type:'joint.remove',id:'link'},{type:'joint.remove',id:'missing'}]),/unknown joint/);assert.equal(JSON.stringify(spec),original);
  assert.equal(sceneBudget(spec).limits.joints,null);assert.equal(sceneBudget(spec).used.joints,1);
});

test('malformed definitions reject before simulation while physical joint cycles remain allowed',()=>{
  const good:SceneJoint={...endpoints,type:'revolute',axis:[0,1,0]};
  for(const joint of [{...good,b:good.a},{...good,axis:[0,0,0]},{...good,limits:[1,-1]},{...good,motor:{mode:'position',targetPosition:2,stiffness:0,damping:1}},{...good,motor:{mode:'position',targetPosition:450,stiffness:10,damping:1}},{...good,b:{objectId:'missing',position:[0,0,0]}},{...good,b:{objectId:'arm',anchorId:'toString'}},{...good,forceLimit:1}])assert.ok(validateSceneSpec(fixture(joint as SceneJoint)));
  const spec=fixture({...endpoints,type:'fixed'});spec.props!.push({id:'third',model:'prop/cube',physics:'dynamic'});
  spec.joints!.second={type:'spherical',a:{objectId:'arm',position:[0,0,0]},b:{objectId:'third',position:[0,0,0]}};
  spec.joints!.third={type:'spherical',a:{objectId:'third',position:[0,0,0]},b:{objectId:'base',position:[0,0,0]}};
  assert.equal(validateSceneSpec(spec),null);
  const edited=applySceneEdits(spec,[{type:'joint.update',id:'link',joint:{...spec.joints!.link,contactsEnabled:true}}]);assert.ok(edited.changedIds.includes('third'));
});

test('joint queries page by ID/body and overlays dispose without changing geometry',async()=>{
  const stage=await buildStage(fixture({...endpoints,type:'revolute',axis:[0,0,1]}));stage.poseAt(1);
  const r=queryStageSpatial(stage,[{type:'joints',objectIds:['arm'],limit:1}])[0];assert.equal(r.type,'joints');if(r.type==='joints')assert.equal(r.total,1);
  assert.throws(()=>readStageJoints(stage,{ids:['absent']}),/unknown joint/);
  const overlay=createJointOverlay(stage,'arm');stage.scene.add(overlay.root);overlay.update();assert.equal(overlay.root.children.length,1);
  let disposed=false;(overlay.root.children[0] as any).geometry.addEventListener('dispose',()=>{disposed=true;});overlay.dispose();assert.equal(disposed,true);assert.equal(overlay.root.parent,null);
});
