import {useEffect,useRef,useState} from 'react';
import {sceneObjects,type SceneSpec} from '@velocut/scene-sdk';
import {readSceneSpatial,editScene} from '../services/scene';
import type {Store} from '../state/store';

type Success=Extract<Awaited<ReturnType<typeof readSceneSpatial>>,{ok:true}>;
type Repair=Extract<Success['results'][number],{type:'anchorRepair'}>;
const PAGE_SIZE=20;

export function SceneAnchorRepairs({store,assetId,objectId,timeS,specText}:{store:Store;assetId:string;objectId:string;timeS:number;specText:string|undefined}) {
  const [scope,setScope]=useState<'invalid'|'all'>('invalid');
  const [preview,setPreview]=useState<{revision:number;timeS:number;items:Repair[]}|null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set()),[page,setPage]=useState(0);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null);
  const generation=useRef(0);
  useEffect(()=>{generation.current++;setPreview(null);setSelected(new Set());setError(null);setBusy(false);return()=>{generation.current++;};},[assetId,objectId,specText]);
  const runPreview=async()=>{
    const request=++generation.current;setBusy(true);setError(null);setPreview(null);
    try{
      const state=store.getState(),asset=state.doc.assets.find(a=>a.id===assetId);
      if(!asset?.spec||asset.spec!==specText)throw Error('Scene changed; preview again.');
      const spec=JSON.parse(asset.spec!) as SceneSpec,object=sceneObjects(spec).find(e=>e.object.id===objectId)?.object;
      const ids=Object.entries(object?.anchors??{}).filter(([,a])=>a.kind==='surface').map(([id])=>id);
      if(!ids.length)throw Error('This object has no surface anchors.');
      const r=await readSceneSpatial(store,{assetId,timeS,expectedRevision:state.revision,queries:ids.map(anchorId=>({type:'anchorRepair' as const,objectId,anchorId,method:'face' as const}))});
      if(!r.ok)throw Error(r.message);if(request!==generation.current)return;
      const items=r.results.filter((r):r is Repair=>r.type==='anchorRepair').filter(r=>scope==='all'||r.currentStatus==='invalid');
      setPreview({revision:r.revision,timeS:r.timeS,items});setPage(0);
      setSelected(new Set(items.filter(r=>r.candidate&&r.candidate.orientationChanged===false).map(r=>r.anchorId)));
    }catch(e){if(request===generation.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(request===generation.current)setBusy(false);}
  };
  const apply=async()=>{
    if(!preview)return;const request=++generation.current;setBusy(true);setError(null);
    try{
      const edits=preview.items.flatMap(r=>selected.has(r.anchorId)&&r.candidate?[r.candidate.edit]:[]);
      if(!edits.length)return;
      const r=await editScene(store,{assetId,expectedRevision:preview.revision,edits,includeSpec:false});
      if(!r.ok)throw Error(r.message);if(request!==generation.current)return;
      setPreview(null);setSelected(new Set());
    }catch(e){if(request===generation.current)setError(e instanceof Error?e.message:String(e));}
    finally{if(request===generation.current)setBusy(false);}
  };
  const pages=preview?Math.max(1,Math.ceil(preview.items.length/PAGE_SIZE)):1;
  return <div>
    <label className="prop-row"><span className="prop-label">Repair scope</span><select aria-label="Anchor repair scope" value={scope} disabled={busy} onChange={e=>{setScope(e.target.value as typeof scope);setPreview(null);}}>
      <option value="invalid">Invalid surface anchors</option><option value="all">All surface anchors / upgrade</option>
    </select></label>
    <button className="fx-add" disabled={busy} onClick={()=>void runPreview()}>Preview face repairs</button>
    {preview&&<>
      <p className="empty-hint">{preview.items.length} results · {preview.timeS.toFixed(2)}s · revision {preview.revision}</p>
      {!preview.items.length&&<p className="empty-hint">No matching surface anchors.</p>}
      {preview.items.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).map(r=><div key={r.anchorId}>
        <label><input type="checkbox" aria-label={`Use repair ${r.anchorId}`} disabled={busy||!r.candidate} checked={selected.has(r.anchorId)} onChange={e=>setSelected(before=>{const next=new Set(before);if(e.target.checked)next.add(r.anchorId);else next.delete(r.anchorId);return next;})}/> {r.anchorId}</label>
        <p className={r.candidate?.orientationChanged||!r.candidate?'scene-error':'empty-hint'}>{r.message??'Candidate ready'}</p>
        {r.candidate&&<p className="empty-hint">Position [{r.candidate.position.map(v=>v.toFixed(5)).join(', ')}] · Normal [{r.candidate.normal?.map(v=>v.toFixed(4)).join(', ')}] · Tangent [{r.candidate.tangent?.map(v=>v.toFixed(4)).join(', ')}]</p>}
      </div>)}
      {pages>1&&<div className="prop-row"><button disabled={page===0} onClick={()=>setPage(page-1)}>Previous</button><span>{page+1} / {pages}</span><button disabled={page+1>=pages} onClick={()=>setPage(page+1)}>Next</button></div>}
      <div className="prop-row"><button disabled={busy} onClick={()=>setSelected(new Set())}>Clear selection</button><button disabled={busy} onClick={()=>setSelected(new Set(preview.items.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE).filter(r=>r.candidate&&r.candidate.orientationChanged===false).map(r=>r.anchorId)))}>Select safe page</button></div>
      <button className="fx-add" disabled={busy||selected.size===0||selected.size>500} onClick={()=>void apply()}>Apply selected repairs ({selected.size})</button>
      {selected.size>500&&<p className="scene-error">The edit API accepts 500 operations per atomic commit. Select a smaller batch.</p>}
      <p className="empty-hint">Orientation changes are not preselected. Inspect the proposed frame. Other topology changes need an explicit surface resample.</p>
    </>}
    {error&&<p className="scene-error">{error}</p>}
  </div>;
}
