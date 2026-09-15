import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {applySceneEdits} from '../src/authoring.ts';
import {queryStageSpatial,validateSpatialQueries} from '../src/spatial.ts';
import {setVisualState} from '../src/visual.ts';
import {type Stage} from '../src/stage.ts';
import {type SceneSpec} from '../src/types.ts';

const near=(a:number[],b:number[])=>a.forEach((n,i)=>assert.ok(Math.abs(n-b[i])<1e-6,`${a} != ${b}`));
function fixture() {
  const scene=new THREE.Scene(),parent=new THREE.Group(),root=new THREE.Mesh(new THREE.BufferGeometry(),new THREE.MeshBasicMaterial());
  root.geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0, 0,0,2, 2,0,0],3));
  root.geometry.setIndex([0,1,2]);root.geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,0,1,1,0],2));
  scene.add(parent);parent.add(root);parent.position.set(10,3,-2);parent.rotation.x=Math.PI/6;parent.scale.set(2,3,4);
  const spec={id:'roof',model:'prop/mesh',anchors:{seat:{position:[.5,0,.5] as [number,number,number],normal:[0,1,0] as [number,number,number],tangent:[0,0,1] as [number,number,number]}}};
  const stage={three:THREE,scene,groups:[{spec:{id:'g'},root:parent}],props:[{spec,root}],characters:[],lights:[],instanceBatches:[]} as unknown as Stage;
  return {stage,root,parent};
}

test('anchors persist through copies and assembly edits; invalid edits roll back',()=>{
  const base:SceneSpec={version:1,durationUs:2_000_000};
  const made=applySceneEdits(base,[{type:'assembly',id:'table',recipe:{template:'table'}},
    {type:'anchor.set',id:'table/top',anchorId:'joint',anchor:{position:[0,.5,0],normal:[0,1,0]}},
    {type:'duplicate',id:'table',newId:'copy'},
    {type:'assembly',id:'copy',recipe:{template:'table',parameters:{width:3}}},
  ]);
  assert.deepEqual(made.spec.props!.find(p=>p.id==='copy/top')!.anchors,made.spec.props!.find(p=>p.id==='table/top')!.anchors);
  for(const anchor of [{position:[NaN,0,0]},{position:[0,0,0],normal:[0,0,0]},{position:[0,0,0],tangent:[0,1,0]},
    {position:[0,0,0],normal:[1,0,0],tangent:[2,0,0]},{position:[0,0,0],surface:'guess'}])
    assert.throws(()=>applySceneEdits(made.spec,[{type:'anchor.set',id:'copy/top',anchorId:'bad',anchor:anchor as any}]));
  assert.throws(()=>applySceneEdits(made.spec,[{type:'anchor.remove',id:'copy/top',anchorId:'missing'}]),/unknown anchor/);
  const removed=applySceneEdits(made.spec,[{type:'anchor.remove',id:'copy/top',anchorId:'joint'}]);
  assert.equal(removed.spec.props!.find(p=>p.id==='copy/top')!.anchors!.joint,undefined);
  assert.ok(made.spec.props!.find(p=>p.id==='copy/top')!.anchors!.joint);
});

test('surface points, normals, UVs and reusable local anchors agree under rotated nonuniform parents',()=>{
  const {stage}=fixture();
  const [anchors,surface,measurement,angle]=queryStageSpatial(stage,[
    {type:'anchors',objectId:'roof'},
    {type:'surface',objectId:'roof',triangleIndex:0,barycentric:[.5,.25,.25]},
    {type:'distance',from:{objectId:'g',position:[0,0,0]},to:{objectId:'roof',anchorId:'seat'}},
    {type:'angle',a:{position:[1,0,0]},vertex:{position:[0,0,0]},b:{position:[0,1,0]}},
  ]) as any[];
  near(surface.surface.position,[11,2,-2+Math.sqrt(3)]);
  near(surface.surface.normal,[0,Math.sqrt(3)/2,.5]);near(surface.surface.uv,[.25,.25]);
  near(anchors.items[0].position,surface.surface.position);near(anchors.items[0].normal,surface.surface.normal);
  near(surface.surface.local.position,[.5,0,.5]);near(surface.surface.local.normal,[0,1,0]);
  assert.ok(Math.abs(measurement.distance-Math.sqrt(5))<1e-6);assert.equal(angle.degrees,90);
  stage.props[0].spec.anchors!.sampled=surface.surface.local;
  const saved=(queryStageSpatial(stage,[{type:'anchors',objectId:'roof',anchorIds:['sampled']}]) as any)[0].items[0];
  near(saved.position,surface.surface.position);near(saved.normal,surface.surface.normal);near(saved.tangent,surface.surface.tangent);
});

