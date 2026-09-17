/** Built-in definitions are data recipes executed by the same YAML interpreter as user models. */
import {ProviderRegistry,type JsonObject,type JsonValue,type ProviderHost} from './index';
import {declarativeProvider,parseModelSpec,type ModelSpec} from './declarative';
import {MODEL_PRESETS,modelPreset,parameterFields,parameterDefaults,type ModelSettings,type ParameterField} from './catalog';

const input=(key:string,optional=true):JsonObject=>({$input:key,...(optional?{optional:true}:{})});
const media=(key:string,kind='image'):JsonObject=>({$media:{id:input(key),kind}});
const mediaArray=(key:string,kind:string):JsonObject=>({$map:{items:input(key),value:{$media:{id:{$item:''},kind}}}});
const object=(properties:JsonObject,required:string[]=[]):JsonObject=>({type:'object',properties,required,additionalProperties:false});
const text:JsonObject={type:'string',minLength:1};
const paths=(field:string)=>['$.data.'+field,'$.'+field];
const miniError={path:'$.base_resp.status_code',success:0,optional:true,message:'$.base_resp.status_msg'};
const videoFields:JsonObject={prompt:{type:'string',pattern:'\\S'},durationS:{type:'number',exclusiveMinimum:0},ratio:text,resolution:text,generateAudio:{type:'boolean'},firstFrameReferenceId:text,lastFrameReferenceId:text,referenceImageIds:{type:'array',items:text},referenceVideoIds:{type:'array',items:text},referenceAudioIds:{type:'array',items:text},parameters:object({})};
const videoParams:JsonObject={prompt:input('prompt',false),duration:input('durationS'),ratio:input('ratio'),resolution:input('resolution'),generate_audio:input('generateAudio'),first_frame_image:media('firstFrameReferenceId'),last_frame_image:media('lastFrameReferenceId'),reference_images:mediaArray('referenceImageIds','image'),reference_videos:mediaArray('referenceVideoIds','video'),reference_audios:mediaArray('referenceAudioIds','audio')};
const arkItems=(key:string,kind:string,role:string,multiple:boolean):JsonValue=>multiple?{$map:{items:input(key),value:{type:kind+'_url',[kind+'_url']:{url:{$media:{id:{$item:''},kind}}},role}}}:{$if:{value:input(key),then:[{type:kind+'_url',[kind+'_url']:{url:media(key,kind)},role}]}};

