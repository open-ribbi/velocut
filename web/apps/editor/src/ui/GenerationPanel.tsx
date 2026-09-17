import {readPath} from '@velocut/provider-sdk/declarative';
import {SchemaFields} from './SchemaFields';
import {declaredModel} from '../services/declarative-models';
import {useEffect,useState,useSyncExternalStore} from 'react';
import {generationManager,type GenerationJob} from '@velocut/runtime';
import type {GenerationRequest,GenerationSlot} from '@velocut/protocol';
import type {Store} from '../state/store';
import {Dialog} from './primitives/Dialog';
import {ModelSettings,ParameterFields} from './ModelSettings';
import {parameterDefaults,parameterFields,modelPreset,resolveVideoRequest} from '../services/model-config';
import {loadVideoGenConfig} from '../services/videogen';
const EMPTY={jobs:[],references:[]} as ReturnType<NonNullable<ReturnType<typeof generationManager>>['getSnapshot']>;
const noop=()=>()=>{};
const labels:Record<string,string>={queued:'Queued',preparing:'Preparing reference',submitting:'Submitting',submission_unknown:'Submission uncertain',running:'Generating',downloading:'Downloading',succeeded:'Ready',failed:'Failed',blocked:'Needs attention',cancelled:'Tracking stopped'};

