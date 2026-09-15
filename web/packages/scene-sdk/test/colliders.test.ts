import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStage} from '../src/stage.ts';
import {applySceneEdits} from '../src/authoring.ts';
import {queryStageSpatial,validateSpatialQueries} from '../src/spatial.ts';
import {createColliderOverlay} from '../src/colliders.ts';
import {validateSceneSpec,type SceneSpec,type SceneProp} from '../src/types.ts';
import type {SceneGeometry} from '../src/geometry.ts';
import {encodeGeometry,geometryHash} from '../src/geometry-resource.ts';

const manifest=readFileSync(new URL('../assets/manifest.json',import.meta.url),'utf8');
globalThis.fetch=async url=>{assert.ok(String(url).endsWith('/manifest.json'));return new Response(manifest);};
const roof:SceneProp={id:'platform',model:'prop/extrude',points:[[-1,-1],[1,-1],[1,1],[-1,1]],holes:[[[-.5,-.5],[-.5,.5],[.5,.5],[.5,-.5]]],depth:.2,rotationX:-90,position:{y:1.2},physics:'fixed'};
const ball:SceneProp={id:'ball',model:'prop/sphere',scale:.2,position:{y:2.8},physics:{type:'dynamic',mass:.1,restitution:0}};
const scene=(platform:SceneProp=roof):SceneSpec=>({version:1,durationUs:3e6,environment:'env/grid',props:[platform,ball]});
const bodyY=(stage:Awaited<ReturnType<typeof buildStage>>,id='ball')=>stage.props.find(p=>p.spec.id===id)!.root.position.y;
const near=(a:number,b:number,tol=1e-5)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const boxes=(parts:Array<[number[],number[]]>):SceneGeometry=>{
  const vertices:SceneGeometry['vertices']=[],faces:SceneGeometry['faces']=[];
  for(const [p,h]of parts){const base=vertices.length;
    for(const [x,y,z]of[[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]])vertices.push([p[0]+x*h[0],p[1]+y*h[1],p[2]+z*h[2]]);
    for(const f of [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]])faces.push(f.map(i=>base+i) as [number,number,number]);
  }return {vertices,faces};
};
const ringParts:Array<[number[],number[]]>=[[[.75,0,0],[.25,.1,1]],[[-.75,0,0],[.25,.1,1]],[[0,0,.75],[.5,.1,.25]],[[0,0,-.75],[.5,.1,.25]]];

test('automatic static mesh preserves a through-hole; explicit hull and solid control stop the ball',async()=>{
  const open=await buildStage(scene());open.poseAt(2);near(bodyY(open),.1,.005);
  const info=(queryStageSpatial(open,[{type:'colliders',objectIds:['platform']}]) as any)[0];assert.equal(info.items[0].effectiveShape,'mesh');
  assert.equal((queryStageSpatial(open,[{type:'raycast',objectIds:['platform'],origin:[0,1.6,0],direction:[0,-1,0]}]) as any)[0].hit,null);
  const hull=await buildStage(scene({...roof,physics:{type:'fixed',colliders:{default:{shape:'convexHull'}}}}));hull.poseAt(2);near(bodyY(hull),1.4,.005);
  assert.match((queryStageSpatial(hull,[{type:'colliders',objectIds:['platform']}]) as any)[0].items[0].warning,/holes/);
  const solid=await buildStage(scene({...roof,holes:undefined}));solid.poseAt(2);near(bodyY(solid),1.4,.005);
  open.poseAt(.2);open.poseAt(2);near(bodyY(open),.1,.005); // Out-of-order playback.
});

test('blind mortise keeps its bottom and an open slot permits horizontal passage',async()=>{
  const geometry=boxes([...ringParts,[[0,-.075,0],[.5,.025,.5]]]);
  const spec=scene({id:'platform',model:'prop/mesh',geometryId:'blind',position:{y:1.2},physics:'fixed'});spec.geometries={blind:geometry};
  const blind=await buildStage(spec);blind.poseAt(2);near(bodyY(blind),1.25,.005);
  const slot=boxes([ringParts[0],ringParts[1],[[0,-.075,0],[.5,.025,1]]]);
  const passage:SceneSpec={...spec,physics:{gravity:0},geometries:{blind:slot},props:[spec.props![0],{...ball,scale:.1,position:{y:1.225,z:-1.5},physics:{type:'dynamic',velocity:[0,0,3],restitution:0}}]};
  const stage=await buildStage(passage);stage.poseAt(1);assert.ok(stage.props[1].root.position.z>1.4);
});

