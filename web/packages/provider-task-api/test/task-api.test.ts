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
