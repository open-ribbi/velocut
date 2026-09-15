import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildStage} from '../src/stage.ts';
import {applySceneEdits} from '../src/authoring.ts';
import {queryStageSpatial} from '../src/spatial.ts';
import {nativeGeometryKey,nativeTopologyKey,assertLegacyGeometryReplacement} from '../src/geometry-fingerprint.ts';
import {encodeGeometry,geometryHash} from '../src/geometry-resource.ts';
import type {SceneSpec} from '../src/types.ts';
import type {SceneGeometry} from '../src/geometry.ts';

const manifest=readFileSync(new URL('../assets/manifest.json',import.meta.url),'utf8');
globalThis.fetch=async url=>{assert.ok(String(url).endsWith('/manifest.json'));return new Response(manifest);};
const geometry:SceneGeometry={vertices:[[0,0,0],[0,0,1],[1,0,0],[2,0,0],[2,0,1],[3,0,0],[4,0,0],[4,0,1],[5,0,0]],faces:[[0,1,2],[3,4,5],[6,7,8]]};
const near=(a:number[],b:number[])=>a.forEach((v,i)=>assert.ok(Math.abs(v-b[i])<1e-6,`${a} != ${b}`));
const patch=(spec:SceneSpec,index:number,value:number[])=>applySceneEdits(spec,[{type:'geometry.patch',id:'roof',attribute:'faces',updates:[{index,value}]}]).spec;
async function inspect(spec:SceneSpec){const stage=await buildStage(spec);stage.poseAt(2);return {stage,anchors:(queryStageSpatial(stage,[{type:'anchors',objectId:'roof'}]) as any)[0].items};}
async function fixture(legacy=false){
  let spec:SceneSpec={version:1,durationUs:3_000_000,environment:'env/void',geometries:{roof:geometry},curves:{drop:{keys:[{t:0,v:2},{t:1,v:0}]}},props:[{id:'roof',model:'prop/mesh',geometryId:'roof',position:{y:2}}]};
  const stage=await buildStage(spec);stage.poseAt(2);
  for(const [anchorId,triangleIndex] of [['a',1],['b',2]] as const){
    const sampled=(queryStageSpatial(stage,[{type:'surface',objectId:'roof',triangleIndex,barycentric:[.2,.3,.5]}]) as any)[0].surface;
    const anchor={...sampled.surfaceAnchor,name:`Seat ${anchorId}`,tangent:[0,0,1]};
    if(legacy){delete anchor.surface.geometryKey;delete anchor.surface.vertexIndices;}
    const source={objectId:'roof',anchorId},target={objectId:anchorId,anchorId:'seat'};
    spec=applySceneEdits(spec,[
      {type:'anchor.set',id:'roof',anchorId,anchor},
      {type:'add',kind:'prop',object:{id:anchorId,model:'prop/cube',scale:.1,color:'#0011ff',anchors:{seat:{position:[0,0,0]}},animation:{timeOffset:.2,channels:{'position.y':{curveId:'drop'}}}}},
      {type:'binding.create',id:`${anchorId}_pos`,binding:{type:'position',source,target,offset:[0,0,.002],offsetSpace:'source',motion:{referenceTimeS:2}}},
      {type:'binding.create',id:`${anchorId}_rot`,binding:{type:'orientation',source,target,twist:12}},
    ]).spec;
  }
  return spec;
}

test('native synchronous fingerprints match resource WebCrypto and rendered topology hashes',async()=>{
  assert.equal(nativeGeometryKey(geometry),await geometryHash(encodeGeometry(geometry)));
  const spec=await fixture(),r=spec.props![0].anchors!.a;
  assert.equal(r.kind,'surface');if(r.kind!=='surface')throw Error('surface');
  assert.equal(r.surface.geometryKey,nativeGeometryKey(geometry));assert.equal(r.surface.topologyKey,nativeTopologyKey(geometry));
  assert.deepEqual(r.surface.vertexIndices,[3,4,5]);
});

test('patching an unused face preserves modern and verified legacy anchors without changing bindings or motion',async()=>{
  for(const legacy of [false,true]){
    const spec=await fixture(legacy),before=JSON.stringify(spec),old=await inspect(spec),changed=patch(spec,0,[0,2,1]),next=await inspect(changed);
    assert.ok(next.stage.bindingStatuses!.every(s=>s.status==='valid'));
    next.anchors.forEach((a:any,i:number)=>{assert.equal(a.status,'valid');near(a.position,old.anchors[i].position);assert.ok(a.anchor.surface.geometryKey);assert.ok(a.anchor.surface.vertexIndices);});
    assert.deepEqual(changed.bindings,spec.bindings);assert.deepEqual(changed.props!.slice(1),spec.props!.slice(1));assert.equal(JSON.stringify(spec),before);
  }
});

