import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';import {resolve} from 'node:path';
const providerSdk='/@fs'+resolve('packages/provider-sdk/src/index.ts'),videoSdk='/@fs'+resolve('packages/provider-sdk/src/video.ts'),renderSdk='/@fs'+resolve('packages/render-sdk/src/index.ts');

test('an external Provider package can drive existing generation slots through the compatibility adapter',async({page},testInfo)=>{
  const compiled=testInfo.outputPath(`external-provider-${Date.now()}.js`);
  await build({entryPoints:[resolve('../examples/provider-example/src/index.ts')],outfile:compiled,bundle:false,format:'esm',platform:'neutral',target:'es2022'});
  const exampleUrl='/@fs'+compiled;
  let submits=0;await page.route('**/__provider/jobs**',async route=>{if(route.request().method()==='POST'){submits++;await route.fulfill({json:{id:'external-job',region:'west'}});}else{expect(new URL(route.request().url()).searchParams.get('region')).toBe('west');await route.fulfill({json:{status:'done',url:new URL('/__provider.mp4',route.request().url()).href}});}});
  await page.route('**/__provider.mp4',route=>route.fulfill({contentType:'video/mp4',body:readFileSync(resolve('e2e/fixtures/red-tone.mp4'))}));
  await page.addInitScript(()=>localStorage.setItem('velocut.videogen',JSON.stringify({channels:[{id:'external',kind:'example-video',baseUrl:location.origin+'/__provider',apiKey:'mock-key',models:['example-1']}]})));
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  const made=await page.evaluate(async({providerSdk,videoSdk,renderSdk,exampleUrl})=>{
    const {ProviderRegistry}=await import(providerSdk),{asVideoGenerator}=await import(videoSdk),{registerVideoGenProvider}=await import(renderSdk),{exampleProvider}=await import(exampleUrl);
    const registry=new ProviderRegistry().register(exampleProvider);
    registerVideoGenProvider({id:exampleProvider.id,label:exampleProvider.label,create:(config:any)=>asVideoGenerator(registry.create({id:'external',provider:exampleProvider.id,config:{endpoint:config.baseUrl},credentials:{apiKey:{store:'host',key:'selected'}}},{resolveCredential:async()=>config.apiKey,fetch:window.fetch}))});
    const v=(window as any).velocut;await v.apply({type:'addTrack',kind:'video'});await v.apply({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:1e6,request:{channel:'external',model:'example-1',prompt:'Custom provider'}});
    return v.generation({action:'submit',slotId:'slot_2',intentVersion:1,requestId:'external'});
  },{providerSdk,videoSdk,renderSdk,exampleUrl});
  expect(made.ok,JSON.stringify(made)).toBe(true);await expect.poll(async()=>{const r=await page.evaluate(id=>(window as any).velocut.generation({action:'get',jobId:id}),made.job.id);expect(JSON.stringify(r)).not.toContain('providerHandle');return r.job.error?`${r.job.state}: ${r.job.error}`:r.job.state;}).toBe('succeeded');
  const adopted=await page.evaluate(jobId=>{const v=(window as any).velocut;return v.generation({action:'adopt',slotId:'slot_2',jobId,intentVersion:1,expectedRevision:v.store.getState().revision});},made.job.id);expect(adopted.ok,JSON.stringify(adopted)).toBe(true);expect(submits).toBe(1);
});

test('the MiniMax compatibility wrapper decodes provider bytes in the browser without editing a project',async({page})=>{
  // A local WAV fixture exercises the browser decoder; the mocked transport makes no paid call.
  const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);for(let i=0;i<800;i++)wav.writeInt16LE(Math.round(Math.sin(i*Math.PI/20)*10000),44+i*2);
  let posts=0;await page.route('**/__speech',async route=>{posts++;expect(route.request().postDataJSON().text).toBe('Hello');await route.fulfill({json:{base_resp:{status_code:0},data:{audio:wav.toString('hex')}}});});
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.doc);
  const result=await page.evaluate(async renderSdk=>{const {MiniMaxTextToSpeech}=await import(renderSdk),v=(window as any).velocut,before=JSON.stringify(v.doc());const tts=new MiniMaxTextToSpeech({endpoint:location.origin+'/__speech',apiKey:'mock-speech'});const audio=await tts.synthesize('Hello');return {length:audio.samples.length,rate:audio.sampleRate,peak:Math.max(...audio.samples),unchanged:before===JSON.stringify(v.doc())};},renderSdk);
  expect(result.length/result.rate).toBeCloseTo(.1,2);expect(result.peak).toBeGreaterThan(.1);expect(result.unchanged).toBe(true);expect(posts).toBe(1);
});
