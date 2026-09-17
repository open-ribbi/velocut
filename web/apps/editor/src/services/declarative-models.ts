import {modelInput,readPath,type ModelSpec} from '@velocut/provider-sdk/declarative';
import type {JsonObject,ProviderReceipt,ProviderResult} from '@velocut/provider-sdk';
import type {GenerationRequest} from '@velocut/protocol';
import type {VideoGenChannel} from './videogen';
export interface ModelEntry {id:string;revision:string;spec:ModelSpec}
export interface ConnectionEntry {id:string;label?:string;baseUrl:string;remoteModel?:string;modelId:string;credentialConfigured:boolean;revision:string}
let catalog:{models:ModelEntry[];connections:ConnectionEntry[]}={models:[],connections:[]};
let available=false;
export const modelCatalog=()=>catalog;
export const modelHostAvailable=()=>available;
export async function modelHostCall(p:Record<string,unknown>,signal?:AbortSignal):Promise<any>{
  const response=await fetch('/__velocut/models',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),signal});
  const result=await response.json();if(!response.ok||!result.ok)throw Object.assign(Error(result.error??'Local model host is unavailable'),{outcome:result.outcome??'unknown',retryable:result.retryable??false});
  return result.data;
}
export async function refreshModels(){catalog=await modelHostCall({action:'list'});available=true;window.dispatchEvent(new Event('velocut-models-changed'));return catalog;}
export async function initializeModels(){try{await refreshModels();}catch{available=false;}}
export function declaredModel(connectionId:string){const connection=catalog.connections.find(c=>c.id===connectionId);return connection?catalog.models.find(m=>m.id===connection.modelId):undefined;}
export function declarativeChannels():VideoGenChannel[]{return catalog.connections.flatMap(c=>{
  const m=declaredModel(c.id);if(!m||m.spec.capability!=='video.generate'||m.spec.execution.type!=='async-http'||m.spec.execution.outputs.length!==1||!m.spec.execution.outputs[0].url||m.spec.execution.outputs[0].kind!=='video')return [];
  const duration=m.spec.timeline?.duration,field=duration?(m.spec.inputSchema.properties as JsonObject|undefined)?.[duration] as JsonObject|undefined:undefined;
  const durations=Array.isArray(field?.enum)&&field.enum.every(x=>typeof x==='number'&&x>0)?field.enum as number[]:undefined;
  return [{id:c.id,label:c.label??m.spec.label??c.id,kind:'declarative-http',baseUrl:c.baseUrl,apiKey:'',models:[m.id],defaultModel:m.id,capabilities:{[m.id]:{...(durations?{durationsS:durations}: {})}}}];
});}
export function declarativeAudioChannels():VideoGenChannel[]{return catalog.connections.flatMap(c=>{const m=declaredModel(c.id);return m&&m.spec.capability.startsWith('audio.')&&m.spec.execution.type==='sync-http'&&m.spec.execution.outputs.length===1&&m.spec.execution.outputs[0].kind==='audio'?[{id:c.id,label:c.label??m.spec.label??c.id,kind:'declarative-audio',baseUrl:c.baseUrl,apiKey:'',models:[m.id],defaultModel:m.id}]:[];});}
export async function executeDeclaredAudio(connectionId:string,input:JsonObject,requestId:string,signal:AbortSignal):Promise<ProviderResult>{
 const m=declaredModel(connectionId);if(!m)throw Error('Unknown model');const result=await modelHostCall({action:'execute',connectionId,revision:m.revision,input:modelInput(m.spec,input),requestId},signal);
 for(const o of result.outputs??[])if(o.source?.kind==='bytes'&&o.source.bytes?.$bytes)o.source.bytes=Uint8Array.from(atob(o.source.bytes.$bytes),c=>c.charCodeAt(0));
 for(const o of result.outputs??[])if(o.source?.kind==='url'&&o.metadata?.localDownloadId){const response=await fetch('/__velocut/models/download/'+o.metadata.localDownloadId,{signal});if(!response.ok)throw Error('Audio download failed');o.source={kind:'bytes',bytes:new Uint8Array(await response.arrayBuffer())};}
 return result;
}
function put(object:JsonObject,path:string,value:unknown){const keys=path.split('.');let out=object;for(const k of keys.slice(0,-1)){out[k]??={};if(!out[k]||typeof out[k]!=='object'||Array.isArray(out[k]))throw Error('Invalid timeline binding');out=out[k] as JsonObject;}out[keys.at(-1)!]=value as never;}
export function declaredInput(request:GenerationRequest,durationS?:number):JsonObject{
  const model=declaredModel(request.channel);if(!model)throw Error('Unknown declarative model');const input=structuredClone(request.input??{});
  if(model.spec.timeline?.prompt&&request.prompt&&readPath(input,model.spec.timeline.prompt)===undefined)put(input,model.spec.timeline.prompt,request.prompt);
  if(model.spec.timeline?.duration&&durationS!==undefined&&readPath(input,model.spec.timeline.duration)===undefined)put(input,model.spec.timeline.duration,durationS);
  return modelInput(model.spec,input);
}
export function resolveDeclaredRequest(request:GenerationRequest):GenerationRequest{
  const m=declaredModel(request.channel);if(!m||request.model!==m.id)throw Error('Unknown declarative model');
  // Final schema validation (including required duration) happens with the timeline plan.
  return {...request,modelRevision:m.revision,input:structuredClone(request.input??{})};
}
export async function modelConfiguration(input:unknown){
  try{
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Expected a model configuration action');const p=input as Record<string,unknown>;
    if(!['list','get','validate','upsert','remove','connections','preview'].includes(String(p.action)))throw Error('Unsupported configuration action');
    // This dedicated control surface accepts model/connection definitions, never credentials or execution.
    const data=await modelHostCall(p);if(['upsert','remove','connections'].includes(String(p.action)))await refreshModels();return {ok:true,...data};
  }catch(e){return {ok:false,message:e instanceof Error?e.message:String(e)};}
}
export const modelBinding=(request:GenerationRequest)=>modelHostCall({action:'binding',connectionId:request.channel,revision:request.modelRevision}).then(r=>r.binding as string);
export async function submitDeclared(request:GenerationRequest,_durationS:number,requestId:string,signal:AbortSignal,urls:Record<string,string>){
  const resources:Record<string,{url:string;kind:string}>={};
  for(const [kind,ids] of [['image',[request.firstFrameReferenceId,request.lastFrameReferenceId,...request.referenceImageIds??[]]],['video',request.referenceVideoIds??[]],['audio',request.referenceAudioIds??[]]] as const)for(const id of ids)if(id&&urls[id])resources[id]={url:urls[id],kind};
  for(const ref of inputMediaReferences(request.input))if(urls[ref.id])resources[ref.id]={url:urls[ref.id],kind:ref.kind};
  const receipt:ProviderReceipt=await modelHostCall({action:'submit',connectionId:request.channel,revision:request.modelRevision,input:request.input,requestId,resources},signal);
  return {taskId:receipt.id,handle:receipt as unknown as JsonObject};
}
export function inputMediaReferences(input:unknown):{id:string;kind:'image'|'video'|'audio'}[]{
  const result:{id:string;kind:'image'|'video'|'audio'}[]=[];
  const walk=(v:any)=>{if(!v||typeof v!=='object')return;if(typeof v.$mediaRef==='string'&&['image','video','audio'].includes(v.kind))result.push({id:v.$mediaRef,kind:v.kind});else Object.values(v).forEach(walk);};walk(input);return result;
}
export async function pollDeclared(request:GenerationRequest,taskId:string,handle:JsonObject|undefined,signal:AbortSignal){
  const receipt=handle??{id:taskId},poll=await modelHostCall({action:'poll',connectionId:request.channel,revision:request.modelRevision,receipt},signal);
  if(poll.state==='failed')return {state:'failed' as const,status:'failed',error:poll.error.message};
  if(poll.state==='running'||poll.state==='pending')return {state:poll.state as 'running',status:poll.status};
  const next=poll.receipt??receipt,result:ProviderResult=poll.state==='ready'?await modelHostCall({action:'collect',connectionId:request.channel,revision:request.modelRevision,receipt:next},signal):poll.result;
  if(result.outputs.length!==1||result.outputs[0].kind!=='video'||result.outputs[0].source.kind!=='url')throw Object.assign(Error('Timeline adoption requires one video URL; this model returns another output shape'),{retryable:false});
  return {state:'succeeded' as const,status:'completed',handle:next as JsonObject,result:{videoUrl:typeof result.outputs[0].metadata?.localDownloadId==='string'?new URL('/__velocut/models/download/'+result.outputs[0].metadata.localDownloadId,location.href).href:result.outputs[0].source.url,durationS:result.outputs[0].durationS}};
}
