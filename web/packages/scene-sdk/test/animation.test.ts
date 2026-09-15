import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {sampleChannel, sampleObjectTransform} from '../src/animation.ts';
import {applySceneEdits} from '../src/authoring.ts';
import {validateSceneSpec, type SceneSpec} from '../src/types.ts';
import {buildInstances, syncInstanceBatches} from '../src/instances.ts';
import {objectIsVisible, prepareVisualMeshes, setVisualState, visibleBounds} from '../src/visual.ts';
import {sceneStructureKey} from '../src/incremental.ts';

const base:SceneSpec={version:1,durationUs:5_000_000,
  curves:{grow:{keys:[{t:0,v:0},{t:1,v:1,ease:'none'}]},show:{mode:'step',keys:[{t:0,v:0},{t:0.1,v:1},{t:2,v:0}]}},
  props:[{id:'a',model:'prop/cube',position:{y:3},animation:{timeOffset:1,channels:{
    'scale.y':{curveId:'grow'},opacity:{curveId:'grow'},visible:{curveId:'show'},
    'position.x':{curveId:'grow',timeOffset:0.25,timeScale:2,valueScale:4,valueOffset:10},
  }}}]};

test('shared curves sample delays, binding transforms and step boundaries independently of seek order',()=>{
  assert.equal(validateSceneSpec(base),null);
  const object=base.props![0];
  assert.equal(sampleObjectTransform(object,0,base).visible,false);
  assert.equal(sampleObjectTransform(object,1.099,base).visible,false);
  assert.equal(sampleObjectTransform(object,1.101,base).visible,true);
  assert.deepEqual(sampleObjectTransform(object,1.5,base),{position:[12,3,0],rotation:[0,0,0],scale:[1,0.5,1],visible:true,opacity:0.5});
  assert.equal(sampleChannel(object,'visible',3,base,1),0);
  const atHalf=sampleObjectTransform(object,1.5,base);
  for(const t of [0,4,1.1,2,1.5,0,5])sampleObjectTransform(object,t,base);
  assert.deepEqual(sampleObjectTransform(object,1.5,base),atHalf);
  const inline={position:{x:[{t:0,v:2},{t:1,v:4,ease:'none'}]},rotationZ:[{t:0,v:0},{t:1,v:90,ease:'none'}],
    visible:[{t:0,v:false},{t:1,v:true}],opacity:[{t:0,v:0},{t:1,v:1,ease:'none'}],animation:{timeOffset:1}};
  assert.deepEqual(sampleObjectTransform(inline,1.5,{}),{position:[3,0,0],rotation:[0,0,45],scale:[1,1,1],visible:false,opacity:0.5});
  assert.equal(sampleObjectTransform(inline,2,{}).visible,true);
  // Easing may overshoot but visual quantities retain their valid range.
  const overshoot={opacity:[{t:0,v:0},{t:1,v:1,ease:'back.out'}],animation:{channels:{'scale.x':[{t:0,v:1},{t:1,v:0,ease:'back.out'}]}}};
  assert.equal(sampleChannel(overshoot,'opacity',0.8,{},1),1);
  assert.equal(sampleChannel(overshoot,'scale.x',0.8,{},1),0);
});

test('curve edits are atomic, reject malformed bindings and preserve references when copying or placing',()=>{
  assert.throws(()=>applySceneEdits(base,[{type:'curve.remove',id:'grow'}]),/referenced/);
  for(const keys of [[],[{t:1,v:0},{t:0,v:1}],[{t:0,v:0},{t:0,v:1}],[{t:-1,v:0}],[{t:0,v:NaN}]])
    assert.throws(()=>applySceneEdits(base,[{type:'curve.update',id:'grow',curve:{keys}}]));
  for(const channels of [{'opacity':{curveId:'missing'}},{'scale.y':-1},{opacity:2},{visible:0.5},{visible:{curveId:'grow'}},
    {visible:{curveId:'show',valueScale:1}},{'position.x':{curveId:'grow',timeScale:0}},{'unknown':1}])
    assert.notEqual(validateSceneSpec({...base,props:[{...base.props![0],animation:{channels} as any}]}),null);
  assert.throws(()=>applySceneEdits(base,[{type:'curve.update',id:'grow',curve:{keys:[{t:0,v:0},{t:1,v:2}]}}]),/opacity/);
  assert.equal(base.curves!.grow.keys[1].v,1);
  const copied=applySceneEdits(base,[{type:'duplicate',id:'a',newId:'b',offset:{x:3}},
    {type:'transform',ids:['b'],timeS:1.5,transform:{position:{x:20},scale:{y:2}}}]);
  const b=copied.spec.props![1];
  assert.deepEqual(b.animation!.channels!['position.x'],{curveId:'grow',timeOffset:0.25,timeScale:2,valueScale:4,valueOffset:18});
  assert.deepEqual(b.animation!.channels!['scale.y'],{curveId:'grow',valueScale:4,valueOffset:0});
  assert.equal(sampleChannel(b,'position.x',1.5,copied.spec,0),20);
  assert.equal(sampleChannel(b,'scale.y',1.5,copied.spec,1),2);
  assert.equal(Object.keys(copied.spec.curves!).length,2);
  const changed=applySceneEdits(copied.spec,[{type:'curve.update',id:'grow',curve:{keys:[{t:0,v:0},{t:2,v:1,ease:'none'}]}}]);
  assert.deepEqual(changed.curveIds,['grow']);assert.deepEqual(changed.changedIds,['a','b']);
  assert.equal(sampleChannel(changed.spec.props![0],'scale.y',1.5,changed.spec,1),0.25);
  assert.throws(()=>applySceneEdits(base,[{type:'transform',ids:['a'],transform:{scale:{y:2}}}]),/scale is zero/);
  const removed=applySceneEdits(base,[{type:'remove',id:'a'},{type:'curve.remove',id:'grow'}]);
  assert.equal(removed.spec.curves!.grow,undefined);
});

