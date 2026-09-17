import {resolveDeclaredRequest,declarativeAudioChannels,declaredModel,executeDeclaredAudio} from './declarative-models';
import type {Store} from '../state/store';
import type {MediaLibrary} from '@velocut/render-sdk';
import {kvGet,kvPut,saveMedia,loadMedia} from '@velocut/collab-sdk';
import {activeProject,activeStorage} from './projects';
import type {JsonObject} from '@velocut/provider-sdk';
import {BUILTIN_PROTOCOLS,builtinModelSpec,configurePresetModel} from '@velocut/provider-sdk/presets';
import {modelInput} from '@velocut/provider-sdk/declarative';
import {MODEL_PRESETS,modelPreset,parameterDefaults,parameterFields,validateParameters} from '@velocut/provider-sdk/catalog';
import type {GenerationRequest} from '@velocut/protocol';
import {createVideoGen,videoGenProviders} from '@velocut/render-sdk';
import {loadVideoGenConfig,saveVideoGenConfig,type VideoGenChannel} from './videogen';
export {MODEL_PRESETS,modelPreset,parameterDefaults,parameterFields};
export type ModelChannel=VideoGenChannel;
export const AUDIO_PROTOCOLS=['minimax-speech','minimax-music'];
export const modelProtocols=()=>[...videoGenProviders().map(p=>({id:p.id,label:p.label,kind:'video'})),{id:'minimax-speech',label:'MiniMax Speech API',kind:'speech'},{id:'minimax-music',label:'MiniMax Music API',kind:'music'}];
export function loadAudioChannels():ModelChannel[]{try{const x=JSON.parse(localStorage.getItem('velocut.audiogen')??'[]');return [...declarativeAudioChannels(),...(Array.isArray(x)?x.filter(c=>c&&typeof c.id==='string'&&AUDIO_PROTOCOLS.includes(c.kind)&&Array.isArray(c.models)):[])];}catch{return declarativeAudioChannels();}}
export function allModelChannels(){return [...loadVideoGenConfig().channels.filter(c=>c.kind!=='declarative-http'),...loadAudioChannels().filter(c=>c.kind!=='declarative-audio')];}
export function validateChannel(c:ModelChannel){
 if(c.kind==='declarative-audio'&&declaredModel(c.id))return;
 if(!c.id.trim()||!c.apiKey.trim())throw Error('Channel name and API Token are required');const url=new URL(c.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||url.search)throw Error('Base URL must be HTTP(S), without embedded credentials, query or fragment');
 if(!modelProtocols().some(p=>p.id===c.kind)||!c.models.length||c.models.some(m=>!m.trim()))throw Error('Select a protocol and model ID');
 for(const [model,settings] of Object.entries(c.modelSettings??{})){if(!c.models.includes(model))continue;const preset=modelPreset(settings.presetId);if(settings.presetId&&!preset)throw Error('Unknown model preset');if(preset&&preset.protocol!==c.kind)throw Error('Preset and protocol do not match');const defs=parameterFields(settings),defaults=parameterDefaults(settings);const extras=Object.fromEntries(Object.entries(defaults).filter(([k])=>!['ratio','resolution','generateAudio'].includes(k)));validateParameters(extras,defs);}
}
export function saveModelChannels(channels:ModelChannel[]){for(const c of channels)validateChannel(c);if(new Set(channels.map(c=>c.id)).size!==channels.length)throw Error('Channel names must be unique');saveVideoGenConfig({channels:channels.filter(c=>!AUDIO_PROTOCOLS.includes(c.kind))});localStorage.setItem('velocut.audiogen',JSON.stringify(channels.filter(c=>AUDIO_PROTOCOLS.includes(c.kind))));window.dispatchEvent(new Event('velocut-models-changed'));}
export function videoProvider(c:ModelChannel,model:string){return createVideoGen(c.kind,{baseUrl:c.baseUrl,apiKey:c.apiKey,modelSettings:c.modelSettings?.[model]?{...c.modelSettings[model],...(c.capabilities?.[model]?{capabilities:c.capabilities[model]}:{})}:undefined});}
export function resolveVideoRequest(request:GenerationRequest):GenerationRequest {
 if(loadVideoGenConfig().channels.find(c=>c.id===request.channel)?.kind==='declarative-http')return resolveDeclaredRequest(request);
 const c=loadVideoGenConfig().channels.find(c=>c.id===request.channel);if(!c)return request;const defaults=parameterDefaults(c.modelSettings?.[request.model]);const {ratio,resolution,generateAudio,...parameters}=defaults;
 return {...(typeof ratio==='string'?{ratio}:{}),...(typeof resolution==='string'?{resolution}:{}),...(typeof generateAudio==='boolean'?{generateAudio}:{}),...request,...(Object.keys(parameters).length||request.parameters?{parameters:{...parameters,...request.parameters}}:{})};
}
export function validateConfiguredVideo(request:GenerationRequest,durationS:number){
 const c=loadVideoGenConfig().channels.find(c=>c.id===request.channel);if(!c)throw Error('Unknown model channel');if(c.kind==='declarative-http'||!BUILTIN_PROTOCOLS[c.kind])return;
 const {channel:_channel,model:_model,modelRevision:_revision,input:_input,...values}=request;
 modelInput(builtinModelSpec(c.kind,request.model,{...c.modelSettings?.[request.model],...(c.capabilities?.[request.model]?{capabilities:c.capabilities[request.model]}:{})}),{...values,durationS});
}
export interface AudioGenerationRecord {id:string;channelId:string;model:string;state:'submitting'|'succeeded'|'unknown'|'failed';createdAt:number;src?:string;error?:string}
export async function audioGenerationRecords():Promise<AudioGenerationRecord[]>{const bytes=await kvGet('audio-generation:'+activeProject().id);return bytes?JSON.parse(new TextDecoder().decode(bytes)):[];}
export async function audioGenerationFile(record:AudioGenerationRecord){if(!record.src)throw Error('Audio result is not available');const file=await loadMedia(record.src,activeStorage().mediaDir);if(!file)throw Error('Audio file is missing from this project');return file.type?file:new File([file],file.name,{type:'audio/mpeg'});}
export async function keepGeneratedAudio(store:Store,media:MediaLibrary,file:File){
 const record=(await audioGenerationRecords()).find(r=>r.state==='succeeded'&&r.src==='opfs://'+file.name);if(!record?.src)throw Error('Generated audio is not in this project');
 const existing=store.getState().doc.assets.find(a=>a.kind==='audio'&&a.src===record.src);if(existing)return existing.id;
 const id='generated_audio_'+record.id,probe=await media.probeAudio(await audioGenerationFile(record));
 // The bytes are already durable. Do not rewrite the OPFS entry backing this
 // File snapshot; attach PCM before publishing so restoration does not decode twice.
 await media.attachAudio(id,probe.buffer);
 const current=store.getState().doc.assets.find(a=>a.id===id);if(current)return current.id;
 const result=store.dispatch({type:'addAsset',id,kind:'audio',src:record.src,name:`Generated ${record.model}`,durationUs:probe.durationUs,hasAudio:true});if(!result.ok)throw Error(result.error.message);return id;
}
export async function generateConfiguredAudio(channelId:string,model:string,text:string,lyrics:string,parameters:Record<string,string|number|boolean>,signal:AbortSignal,input?:JsonObject):Promise<File>{
 const channel=loadAudioChannels().find(c=>c.id===channelId);if(!channel||!channel.models.includes(model))throw Error('Audio channel/model is not configured');validateChannel(channel);const settings=channel.modelSettings?.[model],values={...parameterDefaults(settings),...parameters};validateParameters(values,parameterFields(settings));
 const music=channel.kind==='minimax-music';
 const provider=channel.kind==='declarative-audio'?null:configurePresetModel(channel.kind,model,{baseUrl:channel.baseUrl,apiKey:channel.apiKey,modelSettings:settings});
 const projectId=activeProject().id,storage=activeStorage(),key='audio-generation:'+projectId,id=crypto.randomUUID();
 const record:AudioGenerationRecord={id,channelId,model,state:'submitting',createdAt:Date.now()};
 const update=async()=>navigator.locks.request(key,async()=>{const bytes=await kvGet(key),list:AudioGenerationRecord[]=bytes?JSON.parse(new TextDecoder().decode(bytes)):[];const index=list.findIndex(r=>r.id===id);if(index<0)list.push(record);else list[index]=record;await kvPut(key,new TextEncoder().encode(JSON.stringify(list)));window.dispatchEvent(new Event('velocut-audio-generation'));});
 await update();
 try{
  const result=channel.kind==='declarative-audio'?await executeDeclaredAudio(channelId,input??{},id,signal):await provider!.execute({capability:music?'audio.generate':'audio.synthesize',model,input:music?{prompt:text,lyrics,...values}:{text,...values}},{signal,requestId:id});signal.throwIfAborted();const output=result.outputs[0];if(output?.kind!=='audio'||output.source.kind!=='bytes')throw Error('Audio provider returned no encoded audio');
  const file=new File([new Uint8Array(output.source.bytes)],`generated-audio-${id}.mp3`,{type:output.mimeType??'audio/mpeg'});record.src=await saveMedia(file,storage.mediaDir);record.state='succeeded';await update();const saved=await loadMedia(record.src,storage.mediaDir);if(!saved)throw Error('Audio file is missing');return saved.type?saved:new File([saved],saved.name,{type:file.type});
 }catch(e){record.state=(e as {outcome?:string}).outcome==='rejected'?'failed':'unknown';record.error=String(e instanceof Error?e.message:e).split(channel.apiKey||'\u0000').join('[redacted]').replace(/https?:\/\/[^\s]+/g,'[provider URL]');await update().catch(()=>{});throw e;}

}
export function narrationConfig(){const selected=localStorage.getItem('velocut.narration-channel');if(!selected)return null;const {id,model}=JSON.parse(selected),channel=loadAudioChannels().find(c=>c.id===id&&c.kind==='minimax-speech');if(!channel||!channel.models.includes(model))throw Error('Configured narration channel is unavailable');return {provider:'minimax',config:{baseUrl:channel.baseUrl,apiKey:channel.apiKey,model,...parameterDefaults(channel.modelSettings?.[model])}};}
export function chooseNarration(channel:ModelChannel,model:string){localStorage.setItem('velocut.narration-channel',JSON.stringify({id:channel.id,model}));}
