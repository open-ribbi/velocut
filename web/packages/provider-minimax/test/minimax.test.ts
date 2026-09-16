import {test} from 'node:test';import assert from 'node:assert/strict';
import {ProviderRegistry} from '@velocut/provider-sdk';import {minimaxProvider} from '../dist/index.js';
function configured(fetcher:typeof fetch){return new ProviderRegistry().register(minimaxProvider).create({id:'speech',provider:'minimax',config:{endpoint:'https://speech.invalid/v1/t2a_v2',model:'test-speech',groupId:'my group'},credentials:{apiKey:{store:'test',key:'speech'}}},{fetch:fetcher,resolveCredential:async()=> 'secret'});}
test('speech transport works in Node and returns encoded bytes without an AudioContext',async()=>{
  let calls=0;const provider=configured(async(url,init)=>{calls++;assert.equal(String(url),'https://speech.invalid/v1/t2a_v2?GroupId=my%20group');const body=JSON.parse(String(init?.body));assert.equal(body.model,'test-speech');assert.equal(body.voice_setting.speed,1.2);assert.equal(new Headers(init?.headers).get('authorization'),'Bearer secret');return Response.json({base_resp:{status_code:0},data:{audio:'4944330102'}});});
  const result=await provider.execute({capability:'audio.synthesize',model:'test-speech',input:{text:'Hello',voice:'voice',speed:1.2}});assert.equal(result.outputs[0].source.kind,'bytes');if(result.outputs[0].source.kind==='bytes')assert.deepEqual([...result.outputs[0].source.bytes],[73,68,51,1,2]);assert.equal(calls,1);
  await assert.rejects(()=>provider.execute({capability:'audio.synthesize',model:'test-speech',input:{text:'Hello',speed:99}}),/speed/);assert.equal(calls,1);
});
test('invalid audio and service errors are failures instead of partial decoded buffers',async()=>{
  for(const body of [{data:{audio:'0xz'}},{data:{audio:'01'},base_resp:{status_code:1001,status_msg:'account secret rejected'}}]){
    const provider=configured(async()=>Response.json(body));await assert.rejects(()=>provider.execute({capability:'audio.synthesize',model:'test-speech',input:{text:'Hello'}}),(e:any)=>!e.message.includes('secret')&&e.outcome!==undefined);
  }
});

test('MiniMax native video uses submit/query/file retrieval rather than the speech route',async()=>{
 const {minimaxVideoProvider}=await import('../dist/index.js');const calls:string[]=[];
 const provider=new ProviderRegistry().register(minimaxVideoProvider).create({id:'video',provider:'minimax-video',config:{baseUrl:'https://api.invalid/v1',modelSettings:{presetId:'hailuo-2.3'}},credentials:{apiKey:{store:'test',key:'k'}}},{resolveCredential:async()=> 'fake',fetch:async(url,init)=>{calls.push(String(url));if(init?.method==='POST'){assert.equal(JSON.parse(String(init.body)).duration,6);return Response.json({task_id:'v1'});}if(String(url).includes('query'))return Response.json({status:'Success',file_id:'f1'});return Response.json({file:{download_url:'https://cdn.invalid/v1.mp4'}});}});
 const receipt=await provider.submit({capability:'video.generate',model:'MiniMax-Hailuo-2.3',input:{prompt:'Lake',durationS:6,resolution:'1080P'}});const poll=await provider.poll(receipt);assert.equal(poll.state,'ready');assert.equal((await provider.collect(poll.receipt!)).outputs[0].kind,'video');assert.deepEqual(calls,['https://api.invalid/v1/video_generation','https://api.invalid/v1/query/video_generation?task_id=v1','https://api.invalid/v1/files/retrieve?file_id=f1']);
});
test('MiniMax music maps lyrics and audio parameters to its own endpoint',async()=>{
 const {minimaxMusicProvider}=await import('../dist/index.js');const provider=new ProviderRegistry().register(minimaxMusicProvider).create({id:'music',provider:'minimax-music',config:{baseUrl:'https://api.invalid'},credentials:{apiKey:{store:'test',key:'k'}}},{resolveCredential:async()=> 'fake',fetch:async(url,init)=>{assert.equal(String(url),'https://api.invalid/v1/music_generation');const b=JSON.parse(String(init?.body));assert.equal(b.lyrics,'[Verse] Hello');assert.equal(b.audio_setting.sample_rate,44100);return Response.json({data:{audio:'494433'}});}});
 const out=await provider.execute({capability:'audio.generate',model:'music-2.5',input:{prompt:'Jazz',lyrics:'[Verse] Hello',sampleRate:44100}});assert.equal(out.outputs[0].source.kind,'bytes');
});
