import {test} from 'node:test';import assert from 'node:assert/strict';import {ProviderRegistry} from '@velocut/provider-sdk';import {taskApiProvider} from '../dist/index.js';
test('task-api maps model inputs and reference IDs, then separates polling from result collection',async()=>{
  let submits=0;const calls:string[]=[];
  const provider=new ProviderRegistry().register(taskApiProvider).create({id:'video',provider:'task-api',config:{baseUrl:'https://video.invalid',models:['one']},credentials:{apiKey:{store:'test',key:'video'}}},{resolveCredential:async()=> 'secret',fetch:async(url,init)=>{
    calls.push(String(url));if(init?.method==='POST'){submits++;assert.deepEqual(JSON.parse(String(init.body)),{model:'one',params:{prompt:'Hello',duration:2.5,first_frame_image:'https://files.invalid/frame.png'}});return Response.json({task_id:'task/one'});}
    return Response.json({status:'completed',result:{video_url:'https://cdn.invalid/result.mp4',duration:3,resolution:'720p',ratio:'16:9'},cost:2});
  }});
  assert.equal(provider.describe().models.length,1);assert.equal(provider.supports({capability:'video.generate',model:'missing',input:{prompt:'x'}}).supported,false);
  const receipt=await provider.submit({capability:'video.generate',model:'one',input:{prompt:'Hello',durationS:2.5,firstFrameReferenceId:'frame'}},{resources:{urlFor:async(id,kind)=>{assert.equal(id,'frame');assert.equal(kind,'image');return 'https://files.invalid/frame.png';}}});
  const poll=await provider.poll(receipt);assert.equal(poll.state,'ready');const output=await provider.collect(poll.receipt!);assert.equal(output.outputs[0].metadata?.resolution,'720p');assert.equal(output.usage?.cost,2);assert.equal(submits,1);assert.equal(calls[1],'https://video.invalid/api/v1/tasks/task%2Fone');
  await assert.rejects(()=>provider.submit({capability:'video.generate',model:'one',input:{prompt:'x',firstFrameUrl:'https://unconfigured.invalid'}}),/Unsupported/);assert.equal(submits,1);
});

test('configured H3 maps a single first frame to image_url and accepts wrapped task responses',async()=>{
 let body:any;const provider=new ProviderRegistry().register(taskApiProvider).create({id:'h3',provider:'task-api',config:{baseUrl:'https://gateway.invalid',modelSettings:{presetId:'minimax-h3'}},credentials:{apiKey:{store:'test',key:'x'}}},{resolveCredential:async()=> 'fake',fetch:async(_url,init)=>{if(init?.method==='POST'){body=JSON.parse(String(init.body));return Response.json({data:{id:'h3-task'}});}return Response.json({data:{status:'completed',result:{url:'https://cdn.invalid/h3.mp4'}}});}});
 const receipt=await provider.submit({capability:'video.generate',model:'minimax-h3',input:{prompt:'Lake',durationS:5,resolution:'2K',firstFrameReferenceId:'image'}},{resources:{urlFor:async()=> 'https://files.invalid/image.png'}});assert.equal(body.params.image_url,'https://files.invalid/image.png');assert.equal(body.params.first_frame_image,undefined);const result=await provider.poll(receipt);assert.equal(result.state,'ready');assert.equal((await provider.collect(result.receipt!)).outputs[0].kind,'video');
});

test('Ark preset translates multimodal references into typed content without changing the configured API base',async()=>{
 const {arkVideoProvider}=await import('../dist/index.js');let submitted:any;const provider=new ProviderRegistry().register(arkVideoProvider).create({id:'ark',provider:'ark-video',config:{baseUrl:'https://ark.invalid/api/v3',modelSettings:{presetId:'ark-seedance'}},credentials:{apiKey:{store:'test',key:'k'}}},{resolveCredential:async()=> 'fake',fetch:async(url,init)=>{if(init?.method==='POST'){assert.equal(String(url),'https://ark.invalid/api/v3/contents/generations/tasks');submitted=JSON.parse(String(init.body));return Response.json({id:'ark-task'});}return Response.json({status:'succeeded',content:{video_url:'https://cdn.invalid/ark.mp4'}});}});
 const receipt=await provider.submit({capability:'video.generate',model:'my-deployment',input:{prompt:'Scene',durationS:5,parameters:{seed:7,watermark:false},firstFrameReferenceId:'first'}},{resources:{urlFor:async id=>'https://files.invalid/'+id+'.png'}});
 assert.equal(submitted.model,'my-deployment');assert.equal(submitted.seed,7);assert.deepEqual(submitted.content,[{type:'text',text:'Scene'},{type:'image_url',image_url:{url:'https://files.invalid/first.png'},role:'first_frame'}]);assert.equal((await provider.poll(receipt)).state,'succeeded');
});