test('raycast finds the nearest logical mesh from either face side, filters hidden objects and scopes groups',()=>{
  const {stage,root,parent}=fixture();
  const position=new THREE.Vector3(11,2,-2+Math.sqrt(3)),normal=new THREE.Vector3(0,Math.sqrt(3)/2,.5);
  const ray={type:'raycast' as const,origin:position.clone().addScaledVector(normal,5).toArray() as [number,number,number],direction:normal.clone().multiplyScalar(-7).toArray() as [number,number,number],objectIds:['g']};
  // Opaque instance proxies have visible=false but must still be queryable.
  root.visible=false;setVisualState(root,true,1);
  const hit=(queryStageSpatial(stage,[ray]) as any)[0].hit;
  assert.equal(hit.objectId,'roof');assert.deepEqual(hit.meshPath,[]);assert.ok(Math.abs(hit.distance-5)<1e-6);
  near(hit.position,position.toArray());near(hit.barycentric,[.5,.25,.25]);
  assert.equal((queryStageSpatial(stage,[{...ray,maxDistance:4}]) as any)[0].hit,null);
  const below={...ray,origin:position.clone().addScaledVector(normal,-5).toArray() as [number,number,number],direction:normal.toArray() as [number,number,number]};
  near((queryStageSpatial(stage,[below]) as any)[0].hit.normal,normal.toArray());
  setVisualState(parent,false,1);assert.equal((queryStageSpatial(stage,[ray]) as any)[0].hit,null);
  assert.equal((queryStageSpatial(stage,[{...ray,includeHidden:true}]) as any)[0].hit.objectId,'roof');
  assert.throws(()=>queryStageSpatial(stage,[{...ray,objectIds:['missing']}]),/unknown object/);
});

test('anchor tangent is projected in its authored plane before a sheared world transform',()=>{
  const {stage,root}=fixture();root.rotation.z=Math.PI/5;
  stage.props[0].spec.anchors!.seat.tangent=[1,1,1];
  const anchor=(queryStageSpatial(stage,[{type:'anchors',objectId:'roof'}]) as any)[0].items[0];
  const expected=new THREE.Vector3(1,0,1).transformDirection(root.matrixWorld);
  near(anchor.tangent,expected.toArray());
  assert.ok(Math.abs(new THREE.Vector3(...anchor.normal).dot(expected))<1e-6);
});

test('morph and skin queries use deformed vertices without stale geometry bounds',()=>{
  for(const skin of [false,true]){
    const {stage,root,parent}=fixture();parent.position.set(0,0,0);parent.rotation.set(0,0,0);parent.scale.setScalar(1);
    root.geometry.computeBoundingBox(); // At y=0 before deformation.
    let mesh:THREE.Mesh=root;
    if(skin){
      const bone=new THREE.Bone();mesh=new THREE.SkinnedMesh(root.geometry,root.material);mesh.add(bone);parent.remove(root);parent.add(mesh);
      root.geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(Array(12).fill(0),4));
      root.geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0],4));
      (mesh as THREE.SkinnedMesh).bind(new THREE.Skeleton([bone]));bone.position.y=2;
      stage.props[0].root=mesh;
    }else{
      root.geometry.morphTargetsRelative=true;
      root.geometry.morphAttributes.position=[new THREE.Float32BufferAttribute([0,2,0,0,2,0,0,2,0],3)];
      root.updateMorphTargets();root.morphTargetInfluences![0]=1;
    }
    const hit=(queryStageSpatial(stage,[{type:'raycast',origin:[.5,3,.5],direction:[0,-1,0]}]) as any)[0].hit;
    near(hit.position,[.5,2,.5]);assert.equal(hit.distance,1);
  }
});

test('nested mesh paths identify the sampled mesh, and collapsed anchor frames are explicitly invalid',()=>{
  const {stage,root,parent}=fixture(),wrapper=new THREE.Group();parent.remove(root);parent.add(wrapper);wrapper.add(root);stage.props[0].root=wrapper;
  const s=(queryStageSpatial(stage,[{type:'surface',objectId:'roof',meshPath:[0],triangleIndex:0,barycentric:[1,0,0]}]) as any)[0].surface;
  assert.deepEqual(s.meshPath,[0]);near(s.position,[10,3,-2]);
  assert.throws(()=>queryStageSpatial(stage,[{type:'surface',objectId:'roof',triangleIndex:0,barycentric:[1,0,0]}]),/logical mesh/);
  parent.scale.setScalar(0);
  const a=(queryStageSpatial(stage,[{type:'anchors',objectId:'roof'}]) as any)[0].items[0];
  near(a.position,[10,3,-2]);assert.equal(a.frameValid,false);assert.equal(a.normal,null);
  const collapsed=(queryStageSpatial(stage,[{type:'surface',objectId:'roof',meshPath:[0],triangleIndex:0,barycentric:[1,0,0]}]) as any)[0].surface;
  assert.equal(collapsed.frameValid,false);assert.equal(collapsed.local,null);
});

test('invalid spatial requests fail explicitly without changing the authored scene',()=>{
  const {stage}=fixture(),before=JSON.stringify(stage.props[0].spec);
  for(const query of [{type:'raycast',origin:[0,0,0],direction:[0,0,0]},
    {type:'surface',objectId:'roof',triangleIndex:0,barycentric:[1,1,1]},
    {type:'distance',from:{objectId:'roof'},to:{position:[0,0,0]}},
    {type:'anchors',objectId:'roof',anchorIds:['seat','seat']},{type:'anchors',objectId:'roof',extra:1}])
    assert.throws(()=>validateSpatialQueries([query]));
  assert.throws(()=>queryStageSpatial(stage,[{type:'surface',objectId:'roof',triangleIndex:100,barycentric:[1,0,0]}]),/draw range/);
  assert.throws(()=>queryStageSpatial(stage,[{type:'anchors',objectId:'roof',anchorIds:['missing']}]),/unknown anchor/);
  assert.throws(()=>queryStageSpatial(stage,[{type:'angle',a:{position:[0,0,0]},vertex:{position:[0,0,0]},b:{position:[0,1,0]}}]),/nonzero/);
  assert.equal(JSON.stringify(stage.props[0].spec),before);
});
