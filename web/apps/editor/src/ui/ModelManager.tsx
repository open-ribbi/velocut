import {SchemaFields} from './SchemaFields';
import {declaredModel} from '../services/declarative-models';
import type {JsonObject} from '@velocut/provider-sdk';
import {DeclarativeModels} from './DeclarativeModels';
import {UploadSettings} from './AgentConsole';
import {useEffect,useRef,useState} from 'react';
import type {MediaLibrary} from '@velocut/render-sdk';
import type {Store} from '../state/store';
import {ModelSettings,ParameterFields} from './ModelSettings';
import {loadAudioChannels,parameterDefaults,parameterFields,generateConfiguredAudio,chooseNarration,audioGenerationRecords,audioGenerationFile,keepGeneratedAudio,type AudioGenerationRecord} from '../services/model-config';
export function ModelManager({store,media}:{store:Store;media:MediaLibrary}){
 const [input,setInput]=useState<JsonObject>({});
 const [records,setRecords]=useState<AudioGenerationRecord[]>([]);
 const [channels,setChannels]=useState(loadAudioChannels),[channelId,setChannelId]=useState(''),[model,setModel]=useState(''),[text,setText]=useState(''),[lyrics,setLyrics]=useState(''),[parameters,setParameters]=useState<Record<string,string|number|boolean>>({}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[file,setFile]=useState<File|null>(null),[url,setUrl]=useState('');const controller=useRef<AbortController|null>(null);
 useEffect(()=>{const refresh=()=>void audioGenerationRecords().then(setRecords).catch(()=>{});refresh();window.addEventListener('velocut-audio-generation',refresh);return()=>window.removeEventListener('velocut-audio-generation',refresh);},[]);
 useEffect(()=>{const refresh=()=>setChannels(loadAudioChannels());window.addEventListener('velocut-models-changed',refresh);return()=>{window.removeEventListener('velocut-models-changed',refresh);controller.current?.abort();};},[]);
 useEffect(()=>{if(!file){setUrl('');return;}const src=URL.createObjectURL(file);setUrl(src);return()=>URL.revokeObjectURL(src);},[file]);
 const channel=channels.find(c=>c.id===channelId),settings=channel?.modelSettings?.[model],music=channel?.kind==='minimax-music',definition=declaredModel(channelId)?.spec;
 return <><DeclarativeModels/><ModelSettings/><details><summary>Reference media storage</summary><UploadSettings/></details><section className="model-audio"><h3>Generate audio</h3><p>Preview narration or music with a configured model. Generate uses your service credits.</p>
 <div className="generation-range"><label>Audio channel<select aria-label="Audio channel" disabled={busy} value={channelId} onChange={e=>{const c=channels.find(c=>c.id===e.target.value);setChannelId(e.target.value);setModel(c?.defaultModel??c?.models[0]??'');setParameters({});setInput({});setFile(null);}}><option value="">Choose channel</option>{channels.map(c=><option key={c.id} value={c.id}>{c.label??c.id}</option>)}</select></label><label>Audio model<select aria-label="Audio model" disabled={busy} value={model} onChange={e=>{setModel(e.target.value);setParameters({});}}>{channel?.models.map(m=><option key={m}>{m}</option>)}</select></label></div>
 {!definition&&<label>{music?'Music prompt':'Narration text'}<textarea aria-label="Audio prompt" rows={3} value={text} disabled={busy} onChange={e=>setText(e.target.value)}/></label>}
 {music&&<label>Lyrics<textarea aria-label="Song lyrics" rows={5} value={lyrics} disabled={busy} onChange={e=>setLyrics(e.target.value)}/></label>}
 {definition&&<SchemaFields schema={definition.inputSchema} value={input} onChange={setInput} prefix="Audio input"/>}
 {channel&&!definition&&<ParameterFields prefix="Audio" fields={parameterFields(settings)} values={{...parameterDefaults(settings),...parameters}} disabled={busy} onChange={setParameters}/>}
 <div className="dialog-actions"><button className="primary" disabled={busy||!channel||!model||(!definition&&!(music?lyrics.trim():text.trim()))} onClick={async()=>{const abort=new AbortController();controller.current=abort;setBusy(true);setError('');setNotice('');setFile(null);try{setFile(await generateConfiguredAudio(channelId,model,text,lyrics,parameters,abort.signal,input));}catch(e){setError(abort.signal.aborted?'Local request stopped; the service may still complete it. No automatic retry.':String(e instanceof Error?e.message:e));}finally{setBusy(false);controller.current=null;}}}>{busy?'Generating…':'Generate audio'}</button>{busy&&<button onClick={()=>controller.current?.abort()}>Stop waiting</button>}{channel?.kind==='minimax-speech'&&<button onClick={()=>{chooseNarration(channel,model);setNotice('Selected for narration calls.');}}>Use for narration</button>}</div>
 {records.length>0&&<details><summary>Audio generation history</summary>{records.slice().reverse().map(r=><div key={r.id} className="model-channel"><span>{r.model} · {new Date(r.createdAt).toLocaleTimeString()} · {r.state==='submitting'?'Awaiting a recorded response; may still be active':r.state}{r.error&&<small>{r.error}</small>}</span>{r.state==='succeeded'&&<button onClick={()=>void audioGenerationFile(r).then(setFile).catch(e=>setError(String(e.message)))}>Preview saved audio</button>}</div>)}</details>}
 {url&&<audio src={url} controls preload="metadata"/>}{file&&<button disabled={busy} onClick={async()=>{setBusy(true);try{await keepGeneratedAudio(store,media,file);setNotice('Audio saved in project assets.');setFile(null);}catch(e){setError(String(e instanceof Error?e.message:e));}finally{setBusy(false);}}}>Keep audio in assets</button>}
 {error&&<p role="alert" className="scene-error">{error}</p>}{notice&&<p role="status">{notice}</p>}</section></>;
}
