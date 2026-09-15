import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {applySceneEdits} from '../src/authoring.ts';
import {validateSceneSpec,type SceneSpec} from '../src/types.ts';
import {resolvePropAppearance} from '../src/materials.ts';
import {buildInstances} from '../src/instances.ts';
import {sceneBudget} from '../src/geometry.ts';
const base:SceneSpec={version:1,durationUs:1_000_000,geometries:{tile:{vertices:[[0,0,0],[1,0,0],[0,1,0]],faces:[[0,1,2]]}},
  materials:{tile:{color:'#c08b39',roughness:0.38,metalness:0.12,side:'double'}},
  props:[{id:'a',model:'prop/instance',geometryId:'tile',materialId:'tile'},{id:'b',model:'prop/instance',geometryId:'tile',materialId:'tile',material:{roughness:0.5},color:'#0000ff'}]};

test('shared material changes propagate while object overrides survive and batching uses resolved values',()=>{
  const edited=applySceneEdits(base,[{type:'material.update',id:'tile',material:{...base.materials!.tile,roughness:0.8,color:'#ff0000'}}]);
  assert.deepEqual(edited.materialIds,['tile']);assert.deepEqual(edited.changedIds,['a','b']);
  assert.equal(resolvePropAppearance(edited.spec,edited.spec.props![0]).material.roughness,0.8);
  assert.equal(resolvePropAppearance(edited.spec,edited.spec.props![1]).material.roughness,0.5);
  assert.equal(resolvePropAppearance(edited.spec,edited.spec.props![1]).color,'#0000ff');
  const reset=applySceneEdits(edited.spec,[{type:'update',id:'b',patch:{},clear:['material','color']}]).spec;
  const batches=buildInstances(THREE,reset);assert.equal(batches.batches.length,1);
  const color=new THREE.Color();batches.batches[0].mesh.getColorAt(1,color);assert.equal(color.getHexString(),'ff0000');
  assert.equal((batches.objects[1].root.material as THREE.MeshStandardMaterial).side,THREE.DoubleSide);
  assert.equal(base.materials!.tile.roughness,0.38);
});
test('material references and malformed definitions fail atomically; transparent defaults are accepted',()=>{
  assert.throws(()=>applySceneEdits(base,[{type:'material.remove',id:'tile'}]),/referenced/);
  assert.throws(()=>applySceneEdits(base,[{type:'material.create',id:'tile',material:{}}]),/exists/);
  assert.throws(()=>applySceneEdits(base,[{type:'update',id:'a',patch:{materialId:'missing'}}]),/materialId/);
  for(const material of [{roughness:'0.3'},{roughness:2},{color:'bad'},{map:'url'}])
    assert.throws(()=>applySceneEdits(base,[{type:'material.update',id:'tile',material:material as any}]));
  assert.equal(validateSceneSpec({...base,materials:{tile:{opacity:0.4}}}),null);
  assert.equal(validateSceneSpec({...base,materials:{tile:{opacity:0.5}},props:base.props!.map(p=>({...p,material:{opacity:1}}))}),null);
});
test('1000 animated tiles keep their material without repeating it in every object',()=>{
  const props=Array.from({length:1000},(_,i)=>({id:`tile_${i}`,model:'prop/instance',geometryId:'tile',position:{x:i%40,y:[{t:i/100,v:7},{t:i/100+0.65,v:0,ease:'power2.out'}],z:Math.floor(i/40)},materialId:'tile'}));
  const shared={...base,props};const inline={...base,materials:undefined,props:props.map(({materialId,...p})=>({...p,color:'#c08b39',material:{roughness:0.38,metalness:0.12,side:'double' as const}}))};
  assert.equal(validateSceneSpec(shared),null);
  assert.ok(sceneBudget(inline).used.specBytes-sceneBudget(shared).used.specBytes>40_000);
  assert.equal(sceneBudget(shared).used.instanceBatches,1);
});
