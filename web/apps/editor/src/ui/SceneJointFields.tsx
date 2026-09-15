import {useEffect,useRef,useState} from 'react';
import {JOINT_AXES,type SceneJoint,type JointEndpoint,type SceneSpec,type SceneEdit,type JointMotor} from '@velocut/scene-sdk';
import {NumberField} from './SceneFields';
import {readSceneSpatial} from '../services/scene';
import type {Store} from '../state/store';
type V=[number,number,number];
function Triple({label,value,onChange}:{label:string;value:V;onChange:(v:V)=>void}){
  return <div>{value.map((n,i)=><label className="prop-row" key={i}><span className="prop-label">{label} {'XYZ'[i]}</span><NumberField value={n} step={.1} onCommit={v=>{const next=[...value] as V;next[i]=v;onChange(next);}}/></label>)}</div>;
}
export function SceneJointFields({spec,objectId,store,assetId,timeS,onEdit,jointView,onView}:{spec:SceneSpec;objectId:string;store:Store;assetId:string;timeS:number;onEdit:(edits:SceneEdit[])=>unknown;jointView:string;onView:(v:'off'|'selected'|'all')=>void}){
  const props=(spec.props??[]).filter(p=>p.physics),related=Object.entries(spec.joints??{}).filter(([,j])=>j.a.objectId===objectId||j.b.objectId===objectId);
  const fresh=():SceneJoint=>({type:'fixed',a:{objectId,position:[0,0,0]},b:{objectId:props.find(p=>p.id!==objectId&&(typeof p.physics==='string'?p.physics:p.physics!.type)==='dynamic')?.id??props.find(p=>p.id!==objectId)?.id??objectId,position:[0,0,0]}});
  const [chosen,setChosen]=useState(''),[draft,setDraft]=useState<SceneJoint>(fresh),[report,setReport]=useState<string|null>(null),[busy,setBusy]=useState(false);
  const generation=useRef(0);
  useEffect(()=>{setChosen('');setDraft(fresh());},[objectId]);
  useEffect(()=>{generation.current++;setReport(null);setBusy(false);return()=>{generation.current++;};},[spec,objectId,chosen]);
  const existing=related.find(([id])=>id===chosen),joint=existing?.[1]??draft;
  const save=(j:SceneJoint)=>existing?onEdit([{type:'joint.update',id:existing[0],joint:j}]):setDraft(j);
  const changeType=(type:SceneJoint['type'])=>{
    const common={a:joint.a,b:joint.b,enabled:joint.enabled,name:joint.name,contactsEnabled:joint.contactsEnabled};
    const j:SceneJoint=type==='fixed'||type==='spherical'?{...common,type}:type==='rope'?{...common,type,length:1}:type==='spring'?{...common,type,length:1,stiffness:100,damping:10}:type==='generic'?{...common,type,axis:[1,0,0],lockedAxes:['x','y','z']}:{...common,type,axis:[1,0,0]};save(j);
  };
  const inspect=async()=>{
    if(!existing)return;const request=++generation.current;setBusy(true);
    try{const r=await readSceneSpatial(store,{assetId,timeS,expectedRevision:store.getState().revision,queries:[{type:'joints',ids:[existing[0]]}]});if(request!==generation.current)return;
      if(!r.ok){setReport(r.message);return;}const result=r.results[0];if(result.type==='joints'){const s=result.items[0];setReport(`${s.status} · ${r.timeS.toFixed(2)}s · anchor separation ${s.anchorDistanceM.toFixed(5)} m${s.coordinate===null?'':` · coordinate ${s.coordinate.toFixed(4)} ${s.unit}`}${s.linearErrorM===null?'':` · linear error ${s.linearErrorM.toFixed(5)} m`}${s.angularErrorDeg===null?'':` · angular error ${s.angularErrorDeg.toFixed(3)}°`}`);}
    }finally{if(request===generation.current)setBusy(false);}
  };
  const endpoint=(key:'a'|'b')=>{
    const e=joint[key],p=props.find(p=>p.id===e.objectId),set=(value:JointEndpoint)=>save({...joint,[key]:value});
    return <details><summary>Endpoint {key.toUpperCase()}</summary>
      <label className="prop-row"><span className="prop-label">Body {key.toUpperCase()}</span><select aria-label={`Joint body ${key.toUpperCase()}`} value={e.objectId} onChange={ev=>set({objectId:ev.target.value,position:[0,0,0]})}>{props.map(p=><option key={p.id} value={p.id}>{p.name??p.id}</option>)}</select></label>
      <label className="prop-row"><span className="prop-label">Anchor</span><select aria-label={`Joint anchor ${key.toUpperCase()}`} value={e.anchorId??''} onChange={ev=>set(ev.target.value?{objectId:e.objectId,anchorId:ev.target.value}:{objectId:e.objectId,position:[0,0,0]})}><option value="">Explicit local point</option>{Object.entries(p?.anchors??{}).filter(([,a])=>a.kind!=='surface').map(([id])=><option key={id} value={id}>{id}</option>)}</select></label>
      {e.position&&<Triple label={`Point ${key.toUpperCase()} (m)`} value={e.position} onChange={position=>set({objectId:e.objectId,position})}/>}
    </details>;
  };
  const motorFields=(j:Extract<SceneJoint,{type:'revolute'|'prismatic'}>)=>{
    const m=j.motor,unit=j.type==='revolute'?'°':'m',set=(motor:JointMotor|undefined)=>save({...j,motor});
    return <details><summary>Motor</summary>
      <label className="prop-row"><span className="prop-label">Drive</span><select aria-label="Joint motor" value={m?.mode??'off'} onChange={e=>set(e.target.value==='off'?undefined:e.target.value==='velocity'?{mode:'velocity',targetVelocity:0,damping:10}:{mode:'position',targetPosition:Math.max(j.limits?.[0]??0,Math.min(j.limits?.[1]??0,0)),stiffness:100,damping:10})}><option value="off">Off</option><option value="position">Position</option><option value="velocity">Velocity</option></select></label>
      {m&&<>
        <label className="prop-row"><span className="prop-label">Target ({unit}{m.mode==='velocity'?'/s':''})</span><NumberField value={m.mode==='position'?m.targetPosition:m.targetVelocity} step={.1} onCommit={v=>set(m.mode==='position'?{...m,targetPosition:v}:{...m,targetVelocity:v})}/></label>
        {m.mode==='position'&&<label className="prop-row"><span className="prop-label">Stiffness</span><NumberField value={m.stiffness} min={.000001} onCommit={stiffness=>set({...m,stiffness})}/></label>}
        <label className="prop-row"><span className="prop-label">Damping</span><NumberField value={m.damping} min={0} onCommit={damping=>set({...m,damping})}/></label>
        <label className="prop-row"><span className="prop-label">Motor model</span><select aria-label="Joint motor model" value={m.model??'force'} onChange={e=>set({...m,model:e.target.value as 'force'|'acceleration'})}><option value="force">Force</option><option value="acceleration">Acceleration</option></select></label>
      </>}
    </details>;
  };
  return <details className="scene-actions"><summary>Physics joints · {related.length}</summary>
    <label className="prop-row"><span className="prop-label">Joint</span><select aria-label="Selected physics joint" value={existing?.[0]??''} onChange={e=>{setChosen(e.target.value);setReport(null);}}><option value="">New joint…</option>{related.map(([id,j])=><option key={id} value={id}>{j.name??id}</option>)}</select></label>
    <label className="prop-row"><span className="prop-label">Type</span><select aria-label="Physics joint type" value={joint.type} onChange={e=>changeType(e.target.value as SceneJoint['type'])}>{['fixed','spherical','revolute','prismatic','spring','rope','generic'].map(t=><option key={t} value={t}>{t}</option>)}</select></label>
    <label><input aria-label="Enable physics joint" type="checkbox" checked={joint.enabled!==false} onChange={e=>save({...joint,enabled:e.target.checked})}/> Enabled</label>
    <label><input aria-label="Joint contacts" type="checkbox" checked={joint.contactsEnabled??false} onChange={e=>save({...joint,contactsEnabled:e.target.checked})}/> Collisions between connected bodies</label>
    {endpoint('a')}{endpoint('b')}
    {'axis' in joint&&<details><summary>Joint axis</summary><Triple label="Local axis" value={joint.axis} onChange={axis=>save({...joint,axis})}/><p className="empty-hint">This direction is used in each body's local rotation frame. It does not inherit object scale.</p></details>}
    {joint.type==='fixed'&&<details><summary>Local reference frames</summary>{(['rotationA','rotationB'] as const).map(k=><Triple key={k} label={`${k} (°)`} value={joint[k]??[0,0,0]} onChange={r=>save({...joint,[k]:r})}/>)}</details>}
    {(joint.type==='revolute'||joint.type==='prismatic')&&<>
      <label><input aria-label="Joint limits" type="checkbox" checked={!!joint.limits} onChange={e=>save({...joint,limits:e.target.checked?joint.type==='revolute'?[-90,90]:[-1,1]:undefined})}/> Limits ({joint.type==='revolute'?'degrees':'meters'})</label>
      {joint.limits&&joint.limits.map((v,i)=><label className="prop-row" key={i}><span className="prop-label">{i?'Maximum':'Minimum'}</span><NumberField value={v} step={.1} onCommit={n=>{const limits=[...joint.limits!] as [number,number];limits[i]=n;save({...joint,limits});}}/></label>)}
      {motorFields(joint)}
    </>}
    {(joint.type==='rope'||joint.type==='spring')&&<label className="prop-row"><span className="prop-label">{joint.type==='rope'?'Max length':'Rest length'} (m)</span><NumberField value={joint.length} min={0} step={.1} onCommit={length=>save({...joint,length})}/></label>}
    {joint.type==='spring'&&(['stiffness','damping'] as const).map(k=><label key={k} className="prop-row"><span className="prop-label">{k}</span><NumberField value={joint[k]} min={k==='stiffness'?.000001:0} onCommit={v=>save({...joint,[k]:v})}/></label>)}
    {joint.type==='generic'&&<div>Locked axes {JOINT_AXES.map(axis=><label key={axis}><input type="checkbox" checked={joint.lockedAxes.includes(axis)} onChange={e=>save({...joint,lockedAxes:e.target.checked?[...joint.lockedAxes,axis]:joint.lockedAxes.filter(a=>a!==axis)})}/>{axis}</label>)}</div>}
    {!existing?<button className="fx-add" disabled={props.length<2} onClick={()=>{let n=1;while(Object.hasOwn(spec.joints??{},`joint_${n}`))n++;const id=`joint_${n}`;onEdit([{type:'joint.create',id,joint:draft}]);setChosen(id);}}>Create joint</button>:<div className="prop-row"><button onClick={()=>onEdit([{type:'joint.remove',id:existing[0]}])}>Remove joint</button><button disabled={busy} onClick={()=>void inspect()}>Inspect joint</button></div>}
    <label className="prop-row"><span className="prop-label">Joint guides</span><select aria-label="Joint guides" value={jointView} onChange={e=>onView(e.target.value as 'off'|'selected'|'all')}><option value="off">Off</option><option value="selected">Selected body</option><option value="all">All joints</option></select></label>
    {report&&<p className="empty-hint">{report}</p>}
    <p className="empty-hint">Joint rules participate in simulation. Initial gaps or frame mismatches can move bodies when solving. Measurements are geometric residuals, not load or strength tests.</p>
  </details>;
}