test('physics permits visual animation without silently changing baked colliders',()=>{
  const p={id:'p',model:'prop/cube',physics:'dynamic' as const,visible:[{t:0,v:false},{t:1,v:true}],opacity:[{t:0,v:0},{t:1,v:1}],animation:{timeOffset:1}};
  assert.equal(validateSceneSpec({version:1,durationUs:2_000_000,props:[p]}),null);
  assert.match(validateSceneSpec({version:1,durationUs:2_000_000,props:[{...p,animation:{channels:{'scale.y':1}}}]} )!,/physics transform/);
  assert.match(validateSceneSpec({version:1,durationUs:2_000_000,props:[{...p,physics:'kinematic',position:{y:[{t:0,v:1},{t:1,v:2}]}}]})!,/time offset/);
});

test('fading instances share geometry, compact opaque batches and restore colors after reverse seeks',()=>{
  const spec:SceneSpec={version:1,durationUs:2_000_000,geometries:{tri:{vertices:[[0,0,0],[1,0,0],[0,1,0]],faces:[[0,1,2]]}},
    props:['#ff0000','#00ff00','#0000ff'].map((color,i)=>({id:`i${i}`,model:'prop/instance',geometryId:'tri',color}))};
  const {objects,batches}=buildInstances(THREE,spec),scene=new THREE.Scene(),parent=new THREE.Group();
  scene.add(parent,batches[0].mesh);objects.forEach(o=>parent.add(o.root));
  const pose=(alphas:number[])=>{objects.forEach((o,i)=>setVisualState(o.root,true,alphas[i]));syncInstanceBatches(scene,batches);};
  pose([1,0.4,0]);assert.equal(batches[0].mesh.count,1);
  assert.equal(objects[1].root.visible,true);assert.equal(objects[1].root.material.opacity,0.4);
  assert.equal(objects[1].root.material.depthWrite,false);assert.equal(objectIsVisible(objects[2].root),false);
  assert.equal(new Set(objects.map(o=>o.root.geometry)).size,1);
  const faded=objects[1].root.material;
  pose([0,1,1]);assert.equal(batches[0].mesh.count,2);assert.equal(objects[1].root.visible,false);
  const color=new THREE.Color();batches[0].mesh.getColorAt(0,color);assert.equal(color.getHexString(),'00ff00');
  pose([1,0.4,0]);assert.equal(objects[1].root.material,faded);assert.equal(faded.opacity,0.4);
  setVisualState(parent,false,1);syncInstanceBatches(scene,batches);assert.equal(batches[0].mesh.count,0);assert.equal(objects[1].root.visible,false);
  setVisualState(parent,true,0.5);pose([1,1,1]);assert.equal(batches[0].mesh.count,0);
  objects.forEach(o=>assert.equal(o.root.material.opacity,0.5));
  setVisualState(parent,true,1);pose([1,1,1]);assert.equal(batches[0].mesh.count,3);
  assert.equal(visibleBounds(THREE,parent).max.x,1);
});

test('ordinary and imported materials multiply ancestor opacity without mutating shared sources',()=>{
  const scene=new THREE.Scene(),group=new THREE.Group(),a=new THREE.Group(),b=new THREE.Group();
  const source=new THREE.MeshStandardMaterial({opacity:0.8,transparent:true}),geometry=new THREE.BoxGeometry();
  const ma=new THREE.Mesh(geometry,source),mb=new THREE.Mesh(geometry,source);ma.castShadow=mb.castShadow=true;
  a.add(ma);b.add(mb);group.add(a,b);scene.add(group);
  setVisualState(group,true,1);setVisualState(a,true,1);setVisualState(b,true,1);
  const update=prepareVisualMeshes(scene,new Set());
  update();assert.equal(ma.material,source);assert.equal(mb.material,source);
  setVisualState(group,true,0.5);setVisualState(a,true,0.25);update();
  assert.equal(ma.material.opacity,0.1);assert.equal(mb.material.opacity,0.4);assert.equal(source.opacity,0.8);assert.equal(ma.castShadow,false);
  setVisualState(group,true,1);setVisualState(a,true,1);update();
  assert.equal(ma.material.opacity,0.8);assert.equal(ma.material.depthWrite,true);assert.equal(ma.castShadow,true);
  assert.notEqual(ma.material,mb.material);
});

test('instance animation edits reuse the stage while shared curve changes rebuild it',()=>{
  const spec={...base,props:[{...base.props![0],model:'prop/instance',geometryId:'g'}]};
  const edited=structuredClone(spec);edited.props[0].animation!.timeOffset=3;
  assert.equal(sceneStructureKey(spec),sceneStructureKey(edited));
  edited.curves!.grow.keys[1].t=3;
  assert.notEqual(sceneStructureKey(spec),sceneStructureKey(edited));
});
