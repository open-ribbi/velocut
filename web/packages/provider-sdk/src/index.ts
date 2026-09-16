/** Host-neutral contracts. Providers perform one service action; hosts own jobs and editing. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key:string]:JsonValue };
export type JsonObject = { [key:string]:JsonValue };
export type MediaKind = 'video' | 'audio' | 'image';
export type Capability = 'video.generate' | 'image.generate' | 'audio.synthesize' | 'audio.transcribe' | (string & {});
export type Support = {supported:true} | {supported:false;reason:string};
export interface ProviderRequest {capability:Capability;model:string;input:JsonObject}
export interface ModelDefinition {
  id:string;capability:Capability;label?:string;inputSchema:JsonObject;outputKinds:readonly (MediaKind|'data')[];
  /** Pure validation for model semantics. JSON Schema describes the same inputs for UI/agents. */
  validate(input:JsonObject):Support;
}
export type ModelDescription = Omit<ModelDefinition,'validate'>;
export interface CredentialRef {store:string;key:string}
export interface CredentialSlot {name:string;required?:boolean;label?:string}
export interface ProviderChannel {id:string;provider:string;config:JsonObject;credentials?:Record<string,CredentialRef>}
export interface ProviderContext {
  config:Readonly<JsonObject>;
  fetch:typeof globalThis.fetch;
  /** Only declared, explicitly configured credential slots can be resolved. */
  credentials:{get(slot:string):Promise<string|undefined>};
}
export interface ProviderCall {
  signal?:AbortSignal;requestId?:string;
  /** Resolve host-owned reference IDs using transport appropriate to this provider. */
  resources?:{urlFor(referenceId:string,kind:MediaKind):Promise<string>};
  onProgress?:(progress:{phase:string;completed?:number;total?:number})=>void;
}
/** Persist privately with the owning channel. State must be JSON, with no credentials/media bytes. */
export interface ProviderReceipt {id:string;state?:JsonObject;channelId?:string;providerId?:string}
export type ProviderOutput = {
  kind:MediaKind;metadata?:JsonObject;mimeType?:string;durationS?:number;width?:number;height?:number;
  source:{kind:'url';url:string}|{kind:'bytes';bytes:Uint8Array}|{kind:'resource';id:string};
};
export interface ProviderResult {outputs:ProviderOutput[];data?:JsonValue;usage?:JsonObject}
export type ProviderPoll =
  | {state:'pending'|'running';status?:string;receipt?:ProviderReceipt;retryAfterMs?:number}
  | {state:'ready';receipt?:ProviderReceipt}
  | {state:'succeeded';result:ProviderResult;receipt?:ProviderReceipt}
  | {state:'failed';error:ProviderFailure;receipt?:ProviderReceipt};
