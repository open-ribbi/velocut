import {validateVideoModel,type ModelSettings} from '@velocut/provider-sdk/catalog';
import {ProviderError,ProviderRegistry,defineModel,type ProviderDefinition,type JsonObject,type ProviderResult,type Support,type ProviderRequest,type ProviderCall} from '@velocut/provider-sdk';
import {asVideoGenerator,abortableDelay,VideoGenTransportError,type VideoGenerator,type VideoGenEndpointConfig,type VideoGenRequest,type VideoGenResult,type VideoGenPoll} from '@velocut/provider-sdk/video';

const fields=['prompt','durationS','ratio','resolution','generateAudio','firstFrameReferenceId','lastFrameReferenceId','referenceImageIds','referenceVideoIds','referenceAudioIds','parameters'];
export const taskApiVideoInputSchema:JsonObject={type:'object',additionalProperties:false,required:['prompt'],properties:{prompt:{type:'string',minLength:1},durationS:{type:'number',exclusiveMinimum:0},ratio:{type:'string'},resolution:{type:'string'},generateAudio:{type:'boolean'},firstFrameReferenceId:{type:'string'},lastFrameReferenceId:{type:'string'},referenceImageIds:{type:'array',items:{type:'string'}},referenceVideoIds:{type:'array',items:{type:'string'}},referenceAudioIds:{type:'array',items:{type:'string'}},parameters:{type:'object',description:'Only controls declared in the configured model settings are accepted'}}};
function validate(input:JsonObject,settings?:ModelSettings):Support {
  try{validateVideoModel(settings,input);}catch(e){return {supported:false,reason:e instanceof Error?e.message:String(e)};}
  if(Object.keys(input).some(k=>!fields.includes(k)))return {supported:false,reason:'Unsupported video input field'};
  if(typeof input.prompt!=='string'||!input.prompt.trim())return {supported:false,reason:'videoGen: prompt is required'};
  if(input.durationS!==undefined&&(typeof input.durationS!=='number'||!Number.isFinite(input.durationS)||input.durationS<=0))return {supported:false,reason:'durationS must be positive'};
  for(const name of ['ratio','resolution','firstFrameReferenceId','lastFrameReferenceId'])if(input[name]!==undefined&&(typeof input[name]!=='string'||!input[name]))return {supported:false,reason:`${name} must be a nonempty string`};
  if(input.generateAudio!==undefined&&typeof input.generateAudio!=='boolean')return {supported:false,reason:'generateAudio must be boolean'};
  for(const name of ['referenceImageIds','referenceVideoIds','referenceAudioIds'])if(input[name]!==undefined&&(!Array.isArray(input[name])||(input[name] as unknown[]).some(v=>typeof v!=='string'||!v)))return {supported:false,reason:`${name} must contain reference IDs`};
  return {supported:true};
}
/** Protocol implementation only; there is no vendor model catalogue baked into this adapter. */
export const taskApiProvider:ProviderDefinition={
  apiVersion:1,id:'task-api',label:'Async task API (submit → poll relays)',capabilities:['video.generate'],
  credentials:[{name:'apiKey',required:true}],
  configSchema:{type:'object',required:['baseUrl'],properties:{baseUrl:{type:'string'},models:{type:'array',items:{type:'string'}},modelSettings:{type:'object'}},additionalProperties:false},
  create(context){
    const config=context.config;if(Object.keys(config).some(k=>!['baseUrl','models','modelSettings'].includes(k)))throw Error('Unsupported task-api configuration');
    if(typeof config.baseUrl!=='string')throw Error('Task API needs baseUrl');const url=new URL(config.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Task API needs an HTTP(S) endpoint and separate credentials');
    const settings=config.modelSettings as unknown as ModelSettings|undefined;
    const root=config.baseUrl.replace(/\/+$/,''),base=root.endsWith('/api/v1')?root.slice(0,-7):root,models=config.models??[];
    if(!Array.isArray(models)||models.some(m=>typeof m!=='string'||!m))throw Error('models must contain model IDs');
    const check=(request:ProviderRequest):Support=>request.capability!=='video.generate'||!request.model?{supported:false,reason:'videoGen: model is required'}:models.length&&!models.includes(request.model)?{supported:false,reason:'Model is not configured on this channel'}:validate(request.input,settings);
    const headers=async()=>({'content-type':'application/json',authorization:`Bearer ${await context.credentials.get('apiKey')}`});
    const fail=(phase:'submit'|'poll',status:number,message:string)=>new ProviderError({phase,code:'TASK_API_HTTP',httpStatus:status,message,outcome:phase==='submit'&&status>=400&&status<500?'rejected':'unknown',retryable:status>=500||status===429});
    const compile=async(input:JsonObject,call:ProviderCall)=>{
      const params:JsonObject={...(input.parameters as JsonObject??{}),prompt:input.prompt};
      for(const [name,field] of [['durationS','duration'],['ratio','ratio'],['resolution','resolution'],['generateAudio','generate_audio']] as const)if(input[name]!==undefined)params[field]=input[name];
      for(const [name,field,kind,array] of [['firstFrameReferenceId','first_frame_image','image',false],['lastFrameReferenceId','last_frame_image','image',false],['referenceImageIds','reference_images','image',true],['referenceVideoIds','reference_videos','video',true],['referenceAudioIds','reference_audios','audio',true]] as const){
        if(input[name]===undefined)continue;if(!call.resources)throw new ProviderError({phase:'validate',code:'MISSING_REFERENCE_TRANSPORT',message:'Reference transport is not configured',outcome:'rejected',retryable:false});
        const ids=array?input[name] as string[]:[input[name] as string],urls:string[]=[];
        for(const id of ids){call.signal?.throwIfAborted();const value=await call.resources.urlFor(id,kind),url=new URL(value);if(!['http:','https:'].includes(url.protocol))throw Error('Reference transport returned an invalid URL');urls.push(value);}params[field]=array?urls:urls[0];
      }if(settings?.presetId==='minimax-h3'&&params.first_frame_image&&!params.last_frame_image){params.image_url=params.first_frame_image;delete params.first_frame_image;}return params;
    };
    return {
      models:()=>models.map(id=>defineModel({id:id as string,capability:'video.generate',inputSchema:taskApiVideoInputSchema,outputKinds:['video'],validate:input=>validate(input,settings)})),
      supports:check,
      async submit(request,call){
        const params=await compile(request.input,call);call.signal?.throwIfAborted();const auth=await headers();call.signal?.throwIfAborted();
        const response=await context.fetch(`${base}/api/v1/tasks`,{method:'POST',headers:auth,body:JSON.stringify({model:request.model,params,...(settings?.presetId==='seedance-2.5'&&call.requestId?{idempotency_key:call.requestId}:{})}),signal:call.signal});
        const raw=await response.json().catch(()=>({})) as any;const body={...raw,...raw.data};body.task_id??=body.id;
        if(!response.ok||typeof body.task_id!=='string'||!body.task_id.trim())throw fail('submit',response.status,`videoGen submit failed (HTTP ${response.status}): ${body.detail?.message??'missing task receipt'}`);
        return {id:body.task_id};
      },
      async poll(receipt,call){
        const response=await context.fetch(`${base}/api/v1/tasks/${encodeURIComponent(receipt.id)}`,{headers:await headers(),signal:call.signal});
        const raw=await response.json().catch(()=>({})) as any;const body={...raw,...raw.data};if(body.result&&!body.result.video_url)body.result.video_url=body.result.url;
        if(!response.ok)throw fail('poll',response.status,`videoGen poll failed (HTTP ${response.status}): ${body.detail?.message??'provider error'}`);
        if(['failed','canceled','cancelled','expired'].includes(body.status))return {state:'failed',error:{phase:'poll',code:'TASK_API_FAILED',message:body.error_message??'Provider generation failed',outcome:'rejected',retryable:false}};
        if(body.status==='completed'){
          if(typeof body.result?.video_url!=='string'||!body.result.video_url)throw new ProviderError({phase:'poll',code:'MISSING_RESULT',message:'videoGen: task completed but returned no video_url',outcome:'unknown',retryable:false});
          return {state:'ready',receipt:{id:receipt.id,state:{videoUrl:body.result.video_url,...(typeof body.result.duration==='number'?{durationS:body.result.duration}:{}),...(typeof body.cost==='number'?{cost:body.cost}:{}),...(typeof body.result.resolution==='string'?{resolution:body.result.resolution}:{}),...(typeof body.result.ratio==='string'?{ratio:body.result.ratio}:{})}}};
        }
        if(!['pending','processing','running','queued'].includes(body.status??''))throw new ProviderError({phase:'poll',code:'UNKNOWN_STATUS',message:`Unknown task-api status: ${String(body.status)}`,outcome:'unknown',retryable:false});
        return {state:body.status==='pending'||body.status==='queued'?'pending':'running',status:body.status};
      },
      async collect(receipt):Promise<ProviderResult>{
        if(typeof receipt.state?.videoUrl!=='string')throw Error('Poll a completed task before collecting its result');
        return {outputs:[{kind:'video',metadata:{...(typeof receipt.state.resolution==='string'?{resolution:receipt.state.resolution}:{}),...(typeof receipt.state.ratio==='string'?{ratio:receipt.state.ratio}:{})},source:{kind:'url',url:receipt.state.videoUrl},...(typeof receipt.state.durationS==='number'?{durationS:receipt.state.durationS}:{})}],...(typeof receipt.state.cost==='number'?{usage:{cost:receipt.state.cost}}:{})};
      },
    };
  },
};
/** Existing SDK API, backed by the same new Provider implementation. */
export class TaskApiVideoGen implements VideoGenerator {
  private delegate:VideoGenerator;private config:VideoGenEndpointConfig;
  constructor(config:VideoGenEndpointConfig){
    this.config=config;const registry=new ProviderRegistry().register(taskApiProvider);
    this.delegate=asVideoGenerator(registry.create({id:'legacy-task-api',provider:'task-api',config:{baseUrl:config.baseUrl,...(config.modelSettings?{modelSettings:config.modelSettings as unknown as JsonObject}:{})},credentials:{apiKey:{store:'host',key:'task-api'}}},{resolveCredential:async()=>config.apiKey}));
  }
  private async compatible<T>(work:Promise<T>):Promise<T>{try{return await work;}catch(error){if(error instanceof ProviderError)throw new VideoGenTransportError(error.message,error.outcome,error.retryable);throw error;}}
  submit(request:VideoGenRequest){return this.compatible(this.delegate.submit!(request));}
  poll(taskId:string,signal?:AbortSignal,handle?:JsonObject):Promise<VideoGenPoll>{return this.compatible(this.delegate.poll!(taskId,signal,handle));}
  async generate(request:VideoGenRequest):Promise<VideoGenResult>{
    const receipt=await this.submit(request),started=Date.now();request.onStatus?.('pending',0);let handle=receipt.handle;
    for(;;){await abortableDelay(this.config.pollIntervalMs??5000,request.signal);if(Date.now()-started>(this.config.timeoutMs??20*60_000))throw Error(`videoGen timed out (task ${receipt.taskId} may still complete server-side)`);
      const polled=await this.poll(receipt.taskId,request.signal,handle);handle=polled.handle??handle;request.onStatus?.(polled.status,Math.round((Date.now()-started)/1000));if(polled.result)return polled.result;if(polled.state==='failed')throw Error(polled.error);
    }
  }
}
export {arkVideoProvider} from './ark';
