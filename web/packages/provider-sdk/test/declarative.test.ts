import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ProviderRegistry} from '../dist/index.js';
import {parseModelSpec,serializeModelSpec,modelInput,previewModelRequest,declarativeProvider,type ModelSpec} from '../dist/declarative.js';
const source=`version: 1
id: unknown-video
capability: video.generate
inputSchema:
  type: object
  required: [prompt]
  additionalProperties: false
  properties:
    prompt: {type: string, minLength: 1}
    camera:
      type: object
      properties:
        speeds: {type: array, items: {type: number}}
        enabled: {type: boolean, default: true}
execution:
  type: async-http
  submit:
    method: POST
    path: /tasks
    body: {$input: ''}
  receipt: {id: '$.job'}
  poll:
    method: GET
    path: /tasks/{receipt.id}
    status: $.status
    states:
      running: [queued]
      succeeded: [done]
      failed: [failed]
  outputs: [{kind: video, url: '$.video'}]
`;
export const spec=parseModelSpec(source);
function configure(s:ModelSpec,fetcher:typeof fetch){return new ProviderRegistry().register(declarativeProvider(s)).create({id:'test',provider:'declarative:'+s.id,config:{baseUrl:'https://service.invalid/api',remoteModel:'deployment'},credentials:{apiKey:{store:'test',key:'key'}}},{fetch:fetcher,resolveCredential:async()=>'secret-token'});}
test('YAML round trip, nested defaults, arrays and strict input validation',async()=>{
 assert.deepEqual(parseModelSpec(serializeModelSpec(spec)),spec);
 const input={prompt:'scene',camera:{speeds:[.2,1.5]}};const normalized=modelInput(spec,input);assert.deepEqual(normalized.camera,{speeds:[.2,1.5],enabled:true});assert.equal((input.camera as any).enabled,undefined);
 assert.throws(()=>modelInput(spec,{prompt:'x',surprise:1}),/additional properties/);
 assert.throws(()=>modelInput(spec,{prompt:'x',camera:{speeds:['fast']}}),/camera\/speeds\/0/);
 const preview=await previewModelRequest(spec,{baseUrl:'https://service.invalid'},input);assert.deepEqual(preview.request.body,normalized);assert.equal(preview.request.headers.authorization,'[credential]');
});
test('unknown models submit once with exact types and poll receipt without any model-specific code',async()=>{
 const seen:any[]=[];const p=configure(spec,async(url,init)=>{seen.push({url,init});return Response.json(init?.method==='POST'?{job:'a/b?c'}:{status:'done',video:'https://cdn.invalid/out.mp4'});});
 const receipt=await p.submit({model:spec.id,capability:spec.capability,input:{prompt:'x',camera:{speeds:[1,2],enabled:false}}});
 assert.deepEqual(JSON.parse(seen[0].init.body).camera,{speeds:[1,2],enabled:false});assert.equal(seen[0].init.headers.authorization,'Bearer secret-token');assert.equal((await p.poll(receipt)).state,'succeeded');assert.equal(seen[1].url,'https://service.invalid/api/tasks/a%2Fb%3Fc');assert.equal(seen.length,2);
});
test('conditional schema constraints are enforced before HTTP or credential access',async()=>{
 const s=parseModelSpec({...spec,inputSchema:{type:'object',properties:{size:{enum:['small','large']},seconds:{type:'integer'}},if:{properties:{size:{const:'large'}},required:['size']},then:{properties:{seconds:{const:6}}}}});
 const p=configure(s,async()=>{throw Error('must not send');});await assert.rejects(()=>p.submit({model:s.id,capability:s.capability,input:{size:'large',seconds:10}}),/constant/);
});
test('typed array mapping, conditional omission, media reference resolution and request IDs',async()=>{
 const s=parseModelSpec({...spec,inputSchema:{type:'object',properties:{images:{type:'array',items:{type:'string'}},enabled:{type:'boolean'}}},execution:{...spec.execution,submit:{method:'POST',path:'/tasks',body:{model:{$connection:'remoteModel'},idempotency:{$requestId:true},content:{$map:{items:{$input:'images'},value:{type:'image',url:{$media:{id:{$item:''},kind:'image'}}}}},extra:{$if:{value:{$input:'enabled',optional:true},then:'yes'}}}}}});
 let body:any;const p=configure(s,async(_url,init)=>{body=JSON.parse(init!.body as string);return Response.json({job:'one'});});await p.submit({model:s.id,capability:s.capability,input:{images:['ref1'],enabled:false}},{requestId:'request1',resources:{urlFor:async(id,kind)=>{assert.equal(id,'ref1');assert.equal(kind,'image');return 'https://media.invalid/reference';}}});assert.deepEqual(body,{model:'deployment',idempotency:'request1',content:[{type:'image',url:'https://media.invalid/reference'}]});
});
test('separate collection uses only mapped receipt fields and survives serialization',async()=>{
 const s=parseModelSpec({...spec,execution:{...spec.execution,poll:{...spec.execution.poll!,receipt:{file:'$.file_id'}},collect:{method:'GET',path:'/files',query:{id:{$receipt:'file'}}},outputs:[{kind:'video',url:'$.download'}]}});
 let count=0;const p=configure(s,async(url)=>{count++;return Response.json(count===1?{job:'one'}:count===2?{status:'done',file_id:12,private:'do not persist'}:{download:'https://cdn.invalid/video'});});const receipt=await p.submit({model:s.id,capability:s.capability,input:{prompt:'x'}}),polled=await p.poll(receipt);assert.equal(polled.state,'ready');assert.equal(JSON.stringify(polled).includes('private'),false);const result=await p.collect(JSON.parse(JSON.stringify(polled.receipt)));assert.equal(result.outputs[0].kind,'video');
});
test('synchronous JSON hex, base64, binary, multiple results and structured data',async()=>{
 for(const output of [{kind:'audio',hex:'$.audio'},{kind:'audio',base64:'$.audio'},{kind:'audio',bytes:true}] as const){const s=parseModelSpec({...spec,capability:'audio.synthesize',execution:{type:'sync-http',submit:{method:'POST',path:'/audio',body:{$input:''},...('bytes'in output?{response:'bytes'}:{})},outputs:[output]}});const p=configure(s,async()=>('bytes'in output)?new Response(new Uint8Array([1,2])):Response.json({audio:'hex'in output?'0102':'AQI='}));const r=await p.execute({model:s.id,capability:s.capability,input:{prompt:'x'}});assert.deepEqual((r.outputs[0].source as any).bytes,new Uint8Array([1,2]));}
 const s=parseModelSpec({...spec,execution:{type:'sync-http',submit:{method:'POST',path:'/images'},outputs:[{kind:'image',each:'$.images',url:'$.url'}],data:'$.metadata'}});const p=configure(s,async()=>Response.json({images:[{url:'https://cdn.invalid/a'},{url:'https://cdn.invalid/b'}],metadata:{seed:0}}));const r=await p.execute({model:s.id,capability:s.capability,input:{prompt:'x'}});assert.equal(r.outputs.length,2);assert.deepEqual(r.data,{seed:0});
});
test('unknown states and uncertain POST failures never auto-resubmit',async()=>{
 let calls=0;const p=configure(spec,async(_url,init)=>{calls++;if(init?.method==='POST')throw Error('network secret-token');return Response.json({status:'alien'});});await assert.rejects(()=>p.submit({model:spec.id,capability:spec.capability,input:{prompt:'x'}}),(e:any)=>e.outcome==='unknown'&&!e.message.includes('secret-token'));assert.equal(calls,1);await assert.rejects(()=>p.poll({id:'known'}),(e:any)=>e.code==='UNKNOWN_STATUS'&&!e.retryable);assert.equal(calls,2);
});
test('configuration rejects executable expressions, YAML aliases, duplicate keys, unknown fields and cross-origin paths',()=>{
 for(const definition of [source+'id: duplicate\n',source.replace('id: unknown-video','id: &a unknown-video\nlabel: *a'),source.replace('version: 1','version: 1\nunknown: yes')])assert.throws(()=>parseModelSpec(definition));
 for(const path of ['https://attacker.invalid','//attacker.invalid','/../secret'])assert.throws(()=>parseModelSpec({...spec,execution:{...spec.execution,submit:{method:'POST',path}}}));
 assert.throws(()=>parseModelSpec({...spec,execution:{...spec.execution,submit:{method:'POST',path:'/tasks',body:{$eval:'process.env'}}}}),/expression/);
 assert.throws(()=>parseModelSpec({...spec,inputSchema:{type:'object',unknownConstraint:true}}),/unknown keyword/);
});

test('connection mapping and previews cannot inspect host credentials, even through the root selector',async()=>{
 const definition=parseModelSpec({...spec,execution:{...spec.execution,submit:{method:'POST',path:'/tasks',body:{$connection:''}}}});
 const preview=await previewModelRequest(definition,{baseUrl:'https://service.invalid',remoteModel:'model',apiKey:'private-secret',credentials:{token:'private-secret'}},{prompt:'x'});
 assert.deepEqual(preview.request.body,{baseUrl:'https://service.invalid',remoteModel:'model'});assert.equal(JSON.stringify(preview).includes('private-secret'),false);
 const explicit=parseModelSpec({...spec,execution:{...spec.execution,submit:{method:'POST',path:'/tasks',body:{$connection:'apiKey'}}}});
 await assert.rejects(()=>previewModelRequest(explicit,{baseUrl:'https://service.invalid',apiKey:'private-secret'},{prompt:'x'}),/Missing/);
});
