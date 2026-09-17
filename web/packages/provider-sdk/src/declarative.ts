/** Data-only media adapters. YAML/JSON describes requests; no model-name dispatch or eval. */
import Ajv, {type ValidateFunction} from 'ajv';
import {parseDocument, stringify} from 'yaml';
import {assertJson, ProviderError, type JsonObject, type JsonValue, type MediaKind, type ProviderDefinition, type ProviderContext, type ProviderCall, type ProviderReceipt, type ProviderResult} from './index';

export type ResponseSelector=string|string[];
export interface HttpStep {
  method:'GET'|'POST'|'PUT'|'DELETE'; path:string; body?:JsonValue;
  query?:Record<string,JsonValue>; headers?:Record<string,string>;
  response?:'json'|'bytes';
  error?:{path:ResponseSelector;success:JsonValue;message?:ResponseSelector;optional?:boolean};
  errorMessage?:ResponseSelector;responseSchema?:JsonObject;
}
export interface OutputMapping {kind:MediaKind;each?:ResponseSelector;url?:ResponseSelector;hex?:ResponseSelector;base64?:ResponseSelector;bytes?:boolean;mimeType?:string;durationS?:ResponseSelector;metadata?:Record<string,ResponseSelector>}
export interface ModelSpec {
  version:1; id:string; label?:string; capability:string; inputSchema:JsonObject;
  /** Editor semantic bindings are optional, and never dictate a model's parameter names. */
  timeline?:{prompt?:string;duration?:string};
  execution:{
    type:'sync-http'|'async-http';
    auth?:{type:'none'|'bearer'|'header';header?:string;prefix?:string};
    submit:HttpStep;
    receipt?:Record<string,ResponseSelector>;
    poll? : HttpStep & {status:ResponseSelector;states:{running:string[];succeeded:string[];failed:string[]};receipt?:Record<string,ResponseSelector>;errorMessage?:ResponseSelector};
    collect?:HttpStep;
    outputs:OutputMapping[];
    data?:ResponseSelector;usage?:Record<string,ResponseSelector>;
  };
}
export interface ModelConnection {baseUrl:string;remoteModel?:string;[key:string]:JsonValue|undefined}
/** Connection templates never receive the host's credential store or administrative metadata. */
const mappingConnection=(connection:ModelConnection):ModelConnection=>({baseUrl:connection.baseUrl,...(connection.remoteModel!==undefined?{remoteModel:connection.remoteModel}:{})});
const ajv=new Ajv({strict:true,strictRequired:false,allErrors:true,useDefaults:true,coerceTypes:false,removeAdditional:false,allowUnionTypes:true});
ajv.addKeyword({keyword:'x-media-kind',schemaType:'string',valid:true});
const object=(properties:object,required:string[]=[],extra=false)=>({type:'object',properties,required,additionalProperties:extra});
const selectorSchema={anyOf:[{type:'string'},{type:'array',minItems:1,items:{type:'string'}}]};
const stepProperties={method:{enum:['GET','POST','PUT','DELETE']},path:{type:'string',minLength:1},body:{},query:{type:'object'},headers:{type:'object',additionalProperties:{type:'string'}},response:{enum:['json','bytes']},errorMessage:selectorSchema,responseSchema:{type:'object'},error:object({path:selectorSchema,success:{},message:selectorSchema,optional:{type:'boolean'}},['path','success'])};
const receiptSchema={type:'object',additionalProperties:selectorSchema};
const specValidator=ajv.compile(object({version:{const:1},id:{type:'string',pattern:'^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$'},label:{type:'string'},capability:{type:'string',minLength:1},inputSchema:{type:'object'},timeline:object({prompt:{type:'string'},duration:{type:'string'}}),execution:object({
  type:{enum:['sync-http','async-http']},auth:object({type:{enum:['none','bearer','header']},header:{type:'string'},prefix:{type:'string'}},['type']),
  submit:object(stepProperties,['method','path']),receipt:receiptSchema,
  poll:object({...stepProperties,status:selectorSchema,states:object({running:{type:'array',items:{type:'string'}},succeeded:{type:'array',minItems:1,items:{type:'string'}},failed:{type:'array',items:{type:'string'}}},['running','succeeded','failed']),receipt:receiptSchema,errorMessage:selectorSchema},['method','path','status','states']),
  collect:object(stepProperties,['method','path']),outputs:{type:'array',items:object({kind:{enum:['video','audio','image']},each:selectorSchema,url:selectorSchema,hex:selectorSchema,base64:selectorSchema,bytes:{const:true},mimeType:{type:'string'},durationS:selectorSchema,metadata:receiptSchema},['kind'])},data:selectorSchema,usage:receiptSchema,
},['type','submit','outputs'])},['version','id','capability','inputSchema','execution']));
function errorText(v:ValidateFunction){return (v.errors??[]).map(e=>`${e.instancePath||'/'} ${e.message}${e.params.additionalProperty?' ('+e.params.additionalProperty+')':''}`).join('; ');}
const forbidden=new Set(['__proto__','prototype','constructor']);
function safeData(value:unknown):void {
  assertJson(value);
  const walk=(v:JsonValue):void=>{if(v&&typeof v==='object')for(const [key,x] of Object.entries(v)){if(forbidden.has(key))throw Error(`Unsafe property: ${key}`);walk(x);}};
  walk(value);
}
function parts(path:string):string[]{
  if(path===''||path==='$')return [];
  const p=path.replace(/^\$\./,'').replace(/\[(\d+)\]/g,'.$1');
  if(!/^[\w$-]+(?:\.[\w$-]+)*$/.test(p)||p.split('.').some(k=>forbidden.has(k)))throw Error(`Unsupported data path: ${path}`);
  return p.split('.');
}
export function readPath(value:unknown,path:string):unknown {return parts(path).reduce<unknown>((v,k)=>v&&typeof v==='object'&&Object.hasOwn(v,k)?(v as Record<string,unknown>)[k]:undefined,value);}
function checkSelector(value:ResponseSelector){for(const path of typeof value==='string'?[value]:value)parts(path);}
function select(value:unknown,path:ResponseSelector):unknown {for(const p of typeof path==='string'?[path]:path){const found=readPath(value,p);if(found!==undefined&&found!==null)return found;}return undefined;}
function selectFields(value:unknown,fields:Record<string,ResponseSelector>|undefined):JsonObject {const result:JsonObject={};for(const [key,path] of Object.entries(fields??{})){const found=select(value,path);if(found!==undefined){safeData(found);result[key]=found as JsonValue;}}return result;}
function checkTemplate(value:JsonValue,phase:'submit'|'later'){
  if(value===null||typeof value!=='object')return;
  if(Array.isArray(value)){value.forEach(v=>checkTemplate(v,phase));return;}
  const keys=Object.keys(value),op=keys.find(k=>k.startsWith('$'));
  if(!op){Object.values(value).forEach(v=>checkTemplate(v,phase));return;}
  if(['$input','$connection','$receipt','$item'].includes(op)){
    if(keys.some(k=>k!==op&&k!=='optional')||typeof value[op]!=='string'||value.optional!==undefined&&typeof value.optional!=='boolean')throw Error(`Invalid ${op} expression`);
    parts(value[op] as string);if(phase==='later'&&op==='$input')throw Error('Polling and collection must use receipt fields, not original input');return;
  }
  if(op==='$requestId'&&value[op]===true&&keys.every(k=>k===op||k==='optional'))return;
  if(keys.length!==1)throw Error(`Invalid ${op} expression`);
  if(['$merge','$concat'].includes(op)&&Array.isArray(value[op])){(value[op] as JsonValue[]).forEach(v=>checkTemplate(v,phase));return;}
  const v=value[op];if(!v||typeof v!=='object'||Array.isArray(v))throw Error(`Invalid ${op} expression`);
  if(op==='$media'&&['image','video','audio'].includes(String(v.kind))&&Object.keys(v).every(k=>['id','kind'].includes(k))&&v.id!==undefined){checkTemplate(v.id,phase);return;}
  if(op==='$map'&&Object.keys(v).every(k=>['items','value'].includes(k))&&v.items!==undefined&&v.value!==undefined){checkTemplate(v.items,phase);checkTemplate(v.value,phase);return;}
  if(op==='$if'&&Object.keys(v).every(k=>['value','equals','then','else'].includes(k))&&v.value!==undefined&&v.then!==undefined){checkTemplate(v.value,phase);checkTemplate(v.then,phase);if(v.else!==undefined)checkTemplate(v.else,phase);return;}
  throw Error(`Unsupported template operator: ${op}`);
}
export function parseModelSpec(source:string|unknown):ModelSpec {
  let value:unknown=source;
  if(typeof source==='string'){
    const doc=parseDocument(source,{uniqueKeys:true,strict:true,version:'1.2'});
    if(doc.errors.length||doc.warnings.length)throw Error([...doc.errors,...doc.warnings].map(e=>e.message).join('; '));
    value=doc.toJS({maxAliasCount:0});
  }
  safeData(value);if(!specValidator(value))throw Error(errorText(specValidator));
  const spec=structuredClone(value) as unknown as ModelSpec,e=spec.execution;
  if(forbidden.has(spec.id))throw Error('Invalid model ID');
  if(spec.inputSchema.type!=='object')throw Error('inputSchema must describe an object');
  // Compile eagerly: unknown schema keywords and unresolved references are errors, never ignored constraints.
  ajv.compile(spec.inputSchema);ajv.removeSchema(spec.inputSchema);
  if(spec.inputSchema.$async)throw Error('Async schemas are not supported');
  if(e.type==='async-http'&&(!e.poll||!e.receipt?.id))throw Error('Async execution requires a receipt ID and polling');
  if(e.type==='sync-http'&&(e.poll||e.collect||e.receipt))throw Error('Synchronous execution returns its result directly');
  if(e.auth?.type==='header'&&!e.auth.header)throw Error('Header authentication needs a header name');
  if(e.auth?.header&&!/^[a-zA-Z0-9-]+$/.test(e.auth.header))throw Error('Invalid authentication header');
  if(!e.outputs.length&&!e.data)throw Error('Declare media outputs or structured data');
  const checkStep=(s:HttpStep,phase:'submit'|'later')=>{
    if(!s.path.startsWith('/')||s.path.startsWith('//')||s.path.includes('\\')||s.path.includes('#')||s.path.split('/').some(p=>p==='..'))throw Error('Request paths must be relative to the connection Base URL');
    for(const m of s.path.matchAll(/\{([^{}]+)\}/g)){if(!m[1].startsWith('receipt.'))throw Error('Path variables must refer to receipt fields');parts(m[1].slice(8));}
    if(s.path.replace(/\{[^{}]+\}/g,'').match(/[{}]/))throw Error('Invalid path template');
    if(s.method==='GET'&&s.body!==undefined)throw Error('GET requests cannot have a body');
    if(s.body!==undefined)checkTemplate(s.body,phase);if(s.query)checkTemplate(s.query,phase);
    for(const [k,v] of Object.entries(s.headers??{}))if(!['accept','content-type'].includes(k.toLowerCase())||/[\r\n]/.test(v))throw Error('Only Accept and Content-Type constants belong in request headers; configure authentication separately');
    if(s.error){checkSelector(s.error.path);if(s.error.message)checkSelector(s.error.message);}
    if(s.errorMessage)checkSelector(s.errorMessage);if(s.responseSchema){ajv.compile(s.responseSchema);ajv.removeSchema(s.responseSchema);}
  };
  checkStep(e.submit,'submit');if(e.poll){checkStep(e.poll,'later');checkSelector(e.poll.status);if(e.poll.errorMessage)checkSelector(e.poll.errorMessage);const states=Object.values(e.poll.states).flat();if(new Set(states).size!==states.length)throw Error('Task states must not overlap');}
  if(e.collect)checkStep(e.collect,'later');
  for(const mapping of [e.receipt,e.poll?.receipt])for(const [key,path] of Object.entries(mapping??{})){if(forbidden.has(key)||key.includes('.'))throw Error('Receipt field names must be simple keys');checkSelector(path);}
  for(const o of e.outputs){if(['url','hex','base64','bytes'].filter(k=>Object.hasOwn(o,k)).length!==1)throw Error('Each output needs exactly one source');for(const k of ['url','hex','base64','each','durationS'] as const)if(o[k])checkSelector(o[k]!);}
  if(e.data)checkSelector(e.data);for(const mapping of [...e.outputs.map(o=>o.metadata),e.usage])for(const path of Object.values(mapping??{}))checkSelector(path);for(const path of Object.values(spec.timeline??{}))if(path)parts(path);
  return spec;
}
export const serializeModelSpec=(spec:ModelSpec)=>stringify(parseModelSpec(spec),{aliasDuplicateObjects:false});
export function modelInput(spec:ModelSpec,input:JsonObject):JsonObject {
  safeData(input);const result=structuredClone(input),validate=ajv.compile(spec.inputSchema);ajv.removeSchema(spec.inputSchema);
  if(!validate(result))throw Error(errorText(validate));return result;
}
type Environment={input:JsonObject;connection:ModelConnection;receipt?:JsonObject;requestId?:string;item?:JsonValue;call:ProviderCall;preview?:boolean};
async function template(value:JsonValue,env:Environment):Promise<JsonValue|undefined>{
  if(value===null||typeof value!=='object')return value;
  if(Array.isArray(value)){const result:JsonValue[]=[];for(const v of value){const x=await template(v,env);if(x!==undefined)result.push(x);}return result;}
  for(const [op,root] of [['$input',env.input],['$connection',env.connection],['$receipt',env.receipt],['$item',env.item]] as const)if(Object.hasOwn(value,op)){
    const found=readPath(root,value[op] as string);if(found===undefined&&!value.optional)throw Error(`Missing ${op} value: ${value[op]}`);return found as JsonValue|undefined;
  }
  if(value.$merge||value.$concat){const values=[];for(const v of (value.$merge??value.$concat) as JsonValue[]){const x=await template(v,env);if(x!==undefined)values.push(x);}if(value.$concat){if(values.some(v=>!Array.isArray(v)))throw Error('$concat needs arrays');return (values as JsonValue[][]).flat();}const out:JsonObject={};for(const x of values){if(!x||typeof x!=='object'||Array.isArray(x))throw Error('$merge needs objects');Object.assign(out,x);}return out;}
  if(value.$requestId){if(!env.requestId&&!value.optional)throw Error('A requestId is required by this model');return env.requestId;}
  if(value.$media){const m=value.$media as JsonObject,id=await template(m.id,env);if(id===undefined)return;if(typeof id!=='string'||!id)throw Error('Media inputs must use project reference IDs');if(env.preview)return `[media:${m.kind}:${id}]`;if(!env.call.resources)throw Error('Media reference transport is unavailable');return env.call.resources.urlFor(id,m.kind as MediaKind);}
  if(value.$map){const m=value.$map as JsonObject,items=await template(m.items,env);if(items===undefined)return;if(!Array.isArray(items))throw Error('$map needs an array');const out:JsonValue[]=[];for(const item of items){const x=await template(m.value,{...env,item});if(x!==undefined)out.push(x);}return out;}
  if(value.$if){const c=value.$if as JsonObject,v=await template(c.value,env),yes=Object.hasOwn(c,'equals')?JSON.stringify(v)===JSON.stringify(c.equals):v!==undefined&&v!==null&&v!==false;return yes?template(c.then,env):c.else===undefined?undefined:template(c.else,env);}
  const out:JsonObject={};for(const [k,v] of Object.entries(value)){const x=await template(v,env);if(x!==undefined)out[k]=x;}return out;
}
function baseUrl(connection:ModelConnection){const url=new URL(connection.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Base URL must be HTTP(S) without credentials, query or fragment');return url.href.replace(/\/+$/,'');}
async function compileStep(step:HttpStep,env:Environment){
  const path=step.path.replace(/\{receipt\.([^{}]+)\}/g,(_,key)=>{const value=readPath(env.receipt,key);if(typeof value!=='string'&&typeof value!=='number')throw Error(`Missing receipt path value: ${key}`);return encodeURIComponent(String(value)).replace(/\./g,'%2E');});
  const base=baseUrl(env.connection),url=new URL(base+path);
  if(url.origin!==new URL(base).origin)throw Error('Request escaped its configured connection');
  if(step.query)for(const [k,v] of Object.entries((await template(step.query,env)) as JsonObject)){if(v===null||typeof v==='object')throw Error('Query values must be scalar');url.searchParams.set(k,String(v));}
  return {url:url.href,method:step.method,headers:{...(step.body!==undefined?{'content-type':'application/json'}:{}),...step.headers},...(step.body!==undefined?{body:await template(step.body,env)}:{})};
}
export async function previewModelRequest(spec:ModelSpec,connection:ModelConnection,input:JsonObject,requestId?:string){
  const normalized=modelInput(spec,input),request=await compileStep(spec.execution.submit,{input:normalized,connection:mappingConnection(connection),requestId,call:{},preview:true});
  return {input:normalized,request:{...request,headers:{...request.headers,...(spec.execution.auth?.type==='none'?{}:{[spec.execution.auth?.type==='header'?spec.execution.auth.header!:'authorization']:'[credential]'})}}};
}
function readReceipt(mapping:Record<string,ResponseSelector>|undefined,response:unknown,prior:JsonObject={}):JsonObject {
  const result={...prior};for(const [key,path] of Object.entries(mapping??{})){const v=select(response,path);if(v===undefined)throw Error(`Response has no receipt field: ${path}`);safeData(v);result[key]=v as JsonValue;}return result;
}
function resultOf(spec:ModelSpec,response:unknown):ProviderResult {
  const outputs:ProviderResult['outputs']=[];
  for(const o of spec.execution.outputs){
    const items=o.each?select(response,o.each):[response];if(!Array.isArray(items))throw Error('Output collection is not an array');
    for(const item of items){let source:ProviderResult['outputs'][number]['source'];
      if(o.url){const v=select(item,o.url);if(typeof v!=='string'||!['https:','http:'].includes(new URL(v).protocol))throw Error('Output URL is missing or invalid');source={kind:'url',url:v};}
      else if(o.bytes){if(!(item instanceof Uint8Array))throw Error('Expected binary response');source={kind:'bytes',bytes:item};}
      else {const v=select(item,(o.hex??o.base64)!);if(typeof v!=='string'||!v.length)throw Error('Encoded output is missing');let bytes:Uint8Array;
        if(o.hex){if(v.length%2||!/^[\da-f]+$/i.test(v))throw Error('Invalid hex output');bytes=new Uint8Array(v.length/2);for(let n=0;n<bytes.length;n++)bytes[n]=parseInt(v.slice(n*2,n*2+2),16);}
        else {if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v))throw Error('Invalid base64 output');bytes=Uint8Array.from(atob(v),c=>c.charCodeAt(0));}source={kind:'bytes',bytes};}
      const duration=o.durationS?select(item,o.durationS):undefined;if(duration!==undefined&&(typeof duration!=='number'||!Number.isFinite(duration)||duration<=0))throw Error('Invalid output duration');
      outputs.push({kind:o.kind,source,...(o.metadata?{metadata:selectFields(item,o.metadata)}:{}),...(o.mimeType?{mimeType:o.mimeType}:{}),...(typeof duration==='number'?{durationS:duration}:{})});
    }
  }
  const data=spec.execution.data?select(response,spec.execution.data):undefined;if(spec.execution.data&&data===undefined)throw Error('Structured output is missing');if(data!==undefined)safeData(data);
  return {outputs,...(spec.execution.usage?{usage:selectFields(response,spec.execution.usage)}:{}),...(data!==undefined?{data:data as JsonValue}:{})};
}
/** Compile one exact model configuration into the existing provider lifecycle. */
export function declarativeProvider(source:ModelSpec):ProviderDefinition {
  const spec=parseModelSpec(source),e=spec.execution;
  return {id:'declarative:'+spec.id,label:spec.label??spec.id,apiVersion:1,capabilities:[spec.capability],credentials:e.auth?.type==='none'?[]:[{name:'apiKey',required:true}],configSchema:{type:'object'},create(context:ProviderContext){
    const connection=mappingConnection(context.config as ModelConnection);baseUrl(connection);
    const environment=(call:ProviderCall,input:JsonObject={},receipt?:ProviderReceipt):Environment=>({input,connection,call,requestId:call.requestId,receipt:receipt?{...receipt.state,id:receipt.id}:undefined});
    const send=async(step:HttpStep,env:Environment,phase:'execute'|'submit'|'poll'|'collect')=>{
      let req:Awaited<ReturnType<typeof compileStep>>;
      try{req=await compileStep(step,env);}catch(error){throw new ProviderError({phase:'validate',code:'INVALID_MAPPING',message:String(error instanceof Error?error.message:error),outcome:'rejected',retryable:false});}
      const headers:Record<string,string>={...req.headers};if(e.auth?.type!=='none'){const key=await context.credentials.get('apiKey');headers[e.auth?.type==='header'?e.auth.header!:'authorization']=(e.auth?.type==='header'?e.auth.prefix??'':'Bearer ')+key;}
      env.call.signal?.throwIfAborted();const response=await context.fetch(req.url,{method:req.method,headers,body:req.body===undefined?undefined:JSON.stringify(req.body),signal:env.call.signal,redirect:'error'});
      if(!response.ok){const json=await response.json().catch(()=>null),detail=step.errorMessage?select(json,step.errorMessage):undefined;throw new ProviderError({phase,code:'MODEL_HTTP',message:`Model service HTTP ${response.status}${typeof detail==='string'?': '+detail:''}`,httpStatus:response.status,outcome:response.status>=400&&response.status<500?'rejected':'unknown',retryable:(phase==='poll'||phase==='collect')&&(response.status>=500||response.status===429)});}
      if(step.response==='bytes')return new Uint8Array(await response.arrayBuffer());
      const json:unknown=await response.json();safeData(json);
      if(step.error){const code=select(json,step.error.path);if(!(step.error.optional&&code===undefined)&&JSON.stringify(code)!==JSON.stringify(step.error.success))throw new ProviderError({phase,code:'MODEL_REJECTED',message:step.error.message?String(select(json,step.error.message)??'Model rejected request'):'Model rejected request',outcome:'rejected',retryable:false});}
      if(step.responseSchema){const validate=ajv.compile(step.responseSchema);ajv.removeSchema(step.responseSchema);if(!validate(json))throw new ProviderError({phase,code:'INVALID_RESPONSE',message:errorText(validate),outcome:'unknown',retryable:false});}return json;
    };
    const decode=(data:unknown,phase:'execute'|'poll'|'collect')=>{try{return resultOf(spec,data);}catch(error){throw new ProviderError({phase,code:'INVALID_RESULT',message:String(error instanceof Error?error.message:error),outcome:'unknown',retryable:false});}};
    const validate=(input:JsonObject)=>{try{modelInput(spec,input);return {supported:true as const};}catch(error){return {supported:false as const,reason:String(error instanceof Error?error.message:error)};}};
    const common={models:()=>[{id:spec.id,label:spec.label,capability:spec.capability,inputSchema:spec.inputSchema,outputKinds:[...new Set(e.outputs.map(o=>o.kind))],validate}],supports:(r:{model:string;capability:string;input:JsonObject})=>r.model!==spec.id||r.capability!==spec.capability?{supported:false as const,reason:'Model/capability mismatch'}:validate(r.input)};
    if(e.type==='sync-http')return {...common,execute:async(r,call)=>decode(await send(e.submit,environment(call,modelInput(spec,r.input)),'execute'),'execute')};
    return {...common,
      submit:async(r,call)=>{const values=readReceipt(e.receipt,await send(e.submit,environment(call,modelInput(spec,r.input)),'submit'));if(typeof values.id!=='string'&&typeof values.id!=='number')throw Error('Invalid task ID');const {id,...state}=values;return {id:String(id),state};},
      poll:async(receipt,call)=>{const data=await send(e.poll!,environment(call,{},receipt),'poll'),status=select(data,e.poll!.status);if(typeof status!=='string')throw new ProviderError({phase:'poll',code:'UNKNOWN_STATUS',message:'Task status is missing',outcome:'unknown',retryable:false});
        if(e.poll!.states.failed.includes(status))return {state:'failed',error:{phase:'poll',code:'MODEL_FAILED',message:e.poll!.errorMessage?String(select(data,e.poll!.errorMessage)??'Model task failed'):'Model task failed',outcome:'rejected',retryable:false}};
        if(e.poll!.states.running.includes(status))return {state:'running',status};
        if(!e.poll!.states.succeeded.includes(status))throw new ProviderError({phase:'poll',code:'UNKNOWN_STATUS',message:`Unknown task status: ${status}`,outcome:'unknown',retryable:false});
        if(e.collect){const state=readReceipt(e.poll!.receipt,data,receipt.state);return {state:'ready',receipt:{...receipt,state}};}
        return {state:'succeeded',result:decode(data,'poll')};
      },
      ...(e.collect?{collect:async(receipt:ProviderReceipt,call:ProviderCall)=>decode(await send(e.collect!,environment(call,{},receipt),'collect'),'collect')}:{}),
    };
  }};
}