test('only the changed face and its downstream bindings fail; later patches do not repair it accidentally',async()=>{
  let spec=await fixture();
  spec=applySceneEdits(spec,[{type:'add',kind:'prop',object:{id:'child',model:'prop/cube',anchors:{seat:{position:[0,0,0]}}}},
    {type:'binding.create',id:'child_pos',binding:{type:'position',source:{objectId:'a',anchorId:'seat'},target:{objectId:'child',anchorId:'seat'}}}]).spec;
  const changed=patch(spec,1,[3,5,4]),bad=await inspect(changed);
  assert.equal(bad.anchors[0].status,'invalid');assert.match(bad.anchors[0].message,/face 1/);assert.equal(bad.anchors[0].position,null);assert.equal(bad.anchors[1].status,'valid');
  assert.deepEqual(bad.stage.bindingStatuses!.filter(s=>s.status==='invalid').map(s=>s.id),['a_pos','a_rot','child_pos']);
  const another=patch(changed,0,[0,2,1]);assert.equal((await inspect(another)).anchors[0].status,'invalid');
  const restored=patch(another,1,[3,4,5]);assert.ok((await inspect(restored)).stage.bindingStatuses!.every(s=>s.status==='valid'));
});

test('face-order repair preserves barycentric vertex association and only replaces the surface reference',async()=>{
  const spec=await fixture(),old=await inspect(spec),changed=patch(spec,1,[3,5,4]),bad=await inspect(changed);
  const snapshot=JSON.stringify(changed);
  const result=(queryStageSpatial(bad.stage,[{type:'anchorRepair',objectId:'roof',anchorId:'a',method:'face'}]) as any)[0];
  assert.equal(result.status,'candidate');assert.equal(result.candidate.windingReversed,true);
  assert.deepEqual(result.candidate.edit.surface.barycentric,[.2,.5,.3]);near(result.candidate.position,old.anchors[0].position);
  assert.equal(JSON.stringify(changed),snapshot);
  const renamed=structuredClone(changed.props![0].anchors!.a);renamed.name='Keep manual name';
  const fixed=applySceneEdits(changed,[{type:'anchor.set',id:'roof',anchorId:'a',anchor:renamed},result.candidate.edit]).spec;
  assert.equal(fixed.props![0].anchors!.a.name,'Keep manual name');assert.deepEqual(fixed.props![0].anchors!.a.tangent,[0,0,1]);
  assert.deepEqual(fixed.bindings,changed.bindings);assert.deepEqual(fixed.props!.slice(1),changed.props!.slice(1));
  assert.ok((await inspect(fixed)).stage.bindingStatuses!.every(s=>s.status==='valid'));
});

test('different connectivity refuses face guessing; an explicit ray produces a reviewable candidate',async()=>{
  const changed=patch(await fixture(),1,[3,4,8]),bad=await inspect(changed);
  const results=queryStageSpatial(bad.stage,[{type:'anchorRepair',objectId:'roof',anchorId:'a',method:'face'},
    {type:'anchorRepair',objectId:'roof',anchorId:'a',method:'raycast',ray:{origin:[2.5,5,.3],direction:[0,-1,0]}}]) as any[];
  assert.equal(results[0].candidate,null);assert.match(results[0].message,/original vertices/);
  assert.equal(results[1].status,'candidate');assert.equal(results[1].candidate.windingReversed,null);
  assert.deepEqual(results[1].candidate.edit.surface.vertexIndices,[3,4,8]);
  const fixed=applySceneEdits(changed,[results[1].candidate.edit]).spec;assert.equal((await inspect(fixed)).anchors[0].status,'valid');
});

test('cyclic face-order changes also flag a changed default tangent for review',async()=>{
  const spec=await fixture();delete spec.props![0].anchors!.a.tangent;
  const changed=patch(spec,1,[4,5,3]),stage=(await inspect(changed)).stage;
  const repair=(queryStageSpatial(stage,[{type:'anchorRepair',objectId:'roof',anchorId:'a',method:'face'}]) as any)[0];
  assert.equal(repair.candidate.windingReversed,false);assert.equal(repair.candidate.orientationChanged,true);assert.match(repair.message,/tangent/);
  near(repair.candidate.position,[2.5,2,.3]);
});

