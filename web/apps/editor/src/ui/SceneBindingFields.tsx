import type {SceneSpec,SceneEdit,SceneBinding,BindingStatus} from '@velocut/scene-sdk';
import {JsonField} from './SceneModelFields';

export function SceneBindingFields({spec,objectId,statuses,onEdit}:{spec:SceneSpec;objectId:string;statuses:BindingStatus[];onEdit:(edits:SceneEdit[])=>unknown}) {
  const bindings=Object.entries(spec.bindings??{}).filter(([,b])=>b.target.objectId===objectId);
  if(!bindings.length)return null;
  return <details className="scene-actions">
    <summary>Bindings · {bindings.length}</summary>
    {bindings.map(([id,b])=>{
      const status=statuses.find(s=>s.id===id);
      return <div key={id}>
        <div className="group-title">{b.name??id} · {b.type}</div>
        <label><input type="checkbox" aria-label={`Enable binding ${id}`} checked={b.enabled!==false} onChange={e=>onEdit([{type:'binding.update',id,binding:{...b,enabled:e.target.checked}}])}/> Enabled</label>
        <p className={status?.status==='invalid'?'scene-error':'empty-hint'}>{status?.status??'Not evaluated'}{status?.message?`: ${status.message}`:''}</p>
        <JsonField label={`Binding ${id}`} value={b} onChange={binding=>onEdit([{type:'binding.update',id,binding:binding as SceneBinding}])}/>
        <button className="fx-add" onClick={()=>onEdit([{type:'binding.remove',id}])}>Remove binding {id}</button>
      </div>;
    })}
    <div className="empty-hint">Edit offset or twist to adjust the bound pose. Disabling a binding restores the authored pose. Motion uses a delta from referenceTimeS.</div>
  </details>;
}
