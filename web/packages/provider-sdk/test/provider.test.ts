import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProviderRegistry,defineModel,ProviderError,type ProviderDefinition} from '../dist/index.js';
const inputSchema={type:'object',properties:{prompt:{type:'string'}},required:['prompt']};
const model=defineModel({id:'model',capability:'video.generate',inputSchema,outputKinds:['video'],validate:input=>typeof input.prompt==='string'?{supported:true}:{supported:false,reason:'prompt required'}});
const request={model:'model',capability:'video.generate',input:{prompt:'Hello'}};
function fixture(){
  let reads=0,submits=0,polls=0,collects=0;
  const definition:ProviderDefinition={apiVersion:1,id:'fixture',label:'Fixture',capabilities:['video.generate'],credentials:[{name:'apiKey',required:true}],configSchema:{type:'object'},create:context=>({
    models:()=>[model],supports:r=>r.model==='model'?{supported:true}:{supported:false,reason:'Unknown model'},
    submit:async(r,call)=>{submits++;const key=await context.credentials.get('apiKey');assert.equal(key,'private-value');assert.equal(call.requestId,'once');return {id:'task',state:{region:'west',cursor:1}};},
    poll:async receipt=>{polls++;assert.equal(receipt.state?.region,'west');return {state:'ready',receipt:{...receipt,state:{region:'west',cursor:2}}};},
    collect:async receipt=>{collects++;assert.equal(receipt.state?.cursor,2);return {outputs:[{kind:'video',source:{kind:'url',url:'https://cdn.invalid/video.mp4'}}]};},
  })};
  const registry=new ProviderRegistry().register(definition),host={resolveCredential:async(ref:{store:string;key:string})=>{reads++;assert.deepEqual(ref,{store:'test',key:'one'});return 'private-value';}};
  const channel={id:'account',provider:'fixture',config:{},credentials:{apiKey:{store:'test',key:'one'}}};
  return {registry,host,channel,definition,get counts(){return {reads,submits,polls,collects};}};
}
test('discovery and support checks do not read credentials or submit; lifecycle retains a private receipt',async()=>{
  const f=fixture(),provider=f.registry.create(f.channel,f.host);assert.equal(provider.describe().models[0].id,'model');assert.equal(provider.supports(request).supported,true);assert.equal(provider.supports({...request,input:'invalid' as any}).supported,false);
  await assert.rejects(()=>provider.submit({...request,input:{}}),/prompt required/);assert.deepEqual(f.counts,{reads:0,submits:0,polls:0,collects:0});
  const receipt=await provider.submit(request,{requestId:'once'});assert.equal(receipt.channelId,'account');const polled=await provider.poll(JSON.parse(JSON.stringify(receipt)));assert.equal(polled.state,'ready');
  assert.equal((await provider.collect(polled.receipt!)).outputs[0].kind,'video');assert.deepEqual(f.counts,{reads:1,submits:1,polls:1,collects:1});assert.deepEqual(await provider.cancel(receipt),{status:'unsupported'});
  assert.ok(!JSON.stringify(provider.describe()).includes('private-value'));
  const other=f.registry.create({...f.channel,id:'other'},f.host);await assert.rejects(()=>other.poll(receipt),/different provider channel/);
});
test('registration rejects conflicts and credential access is limited to declared slots',async()=>{
  const f=fixture();assert.throws(()=>f.registry.register(f.definition),/already registered/);assert.throws(()=>f.registry.create({...f.channel,credentials:{other:{store:'test',key:'one'}}},f.host),/Undeclared/);
  const definition={...f.definition,id:'bad',create:(context:any)=>({models:()=>[model],supports:()=>({supported:true as const}),execute:async()=>{await context.credentials.get('other');return {outputs:[]};}})};
  const provider=new ProviderRegistry().register(definition).create({...f.channel,provider:'bad'},f.host);await assert.rejects(()=>provider.execute(request),/Undeclared/);assert.equal(f.counts.reads,0);
});
test('provider exceptions keep phase/outcome, redact resolved credentials, and never retry a paid action',async()=>{
  const f=fixture();let calls=0;const definition={...f.definition,id:'fails',create:(context:any)=>({models:()=>[model],supports:()=>({supported:true as const}),submit:async()=>{calls++;const key=await context.credentials.get('apiKey');throw Error('network lost '+key);},poll:async()=>({state:'running' as const})})};
  const provider=new ProviderRegistry().register(definition).create({...f.channel,provider:'fails'},f.host);
  await assert.rejects(()=>provider.submit(request),(e:any)=>e instanceof ProviderError&&e.phase==='submit'&&e.outcome==='unknown'&&!e.message.includes('private-value'));assert.equal(calls,1);
  const controller=new AbortController();controller.abort();await assert.rejects(()=>provider.submit(request,{signal:controller.signal}));assert.equal(calls,1);
});

test('an immediate capability can return structured data without manufacturing a media asset',async()=>{
  const provider=new ProviderRegistry().register({apiVersion:1,id:'alignment',label:'Local alignment',capabilities:['audio.transcribe'],configSchema:{type:'object'},create:()=>({
    models:()=>[defineModel({id:'local',capability:'audio.transcribe',inputSchema:{type:'object'},outputKinds:['data'],validate:()=>({supported:true})})],supports:()=>({supported:true}),
    execute:async()=>({outputs:[],data:{words:[{text:'Hello',startS:0,endS:.3}]}}),
  })}).create({id:'local',provider:'alignment',config:{}},{resolveCredential:async()=>{throw Error('Local capability needs no credential');}});
  assert.deepEqual(await provider.execute({capability:'audio.transcribe',model:'local',input:{}}),{outputs:[],data:{words:[{text:'Hello',startS:0,endS:.3}]}});
});