export type CancelOutcome = {status:'accepted'|'confirmed'|'unsupported'|'too-late'};
export type ProviderPhase = 'validate'|'execute'|'submit'|'poll'|'collect'|'cancel';
export interface ProviderFailure {code:string;message:string;phase:ProviderPhase;outcome:'rejected'|'unknown';retryable:boolean;httpStatus?:number;requestId?:string}
export class ProviderError extends Error implements ProviderFailure {
  code:string;phase:ProviderPhase;outcome:'rejected'|'unknown';retryable:boolean;httpStatus?:number;requestId?:string;
  constructor(failure:ProviderFailure){super(failure.message);this.name='ProviderError';Object.assign(this,failure);this.code=failure.code;this.phase=failure.phase;this.outcome=failure.outcome;this.retryable=failure.retryable;}
}
export interface Provider {
  models():readonly ModelDefinition[];
  /** Service-specific restrictions, including dynamically configured model IDs. No network. */
  supports(request:ProviderRequest):Support;
  execute?(request:ProviderRequest,call:ProviderCall):Promise<ProviderResult>;
  submit?(request:ProviderRequest,call:ProviderCall):Promise<ProviderReceipt>;
  poll?(receipt:ProviderReceipt,call:ProviderCall):Promise<ProviderPoll>;
  collect?(receipt:ProviderReceipt,call:ProviderCall):Promise<ProviderResult>;
  cancel?(receipt:ProviderReceipt,call:ProviderCall):Promise<CancelOutcome>;
  readPricing?(request:ProviderRequest,call:ProviderCall):Promise<{source:string;data:JsonObject}[]>;
}
export interface ProviderDefinition {
  id:string;label:string;apiVersion:1;capabilities:readonly Capability[];
  credentials?:readonly CredentialSlot[];configSchema:JsonObject;
  create(context:ProviderContext):Provider;
}
export interface ProviderHost {resolveCredential(ref:CredentialRef):Promise<string|undefined>;fetch?:typeof globalThis.fetch}
export function defineModel(model:ModelDefinition):ModelDefinition {
  if(!model.id||!model.capability||typeof model.validate!=='function')throw Error('A model needs an ID, capability and validator');
  assertJson(model.inputSchema);return Object.freeze({...model,inputSchema:structuredClone(model.inputSchema),outputKinds:[...model.outputKinds]});
}
export function assertJson(value:unknown):asserts value is JsonValue {
  const visit=(v:unknown,seen:Set<object>):void=>{
    if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(!v||typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)throw Error('Expected finite JSON data');
    seen.add(v);for(const x of Array.isArray(v)?v:Object.values(v))visit(x,seen);seen.delete(v);
  };visit(value,new Set());
}
function receipt(value:ProviderReceipt){if(!value||typeof value.id!=='string'||!value.id.trim())throw Error('Provider returned no valid receipt');if(value.state!==undefined)assertJson(value.state);return structuredClone(value);}
/** An explicit registry per host. Registering a package never starts a network call. */
export class ProviderRegistry {
  private definitions=new Map<string,ProviderDefinition>();
  register(definition:ProviderDefinition){
    if(definition.apiVersion!==1||!definition.id)throw Error('Unsupported provider definition');
    if(this.definitions.has(definition.id))throw Error(`Provider already registered: ${definition.id}`);
    const slots=definition.credentials??[];if(new Set(slots.map(s=>s.name)).size!==slots.length)throw Error('Duplicate credential slot');
    this.definitions.set(definition.id,definition);return this;
  }
  list(){return [...this.definitions.values()].map(d=>({id:d.id,label:d.label,apiVersion:d.apiVersion,capabilities:[...d.capabilities],credentials:structuredClone(d.credentials??[]),configSchema:structuredClone(d.configSchema)}));}
  create(channel:ProviderChannel,host:ProviderHost):ConfiguredProvider {
    const definition=this.definitions.get(channel.provider);if(!definition)throw Error(`Unknown provider: ${channel.provider}`);
    assertJson(channel.config);const selected=structuredClone(channel),slots=definition.credentials??[];
    for(const name of Object.keys(selected.credentials??{}))if(!slots.some(s=>s.name===name))throw Error(`Undeclared credential slot: ${name}`);
    for(const slot of slots)if(slot.required&&!selected.credentials?.[slot.name])throw Error(`Missing credential reference: ${slot.name}`);
    const secrets=new Set<string>();
    const implementation=definition.create({config:selected.config,fetch:(host.fetch??globalThis.fetch).bind(globalThis),credentials:{get:async name=>{
      const slot=slots.find(s=>s.name===name);if(!slot)throw Error(`Undeclared credential slot: ${name}`);
      const ref=selected.credentials?.[name];const value=ref?await host.resolveCredential(structuredClone(ref)):undefined;
      if(slot.required&&!value)throw new ProviderError({phase:'validate',code:'MISSING_CREDENTIAL',message:`Credential is unavailable: ${name}`,outcome:'rejected',retryable:false});if(value)secrets.add(value);return value;
    }}});
    return new ConfiguredProvider(selected.id,definition,implementation,secrets);
  }
}
export class ConfiguredProvider {
  readonly channelId:string;private definition:ProviderDefinition;private provider:Provider;private secrets:Set<string>;
  constructor(channelId:string,definition:ProviderDefinition,provider:Provider,secrets:Set<string>){this.channelId=channelId;this.definition=definition;this.provider=provider;this.secrets=secrets;}
  describe(){return {channelId:this.channelId,provider:this.definition.id,label:this.definition.label,capabilities:[...this.definition.capabilities],models:this.provider.models().map(({validate:_validate,...model})=>structuredClone(model)),lifecycle:{execute:!!this.provider.execute,submit:!!this.provider.submit,poll:!!this.provider.poll,collect:!!this.provider.collect,cancel:!!this.provider.cancel,pricing:!!this.provider.readPricing}};}
  supports(request:ProviderRequest):Support {
    try{
      assertJson(request);if(!request.model)return {supported:false,reason:'model is required'};if(!this.definition.capabilities.includes(request.capability)||!request.input||typeof request.input!=='object'||Array.isArray(request.input))return {supported:false,reason:'Unsupported capability or malformed request'};
      const model=this.provider.models().find(m=>m.id===request.model&&m.capability===request.capability);
      if(model){const result=model.validate(structuredClone(request.input));if(!result.supported)return result;}
      const result=this.provider.supports(structuredClone(request));return result.supported?result:{supported:false,reason:this.message(result.reason)};
    }catch(error){return {supported:false,reason:this.message(error)};}
  }
  private message(error:unknown){let message=error instanceof Error?error.message:String(error);for(const secret of this.secrets)message=message.split(secret).join('[redacted]');return message;}
  private check(request:ProviderRequest){const result=this.supports(request);if(!result.supported)throw new ProviderError({phase:'validate',code:'UNSUPPORTED_REQUEST',message:result.reason,outcome:'rejected',retryable:false});}
  private async action<T>(phase:ProviderPhase,call:ProviderCall,work:()=>Promise<T>):Promise<T>{
    call.signal?.throwIfAborted();try{return await work();}catch(error){if(error instanceof ProviderError)throw new ProviderError({...error,message:this.message(error)});if(call.signal?.aborted)throw error;throw new ProviderError({phase,code:'PROVIDER_ACTION_FAILED',message:this.message(error),outcome:phase==='validate'?'rejected':'unknown',retryable:phase==='poll'||phase==='collect'});}
  }
  private task(value:ProviderReceipt){
    if(value.channelId!==undefined&&value.channelId!==this.channelId||value.providerId!==undefined&&value.providerId!==this.definition.id)throw Error('Receipt belongs to a different provider channel');
    return {...receipt(value),channelId:this.channelId,providerId:this.definition.id};
  }
  async execute(request:ProviderRequest,call:ProviderCall={}){this.check(request);if(!this.provider.execute)throw Error('Provider has no immediate execution');return this.action('execute',call,()=>this.provider.execute!(structuredClone(request),call));}
  async submit(request:ProviderRequest,call:ProviderCall={}){this.check(request);if(!this.provider.submit||!this.provider.poll)throw Error('Provider needs submit/poll for asynchronous work');return this.action('submit',call,async()=>this.task(await this.provider.submit!(structuredClone(request),call)));}
  async poll(task:ProviderReceipt,call:ProviderCall={}){if(!this.provider.poll)throw Error('Provider has no polling');return this.action('poll',call,async()=>{const result=await this.provider.poll!(this.task(task),call);if(result.receipt)result.receipt=this.task(result.receipt);if(result.state==='failed')result.error={...result.error,message:this.message(result.error.message)};return result;});}
  async collect(task:ProviderReceipt,call:ProviderCall={}){if(!this.provider.collect)throw Error('Provider has no collection');return this.action('collect',call,()=>this.provider.collect!(this.task(task),call));}
  async cancel(task:ProviderReceipt,call:ProviderCall={}):Promise<CancelOutcome>{if(!this.provider.cancel)return {status:'unsupported'};return this.action('cancel',call,()=>this.provider.cancel!(this.task(task),call));}
  async readPricing(request:ProviderRequest,call:ProviderCall={}){this.check(request);return this.provider.readPricing?this.action('validate',call,()=>this.provider.readPricing!(structuredClone(request),call)):[];}
}