test('full replacement with unchanged index numbers invalidates anchors and cannot be laundered by a later patch',async()=>{
  for(const legacy of [false,true]){
    const spec=await fixture(legacy),replacement={...geometry,vertices:geometry.vertices.map(([x,y,z])=>[x,y+.5,z] as [number,number,number])};
    assert.equal(nativeTopologyKey(replacement),nativeTopologyKey(geometry));
    const changed=applySceneEdits(spec,[{type:'geometry.update',id:'roof',geometry:replacement}]).spec,bad=await inspect(changed);
    assert.ok(bad.anchors.every((a:any)=>a.status==='invalid'));
    const face=(queryStageSpatial(bad.stage,[{type:'anchorRepair',objectId:'roof',anchorId:'a',method:'face'}]) as any)[0];
    assert.equal(face.candidate,null);assert.match(face.message,/replaced|reindexed/);
    assert.ok((await inspect(patch(changed,0,[0,2,1]))).anchors.every((a:any)=>a.status==='invalid'));
    if(legacy){const raw=structuredClone(spec);raw.geometries!.roof=replacement;assert.throws(()=>assertLegacyGeometryReplacement(spec,raw),/verified upgrade/);}
  }
  const spec=await fixture(),reindexed={...geometry,vertices:[...geometry.vertices].reverse(),faces:geometry.faces.map(f=>f.map(i=>geometry.vertices.length-1-i) as [number,number,number])};
  assert.ok((await inspect(applySceneEdits(spec,[{type:'geometry.update',id:'roof',geometry:reindexed}]).spec)).anchors.every((a:any)=>a.status==='invalid'));
});

test('stale or forged repair candidates fail atomically, including changes later in the same batch',async()=>{
  const changed=patch(await fixture(),1,[3,5,4]),bad=await inspect(changed);
  const edit=(queryStageSpatial(bad.stage,[{type:'anchorRepair',objectId:'roof',anchorId:'a',method:'face'}]) as any)[0].candidate.edit;
  const snapshot=JSON.stringify(changed);
  assert.throws(()=>applySceneEdits(patch(changed,0,[0,2,1]),[edit]),/reference changed/);
  assert.throws(()=>applySceneEdits(changed,[{...edit,surface:{...edit.surface,geometryKey:'0'.repeat(64)}}]),/candidate/);
  assert.throws(()=>applySceneEdits(changed,[edit,edit]),/reference changed/);
  assert.throws(()=>applySceneEdits(changed,[edit,{type:'geometry.patch',id:'roof',attribute:'faces',updates:[{index:1,value:[3,4,8]}]}]),/candidate/);
  assert.equal(JSON.stringify(changed),snapshot);
});

test('immutable resources, geometry clones and makeUnique retain independent patch histories',async()=>{
  const spec=await fixture(),bytes=encodeGeometry(geometry),src=`opfs://scene-geometry-${nativeGeometryKey(geometry)}.vmesh`;
  const resource={src,vertexCount:geometry.vertices.length,triangleCount:geometry.faces.length,hasUvs:false,byteLength:bytes.byteLength};
  const external={...spec,geometries:undefined,geometryResources:{roof:resource}};
  const copied=applySceneEdits(external,[{type:'geometry.clone',id:'roof',newId:'private'},{type:'duplicate',id:'roof',newId:'copy'},
    {type:'update',id:'copy',patch:{geometryId:'private'}},{type:'geometry.patch',id:'private',attribute:'faces',updates:[{index:1,value:[3,5,4]}]}],new Map([[src,geometry]])).spec;
  const stage=await buildStage(copied,undefined,{geometryBytes:async()=>bytes});stage.poseAt(2);
  const results=queryStageSpatial(stage,[{type:'anchors',objectId:'roof'},{type:'anchors',objectId:'copy'}]) as any[];
  assert.ok(results[0].items.every((a:any)=>a.status==='valid'));assert.equal(results[1].items[0].status,'invalid');assert.equal(results[1].items[1].status,'valid');
  const instances={...external,props:external.props!.map(p=>p.id==='roof'?{...p,model:'prop/instance'}:p)};
  const unique=applySceneEdits(instances,[{type:'makeUnique',id:'roof',geometryId:'unique'}]).spec;
  const isolated=await buildStage(unique,undefined,{geometryBytes:async()=>bytes});isolated.poseAt(2);
  assert.equal(unique.props![0].model,'prop/mesh');assert.ok((queryStageSpatial(isolated,[{type:'anchors',objectId:'roof'}]) as any)[0].items.every((a:any)=>a.status==='valid'));
});
