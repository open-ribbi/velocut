import {test,expect,type Page} from './test-fixtures';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
const video=readFileSync(resolve('e2e/fixtures/red-tone.mp4'));
async function provider(page:Page){
  const state={posts:0,ready:true,requests:[] as any[]};
  await page.addInitScript(()=>localStorage.setItem('velocut.videogen',JSON.stringify({channels:[{id:'mock',kind:'task-api',baseUrl:location.origin+'/__generation',apiKey:'test-secret-never-return',models:['mock-video'],defaultModel:'mock-video',capabilities:{'mock-video':{durationsS:[2,5,10],ratios:['16:9'],imageToVideo:true,audio:true}}}]})));
  await page.route('**/__generation/api/v1/tasks**',async route=>{
    if(route.request().method()==='POST'){state.posts++;state.requests.push(route.request().postDataJSON());await route.fulfill({json:{task_id:'task_'+state.posts,status:'pending'}});}
    else await route.fulfill({json:state.ready?{status:'completed',result:{video_url:new URL('/__generated.mp4',route.request().url()).href,duration:2},cost:1}:{status:'processing'}});
  });
  await page.route('**/__generated.mp4',route=>route.fulfill({contentType:'video/mp4',body:video}));
  return state;
}
const request={channel:'mock',model:'mock-video',prompt:'A generated sunrise',ratio:'16:9'};
const jobReady=async(page:Page,jobId:string)=>{let value:any;await expect.poll(async()=>{const r=await page.evaluate(jobId=>(window as any).velocut.generation({action:'get',jobId}),jobId);expect(r.ok,JSON.stringify(r)).toBe(true);value=r.job;return r.job.state;},{timeout:20000}).toBe('succeeded');return value;};

test('MCP generation submits once, resumes after reload and adopts at the current slot position atomically',async({page})=>{
  const remote=await provider(page);remote.ready=false;
  const client=new Client({name:'generation-test',version:'1'});await client.connect(new StdioClientTransport({command:process.execPath,args:[resolve('packages/mcp/dist/velocut/scripts/server.cjs')],stderr:'pipe'}));
  const call=async(name:string,args:Record<string,unknown>={})=>(await client.callTool({name,arguments:args}) as any).structuredContent;
  try{
    await page.goto((await call('velocut_connect')).url);await expect(page.locator('.codex-status')).toHaveClass(/\bconnected\b/);const sessionId=(await call('velocut_sessions')).sessions[0].sessionId;
    const created=await call('velocut_script',{sessionId,code:`const s=await velocut.query({kind:'snapshot'});return await velocut.transaction({action:'commit',runtimeId:s.runtimeId,expectedRevision:s.revision,requestId:'slot',operations:[{id:'t',command:velocut.ops.addTrack({kind:'video'})},{id:'s',command:velocut.ops.addGenerationSlot({trackId:velocut.ref('t','trackId'),startUs:0,durationUs:1000000,request:${JSON.stringify(request)}})}]});`});
    expect(created.ok,JSON.stringify(created)).toBe(true);expect(created.result.ok,JSON.stringify(created)).toBe(true);const slotId=created.result.data.results.s.slotId;
    const plan=await call('velocut_generation',{sessionId,action:'plan',slotId});expect(plan.providerDurationS).toBe(2);
    const queued=await call('velocut_generation',{sessionId,action:'submit',slotId,intentVersion:1,requestId:'paid-one'});expect(queued.ok).toBe(true);const jobId=queued.job.id;
    const again=await call('velocut_generation',{sessionId,action:'submit',slotId,intentVersion:1,requestId:'paid-one'});expect(again.job.id).toBe(jobId);
    await expect.poll(async()=>{const j=await page.evaluate(jobId=>(window as any).velocut.generation({action:'get',jobId}),jobId);return !!j.job?.providerTaskId;}).toBe(true);
    expect(remote.posts).toBe(1);expect(JSON.stringify(queued)).not.toContain('test-secret');
    await page.evaluate(async slotId=>{const v=(window as any).velocut;await v.apply({type:'updateGenerationSlot',slotId,startUs:2e6});await v.collab.flushNow();},slotId);
    await page.reload();await page.waitForFunction(()=>(window as any).velocut?.generation);remote.ready=true;
    const done=await jobReady(page,jobId);expect(done.result.durationUs).toBeGreaterThan(1e6);expect(remote.posts).toBe(1);
    const adopted=await page.evaluate(async({slotId,jobId})=>{const v=(window as any).velocut;return v.generation({action:'adopt',slotId,jobId,intentVersion:1,expectedRevision:v.store.getState().revision});},{slotId,jobId});expect(adopted.ok,JSON.stringify(adopted)).toBe(true);
    const result=await page.evaluate(()=>{const v=(window as any).velocut;return {doc:v.doc(),frame:v.store.evaluate(2e6)};});expect(result.doc.tracks[0].clips[0].startUs).toBe(2e6);expect(result.doc.tracks[0].clips[0].durationUs).toBe(1e6);expect(result.frame.pendingGenerationIds).toBeUndefined();
    await page.evaluate(async()=>{const v=(window as any).velocut;await v.undo();await v.redo();});expect(remote.posts).toBe(1);
  }finally{await client.close();}
});

