import {ProviderError,defineModel,type ProviderDefinition,type JsonObject,type Support} from '@velocut/provider-sdk';
export const minimaxSpeechInputSchema:JsonObject={type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',minLength:1},voice:{type:'string'},speed:{type:'number',minimum:.5,maximum:2}}};
function validate(input:JsonObject):Support {
  if(Object.keys(input).some(k=>!['text','voice','speed'].includes(k)))return {supported:false,reason:'Unsupported speech input field'};
  if(typeof input.text!=='string'||!input.text.trim())return {supported:false,reason:'Speech text is required'};
  if(input.voice!==undefined&&(typeof input.voice!=='string'||!input.voice))return {supported:false,reason:'voice must be a nonempty string'};
  if(input.speed!==undefined&&(typeof input.speed!=='number'||!Number.isFinite(input.speed)||input.speed<.5||input.speed>2))return {supported:false,reason:'Speech speed must be within 0.5–2'};
  return {supported:true};
}
/** MiniMax T2A wire transport. Returns encoded audio; decoding belongs to the host. */
export const minimaxProvider:ProviderDefinition={
  apiVersion:1,id:'minimax',label:'MiniMax speech',capabilities:['audio.synthesize'],credentials:[{name:'apiKey'}],
  configSchema:{type:'object',properties:{endpoint:{type:'string'},groupId:{type:'string'},model:{type:'string'},voice:{type:'string'}},additionalProperties:false},
  create(context){
    const config=context.config;
    for(const [name,value] of Object.entries(config))if(!['endpoint','groupId','model','voice'].includes(name)||typeof value!=='string')throw Error('Invalid MiniMax configuration');
    const endpoint=String(config.endpoint??'/minimax-proxy/v1/t2a_v2'),model=String(config.model??'speech-2.8-hd');
    if(!endpoint.startsWith('/')||endpoint.startsWith('//')){const url=new URL(endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('MiniMax needs an HTTP(S) endpoint and separate credentials');}
    const definition=defineModel({id:model,capability:'audio.synthesize',inputSchema:minimaxSpeechInputSchema,outputKinds:['audio'],validate});
    return {
      models:()=>[definition],supports:request=>request.capability!=='audio.synthesize'||request.model!==model?{supported:false,reason:'Unsupported MiniMax model or capability'}:validate(request.input),
      async execute(request,call){
        const apiKey=await context.credentials.get('apiKey');call.signal?.throwIfAborted();
        const url=config.groupId?`${endpoint}${endpoint.includes('?')?'&':'?'}GroupId=${encodeURIComponent(String(config.groupId))}`:endpoint;
        const response=await context.fetch(url,{method:'POST',headers:{'content-type':'application/json',...(apiKey?{authorization:`Bearer ${apiKey}`}:{})},signal:call.signal,body:JSON.stringify({
          model:request.model,text:request.input.text,stream:false,
          voice_setting:{voice_id:request.input.voice??config.voice??'male-qn-jingying',speed:request.input.speed??1},audio_setting:{format:'mp3',sample_rate:32000},
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
