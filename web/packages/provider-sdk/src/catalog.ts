/** Editable model presets. Protocol identity is independent from the model vendor. */
import type {JsonObject} from './index';
import type {VideoModelCapabilities} from './video';
export type ParameterValue=string|number|boolean;
export interface ParameterField {key:string;label:string;type:'text'|'number'|'boolean'|'select';options?:ParameterValue[];min?:number;max?:number;integer?:boolean;required?:boolean;default?:ParameterValue}
export interface ModelSettings {presetId?:string;defaults?:Record<string,ParameterValue>;parameters?:ParameterField[];capabilities?:VideoModelCapabilities}
export interface ModelPreset {id:string;label:string;protocol:string;model:string;kind:'video'|'speech'|'music';baseUrl?:string;capabilities?:VideoModelCapabilities;defaults:Record<string,ParameterValue>;parameters:ParameterField[];references?:{first?:boolean;last?:boolean;images?:number|null;videos?:number|null;audios?:number|null;exclusiveFrames?:boolean;audioNeedsVisual?:boolean}}
const ratios=['adaptive','21:9','16:9','4:3','1:1','3:4','9:16'];
const range=(a:number,b:number)=>Array.from({length:b-a+1},(_,i)=>a+i);
const flag=(key:string,label:string,defaultValue?:boolean):ParameterField=>({key,label,type:'boolean',...(defaultValue===undefined?{}:{default:defaultValue})});
const voice:ParameterField[]=[{key:'voice',label:'Voice ID',type:'text',default:'male-qn-jingying'},{key:'speed',label:'Speaking speed',type:'number',min:.5,max:2,default:1},{key:'volume',label:'Volume',type:'number',min:0,max:10},{key:'pitch',label:'Pitch',type:'number',min:-12,max:12,integer:true},{key:'emotion',label:'Emotion',type:'select',options:['happy','sad','angry','fearful','disgusted','surprised','calm','fluent']},{key:'languageBoost',label:'Language / dialect',type:'text'}];
export const MODEL_PRESETS:readonly ModelPreset[]=[
 {id:'task-generic',label:'Custom video · Task API',protocol:'task-api',model:'',kind:'video',defaults:{},parameters:[],references:{first:true,last:true,images:null,videos:null,audios:null}},
 {id:'minimax-h3',label:'MiniMax H3 · Task API',protocol:'task-api',model:'minimax-h3',kind:'video',capabilities:{durationsS:range(4,15),ratios,resolutions:['2K','768P'],imageToVideo:true,audio:false},defaults:{resolution:'2K',ratio:'adaptive',generateAudio:false},parameters:[],references:{first:true,last:true,images:9,videos:3,audios:3,exclusiveFrames:true,audioNeedsVisual:true}},
 ...['seedance-2','seedance-2-mini'].map(model=>({id:model,label:`${model} · Task API`,protocol:'task-api',model:model==='seedance-2'?'seedance-2.0':'seedance-2.0-mini',kind:'video' as const,capabilities:{durationsS:range(4,15),ratios,resolutions:['480p','720p','1080p'],imageToVideo:true,audio:true},defaults:{resolution:'720p',ratio:'16:9',generateAudio:true},parameters:[flag('human_review','Human review')],references:{first:true,last:true,images:9,videos:3,audios:3,exclusiveFrames:true,audioNeedsVisual:true}})),
 {id:'seedance-2.5',label:'Seedance 2.5 · Task API',protocol:'task-api',model:'seedance-2.5',kind:'video',capabilities:{durationsS:range(4,30),ratios,resolutions:['480p','720p','1080p'],imageToVideo:true,audio:true},defaults:{resolution:'720p',ratio:'adaptive',generateAudio:true,output_format:'mp4'},parameters:[{key:'output_format',label:'Output format',type:'select',options:['mp4'],default:'mp4'},flag('human_review','Human review')],references:{images:30,videos:10,audios:10}},
 {id:'ark-seedance',label:'Seedance · Ark content tasks',protocol:'ark-video',model:'',kind:'video',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',defaults:{resolution:'720p',ratio:'16:9'},parameters:[{key:'seed',label:'Seed',type:'number',integer:true},flag('watermark','Watermark'),flag('camera_fixed','Fixed camera')],references:{first:true,last:true,images:9,videos:3,audios:3,exclusiveFrames:true}},
 {id:'hailuo-2.3',label:'MiniMax Hailuo 2.3 · Video API',protocol:'minimax-video',model:'MiniMax-Hailuo-2.3',kind:'video',baseUrl:'https://api.minimax.io',capabilities:{durationsS:[6,10],resolutions:['768P','1080P'],imageToVideo:true,audio:false},defaults:{resolution:'768P'},parameters:[flag('prompt_optimizer','Optimize prompt',true)],references:{first:true}},
 ...['speech-2.8-hd','speech-2.8-turbo'].map(model=>({id:model,label:`MiniMax ${model} · Speech API`,protocol:'minimax-speech',model,kind:'speech' as const,baseUrl:'https://api.minimax.io',defaults:{voice:'male-qn-jingying',speed:1},parameters:voice})),
 {id:'music-2.5',label:'MiniMax Music 2.5 · Music API',protocol:'minimax-music',model:'music-2.5',kind:'music',baseUrl:'https://api.minimax.io',defaults:{sampleRate:44100,bitrate:256000},parameters:[{key:'sampleRate',label:'Sample rate',type:'select',options:[16000,24000,32000,44100]},{key:'bitrate',label:'Bitrate',type:'select',options:[32000,64000,128000,256000]},flag('watermark','Audio watermark')]},
];
export const modelPreset=(id?:string)=>MODEL_PRESETS.find(p=>p.id===id);
const unsafe=/url|uri|endpoint|token|secret|api.?key|authorization|reference|frame/i;
const reserved=new Set(['model','prompt','duration','durationS','resolution','ratio','generateAudio','generate_audio','parameters','__proto__','constructor','prototype']);
export function validateParameterFields(fields:ParameterField[]):void {
 if(!Array.isArray(fields))throw Error('Parameter definitions must be an array');const keys=new Set<string>();
 for(const f of fields){if(!f||!/^[_a-zA-Z][a-zA-Z0-9_]*$/.test(f.key)||reserved.has(f.key)||unsafe.test(f.key)||keys.has(f.key))throw Error(`Invalid or reserved parameter key: ${f?.key}`);keys.add(f.key);if(!['text','number','boolean','select'].includes(f.type)||typeof f.label!=='string')throw Error('Invalid parameter definition');if(f.type==='select'&&(!f.options?.length||f.options.some(v=>!['string','number','boolean'].includes(typeof v))))throw Error('Select options are required');for(const v of [f.min,f.max])if(v!==undefined&&!Number.isFinite(v))throw Error('Parameter bounds must be finite');if(f.min!==undefined&&f.max!==undefined&&f.min>f.max)throw Error('Invalid parameter bounds');}
}
export function parameterFields(settings?:ModelSettings):ParameterField[]{const preset=modelPreset(settings?.presetId);const map=new Map((preset?.parameters??[]).map(f=>[f.key,f]));for(const f of settings?.parameters??[])map.set(f.key,f);const fields=[...map.values()];validateParameterFields(fields);return fields;}
export function parameterDefaults(settings?:ModelSettings):Record<string,ParameterValue>{return {...modelPreset(settings?.presetId)?.defaults,...Object.fromEntries(parameterFields(settings).filter(f=>f.default!==undefined).map(f=>[f.key,f.default!])),...settings?.defaults};}
export function validateParameters(values:Record<string,unknown>,fields:ParameterField[]):void {
 validateParameterFields(fields);for(const key of Object.keys(values))if(!fields.some(f=>f.key===key))throw Error(`Parameter is not configured for this model: ${key}`);
 for(const f of fields){const v=values[f.key];if(v===undefined){if(f.required)throw Error(`${f.label} is required`);continue;}
 if(f.type==='boolean'&&typeof v!=='boolean'||f.type==='text'&&typeof v!=='string'||f.type==='select'&&!f.options?.includes(v as ParameterValue)||f.type==='number'&&(typeof v!=='number'||!Number.isFinite(v)||f.integer&&!Number.isInteger(v)||f.min!==undefined&&v<f.min||f.max!==undefined&&v>f.max))throw Error(`Invalid ${f.label}`);}
}
export function validateVideoModel(settings:ModelSettings|undefined,input:JsonObject):void {
 if(input.durationS!==undefined&&(typeof input.durationS!=='number'||!Number.isFinite(input.durationS)||input.durationS<=0))throw Error('Source duration must be a positive number');
 for(const key of ['ratio','resolution','firstFrameReferenceId','lastFrameReferenceId'])if(input[key]!==undefined&&(typeof input[key]!=='string'||!input[key]))throw Error(`Invalid ${key}`);
 for(const key of ['referenceImageIds','referenceVideoIds','referenceAudioIds'])if(input[key]!==undefined&&(!Array.isArray(input[key])||(input[key] as unknown[]).some(id=>typeof id!=='string'||!id)))throw Error(`Invalid ${key}`);
 if(input.generateAudio!==undefined&&typeof input.generateAudio!=='boolean')throw Error('generateAudio must be boolean');
 if(input.parameters!==undefined&&(!input.parameters||typeof input.parameters!=='object'||Array.isArray(input.parameters)))throw Error('Model parameters must be an object');
 const preset=modelPreset(settings?.presetId),refs=preset?.references;
 const params=(input.parameters??{}) as Record<string,unknown>;validateParameters(params,parameterFields(settings));
 if(!preset)return;
 const caps={...preset.capabilities,...settings?.capabilities};
 if(input.durationS!==undefined&&caps?.durationsS&&!caps.durationsS.includes(Number(input.durationS)))throw Error('Duration is not supported by this model preset');
 if(input.resolution!==undefined&&caps?.resolutions&&!caps.resolutions.includes(String(input.resolution)))throw Error('Resolution is not supported by this model preset');
 if(input.ratio!==undefined&&caps?.ratios&&!caps.ratios.includes(String(input.ratio)))throw Error('Aspect ratio is not supported by this model preset');
 if(input.generateAudio===true&&caps?.audio===false)throw Error('This model preset does not support generated audio');
 const first=!!input.firstFrameReferenceId,last=!!input.lastFrameReferenceId,counts=['referenceImageIds','referenceVideoIds','referenceAudioIds'].map(k=>Array.isArray(input[k])?(input[k] as unknown[]).length:0);
 if(first&&!refs?.first||last&&!refs?.last)throw Error('This model preset does not support the selected frame role');
 if(last&&!first&&preset.id!=='task-generic'&&preset.id!=='ark-seedance')throw Error('A last frame requires a first frame');
 for(let i=0;i<3;i++)if([refs?.images,refs?.videos,refs?.audios][i]!==null&&counts[i]>([refs?.images,refs?.videos,refs?.audios][i]??0))throw Error('Too many or unsupported reference inputs for this model');
 if(refs?.exclusiveFrames&&(first||last)&&counts.some(Boolean))throw Error('First/last frames cannot be combined with multimodal references');
 if(refs?.audioNeedsVisual&&counts[2]&&!counts[0]&&!counts[1])throw Error('Audio references require image or video references');
 if(preset.id==='hailuo-2.3'&&input.resolution==='1080P'&&input.durationS!==6)throw Error('Hailuo 1080P supports a 6-second source; choose 768P for 10 seconds');
}
