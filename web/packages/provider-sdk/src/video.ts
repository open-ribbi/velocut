import type {JsonObject,ConfiguredProvider,ProviderReceipt,ProviderResult} from './index';
export interface VideoGenRequest {
  /** Channel-defined model id (as the configured relay names it). */
  model: string;
  /** Scene/motion description (most providers cap ~500 chars). */
  prompt: string;
  /** Requested clip length, seconds (provider clamps to its range). */
  durationS?: number;
  /** Provider-defined tier: '480p' | '720p' | '1080p' | '4k'. */
  resolution?: string;
  /** '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9' | 'adaptive'. */
  ratio?: string;
  /** Generate a synced audio track (provider default usually true). */
  generateAudio?: boolean;
  /** Image-to-video conditioning: public URLs (providers don't take base64). */
  firstFrameUrl?: string;
  lastFrameUrl?: string;
  referenceImageUrls?: string[];
  referenceVideoUrls?: string[];
  signal?: AbortSignal;
  requestId?: string;
  parameters?: Record<string,string|number|boolean>;
  referenceAudioUrls?:string[];
  /** Progress callback: provider status ('pending'/'processing'/…) + seconds elapsed. */
  onStatus?: (status: string, elapsedS: number) => void;
}

export interface VideoGenResult {
  /** Generated video URL — often short-lived (24h): download promptly. */
  videoUrl: string;
  durationS?: number;
  resolution?: string;
  ratio?: string;
  /** Credits charged by the channel, if reported. */
  cost?: number;
  taskId?: string;
}

/** Prompt (+ optional image conditioning) → a generated video URL. */
export interface VideoGenerator {
  generate(req: VideoGenRequest): Promise<VideoGenResult>;
  submit?(req:VideoGenRequest):Promise<{taskId:string;handle?:JsonObject}>;
  poll?(taskId:string,signal?:AbortSignal,handle?:JsonObject):Promise<VideoGenPoll>;
}
export interface VideoGenPoll {state:'pending'|'running'|'succeeded'|'failed';status:string;result?:VideoGenResult;error?:string;handle?:JsonObject}
export interface VideoModelCapabilities {durationsS?:number[];ratios?:string[];resolutions?:string[];imageToVideo?:boolean;audio?:boolean}
export class VideoGenTransportError extends Error {
  outcome:'rejected'|'unknown';retryable:boolean;
  constructor(message:string,outcome:'rejected'|'unknown'='unknown',retryable=true){super(message);this.outcome=outcome;this.retryable=retryable;}
}

/** Endpoint configuration a channel supplies — the part that differs between
 *  channels speaking the same protocol. */
export interface VideoGenEndpointConfig {
  /** API root, no trailing slash (e.g. 'https://api.example.com'). */
  baseUrl: string;
  apiKey: string;
  pollIntervalMs?: number;
  /** Overall generation deadline (default 20 min — multi-reference tasks
   *  run well past a t2v's couple of minutes). */
  timeoutMs?: number;
  modelSettings?:import('./catalog').ModelSettings;
}

/** A registered protocol implementation — self-describing so the UI/agent can
 *  enumerate what's available. */
export interface VideoGenProviderKind {
  id: string;
  label: string;
  create(config: VideoGenEndpointConfig): VideoGenerator;
}


/** Compatibility adapter for the current single-video timeline runtime. */
export function asVideoGenerator(provider:ConfiguredProvider):VideoGenerator {
  const task=(taskId:string,handle?:JsonObject):ProviderReceipt=>({id:taskId,...(handle?{state:handle}:{})});
  const result=(value:ProviderResult,taskId:string):VideoGenResult=>{
    if(value.outputs.length!==1||value.outputs[0].kind!=='video'||value.outputs[0].source.kind!=='url')throw new VideoGenTransportError('Timeline video adapter requires one video URL; consume multi-output or binary results through provider-sdk','unknown',false);
    const output=value.outputs[0];return {videoUrl:(output.source as {url:string}).url,taskId,durationS:output.durationS,...(typeof output.metadata?.resolution==='string'?{resolution:output.metadata.resolution}:{}),...(typeof output.metadata?.ratio==='string'?{ratio:output.metadata.ratio}:{}),...(typeof value.usage?.cost==='number'?{cost:value.usage.cost}:{})};
  };
  const api:VideoGenerator={
    async submit(req){
      const urls=new Map<string,string>(),input:JsonObject={prompt:req.prompt,...(req.parameters?{parameters:req.parameters}:{})};
      for(const name of ['durationS','ratio','resolution','generateAudio'] as const)if(req[name]!==undefined)input[name]=req[name]!;
      for(const [from,to] of [['firstFrameUrl','firstFrameReferenceId'],['lastFrameUrl','lastFrameReferenceId']] as const)if(req[from]){urls.set(to,req[from]!);input[to]=to;}
      for(const [from,to] of [['referenceImageUrls','referenceImageIds'],['referenceVideoUrls','referenceVideoIds'],['referenceAudioUrls','referenceAudioIds']] as const)if(req[from]?.length)input[to]=req[from]!.map((url,i)=>{const id=to+'_'+i;urls.set(id,url);return id;});
      const receipt=await provider.submit({capability:'video.generate',model:req.model,input},{signal:req.signal,requestId:req.requestId,resources:{urlFor:async id=>{const url=urls.get(id);if(!url)throw Error('Unknown video reference');return url;}}});
      return {taskId:receipt.id,...(receipt.state?{handle:receipt.state}:{})};
    },
    async poll(taskId,signal,handle){
      const receipt=task(taskId,handle),polled=await provider.poll(receipt,{signal});
      const next=polled.receipt??receipt;
      if(polled.state==='failed')return {state:'failed',status:'failed',error:polled.error.message,...(next.state?{handle:next.state}:{})};
      if(polled.state==='ready'||polled.state==='succeeded'){
        const collected=polled.state==='succeeded'?polled.result:await provider.collect(next,{signal});
        return {state:'succeeded',status:'completed',result:result(collected,taskId),...(next.state?{handle:next.state}:{})};
      }
      return {state:polled.state,status:polled.status??polled.state,...(next.state?{handle:next.state}:{})};
    },
    async generate(req){
      const receipt=await api.submit!(req);let handle=receipt.handle;
      for(;;){const polled=await api.poll!(receipt.taskId,req.signal,handle);handle=polled.handle??handle;req.onStatus?.(polled.status,0);if(polled.result)return polled.result;if(polled.state==='failed')throw Error(polled.error);await abortableDelay(5000,req.signal);}
    },
  };return api;
}
export function abortableDelay(ms:number,signal?:AbortSignal):Promise<void>{
  return new Promise((resolve,reject)=>{
    if(signal?.aborted){reject(signal.reason);return;}
    const finish=()=>{signal?.removeEventListener('abort',abort);resolve();};
    const timer=setTimeout(finish,ms),abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(signal?.reason??new DOMException('aborted','AbortError'));};
    signal?.addEventListener('abort',abort,{once:true});
  });
}