test('small-window range drawing, provider duration fit, candidate preview and adoption work without round-trips',async({page},testInfo)=>{
  const remote=await provider(page);await page.setViewportSize({width:640,height:760});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  await page.evaluate(()=>(window as any).velocut.apply({type:'addTrack',kind:'video'}));await page.getByLabel('Draw generation range').click();
  const canvas=page.getByLabel('Timeline tracks');const box=(await canvas.boundingBox())!,header=box.width<600?92:130;
  await page.mouse.move(box.x+header+20,box.y+50);await page.mouse.down();await page.mouse.move(box.x+header+120,box.y+50,{steps:8});await page.mouse.up();
  const dialog=page.getByRole('dialog',{name:'Generate video',exact:true});await expect(dialog).toBeVisible();await expect(page.getByLabel('Generation duration',{exact:true})).toHaveValue('1');
  await page.getByLabel('Video generation prompt').fill('Camera slowly reveals a red landscape');await page.getByRole('button',{name:'Generate video',exact:true}).click();
  await expect(dialog.getByText('Ready',{exact:true})).toBeVisible({timeout:20000});expect(remote.posts).toBe(1);expect(remote.requests[0].params.duration).toBe(2);
  await page.getByRole('button',{name:'Preview result',exact:true}).click();await expect(page.locator('.generation-preview')).toBeVisible();await page.screenshot({path:testInfo.outputPath('generation-panel.png')});
  const fit=await dialog.boundingBox();expect(fit!.x).toBeGreaterThanOrEqual(0);expect(fit!.x+fit!.width).toBeLessThanOrEqual(640);
  await page.getByRole('button',{name:'Use for slot',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).velocut.doc().tracks[0].clips.length)).toBe(1);
  const clip=await page.evaluate(()=>(window as any).velocut.doc().tracks[0].clips[0]);expect(clip.durationUs).toBe(1e6);expect(clip.startUs).toBe(200000);
  await page.getByRole('button',{name:'Close Generate video',exact:true}).click();await expect.poll(()=>page.evaluate(()=>{const v=(window as any).velocut;return v.media.hasAsset(v.doc().tracks[0].clips[0].assetId);})).toBe(true);
});

