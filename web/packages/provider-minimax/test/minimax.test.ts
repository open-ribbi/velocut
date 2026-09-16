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
