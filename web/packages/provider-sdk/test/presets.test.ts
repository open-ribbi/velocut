import {test} from 'node:test';
import assert from 'node:assert/strict';
import {builtinTemplates,builtinModelSpec,configurePresetModel} from '../dist/presets.js';
import {parseModelSpec,serializeModelSpec,modelInput,previewModelRequest,declarativeProvider} from '../dist/declarative.js';
import {ProviderRegistry} from '../dist/index.js';
import type {ModelSettings} from '../dist/catalog.js';
const configured=(protocol:string,model:string,fetcher:typeof fetch,settings?:ModelSettings)=>configurePresetModel(protocol,model,{baseUrl:'https://service.invalid',apiKey:'secret',modelSettings:settings},{fetch:fetcher,resolveCredential:async()=> 'secret'});

test('every bundled preset is an exportable declaration with the same schema as imported YAML',()=>{
 const templates=builtinTemplates();assert.equal(templates.length,10);
 for(const spec of templates)assert.deepEqual(parseModelSpec(serializeModelSpec(spec)),spec);
 for(const presetId of ['minimax-h3','seedance-2','seedance-2-mini']){
   const spec=builtinModelSpec('task-api','model',{presetId});
   assert.throws(()=>modelInput(spec,{prompt:'test',lastFrameReferenceId:'last'}),/dependencies|firstFrame/);
   assert.throws(()=>modelInput(spec,{prompt:'test',firstFrameReferenceId:'first',referenceImageIds:['image']}),/NOT/);
   assert.throws(()=>modelInput(spec,{prompt:'test',referenceAudioIds:['audio']}),/required|anyOf/);
 }
 assert.throws(()=>modelInput(builtinModelSpec('minimax-video','video'),{prompt:'test',durationS:10,resolution:'1080P'}),/constant/);
 assert.throws(()=>modelInput(builtinModelSpec('task-api','seedance',{presetId:'seedance-2.5'}),{prompt:'test',firstFrameReferenceId:'first'}),/additional properties/);
});
test('Task API recipes preserve references, wrapped responses, costs and output metadata',async()=>{
 let body:any;const urls:string[]=[];
 const provider=configured('task-api','one',async(url,init)=>{urls.push(String(url));if(init?.method==='POST'){body=JSON.parse(String(init.body));return Response.json({data:{task_id:'task/one'}});}return Response.json({data:{status:'completed',result:{url:'https://cdn.invalid/result.mp4',duration:3,resolution:'720p',ratio:'16:9'},cost:2}});});
 const receipt=await provider.submit({model:'one',capability:'video.generate',input:{prompt:'Hello',durationS:2.5,firstFrameReferenceId:'frame'}},{resources:{urlFor:async(id,kind)=>{assert.equal(id,'frame');assert.equal(kind,'image');return 'https://files.invalid/frame.png';}}});
 assert.deepEqual(body,{model:'one',params:{prompt:'Hello',duration:2.5,first_frame_image:'https://files.invalid/frame.png'}});const poll=await provider.poll(receipt);assert.equal(poll.state,'succeeded');if(poll.state==='succeeded'){assert.equal(poll.result.usage?.cost,2);assert.equal(poll.result.outputs[0].metadata?.resolution,'720p');}
 assert.equal(urls[1],'https://service.invalid/api/v1/tasks/task%2Fone');
});
test('H3 first-frame and Seedance idempotency behavior live in declarative mappings',async()=>{
 for(const paired of [false,true]){
 let body:any;const provider=configured('task-api','minimax-h3',async(_url,init)=>{body=JSON.parse(String(init!.body));return Response.json({data:{id:'task'}});},{presetId:'minimax-h3'});
 await provider.submit({model:'minimax-h3',capability:'video.generate',input:{prompt:'Lake',firstFrameReferenceId:'first',...(paired?{lastFrameReferenceId:'last'}:{})}},{resources:{urlFor:async id=>'https://files.invalid/'+id}});
 assert.equal(body.params[paired?'first_frame_image':'image_url'],'https://files.invalid/first');assert.equal(body.params[paired?'image_url':'first_frame_image'],undefined);
 }
 const spec=builtinModelSpec('task-api','deployment',{presetId:'seedance-2.5'});
 const preview=await previewModelRequest(spec,{baseUrl:'https://service.invalid',remoteModel:'deployment'},{prompt:'x'},'stable-request');assert.equal((preview.request.body as any).idempotency_key,'stable-request');
});
test('Ark recipes concatenate text and typed media content and preserve falsy parameter values',async()=>{
 let body:any;const provider=configurePresetModel('ark-video','deployment',{baseUrl:'https://ark.invalid/api/v3',apiKey:'key'},{resolveCredential:async()=> 'key',fetch:async(url,init)=>{assert.equal(String(url),'https://ark.invalid/api/v3/contents/generations/tasks');body=JSON.parse(String(init!.body));return Response.json({id:'task'});}});
 await provider.submit({model:'deployment',capability:'video.generate',input:{prompt:'Scene',durationS:5,parameters:{seed:0,watermark:false},firstFrameReferenceId:'first'}},{resources:{urlFor:async id=>'https://files.invalid/'+id}});
 assert.equal(body.seed,0);assert.equal(body.watermark,false);assert.deepEqual(body.content,[{type:'text',text:'Scene'},{type:'image_url',image_url:{url:'https://files.invalid/first'},role:'first_frame'}]);
});
test('native video uses the same executor for submission, polling and file collection',async()=>{
 const urls:string[]=[];const provider=configurePresetModel('minimax-video','video',{baseUrl:'https://service.invalid/v1',apiKey:'secret'},{resolveCredential:async()=> 'secret',fetch:async(url,init)=>{urls.push(String(url));return Response.json(init?.method==='POST'?{task_id:'v'}:String(url).includes('/query/')?{status:'Success',file_id:'file'}:{file:{download_url:'https://cdn.invalid/video'}});}});
 const receipt=await provider.submit({model:'video',capability:'video.generate',input:{prompt:'Lake',durationS:6,resolution:'1080P'}}),poll=await provider.poll(receipt);assert.equal(poll.state,'ready');assert.equal((await provider.collect(poll.receipt!)).outputs[0].kind,'video');assert.deepEqual(urls,['https://service.invalid/v1/video_generation','https://service.invalid/v1/query/video_generation?task_id=v','https://service.invalid/v1/files/retrieve?file_id=file']);
});
test('speech and music declarations preserve configurable endpoint, voice controls, lyrics and byte output',async()=>{
 let body:any;const speech=configurePresetModel('minimax-speech','speech',{baseUrl:'https://unused.invalid',endpoint:'https://speech.invalid/custom',groupId:'my group',apiKey:'secret'},{resolveCredential:async()=> 'secret',fetch:async(url,init)=>{assert.equal(new URL(String(url)).searchParams.get('GroupId'),'my group');assert.equal(new URL(String(url)).pathname,'/custom');body=JSON.parse(String(init!.body));return Response.json({base_resp:{status_code:0},data:{audio:'494433'}});}});
 const audio=await speech.execute({model:'speech',capability:'audio.synthesize',input:{text:'Hello',voice:'voice',speed:1.2,volume:0,pitch:0}});assert.deepEqual(body.voice_setting,{voice_id:'voice',speed:1.2,vol:0,pitch:0});assert.equal(audio.outputs[0].source.kind,'bytes');await assert.rejects(()=>speech.execute({model:'speech',capability:'audio.synthesize',input:{text:'Hello',speed:99}}),/speed/);
 const music=configured('minimax-music','song',async(_url,init)=>{body=JSON.parse(String(init!.body));return Response.json({data:{audio:'494433'}});});await music.execute({model:'song',capability:'audio.generate',input:{prompt:'Jazz',lyrics:'[Verse] Hello'}});assert.equal(body.audio_setting.sample_rate,44100);assert.equal(body.lyrics,'[Verse] Hello');
});
test('provider failures redact resolved tokens and invalid responses never produce partial media',async()=>{
 const video=configured('task-api','video',async()=>Response.json({status:'completed',result:{}}));
 await assert.rejects(()=>video.poll({id:'saved'}),(e:any)=>e.code==='INVALID_RESULT'&&e.retryable===false);
 for(const body of [{data:{audio:'0xz'}},{base_resp:{status_code:1001,status_msg:'secret rejected'}}]){
   const p=configured('minimax-speech','speech',async()=>Response.json(body));await assert.rejects(()=>p.execute({model:'speech',capability:'audio.synthesize',input:{text:'Hello'}}),(e:any)=>!e.message.includes('secret')&&e.outcome!==undefined);
 }
});

test('exported video templates resolve typed project references through the same mappings',async()=>{
 for(const id of ['minimax-h3','ark-seedance','hailuo-2.3']){
  const spec=builtinTemplates().find(s=>s.id===id)!,definition=declarativeProvider(spec);let body:any,resolved=0;
  const p=new ProviderRegistry().register(definition).create({id,provider:definition.id,config:{baseUrl:'https://service.invalid',remoteModel:'deployment'},credentials:{apiKey:{store:'test',key:'key'}}},{resolveCredential:async()=> 'secret',fetch:async(_url,init)=>{body=JSON.parse(String(init!.body));return Response.json({id:'task',task_id:'task'});}});
  await p.submit({model:id,capability:'video.generate',input:{prompt:'Frame',firstFrameReferenceId:{$mediaRef:'project-ref',kind:'image'}}},{resources:{urlFor:async(ref,kind)=>{assert.equal(ref,'project-ref');assert.equal(kind,'image');resolved++;return 'https://files.invalid/frame';}}});
  assert.equal(resolved,1);assert.ok(JSON.stringify(body).includes('https://files.invalid/frame'));assert.ok(!JSON.stringify(body).includes('$mediaRef'));
 }
});