test('compound convex parts share one moving body and total mass, with local/world wireframe inspection',async()=>{
  const colliders=Object.fromEntries(ringParts.map(([position,halfExtents],i)=>['part_'+i,{shape:'box' as const,position:position as [number,number,number],halfExtents:halfExtents as [number,number,number]}]));
  const spec:SceneSpec={version:1,durationUs:2e6,environment:'env/void',physics:{gravity:0},props:[{id:'ring',model:'prop/mesh',geometryId:'ring',physics:{type:'dynamic',mass:8,velocity:[1,0,0],angularVelocity:[0,45,0],colliders}}],geometries:{ring:boxes(ringParts)}};
  const stage=await buildStage(spec);stage.poseAt(1);
  const q=(queryStageSpatial(stage,[{type:'colliders'},{type:'colliderGeometry',objectId:'ring',colliderId:'part_0',space:'local',limit:2},{type:'colliderGeometry',objectId:'ring',colliderId:'part_0',limit:2}]) as any);
  assert.equal(q[0].bodies.length,1);assert.equal(q[0].total,4);near(q[0].bodies[0].mass,8);near(q[0].items.reduce((s:number,c:any)=>s+c.mass,0),8);
  assert.equal(q[1].items.length,2);assert.equal(q[1].nextOffset,2);assert.notDeepEqual(q[1].items,q[2].items);
  near(stage.props[0].root.position.x,1,.01);
  const overlay=createColliderOverlay(stage,'ring');assert.equal(overlay.root.children.length,4);stage.scene.add(overlay.root);overlay.update();
  near(overlay.root.children[0].position.x,stage.props[0].root.position.x);let disposed=0;overlay.root.children.forEach((l:any)=>l.geometry.addEventListener('dispose',()=>disposed++));overlay.dispose();assert.equal(disposed,4);assert.equal(overlay.root.parent,null);
});

test('collider edits materialize the automatic default, compose atomically, clone independently and reset',async()=>{
  const original=scene(),snapshot=JSON.stringify(original);
  const made=applySceneEdits(original,[{type:'collider.remove',id:'platform',colliderId:'default'},...ringParts.map(([position,halfExtents],i)=>({type:'collider.create' as const,id:'platform',colliderId:'p'+i,collider:{shape:'box' as const,position:position as [number,number,number],halfExtents:halfExtents as [number,number,number]}})),{type:'duplicate',id:'platform',newId:'copy',offset:{x:4}}]);
  const changed=applySceneEdits(made.spec,[{type:'collider.update',id:'copy',colliderId:'p0',collider:{shape:'sphere',radius:.2}}]);
  assert.equal((changed.spec.props![0].physics as any).colliders.p0.shape,'box');assert.equal((changed.spec.props![2].physics as any).colliders.p0.shape,'sphere');
  const reset=applySceneEdits(changed.spec,[{type:'collider.reset',id:'copy'}]);assert.equal((reset.spec.props![2].physics as any).colliders,undefined);assert.equal(JSON.stringify(original),snapshot);
  assert.throws(()=>applySceneEdits(original,[{type:'collider.create',id:'platform',colliderId:'x',collider:{shape:'box',halfExtents:[1,1,1]}},{type:'collider.remove',id:'platform',colliderId:'missing'}]),/unknown collider/);
  assert.throws(()=>applySceneEdits(original,[{type:'collider.update',id:'ball',colliderId:'default',collider:{shape:'mesh'}}]),/dynamic/);
  const noCollision=applySceneEdits(original,[{type:'collider.remove',id:'platform',colliderId:'default'}]);const stage=await buildStage(noCollision.spec);stage.poseAt(2);near(bodyY(stage),.1,.005);
});

test('collider-only resource references are validated, protected from deletion and participate in geometry edits',async()=>{
  const geometry=boxes(ringParts),bytes=encodeGeometry(geometry),src=`opfs://scene-geometry-${await geometryHash(bytes)}.vmesh`;
  const spec:SceneSpec={...scene(),geometryResources:{collision:{src,vertexCount:geometry.vertices.length,triangleCount:geometry.faces.length,hasUvs:false,byteLength:bytes.byteLength}}};
  spec.props![0]={id:'platform',model:'prop/cube',position:{y:1.2},physics:{type:'fixed',colliders:{mesh:{shape:'mesh',geometryId:'collision'}}}};
  assert.equal(validateSceneSpec(spec),null);assert.throws(()=>applySceneEdits(spec,[{type:'geometry.remove',id:'collision'}]),/referenced/);
  const stage=await buildStage(spec,undefined,{geometryBytes:async()=>bytes});stage.poseAt(2);near(bodyY(stage),.1,.005);
  const changed=applySceneEdits(spec,[{type:'geometry.patch',id:'collision',attribute:'vertices',updates:[{index:0,value:[-.8,0,0]}]}],new Map([[src,geometry]]));assert.ok(changed.changedIds.includes('platform'));
  assert.match(validateSceneSpec({...spec,geometryResources:{}})!,/geometryId/);
});

test('collision geometry respects nonuniform scale and rotated local offsets',async()=>{
  const spec:SceneSpec={version:1,durationUs:1e6,environment:'env/void',props:[{id:'owner',model:'prop/cube',scale:{x:2,y:1,z:3},physics:{type:'fixed',colliders:{part:{shape:'box',halfExtents:[.5,.25,.1],position:[1,0,0],rotation:[0,45,0]}}}},{id:'child',model:'prop/cube',position:{x:100}}]};
  const stage=await buildStage(spec);stage.poseAt(0);const q=(queryStageSpatial(stage,[{type:'colliders'},{type:'colliderGeometry',objectId:'owner',colliderId:'part',space:'local'}]) as any);
  assert.equal(q[0].items[0].effectiveShape,'convexHull');const xs=q[1].items.flatMap((s:number[])=>[s[0],s[3]]);near(Math.max(...xs),2+Math.SQRT1_2*.6*2,1e-5);assert.ok(Math.max(...xs)<5);
  assert.throws(()=>validateSpatialQueries([{type:'colliders',limit:0}]),/range/);
  assert.throws(()=>queryStageSpatial(stage,[{type:'colliderGeometry',objectId:'owner',colliderId:'missing'}]),/unknown collider/);
});
