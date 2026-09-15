import {useEffect,useRef,useState} from 'react';
import {colliderDefinitions,type SceneProp,type SceneSpec,type SceneEdit,type SceneCollider} from '@velocut/scene-sdk';
import {NumberField} from './SceneFields';
import {readSceneSpatial} from '../services/scene';
import type {Store} from '../state/store';

export function ScenePhysicsFields({value,spec,assetId,store,timeS,onEdit,colliderView,onView}:{value:SceneProp;spec:SceneSpec;assetId:string;store:Store;timeS:number;onEdit:(edits:SceneEdit[])=>unknown;colliderView:string;onView:(view:'off'|'selected'|'all')=>void}) {
  const physics=typeof value.physics==='string'?{type:value.physics}:value.physics;
  const defs=colliderDefinitions(value),ids=Object.keys(defs);
  const [chosen,setChosen]=useState('default'),[report,setReport]=useState<string[]|null>(null),[busy,setBusy]=useState(false);
  const selected=Object.hasOwn(defs,chosen)?chosen:ids[0],collider=defs[selected];
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setReport(null);setBusy(false);return()=>{generation.current++;};},[value]);
  const update=(c:SceneCollider)=>onEdit([{type:'collider.update',id:value.id!,colliderId:selected,collider:c}]);
  const setShape=(shape:SceneCollider['shape'])=>{
    const common={name:collider.name,...(collider.shape!=='auto'?{position:collider.position,rotation:collider.rotation}:{})};
    update(shape==='auto'?{shape,name:collider.name}:shape==='box'?{...common,shape,halfExtents:[.5,.5,.5]}:shape==='sphere'?{...common,shape,radius:.5}:{...common,shape,...('geometryId' in collider?{geometryId:collider.geometryId}:{})});
  };
  const inspect=async()=>{
    const request=++generation.current;setBusy(true);
    try{
      const r=await readSceneSpatial(store,{assetId,timeS,expectedRevision:store.getState().revision,queries:[{type:'colliders',objectIds:[value.id!]}]});
      if(request!==generation.current)return;
      if(!r.ok){setReport([r.message]);return;}
      const result=r.results[0];if(result.type==='colliders')setReport(result.items.map(c=>`${c.colliderId}: ${c.effectiveShape}, ${c.triangleCount} triangles, ${c.mass.toFixed(3)} kg${c.warning?' · '+c.warning:''}`));
    }finally{if(request===generation.current)setBusy(false);}
  };
  return <details className="scene-actions"><summary>Physics & colliders</summary>
    <label className="prop-row"><span className="prop-label">Body</span><select aria-label="Physics body" value={physics?.type??'off'} disabled={value.model==='prop/instance'} onChange={e=>onEdit([e.target.value==='off'?{type:'update',id:value.id!,patch:{},clear:['physics']}:{type:'update',id:value.id!,patch:{physics:{...physics,type:e.target.value as 'fixed'|'dynamic'|'kinematic'}}}])}>
      <option value="off">Off</option><option value="fixed">Fixed</option><option value="dynamic">Dynamic</option><option value="kinematic">Kinematic</option>
    </select></label>
    {value.model==='prop/instance'&&<p className="empty-hint">Make geometry unique to enable physics.</p>}
    {physics&&<>
      <label><input type="checkbox" checked={physics.mass!==undefined} onChange={e=>onEdit([{type:'update',id:value.id!,patch:{physics:{...physics,mass:e.target.checked?1:undefined}}}])}/> Custom body mass</label>
      {(['mass','friction','restitution'] as const).filter(k=>k!=='mass'||physics.mass!==undefined).map(k=><label className="prop-row" key={k}><span className="prop-label">{k==='mass'?'Body mass (kg)':k}</span><NumberField value={physics[k]??(k==='friction'?.6:.3)} min={k==='mass'?.000001:0} max={k==='restitution'?1:undefined} step={.1} onCommit={v=>onEdit([{type:'update',id:value.id!,patch:{physics:{...physics,[k]:v}}}])}/></label>)}
      <p className="empty-hint">{physics.mass===undefined?'Mass is derived from collider volume.':'Mass is shared across all collider parts.'} {ids.length} colliders on one rigid body.</p>
      <label className="prop-row"><span className="prop-label">Wireframe</span><select aria-label="Collider wireframe" value={colliderView} onChange={e=>onView(e.target.value as 'off'|'selected'|'all')}><option value="off">Off</option><option value="selected">Selected body</option><option value="all">All bodies</option></select></label>
      <label className="prop-row"><span className="prop-label">Collider</span><select aria-label="Selected collider" value={selected??''} onChange={e=>setChosen(e.target.value)}>{ids.map(id=><option key={id} value={id}>{id}</option>)}{!ids.length&&<option value="">No colliders</option>}</select></label>
      <div className="prop-row"><button onClick={()=>{let n=1;while(Object.hasOwn(defs,`collider_${n}`))n++;const id=`collider_${n}`;setChosen(id);onEdit([{type:'collider.create',id:value.id!,colliderId:id,collider:{shape:'box',halfExtents:[.5,.5,.5]}}]);}}>Add box collider</button><button disabled={!collider} onClick={()=>onEdit([{type:'collider.remove',id:value.id!,colliderId:selected}])}>Remove collider</button></div>
      {collider&&<>
        <label className="prop-row"><span className="prop-label">Shape</span><select aria-label="Collider shape" value={collider.shape} onChange={e=>setShape(e.target.value as SceneCollider['shape'])}><option value="auto">Automatic</option><option value="box">Box</option><option value="sphere">Sphere</option><option value="convexHull">Convex hull</option><option value="mesh" disabled={physics.type==='dynamic'}>Triangle mesh</option></select></label>
        {collider.shape==='box'&&collider.halfExtents.map((v,i)=><label key={i} className="prop-row"><span className="prop-label">Half extent {'XYZ'[i]}</span><NumberField value={v} min={.000001} step={.05} onCommit={n=>{const h=[...collider.halfExtents] as [number,number,number];h[i]=n;update({...collider,halfExtents:h});}}/></label>)}
        {collider.shape==='sphere'&&<label className="prop-row"><span className="prop-label">Radius</span><NumberField value={collider.radius} min={.000001} step={.05} onCommit={radius=>update({...collider,radius})}/></label>}
        {(collider.shape==='mesh'||collider.shape==='convexHull')&&<label className="prop-row"><span className="prop-label">Source geometry</span><select aria-label="Collider source geometry" value={collider.geometryId??''} onChange={e=>update({...collider,geometryId:e.target.value||undefined})}><option value="">Visual mesh</option>{[...Object.keys(spec.geometries??{}),...Object.keys(spec.geometryResources??{})].map(id=><option key={id} value={id}>{id}</option>)}</select></label>}
        {collider.shape!=='auto'&&<details><summary>Collider offset & rotation</summary>{(['position','rotation'] as const).map(k=><div key={k}>{[0,1,2].map(i=><label className="prop-row" key={i}><span className="prop-label">{k==='position'?'Offset (m)':'Rotation (°)'} {'XYZ'[i]}</span><NumberField value={collider[k]?.[i]??0} step={k==='position'?.05:1} onCommit={v=>{const xyz=[...(collider[k]??[0,0,0])] as [number,number,number];xyz[i]=v;update({...collider,[k]:xyz});}}/></label>)}</div>)}</details>}
      </>}
      <div className="prop-row"><button onClick={()=>onEdit([{type:'collider.reset',id:value.id!}])}>Reset automatic collider</button><button disabled={busy} onClick={()=>void inspect()}>Inspect colliders</button></div>
      {report?.map((line,i)=><p className="empty-hint" key={i}>{line}</p>)}
      {!ids.length&&<p className="empty-hint">Collision is disabled for this body.</p>}
      <p className="empty-hint">Automatic static meshes keep holes. Dynamic meshes use a convex hull; use several convex parts to preserve cavities. Meshes describe boundaries, not solid interiors.</p>
    </>}
  </details>;
}
