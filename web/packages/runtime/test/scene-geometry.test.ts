import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store,TsEngineAdapter,configureSceneStorage,sceneResources,readSceneGeometry,editScene } from '../dist/index.js';
import { externalizeSceneGeometry } from '../dist/scene-resources.js';
import { sceneBudget,resolveSceneGeometry,validateSceneSpec,type SceneGeometry,type SceneSpec } from '@velocut/scene-sdk';

function fixture(failSave=false) {
  const store=new Store(new TsEngineAdapter('Geometry',320,180,30,1)),files=new Map<string,Blob>();
  configureSceneStorage(store,{load:async src=>files.get(src)??null,save:async file=>{
    if(failSave)throw new Error('disk full');const src=`opfs://${file.name}`;files.set(src,file);return src;
  }});
  return {store,files};
}
const g:SceneGeometry={vertices:[[0,0,0],[1,0,0],[0,1,0]],faces:[[0,1,2]]};
test('large inline geometry becomes a compact manifest; versions deduplicate and project bindings stay isolated',async()=>{
  const f=fixture();
  const dense:SceneGeometry={vertices:Array.from({length:4096},(_,i)=>[Math.sin(i)*0.123456789012345,i*0.0123456789012345,Math.cos(i)*0.987654321098765]),
    faces:Array.from({length:4094},(_,i)=>[i,i+1,i+2])};
  const spec:SceneSpec={version:1,durationUs:1_000_000,geometries:{a:dense,b:dense},props:[{id:'a',model:'prop/instance',geometryId:'a'}]};
  assert.ok(JSON.stringify(spec).length>262144);assert.equal(validateSceneSpec(spec),null);
  const dry=await externalizeSceneGeometry(f.store,spec,false);assert.equal(f.files.size,0);
  assert.deepEqual(await resolveSceneGeometry(dry.spec,'a',dry.resources),dense);
  const stored=await externalizeSceneGeometry(f.store,spec,true);assert.equal(f.files.size,1);
  assert.ok(JSON.stringify(stored.spec).length<1024);assert.equal(stored.spec.geometries,undefined);
  assert.equal(sceneBudget(stored.spec).sharedVertices,8192);
  assert.deepEqual(await resolveSceneGeometry(stored.spec,'a',sceneResources(f.store)),dense);
  await externalizeSceneGeometry(f.store,spec,true);assert.equal(f.files.size,1);
  const other=fixture();await assert.rejects(resolveSceneGeometry(stored.spec,'a',sceneResources(other.store)),/missing/);
  assert.throws(()=>configureSceneStorage(f.store,{load:async()=>null,save:async()=>''}),/already bound/);
});
test('range reads and patch preflight verify the captured resource without editing history or storage',async()=>{
  const f=fixture(),before:SceneSpec={version:1,durationUs:1_000_000,geometries:{tile:g}};
  const stored=await externalizeSceneGeometry(f.store,before,true);
  f.store.dispatch({type:'addAsset',kind:'image',name:'Geometry',src:'scene://geometry',width:320,height:180,durationUs:1_000_000,spec:JSON.stringify(stored.spec)});
  const assetId=f.store.getState().doc.assets[0].id,revision=f.store.getState().revision;
  const read:any=await readSceneGeometry(f.store,{assetId,geometryId:'tile',offset:1,limit:1});
  assert.equal(read.ok,true);assert.deepEqual(read.items,[[1,0,0]]);assert.equal(read.nextOffset,2);
  const patch:any=await editScene(f.store,{assetId,preflight:true,edits:[{type:'geometry.patch',id:'tile',attribute:'vertices',updates:[{index:1,value:[2,0,0]}]}]});
  assert.equal(patch.ok,true);assert.equal(f.files.size,1);assert.equal(f.store.getState().revision,revision);
  const src=stored.spec.geometryResources!.tile.src;
  f.files.set(src,new Blob([new Uint8Array(stored.spec.geometryResources!.tile.byteLength)]));
  assert.equal((await readSceneGeometry(f.store,{assetId,geometryId:'tile'})).ok,false);
  assert.equal((await editScene(f.store,{assetId,preflight:true,edits:[{type:'makeUnique',id:'missing'}]})).ok,false);
});
test('storage failure cannot publish a geometry manifest',async()=>{
  const f=fixture(true);
  await assert.rejects(externalizeSceneGeometry(f.store,{version:1,durationUs:1_000_000,geometries:{tile:g}},true),/disk full/);
  assert.equal(f.store.getState().doc.assets.length,0);
});