test('short output cannot silently fill a longer range; source-duration adoption and unresolved export are explicit',async({page})=>{
  const remote=await provider(page);await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  const ids=await page.evaluate(async request=>{const v=(window as any).velocut;await v.apply({type:'addTrack',kind:'video'});await v.apply({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:6e6,request});const r=await v.generation({action:'submit',slotId:'slot_2',intentVersion:1,requestId:'short'});return {slotId:'slot_2',jobId:r.job.id};},request);
  const ready=await jobReady(page,ids.jobId);expect(remote.requests[0].params.duration).toBe(10);
  const result=await page.evaluate(async({slotId,jobId})=>{
    const v=(window as any).velocut,before=JSON.stringify(v.doc()),revision=v.store.getState().revision;
    const failed=await v.generation({action:'adopt',slotId,jobId,intentVersion:1,expectedRevision:revision});
    let exportError='';try{await new v.Exporter(v.media).export({width:96,height:64,fpsNum:30,fpsDen:1,durationUs:100000,evaluate:(t:number)=>v.store.evaluate(t),audioClips:[]});}catch(e){exportError=String(e);}
    return {failed,exportError,unchanged:before===JSON.stringify(v.doc()),fit:await v.generation({action:'adopt',slotId,jobId,intentVersion:1,expectedRevision:revision,fit:'sourceDuration'})};
  },ids);
  expect(result.failed.ok).toBe(false);expect(result.unchanged).toBe(true);expect(result.exportError).toContain('Unresolved generation slots');expect(result.fit.ok,JSON.stringify(result.fit)).toBe(true);
  const duration=await page.evaluate(()=>(window as any).velocut.doc().tracks[0].clips[0].durationUs);expect(duration).toBe(ready.result.durationUs);expect(remote.posts).toBe(1);
});

test('reference snapshots are uploaded only on submission and survive generation recovery',async({page})=>{
  const remote=await provider(page);let uploads=0;
  await page.addInitScript(()=>localStorage.setItem('velocut.upload',JSON.stringify({kind:'relay',config:{endpoint:location.origin+'/__reference-upload'}})));
  await page.route('**/__reference-upload',async route=>{uploads++;await route.fulfill({json:{url:'https://reference.invalid/immutable.png'}});});
  await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  const capture=await page.evaluate(async request=>{
    const v=(window as any).velocut;await v.apply({type:'addTrack',kind:'text'});await v.apply({type:'addTextClip',trackId:'track_1',startUs:0,durationUs:1e6,text:{content:'Reference'}});
    const ref=await v.generation({action:'captureReference',source:{kind:'timeline',timeUs:0},expectedRevision:v.store.getState().revision});if(!ref.ok)throw Error(ref.message);
    await v.apply({type:'addTrack',kind:'video'});const trackId=v.doc().tracks.find((t:any)=>t.kind==='video').id;
    await v.apply({type:'addGenerationSlot',trackId,startUs:0,durationUs:1e6,request:{...request,firstFrameReferenceId:ref.reference.id}});
    return {reference:ref.reference,slotId:v.doc().generationSlots[0].id};
  },request);
  expect(uploads).toBe(0);expect(JSON.stringify(capture.reference)).not.toContain('https://');
  const j=await page.evaluate(slotId=>(window as any).velocut.generation({action:'submit',slotId,intentVersion:1,requestId:'image'}),capture.slotId);expect(j.ok,JSON.stringify(j)).toBe(true);await jobReady(page,j.job.id);
  expect(uploads).toBe(1);expect(remote.requests[0].params.first_frame_image).toBe('https://reference.invalid/immutable.png');
});

test('switching projects keeps the pending task and downloaded result in its original project',async({page})=>{
  const remote=await provider(page);remote.ready=false;await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  const original=await page.evaluate(async request=>{const v=(window as any).velocut;await v.apply({type:'addTrack',kind:'video'});await v.apply({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:1e6,request});const job=await v.generation({action:'submit',slotId:'slot_2',intentVersion:1,requestId:'switch'});return {projectId:v.projects.active().id,jobId:job.job.id};},request);
  await expect.poll(()=>page.evaluate(async id=>(await (window as any).velocut.generation({action:'get',jobId:id})).job.providerTaskId,original.jobId)).toBeTruthy();
  const other=await page.evaluate(async()=>{const v=(window as any).velocut,p=await v.projects.create('Other generation project');await v.projects.open(p.id);return p.id;});
  await page.waitForFunction(id=>(window as any).velocut?.projects.active().id===id,other);remote.ready=true;
  const empty=await page.evaluate(async id=>{const v=(window as any).velocut;return {jobs:await v.generation({action:'list'}),old:await v.generation({action:'get',jobId:id}),doc:v.doc()};},original.jobId);
  expect(empty.jobs.total).toBe(0);expect(empty.old.ok).toBe(false);expect(empty.doc.assets).toHaveLength(0);expect(empty.doc.tracks).toHaveLength(0);
  await page.evaluate(id=>(window as any).velocut.projects.open(id),original.projectId);await page.waitForFunction(id=>(window as any).velocut?.projects.active().id===id,original.projectId);
  const result=await jobReady(page,original.jobId);expect(result.projectId).toBe(original.projectId);expect(remote.posts).toBe(1);
});

