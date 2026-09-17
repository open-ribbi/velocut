/** Existing SDK entry points delegate to recipes and the shared declarative executor. */
export * from '@velocut/provider-sdk/video';
import {ProviderError,type JsonObject} from '@velocut/provider-sdk';
import {BUILTIN_PROTOCOLS,configurePresetModel} from '@velocut/provider-sdk/presets';
import {asVideoGenerator,abortableDelay,VideoGenTransportError,type VideoGenProviderKind,type VideoGenEndpointConfig,type VideoGenerator,type VideoGenRequest,type VideoGenPoll} from '@velocut/provider-sdk/video';
const kinds=new Map<string,VideoGenProviderKind>();
export function registerVideoGenProvider(kind:VideoGenProviderKind){kinds.set(kind.id,kind);}
export function videoGenProviders():VideoGenProviderKind[]{return [...kinds.values()];}
export function createVideoGen(kindId:string,config:VideoGenEndpointConfig):VideoGenerator {
  const kind=kinds.get(kindId);if(!kind)throw Error(`unknown video-gen provider kind: ${kindId} (have: ${[...kinds.keys()].join(', ')})`);return kind.create(config);
}
class PresetVideoGenerator implements VideoGenerator {
  private protocol:string;private config:VideoGenEndpointConfig;private model?:string;
  constructor(protocol:string,config:VideoGenEndpointConfig){this.protocol=protocol;this.config=config;}
  private api(model:string){return asVideoGenerator(configurePresetModel(this.protocol,model,this.config));}
  private async action<T>(work:()=>Promise<T>):Promise<T>{try{return await work();}catch(error){if(error instanceof ProviderError)throw new VideoGenTransportError(error.message,error.outcome,error.retryable);throw error;}}
  async submit(request:VideoGenRequest){return this.action(async()=>{
    if(!request.model?.trim())throw new VideoGenTransportError('model is required','rejected',false);
    if(!request.prompt?.trim())throw new VideoGenTransportError('prompt is required','rejected',false);
    this.model=request.model;const receipt=await this.api(request.model).submit!(request);
    return {...receipt,handle:{...receipt.handle,__model:request.model}};
  });}
  async poll(taskId:string,signal?:AbortSignal,handle?:JsonObject):Promise<VideoGenPoll>{return this.action(async()=>{
    const {__model,...state}=handle??{},model=typeof __model==='string'?__model:this.model??'resume';
    const result=await this.api(model).poll!(taskId,signal,state);return {...result,handle:{...result.handle,__model:model}};
  });}
  async generate(request:VideoGenRequest){
    const receipt=await this.submit(request),started=Date.now();let handle:JsonObject=receipt.handle;
    request.onStatus?.('pending',0);
    for(;;){
      await abortableDelay(this.config.pollIntervalMs??5000,request.signal);
      if(Date.now()-started>(this.config.timeoutMs??20*60_000))throw Error(`video generation timed out (task ${receipt.taskId} may still complete server-side)`);
      const polled=await this.poll(receipt.taskId,request.signal,handle);handle=polled.handle??handle;
      request.onStatus?.(polled.status,Math.round((Date.now()-started)/1000));
      if(polled.result)return polled.result;if(polled.state==='failed')throw Error(polled.error);
    }
  }
}
/** Constructor alias for existing render-sdk consumers; no separate transport. */
export class TaskApiVideoGen extends PresetVideoGenerator {constructor(config:VideoGenEndpointConfig){super('task-api',config);}}
for(const [id,recipe] of Object.entries(BUILTIN_PROTOCOLS))if(recipe.kind==='video')registerVideoGenProvider({id,label:recipe.label,create:config=>new PresetVideoGenerator(id,config)});
