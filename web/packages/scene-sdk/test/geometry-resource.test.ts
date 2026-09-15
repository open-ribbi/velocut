import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeGeometry, decodeGeometry, geometryHash, resolveSceneGeometry, type SceneGeometryResource } from '../src/geometry-resource.ts';
import { applySceneEdits } from '../src/authoring.ts';
import { validateSceneSpec, type SceneSpec } from '../src/types.ts';
import { sceneBudget, type SceneGeometry } from '../src/geometry.ts';
import { sceneStructureKey } from '../src/incremental.ts';

const geometry: SceneGeometry = {vertices:[[0,0,0],[1/3,0,0],[0,1/7,0]],faces:[[0,1,2]],uvs:[[0,0],[1,0],[0,1]]};
async function fixture() {
  const bytes=encodeGeometry(geometry),src=`opfs://scene-geometry-${await geometryHash(bytes)}.vmesh`;
  const resource:SceneGeometryResource={src,vertexCount:3,triangleCount:1,hasUvs:true,byteLength:bytes.byteLength};
  const spec:SceneSpec={version:1,durationUs:1_000_000,geometryResources:{tile:resource},props:[{id:'a',model:'prop/instance',geometryId:'tile'}]};
  return {bytes,resource,spec};
}
test('binary geometry round-trips exact source numbers and rejects truncated/corrupt versions', async () => {
  const f=await fixture();assert.deepEqual(decodeGeometry(f.bytes),geometry);
  const resources={modelBytes:async()=>new ArrayBuffer(0),geometryBytes:async()=>f.bytes};
  assert.deepEqual(await resolveSceneGeometry(f.spec,'tile',resources),geometry);
  const changed=f.bytes.slice(0);new DataView(changed).setFloat64(24,42,true);
  await assert.rejects(resolveSceneGeometry(f.spec,'tile',{...resources,geometryBytes:async()=>changed}),/changed/);
  assert.throws(()=>decodeGeometry(f.bytes.slice(0,-1)),/length/);
  const malformed=f.bytes.slice(0);new DataView(malformed).setUint32(12,0xffffffff,true);
  assert.throws(()=>decodeGeometry(malformed),/header/);
  assert.notEqual(validateSceneSpec({...f.spec,geometryResources:{tile:{...f.resource,byteLength:7}}}),null);
  assert.notEqual(validateSceneSpec({...f.spec,geometries:{tile:geometry}}),null);
});
test('resource counts participate in budgets; geometry.patch is bounded and atomic', async () => {
  const f=await fixture();assert.equal(validateSceneSpec(f.spec),null);
  assert.equal(sceneBudget(f.spec).sharedVertices,3);assert.equal(sceneBudget(f.spec).used.instanceTriangles,1);
  const inline:SceneSpec={version:1,durationUs:1_000_000,geometries:{tile:geometry}};
  const changed=applySceneEdits(inline,[{type:'geometry.patch',id:'tile',attribute:'vertices',updates:[{index:1,value:[2,0,0]}]}]);
  assert.equal(changed.spec.geometries!.tile.vertices[1][0],2);assert.equal(geometry.vertices[1][0],1/3);
  assert.throws(()=>applySceneEdits(inline,[{type:'geometry.patch',id:'tile',attribute:'faces',updates:[{index:0,value:[0,0,0]}]}]),/distinct/);
  assert.throws(()=>applySceneEdits(inline,[{type:'geometry.patch',id:'tile',attribute:'vertices',updates:[{index:1,value:[2,0,0]},{index:1,value:[3,0,0]}]}]),/unique/);
});
test('transform compatibility excludes topology, parent, material and physics changes', async () => {
  const f=await fixture();f.spec.groups=[{id:'g'}];f.spec.props![0].parentId='g';
  const key=sceneStructureKey(f.spec);
  const moved=applySceneEdits(f.spec,[{type:'transform',ids:['g'],transform:{rotation:{y:45}}},{type:'transform',ids:['a'],transform:{position:{x:2}}}]).spec;
  assert.equal(sceneStructureKey(moved),key);
  for (const patch of [{color:'#ff0000'},{geometryId:'another'},{parentId:undefined},{scale:2,material:{roughness:0.3}}]) {
    const different=structuredClone(f.spec);Object.assign(different.props![0],patch);
    assert.notEqual(sceneStructureKey(different),key);
  }
});
