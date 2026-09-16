import {defineModel,ProviderError,type ProviderDefinition,type Support,type JsonObject} from '@velocut/provider-sdk';
// Illustrative protocol, not an integration with a real model service.
const validate=(input:JsonObject):Support=>typeof input.prompt==='string'&&input.prompt.trim()&&Object.keys(input).every(k=>['prompt','durationS','ratio'].includes(k))&&(input.durationS===undefined||typeof input.durationS==='number'&&Number.isFinite(input.durationS)&&input.durationS>0)&&(input.ratio===undefined||['16:9','9:16','1:1'].includes(String(input.ratio)))?{supported:true}:{supported:false,reason:'Supply a prompt, optional positive durationS and a supported ratio'};
export const exampleProvider:ProviderDefinition={
  apiVersion:1,id:'example-video',label:'Example video service',capabilities:['video.generate'],
  credentials:[{name:'apiKey',required:true}],
  configSchema:{type:'object',properties:{endpoint:{type:'string'}},required:['endpoint'],additionalProperties:false},
  create(context){
    if(typeof context.config.endpoint!=='string')throw Error('endpoint is required');
    const url=new URL(context.config.endpoint);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Configure an HTTP(S) endpoint without embedded credentials');
    const base=url.href.replace(/\/$/,''),model=defineModel({id:'example-1',capability:'video.generate',inputSchema:{type:'object',properties:{prompt:{type:'string',minLength:1},durationS:{type:'number',exclusiveMinimum:0},ratio:{enum:['16:9','9:16','1:1']}},required:['prompt'],additionalProperties:false},outputKinds:['video'],validate});
    const auth=async()=>({authorization:`Bearer ${await context.credentials.get('apiKey')}`});
    return {
      models:()=>[model],supports:r=>r.capability==='video.generate'&&r.model===model.id?validate(r.input):{supported:false,reason:'Unsupported model'},
      async submit(request,call){
        const response=await context.fetch(`${base}/jobs`,{method:'POST',headers:{...await auth(),'content-type':'application/json'},body:JSON.stringify({model:request.model,text:request.input.prompt,...(request.input.durationS!==undefined?{seconds:request.input.durationS}:{}),...(request.input.ratio!==undefined?{ratio:request.input.ratio}:{})}),signal:call.signal});
        if(!response.ok)throw new ProviderError({phase:'submit',code:'EXAMPLE_HTTP',httpStatus:response.status,message:`Submission HTTP ${response.status}`,outcome:response.status>=400&&response.status<500?'rejected':'unknown',retryable:false});
        const body=await response.json() as {id?:string;region?:string};if(!body.id||!body.region)throw Error('Missing service receipt');
        return {id:body.id,state:{region:body.region}};
      },
      async poll(receipt,call){
        const region=receipt.state?.region;if(typeof region!=='string')throw Error('Missing original region');
        const response=await context.fetch(`${base}/jobs/${encodeURIComponent(receipt.id)}?region=${encodeURIComponent(region)}`,{headers:await auth(),signal:call.signal});
        if(!response.ok)throw Error(`Polling HTTP ${response.status}`);
        const body=await response.json() as {status?:string;url?:string};
        if(body.status==='queued'||body.status==='running')return {state:'running',receipt};
        if(body.status==='done'&&body.url)return {state:'ready',receipt:{...receipt,state:{region,url:body.url}}};
        return {state:'failed',receipt,error:{phase:'poll',code:'EXAMPLE_FAILED',message:'Service did not return a completed result',outcome:'rejected',retryable:false}};
      },
      async collect(receipt){
        const result=receipt.state?.url;if(typeof result!=='string'||!['http:','https:'].includes(new URL(result).protocol))throw Error('Missing result URL');
        return {outputs:[{kind:'video',source:{kind:'url',url:result}}]};
      },
    };
  },
};