const taskIdShape={type:'object',anyOf:['task_id','id'].map(k=>({required:[k],properties:{[k]:text}}))};
interface Recipe {label:string;kind:'video'|'speech'|'music';baseSuffix?:string;defaultPreset:string;spec:Omit<ModelSpec,'id'|'version'|'label'>}
export const BUILTIN_PROTOCOLS:Readonly<Record<string,Recipe>>={
 'task-api':{label:'Async task API',kind:'video',baseSuffix:'/api/v1',defaultPreset:'task-generic',spec:{capability:'video.generate',timeline:{prompt:'prompt',duration:'durationS'},inputSchema:object(videoFields,['prompt']),execution:{type:'async-http',
   submit:{method:'POST',path:'/api/v1/tasks',body:{model:{$connection:'remoteModel'},params:{$merge:[input('parameters'),videoParams]}},errorMessage:['$.detail.message','$.message'],responseSchema:{type:'object',anyOf:[...taskIdShape.anyOf,{required:['data'],properties:{data:taskIdShape}}]}},
   receipt:{id:[...paths('task_id'),...paths('id')]},poll:{method:'GET',path:'/api/v1/tasks/{receipt.id}',status:paths('status'),states:{running:['pending','processing','running','queued'],succeeded:['completed'],failed:['failed','canceled','cancelled','expired']},errorMessage:paths('error_message')},outputs:[{kind:'video',url:[...paths('result.video_url'),...paths('result.url')],durationS:paths('result.duration'),metadata:{resolution:paths('result.resolution'),ratio:paths('result.ratio')}}],usage:{cost:paths('cost')},
 }}},
 'ark-video':{label:'Ark content tasks',kind:'video',defaultPreset:'ark-seedance',spec:{capability:'video.generate',timeline:{prompt:'prompt',duration:'durationS'},inputSchema:object(videoFields,['prompt']),execution:{type:'async-http',
   submit:{method:'POST',path:'/contents/generations/tasks',body:{$merge:[input('parameters'),{model:{$connection:'remoteModel'},duration:input('durationS'),resolution:input('resolution'),ratio:input('ratio'),generate_audio:input('generateAudio'),content:{$concat:[[{type:'text',text:input('prompt',false)}],arkItems('firstFrameReferenceId','image','first_frame',false),arkItems('lastFrameReferenceId','image','last_frame',false),arkItems('referenceImageIds','image','reference_image',true),arkItems('referenceVideoIds','video','reference_video',true),arkItems('referenceAudioIds','audio','reference_audio',true)]}}]},errorMessage:'$.error.message'},
   receipt:{id:'$.id'},poll:{method:'GET',path:'/contents/generations/tasks/{receipt.id}',status:'$.status',states:{running:['queued','running'],succeeded:['succeeded'],failed:['failed','cancelled','expired']},errorMessage:'$.error.message'},outputs:[{kind:'video',url:'$.content.video_url'}],
 }}},
 'minimax-video':{label:'MiniMax Video API',kind:'video',baseSuffix:'/v1',defaultPreset:'hailuo-2.3',spec:{capability:'video.generate',timeline:{prompt:'prompt',duration:'durationS'},inputSchema:object({prompt:videoFields.prompt,durationS:videoFields.durationS,resolution:text,generateAudio:{const:false},firstFrameReferenceId:text,parameters:object({})},['prompt']),execution:{type:'async-http',
   submit:{method:'POST',path:'/v1/video_generation',body:{$merge:[input('parameters'),{model:{$connection:'remoteModel'},prompt:input('prompt',false),duration:input('durationS'),resolution:input('resolution'),first_frame_image:media('firstFrameReferenceId')}]},error:miniError},receipt:{id:'$.task_id'},
   poll:{method:'GET',path:'/v1/query/video_generation',query:{task_id:{$receipt:'id'}},status:'$.status',states:{running:['Preparing','Queueing','Processing'],succeeded:['Success'],failed:['Fail','Failed','Cancelled']},receipt:{fileId:'$.file_id'},error:miniError,errorMessage:'$.base_resp.status_msg'},
   collect:{method:'GET',path:'/v1/files/retrieve',query:{file_id:{$receipt:'fileId'}},error:miniError},outputs:[{kind:'video',url:'$.file.download_url'}],
 }}},
 'minimax-speech':{label:'MiniMax Speech API',kind:'speech',baseSuffix:'/v1',defaultPreset:'speech-2.8-hd',spec:{capability:'audio.synthesize',inputSchema:object({text:{type:'string',pattern:'\\S'},voice:{type:'string',minLength:1,default:'male-qn-jingying'},speed:{type:'number',minimum:.5,maximum:2,default:1},volume:{type:'number',minimum:0,maximum:10},pitch:{type:'integer',minimum:-12,maximum:12},emotion:{type:'string'},languageBoost:{type:'string'}},['text']),execution:{type:'sync-http',
   submit:{method:'POST',path:'/v1/t2a_v2',body:{model:{$connection:'remoteModel'},text:input('text',false),stream:false,voice_setting:{voice_id:input('voice',false),speed:input('speed',false),vol:input('volume'),pitch:input('pitch'),emotion:input('emotion')},language_boost:input('languageBoost'),audio_setting:{format:'mp3',sample_rate:32000}},error:miniError},outputs:[{kind:'audio',hex:'$.data.audio',mimeType:'audio/mpeg'}],
 }}},
 'minimax-music':{label:'MiniMax Music API',kind:'music',baseSuffix:'/v1',defaultPreset:'music-2.5',spec:{capability:'audio.generate',inputSchema:object({prompt:{type:'string',maxLength:2000,default:''},lyrics:{type:'string',pattern:'\\S',maxLength:3500},sampleRate:{enum:[16000,24000,32000,44100],default:44100},bitrate:{enum:[32000,64000,128000,256000],default:256000},watermark:{type:'boolean'}},['lyrics']),execution:{type:'sync-http',
   submit:{method:'POST',path:'/v1/music_generation',body:{model:{$connection:'remoteModel'},prompt:input('prompt',false),lyrics:input('lyrics',false),stream:false,output_format:'hex',audio_setting:{format:'mp3',sample_rate:input('sampleRate',false),bitrate:input('bitrate',false)},aigc_watermark:input('watermark')},error:miniError},outputs:[{kind:'audio',hex:'$.data.audio',mimeType:'audio/mpeg'}],
 }}},
};
function fieldSchema(f:ParameterField):JsonObject{return {title:f.label,...(f.type==='select'?{enum:f.options!}:{type:f.type==='text'?'string':f.type==='number'?(f.integer?'integer':'number'):'boolean'}),...(f.min!==undefined?{minimum:f.min}:{}),...(f.max!==undefined?{maximum:f.max}:{}),...(f.default!==undefined?{default:f.default}:{})};}
const nonempty=(key:string)=>({required:[key],properties:{[key]:{type:'array',minItems:1}}});
/** Convert saved channel settings to a self-contained, exportable definition; no network here. */
export function builtinModelSpec(protocol:string,model:string,settings?:ModelSettings):ModelSpec {
 const recipe=BUILTIN_PROTOCOLS[protocol];if(!recipe)throw Error(`Unknown model protocol: ${protocol}`);
 const selected=settings?.presetId??recipe.defaultPreset,preset=modelPreset(selected);if(!preset||preset.protocol!==protocol)throw Error('Model preset and protocol do not match');
 const effective={...settings,presetId:selected},spec:ModelSpec={version:1,id:model||selected,label:preset.label,...structuredClone(recipe.spec)},properties=spec.inputSchema.properties as JsonObject;
 const fields=parameterFields(effective),parameterSchema=object(Object.fromEntries(fields.map(f=>[f.key,fieldSchema(f)])),fields.filter(f=>f.required).map(f=>f.key));
 const defaults=parameterDefaults(effective);
 if(recipe.kind==='video'){
   properties.parameters=parameterSchema;
   const caps={...preset.capabilities,...settings?.capabilities},refs=preset.references,rules:JsonObject[]=[...preset.rules??[]];
   for(const [name,values] of [['durationS',caps.durationsS],['ratio',caps.ratios],['resolution',caps.resolutions]] as const)if(values&&properties[name])properties[name]={...(properties[name] as JsonObject),enum:values};
   if(caps.audio===false&&properties.generateAudio)properties.generateAudio={const:false};
   for(const [name,allowed] of [['firstFrameReferenceId',refs?.first],['lastFrameReferenceId',refs?.last]] as const)if(!allowed)delete properties[name];
   for(const [name,max] of [['referenceImageIds',refs?.images],['referenceVideoIds',refs?.videos],['referenceAudioIds',refs?.audios]] as const)if(properties[name]&&max!==null)properties[name]={...(properties[name] as JsonObject),maxItems:max??0};
   if(refs?.lastRequiresFirst)rules.push({dependencies:{lastFrameReferenceId:['firstFrameReferenceId']}});
   if(refs?.exclusiveFrames)rules.push({not:{allOf:[{anyOf:[{required:['firstFrameReferenceId']},{required:['lastFrameReferenceId']}]},{anyOf:['referenceImageIds','referenceVideoIds','referenceAudioIds'].map(nonempty)}]}});
   if(refs?.audioNeedsVisual)rules.push({if:nonempty('referenceAudioIds'),then:{anyOf:[nonempty('referenceImageIds'),nonempty('referenceVideoIds')]}});
   if(rules.length)spec.inputSchema.allOf=rules;
   const parameterDefaults:JsonObject={};for(const [key,value] of Object.entries(defaults)){const target=properties[key]?properties:parameterSchema.properties as JsonObject;if(!target[key])throw Error(`Default parameter is not declared: ${key}`);target[key]={...(target[key] as JsonObject),default:value};if(target!==properties)parameterDefaults[key]=value;}
   if(Object.keys(parameterDefaults).length)parameterSchema.default=parameterDefaults;
   if(preset.wire?.singleFirstFrameField){const params=structuredClone(videoParams);delete params.first_frame_image;(spec.execution.submit.body as JsonObject).params={$merge:[input('parameters'),params,{$if:{value:input('lastFrameReferenceId'),then:{first_frame_image:media('firstFrameReferenceId')},else:{[preset.wire.singleFirstFrameField]:media('firstFrameReferenceId')}}}]};}
   if(preset.wire?.idempotencyKey)(spec.execution.submit.body as JsonObject).idempotency_key={$requestId:true,optional:true};
 }else{
   for(const f of fields){if(!properties[f.key])throw Error(`Unsupported audio parameter: ${f.key}`);properties[f.key]={...(properties[f.key] as JsonObject),...fieldSchema(f)};}
   for(const [key,value] of Object.entries(defaults)){if(!properties[key])throw Error(`Default parameter is not declared: ${key}`);properties[key]={...(properties[key] as JsonObject),default:value};}
 }
 return parseModelSpec(spec);
}
/** Editor declarations use structured project references; legacy SDK inputs remain string IDs. */
export function builtinTemplates():ModelSpec[]{return MODEL_PRESETS.map(p=>{
 const spec=builtinModelSpec(p.protocol,p.id,{presetId:p.id}),properties=spec.inputSchema.properties as JsonObject;
 const roles:Record<string,string>={firstFrameReferenceId:'image',lastFrameReferenceId:'image',referenceImageIds:'image',referenceVideoIds:'video',referenceAudioIds:'audio'};
 for(const [key,kind] of Object.entries(roles))if(properties[key]){const field=properties[key] as JsonObject,ref={...object({$mediaRef:{type:'string',minLength:1},kind:{const:kind}},['$mediaRef','kind']),'x-media-kind':kind};properties[key]=field.type==='array'?{...field,items:ref}:ref;}
 const adapt=(value:JsonValue):void=>{if(!value||typeof value!=='object')return;if(!Array.isArray(value)&&value.$media){const id=(value.$media as JsonObject).id as JsonObject;if(typeof id?.$input==='string'&&roles[id.$input])id.$input+='.$mediaRef';if(id?.$item==='')id.$item='$mediaRef';}for(const child of Object.values(value))adapt(child);};
 if(spec.execution.submit.body)adapt(spec.execution.submit.body);return parseModelSpec(spec);
});}
export interface PresetConnectionOptions {baseUrl:string;apiKey?:string;endpoint?:string;groupId?:string;modelSettings?:ModelSettings;anonymous?:boolean}
/** Compatibility for existing SDK/channel inputs, backed entirely by the declarative executor. */
export function configurePresetModel(protocol:string,model:string,config:PresetConnectionOptions,host?:ProviderHost){
 const spec=builtinModelSpec(protocol,model,config.modelSettings),recipe=BUILTIN_PROTOCOLS[protocol];let base=config.baseUrl.replace(/\/+$/,'');
 if(recipe.baseSuffix&&base.endsWith(recipe.baseSuffix))base=base.slice(0,-recipe.baseSuffix.length);
 if(config.endpoint){const endpoint=new URL(config.endpoint,typeof location!=='undefined'?location.href:undefined);if(endpoint.username||endpoint.password||endpoint.hash)throw Error('Endpoint must use separate credentials');base=endpoint.origin;spec.execution.submit.path=endpoint.pathname;spec.execution.submit.query={...Object.fromEntries(endpoint.searchParams),...spec.execution.submit.query};}
 if(config.groupId)spec.execution.submit.query={...spec.execution.submit.query,GroupId:config.groupId};
 if(config.anonymous)spec.execution.auth={type:'none'};
 const definition=declarativeProvider(spec);
 return new ProviderRegistry().register(definition).create({id:definition.id,provider:definition.id,config:{baseUrl:base,remoteModel:model},...(config.anonymous?{}:{credentials:{apiKey:{store:'host',key:'configured-channel'}}})},host??{resolveCredential:async()=>config.apiKey});
}