test('a 360px panel can create a numeric range in an empty project and adopt generated media',async({page})=>{
  const remote=await provider(page);await page.setViewportSize({width:360,height:650});await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  await page.getByLabel('Draw generation range').click();await page.getByRole('button',{name:'Set range…',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Generate video',exact:true});await expect(dialog).toBeVisible();
  await page.getByLabel('Generation start',{exact:true}).fill('2');await page.getByLabel('Generation duration',{exact:true}).fill('1');await page.getByLabel('Video generation prompt').fill('Narrow panel generation');
  await page.getByRole('button',{name:'Generate video',exact:true}).click();await expect(dialog.getByText('Ready',{exact:true})).toBeVisible({timeout:20000});
  await page.getByRole('button',{name:'Use for slot',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).velocut.doc().tracks[0].clips.length)).toBe(1);const clip=await page.evaluate(()=>(window as any).velocut.doc().tracks[0].clips[0]);expect(clip.startUs).toBe(2e6);expect(clip.durationUs).toBe(1e6);expect(remote.posts).toBe(1);
  const bounds=await dialog.evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right}));expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(360);expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
});

test('a document storage failure blocks provider submission before any credits are spent',async({page})=>{
  const remote=await provider(page);await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  const result=await page.evaluate(async request=>{
    const v=(window as any).velocut;await v.apply({type:'addTrack',kind:'video'});await v.apply({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:1e6,request});
    const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){if(key==='ydoc')throw new DOMException('Test disk failure','QuotaExceededError');return original.call(this,value,key!);};
    try{return await v.generation({action:'submit',slotId:'slot_2',intentVersion:1,requestId:'storage-failure'});}finally{IDBObjectStore.prototype.put=original;}
  },request);
  expect(result.ok).toBe(false);expect(result.message).toContain('Test disk failure');expect(remote.posts).toBe(0);expect((await page.evaluate(()=>(window as any).velocut.generation({action:'list'}))).total).toBe(0);
});

test('two browser tabs coordinate a single paid submission and share its receipt',async({page})=>{
  const remote=await provider(page);await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.generation);
  await page.evaluate(async request=>{const v=(window as any).velocut;await v.apply({type:'addTrack',kind:'video'});await v.apply({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:1e6,request});await v.collab.flushNow();},request);
  const second=await page.context().newPage();const otherRemote=await provider(second);
  try{
    await second.goto('/');await second.waitForFunction(()=>(window as any).velocut?.doc().generationSlots?.length===1);
    const input={action:'submit',slotId:'slot_2',intentVersion:1,requestId:'both-tabs'};
    const [one,two]=await Promise.all([page.evaluate(input=>(window as any).velocut.generation(input),input),second.evaluate(input=>(window as any).velocut.generation(input),input)]);
    expect(one.ok,JSON.stringify(one)).toBe(true);expect(two.ok,JSON.stringify(two)).toBe(true);expect(one.job.id).toBe(two.job.id);
    await jobReady(second,one.job.id);expect(remote.posts+otherRemote.posts).toBe(1);
    expect((await page.evaluate(()=> (window as any).velocut.generation({action:'list'}))).total).toBe(1);
  }finally{await second.close();}
});
