import {ProviderError,defineModel,type ProviderDefinition,type JsonObject,type Support} from '@velocut/provider-sdk';
export const minimaxSpeechInputSchema:JsonObject={type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',minLength:1},voice:{type:'string'},speed:{type:'number',minimum:.5,maximum:2},volume:{type:'number',minimum:0,maximum:10},pitch:{type:'integer',minimum:-12,maximum:12},emotion:{type:'string'},languageBoost:{type:'string'}}};
function validate(input:JsonObject):Support {
  if(Object.keys(input).some(k=>!['text','voice','speed','volume','pitch','emotion','languageBoost'].includes(k)))return {supported:false,reason:'Unsupported speech input field'};
  if(typeof input.text!=='string'||!input.text.trim())return {supported:false,reason:'Speech text is required'};
  if(input.voice!==undefined&&(typeof input.voice!=='string'||!input.voice))return {supported:false,reason:'voice must be a nonempty string'};
  if(input.speed!==undefined&&(typeof input.speed!=='number'||!Number.isFinite(input.speed)||input.speed<.5||input.speed>2))return {supported:false,reason:'Speech speed must be within 0.5–2'};
  if(input.volume!==undefined&&(typeof input.volume!=='number'||input.volume<0||input.volume>10))return {supported:false,reason:'Volume must be between 0 and 10'};
  if(input.pitch!==undefined&&(typeof input.pitch!=='number'||!Number.isInteger(input.pitch)||input.pitch< -12||input.pitch>12))return {supported:false,reason:'Pitch must be an integer between -12 and 12'};
  for(const key of ['emotion','languageBoost'])if(input[key]!==undefined&&typeof input[key]!=='string')return {supported:false,reason:'Invalid speech option'};
  return {supported:true};
}
/** MiniMax T2A wire transport. Returns encoded audio; decoding belongs to the host. */
export const minimaxProvider:ProviderDefinition={
  apiVersion:1,id:'minimax',label:'MiniMax speech',capabilities:['audio.synthesize'],credentials:[{name:'apiKey'}],
  configSchema:{type:'object',properties:{endpoint:{type:'string'},baseUrl:{type:'string'},groupId:{type:'string'},model:{type:'string'},voice:{type:'string'}},additionalProperties:false},
  create(context){
    const config=context.config;
    for(const [name,value] of Object.entries(config))if(!['endpoint','baseUrl','groupId','model','voice'].includes(name)||typeof value!=='string')throw Error('Invalid MiniMax configuration');
    const endpoint=String(config.endpoint??(config.baseUrl?String(config.baseUrl).replace(/\/+$/,'').replace(/\/v1$/,'')+'/v1/t2a_v2':'/minimax-proxy/v1/t2a_v2')),model=String(config.model??'speech-2.8-hd');
    if(!endpoint.startsWith('/')||endpoint.startsWith('//')){const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('MiniMax needs an HTTP(S) endpoint and separate credentials');}
    const definition=defineModel({id:model,capability:'audio.synthesize',inputSchema:minimaxSpeechInputSchema,outputKinds:['audio'],validate});
    return {
      models:()=>[definition],supports:request=>request.capability!=='audio.synthesize'||request.model!==model?{supported:false,reason:'Unsupported MiniMax model or capability'}:validate(request.input),
      async execute(request,call){
        const apiKey=await context.credentials.get('apiKey');call.signal?.throwIfAborted();
        const url=config.groupId?`${endpoint}${endpoint.includes('?')?'&':'?'}GroupId=${encodeURIComponent(String(config.groupId))}`:endpoint;
        const response=await context.fetch(url,{method:'POST',headers:{'content-type':'application/json',...(apiKey?{authorization:`Bearer ${apiKey}`}:{})},signal:call.signal,body:JSON.stringify({
          model:request.model,text:request.input.text,stream:false,
          voice_setting:{voice_id:request.input.voice??config.voice??'male-qn-jingying',speed:request.input.speed??1,...(request.input.volume!==undefined?{vol:request.input.volume}:{}),...(request.input.pitch!==undefined?{pitch:request.input.pitch}:{}),...(request.input.emotion?{emotion:request.input.emotion}:{})},...(request.input.languageBoost?{language_boost:request.input.languageBoost}:{}),audio_setting:{format:'mp3',sample_rate:32000},
        })});
        if(!response.ok)throw new ProviderError({phase:'execute',code:'MINIMAX_HTTP',httpStatus:response.status,message:`MiniMax HTTP ${response.status}`,outcome:response.status>=400&&response.status<500?'rejected':'unknown',retryable:response.status>=500||response.status===429});
        const json=await response.json() as {data?:{audio?:unknown};base_resp?:{status_code?:number;status_msg?:string}};
        if(json.base_resp?.status_code&&json.base_resp.status_code!==0)throw new ProviderError({phase:'execute',code:'MINIMAX_REJECTED',message:json.base_resp.status_msg??'MiniMax rejected speech generation',outcome:'rejected',retryable:false});
        const hex=json.data?.audio;if(typeof hex!=='string'||!hex.length||hex.length%2||!/^[0-9a-f]+$/i.test(hex))throw new ProviderError({phase:'execute',code:'INVALID_AUDIO',message:'MiniMax returned invalid audio',outcome:'unknown',retryable:false});
        const bytes=new Uint8Array(hex.length/2);for(let i=0;i<bytes.length;i++)bytes[i]=parseInt(hex.slice(i*2,i*2+2),16);
        return {outputs:[{kind:'audio',mimeType:'audio/mpeg',source:{kind:'bytes',bytes}}]};
      },
    };
  },
};
export {minimaxVideoProvider,minimaxMusicProvider} from './media';