function Preview({store,job}:{store:Store;job:GenerationJob}){
  const [url,setUrl]=useState('');
  useEffect(()=>{let disposed=false,created='';setUrl('');void generationManager(store)!.resultBlob(job.id).then(blob=>{created=URL.createObjectURL(blob);if(disposed)URL.revokeObjectURL(created);else setUrl(created);}).catch(()=>{});return()=>{disposed=true;if(created)URL.revokeObjectURL(created);};},[store,job.id]);
  return url?<video className="generation-preview" src={url} controls playsInline preload="metadata"/>:<p>Loading preview…</p>;
}
export function GenerationPanel({store,slotId,onSelect,onClose}:{store:Store;slotId:string|null;onSelect:(id:string|null)=>void;onClose:()=>void}){
  const state=useSyncExternalStore(store.subscribe,store.getState,store.getState),manager=generationManager(store);
  const data=useSyncExternalStore(manager?.subscribe??noop,manager?.getSnapshot??(()=>EMPTY),manager?.getSnapshot??(()=>EMPTY));
  const slot=state.doc.generationSlots?.find(s=>s.id===slotId);
  const [draft,setDraft]=useState<GenerationRequest>(slot?.request??{channel:'',model:'',prompt:''}),[start,setStart]=useState((slot?.startUs??0)/1e6),[duration,setDuration]=useState((slot?.durationUs??5e6)/1e6);
  const [base,setBase]=useState<GenerationSlot|undefined>(slot),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[preview,setPreview]=useState<string|null>(null),[settings,setSettings]=useState(false);
  const [channels,setChannels]=useState(()=>loadVideoGenConfig().channels);
  const reset=()=>{const s=store.getState().doc.generationSlots?.find(s=>s.id===slotId);setBase(s);setDraft(s?.request??{channel:'',model:'',prompt:''});setStart((s?.startUs??0)/1e6);setDuration((s?.durationUs??5e6)/1e6);setError(null);setPreview(null);};
  useEffect(reset,[slotId]);
  useEffect(()=>{const refresh=()=>setChannels(loadVideoGenConfig().channels);window.addEventListener('velocut-models-changed',refresh);return()=>window.removeEventListener('velocut-models-changed',refresh);},[]);
  const channel=channels.find(c=>c.id===draft.channel),cap=channel?.capabilities?.[draft.model];
  const definition=declaredModel(draft.channel)?.spec;
  const configured=channel?.modelSettings?.[draft.model],preset=modelPreset(configured?.presetId);
  const changeModel=(channelId:string,model:string)=>{const c=channels.find(c=>c.id===channelId),defaults=parameterDefaults(c?.modelSettings?.[model]),{ratio,resolution,generateAudio,...parameters}=defaults;setDraft({channel:channelId,model,prompt:draft.prompt,...(declaredModel(channelId)?{input:{}}:{}),...(typeof ratio==='string'?{ratio}:{}),...(typeof resolution==='string'?{resolution}:{}),...(typeof generateAudio==='boolean'?{generateAudio}:{}),parameters});};
  const selectedClip=state.doc.tracks.flatMap(t=>t.clips).find(c=>c.id===slot?.clipId);
  const explicitDuration=definition?.timeline?.duration?readPath(draft.input,definition.timeline.duration):undefined;
  const need=duration*(selectedClip?.speed??1),planned=typeof explicitDuration==='number'?explicitDuration:cap?.durationsS?[...cap.durationsS].sort((a,b)=>a-b).find(s=>s>=need):need;
  const jobs=data.jobs.filter(j=>!slotId||j.slotId===slotId).slice().reverse(),candidate=jobs.find(j=>j.id===preview);
  const api=async(opts:Record<string,unknown>)=>{if(!manager)throw Error('Generation is not configured');const r=await manager.execute(opts);if(!r.ok)throw Error(r.message);return r as any;};
  const perform=async(work:()=>Promise<void>)=>{setBusy(true);setError(null);try{await work();}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const save=()=>{
    const invalid=document.querySelector('.generation-dialog .schema-fields :invalid') as HTMLInputElement|null;if(invalid){invalid.reportValidity();throw Error('Fix the invalid model input before saving');}
    if(!slot||!base)throw Error('Slot no longer exists');const current=store.getState().doc.generationSlots?.find(s=>s.id===slot.id);
    if(!current||current.intentVersion!==base.intentVersion||current.startUs!==base.startUs||current.trackId!==base.trackId||current.durationUs!==base.durationUs)throw Error('This slot changed. Reload its settings before saving.');
    const r=store.dispatch({type:'updateGenerationSlot',slotId:slot.id,startUs:Math.round(start*1e6),durationUs:Math.round(duration*1e6),request:resolveVideoRequest(draft)});if(!r.ok)throw Error(r.error.message);
    const saved=store.getState().doc.generationSlots!.find(s=>s.id===slot.id)!;setBase(saved);return saved;
  };
  const capture=async(source:Record<string,unknown>)=>perform(async()=>{const r=await api({action:'captureReference',source,expectedRevision:store.getState().revision});setDraft(d=>{if(definition)return d;const kind=r.reference.kind??'image';if(kind==='image'&&preset?.references?.first!==false&&(!preset||preset.references?.first))return {...d,firstFrameReferenceId:r.reference.id};const key=kind==='video'?'referenceVideoIds':kind==='audio'?'referenceAudioIds':'referenceImageIds';return {...d,[key]:[...d[key]??[],r.reference.id]};});});
  return <Dialog open title={slot?'Generate video':'Generation jobs'} onClose={onClose} className="generation-dialog">
    <label className="prop-row"><span>Slot</span><select aria-label="Generation slot" value={slot?.id??''} onChange={e=>onSelect(e.target.value||null)}><option value="">All jobs</option>{(state.doc.generationSlots??[]).map(s=><option key={s.id} value={s.id}>{s.name} · {(s.startUs/1e6).toFixed(2)}s</option>)}</select></label>
    {slot&&<>
      <div className="generation-range"><label>Start (s)<input aria-label="Generation start" type="number" min={0} step={.1} value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label>Target duration (s)<input aria-label="Generation duration" type="number" min={.001} step={.1} value={duration} disabled={!!slot.clipId} onChange={e=>setDuration(Number(e.target.value))}/></label></div>
      {!definition&&<label>Prompt<textarea aria-label="Video generation prompt" rows={3} value={draft.prompt} onChange={e=>setDraft({...draft,prompt:e.target.value})} placeholder="Describe the shot, action and camera motion…"/></label>}
      <div className="generation-range"><label>Channel<select aria-label="Generation channel" value={draft.channel} onChange={e=>{const c=channels.find(c=>c.id===e.target.value);changeModel(e.target.value,c?.defaultModel??c?.models[0]??'');}}><option value="">Choose channel</option>{channels.map(c=><option key={c.id} value={c.id}>{c.label??c.id}</option>)}</select></label><label>Model<select aria-label="Generation model" value={draft.model} onChange={e=>changeModel(draft.channel,e.target.value)}><option value="">Choose model</option>{channel?.models.map(m=><option key={m} value={m}>{m}</option>)}</select></label></div>
      {!definition&&<div className="generation-range">{channel?.kind!=='minimax-video'&&<label>Aspect ratio<input aria-label="Generation ratio" list="generation-ratios" value={draft.ratio??''} onChange={e=>setDraft({...draft,ratio:e.target.value||undefined})}/><datalist id="generation-ratios">{(cap?.ratios??['16:9','9:16','1:1']).map(r=><option key={r} value={r}/>)}</datalist></label>}<label>Resolution<input aria-label="Generation resolution" list="generation-resolutions" value={draft.resolution??''} placeholder="Provider default" onChange={e=>setDraft({...draft,resolution:e.target.value||undefined})}/><datalist id="generation-resolutions">{(cap?.resolutions??[]).map(r=><option key={r} value={r}/>)}</datalist></label></div>}
      {!definition&&channel?.kind!=='minimax-video'&&<label>Audio<select aria-label="Generated audio" value={draft.generateAudio===undefined?"default":String(draft.generateAudio)} onChange={e=>setDraft({...draft,generateAudio:e.target.value==="default"?undefined:e.target.value==="true"})}><option value="default">Provider default</option><option value="false">Off</option><option value="true" disabled={cap?.audio===false}>Generate audio</option></select></label>}
      {definition&&<SchemaFields schema={definition.inputSchema} value={draft.input??{}} onChange={input=>setDraft({...draft,input})} references={data.references}/>}
      {configured&&<ParameterFields fields={parameterFields(configured)} values={{...Object.fromEntries(Object.entries(parameterDefaults(configured)).filter(([k])=>!['ratio','resolution','generateAudio'].includes(k))),...draft.parameters??{}}} onChange={parameters=>setDraft({...draft,parameters})}/>}
      <details><summary>Reference media</summary>{definition&&<p>Capture a reference, then select it in the model inputs above.</p>}
        {!definition&&(!preset||preset.references?.first)&&<label>Saved reference<select aria-label="Generation first frame" value={draft.firstFrameReferenceId??''} onChange={e=>setDraft({...draft,firstFrameReferenceId:e.target.value||undefined})}><option value="">Text only</option>{data.references.filter(r=>(r.kind??'image')==='image').map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
        <button disabled={busy||cap?.imageToVideo===false} onClick={()=>void capture({kind:'timeline',timeUs:store.getState().playheadUs})}>Capture current composite frame</button>
        <label>Snapshot imported media<select aria-label="Capture generation image" value="" disabled={busy||cap?.imageToVideo===false} onChange={e=>{if(e.target.value)void capture({kind:'asset',assetId:e.target.value});}}><option value="">Choose media to snapshot</option>{state.doc.assets.filter(a=>a.src.startsWith('opfs://')).map(a=><option key={a.id} value={a.id}>{a.name} · {a.kind}</option>)}</select></label>
        {!definition&&channel?.kind!=='minimax-video'&&(!preset||preset.references?.last)&&<label>Last frame<select aria-label="Generation last frame" value={draft.lastFrameReferenceId??''} onChange={e=>setDraft({...draft,lastFrameReferenceId:e.target.value||undefined})}><option value="">None</option>{data.references.filter(r=>(r.kind??'image')==='image').map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
        {!definition&&channel?.kind!=='minimax-video'&&(['image','video','audio'] as const).map(kind=>{const key=kind==='image'?'referenceImageIds':kind==='video'?'referenceVideoIds':'referenceAudioIds';return <fieldset key={kind}><legend>Reference {kind}s</legend><div className="generation-reference-list">{data.references.filter(r=>(r.kind??'image')===kind).map(r=><label key={r.id}><input type="checkbox" checked={draft[key]?.includes(r.id)??false} onChange={e=>setDraft({...draft,[key]:e.target.checked?[...draft[key]??[],r.id]:(draft[key]??[]).filter(id=>id!==r.id)})}/>{r.name}</label>)}</div></fieldset>;})}
        <p className="empty-hint">A captured reference is stored with this project. Generate uploads the selected snapshots to your configured storage for the provider.</p>
      </details>
      <p className="empty-hint">{planned===undefined?'Target is longer than this model supports.':`Request ${planned.toFixed(2)}s of source video for ${duration.toFixed(2)}s on the timeline${planned>need?'; keep the full result and trim on adoption':''}.`} {!cap?.durationsS&&'Duration constraints are not configured; the provider may reject this length.'} Generation uses your provider account; price is not estimated here.</p>
      <div className="dialog-actions"><button disabled={busy} onClick={()=>void perform(async()=>{save();})}>Save settings</button><button className="primary" disabled={busy||(!definition&&!draft.prompt.trim())||!draft.channel||!draft.model||planned===undefined} onClick={()=>void perform(async()=>{const s=save();const plan=await api({action:'plan',slotId:s.id});if(plan.providerDurationS!==planned)throw Error('Model constraints changed. Review the requested duration and generate again.');await api({action:'submit',slotId:s.id,intentVersion:s.intentVersion,requestId:'request_'+crypto.randomUUID()});})}>Generate video</button><button disabled={busy} onClick={reset}>Reload settings</button></div>
      <button disabled={busy} onClick={()=>{const r=store.dispatch({type:'removeGenerationSlot',slotId:slot.id});if(!r.ok)setError(r.error.message);else onSelect(null);}}>Remove generation intent</button>
    </>}
    {error&&<p className="scene-error" role="alert">{error}</p>}{data.error&&<p className="scene-error">{data.error}</p>}
    {candidate?.result&&<Preview store={store} job={candidate}/>}
    <div className="generation-jobs">{jobs.map(j=><article key={j.id} className="generation-job" data-job-id={j.id}>
      <strong>{labels[j.state]}</strong><p>{j.request.prompt}</p><small>{j.request.model} · requested {j.providerDurationS}s{j.result?` · received ${(j.result.durationUs/1e6).toFixed(2)}s`:''}{j.cost!==undefined?` · provider cost ${j.cost}`:''}</small>
      {j.error&&<p className="scene-error">{j.error}</p>}
      <div className="dialog-actions">
        {!['succeeded','failed','cancelled','blocked','submission_unknown'].includes(j.state)&&<button disabled={busy} onClick={()=>void perform(async()=>{await api({action:'cancel',jobId:j.id});})}>Stop tracking</button>}
        {['cancelled','blocked','submission_unknown','failed'].includes(j.state)&&<button disabled={busy||j.submissionStartedAt!==undefined&&!j.providerTaskId} onClick={()=>void perform(async()=>{await api({action:'resume',jobId:j.id});})}>{j.providerTaskId?'Resume tracking':'Resume queued generation'}</button>}
        {j.result&&<><button onClick={()=>setPreview(j.id)}>Preview result</button><button disabled={busy} onClick={()=>void perform(async()=>{await api({action:'registerResult',jobId:j.id,expectedRevision:store.getState().revision});})}>Keep in assets</button>
          {slot&&<><button disabled={busy||slot.selectedJobId===j.id} onClick={()=>void perform(async()=>{const s=store.getState().doc.generationSlots!.find(s=>s.id===slot.id)!;await api({action:'adopt',slotId:s.id,jobId:j.id,intentVersion:s.intentVersion,expectedRevision:store.getState().revision});reset();})}>Use for slot</button>
            {j.result.durationUs/(selectedClip?.speed??1)<slot.durationUs&&<button disabled={busy} onClick={()=>void perform(async()=>{const s=store.getState().doc.generationSlots!.find(s=>s.id===slot.id)!;await api({action:'adopt',slotId:s.id,jobId:j.id,intentVersion:s.intentVersion,expectedRevision:store.getState().revision,fit:'sourceDuration'});reset();})}>Use shorter result duration</button>}
            {j.intentVersion!==slot.intentVersion&&<button disabled={busy} onClick={()=>void perform(async()=>{const s=store.getState().doc.generationSlots!.find(s=>s.id===slot.id)!;await api({action:'adopt',slotId:s.id,jobId:j.id,intentVersion:s.intentVersion,expectedRevision:store.getState().revision,acceptEarlierIntent:true});reset();})}>Use earlier-intent result</button>}
          </>}
        </>}
      </div>
    </article>)}</div>
    {!jobs.length&&<p className="empty-hint">No generation jobs yet. Saving an intent does not call a provider.</p>}
    <button onClick={()=>{setSettings(!settings);setChannels(loadVideoGenConfig().channels);}}>Generation channel settings</button>
    {settings&&<><ModelSettings videoOnly/><button onClick={()=>{setChannels(loadVideoGenConfig().channels);setSettings(false);}}>Done configuring channels</button></>}
  </Dialog>;
}
