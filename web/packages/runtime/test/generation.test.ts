import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store,TsEngineAdapter,configureGeneration,atomicRuntime,type GenerationAdapter,type GenerationLedger} from '../dist/index.js';
import {VideoGenTransportError} from '@velocut/render-sdk';
import {ops,ref} from '@velocut/protocol';

const request={channel:'test',model:'model',prompt:'A calm lake',ratio:'16:9'};
const ok=(r:any)=>{assert.equal(r.ok,true,JSON.stringify(r));return r;};
const sleep=(ms=5)=>new Promise(r=>setTimeout(r,ms));
function backend(){
  let ledger:GenerationLedger|null=null,mutex:Promise<unknown>=Promise.resolve(),leader=false;
  return {submits:0,polls:0,ready:false,downloadFails:0,unknown:false,failWrite:false,files:new Map<string,Blob>(),tasks:new Set<string>(),
    adapter(projectId='project'):GenerationAdapter{const b=this;return {
      projectId,channels:()=>[{id:'test',models:['model'],capabilities:{model:{durationsS:[5,10],ratios:['16:9'],imageToVideo:true}}}],binding:()=>projectId+':test',
      read:async()=>structuredClone(ledger),write:async l=>{if(b.failWrite)throw Error('Disk unavailable');ledger=structuredClone(l);},
      lock:work=>{const next=mutex.then(work);mutex=next.catch(()=>{});return next;},
      lead:async(work,signal)=>{while(leader&&!signal.aborted)await sleep();if(signal.aborted)return;leader=true;try{await work();}finally{leader=false;}},
      submit:async j=>{b.submits++;const taskId='provider_'+b.submits;b.tasks.add(taskId);assert.equal(j.providerDurationS,10);if(b.unknown)throw new VideoGenTransportError('connection dropped after acceptance');return {taskId};},
      poll:async j=>{b.polls++;assert.ok(b.tasks.has(j.providerTaskId!));return b.ready?{state:'succeeded',status:'completed',result:{videoUrl:'https://provider.invalid/result.mp4',cost:2}}:{state:'running',status:'processing'};},
      download:async j=>{if(b.downloadFails-->0)throw Error('download interrupted');return {src:`opfs://${projectId}-${j.id}.mp4`,name:'Lake',durationUs:8e6,width:320,height:180,hasAudio:false,size:100};},
      prepareReference:async()=> 'https://upload.invalid/ref.png',
      capture:async()=>({blob:new Blob(['png']),name:'frame.png',provenance:{kind:'timeline',timeUs:0}}),saveReference:async(id,blob)=>{b.files.set(id,blob);return 'opfs://'+id;},referenceBlob:async()=>new Blob(['png']),mediaBlob:async()=>new Blob(['video']),attach:async()=>{},pollIntervalMs:5,
    };},get ledger(){return structuredClone(ledger);},set ledger(v:GenerationLedger|null){ledger=structuredClone(v);}};
}
function fixture(b=backend(),project='project'){
  const store=new Store(new TsEngineAdapter(project,320,180,30,1));ok(store.dispatch({type:'addTrack',kind:'video'}));ok(store.dispatch({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:6e6,request}));
  const manager=configureGeneration(store,b.adapter(project));return {store,manager,b,slotId:'slot_2'};
}
async function until(m:ReturnType<typeof configureGeneration>,jobId:string,predicate:(j:any)=>boolean){for(let i=0;i<1000;i++){const j=ok(await m.execute({action:'get',jobId})).job;if(predicate(j))return j;await sleep();}throw Error('Job did not reach expected state');}
const submit=async(f:ReturnType<typeof fixture>,requestId='one')=>ok(await f.manager.execute({action:'submit',slotId:f.slotId,intentVersion:1,requestId})).job;

test('generation intents compose with operation refs; pending frames and stable-source adoption are undoable',async()=>{
  const store=new Store(new TsEngineAdapter('slots',320,180,30,1)),api=atomicRuntime(store);
  const r=ok(await api.transaction({action:'commit',runtimeId:api.runtimeId,expectedRevision:0,requestId:'create',operations:[{id:'t',command:ops.addTrack({kind:'video'})},{id:'s',command:ops.addGenerationSlot({trackId:ref('t','trackId'),startUs:0,durationUs:6e6,request})}]}));
  assert.equal(r.data.results.s.slotId,'slot_2');assert.deepEqual(store.evaluate(0).pendingGenerationIds,['slot_2']);assert.equal(store.getState().durationUs,6e6);
  ok(store.dispatch({type:'addAsset',id:'source',kind:'video',src:'opfs://one.mp4',name:'One',durationUs:10e6}));
  ok(store.dispatch({type:'resolveGenerationSlot',slotId:'slot_2',intentVersion:1,assetId:'source',jobId:'job'}));const clip=store.getState().doc.tracks[0].clips[0];
  ok(store.dispatch({type:'addEffect',clipId:clip.id,effect:'brightnessContrast',params:{brightness:.1}}));
  ok(store.dispatch({type:'addAsset',id:'other',kind:'video',src:'opfs://two.mp4',name:'Two',durationUs:12e6}));
  const effect=structuredClone(store.getState().doc.tracks[0].clips[0].effects);
  ok(store.dispatch({type:'resolveGenerationSlot',slotId:'slot_2',intentVersion:1,assetId:'other',jobId:'other-job'}));
  assert.equal(store.getState().doc.tracks[0].clips[0].id,clip.id);assert.deepEqual(store.getState().doc.tracks[0].clips[0].effects,effect);assert.equal(store.evaluate(0).pendingGenerationIds,undefined);
  store.undo();assert.equal(store.getState().doc.tracks[0].clips[0].assetId,'source');store.redo();assert.equal(store.getState().doc.tracks[0].clips[0].assetId,'other');
  ok(store.dispatch({type:'moveClip',clipId:clip.id,startUs:2e6}));assert.equal(store.getState().doc.generationSlots![0].startUs,2e6);assert.equal(store.getState().doc.generationSlots![0].intentVersion,1);
  ok(store.dispatch({type:'trimClip',clipId:clip.id,edge:'out',toUs:5e6}));assert.equal(store.getState().doc.generationSlots![0].intentVersion,2);
});

test('a paid submission is idempotent and returns a candidate without editing the document',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());const before=JSON.stringify(f.store.getState().doc);
  const plan=ok(await f.manager.execute({action:'plan',slotId:f.slotId}));assert.equal(plan.providerDurationS,10);assert.equal(plan.targetDurationUs,6e6);
  const [a,b]=await Promise.all([submit(f),submit(f)]);assert.equal(a.id,b.id);
  await until(f.manager,a.id,j=>!!j.providerTaskId);assert.equal(f.b.submits,1);f.b.ready=true;
  const ready=await until(f.manager,a.id,j=>j.state==='succeeded');assert.equal(ready.result.durationUs,8e6);assert.equal(JSON.stringify(f.store.getState().doc),before);
  assert.equal((ready as any).binding,undefined);assert.equal((ready as any).providerResult,undefined);
  const adopted=ok(await f.manager.execute({action:'adopt',slotId:f.slotId,jobId:a.id,intentVersion:1,expectedRevision:f.store.getState().revision}));assert.ok(adopted.clipId);assert.equal(f.store.getState().doc.tracks[0].clips[0].durationUs,6e6);
  f.store.undo();f.store.redo();assert.equal(f.b.submits,1);
});

test('reload resumes a persisted provider receipt; lost submission receipts are never re-posted',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());const job=await submit(f);await until(f.manager,job.id,j=>!!j.providerTaskId);f.manager.dispose();
  const restored=new Store(new TsEngineAdapter('same project',320,180,30,1));restored.loadDocument(f.store.getState().doc);const next=configureGeneration(restored,f.b.adapter());t.after(()=>next.dispose());f.b.ready=true;
  await until(next,job.id,j=>j.state==='succeeded');assert.equal(f.b.submits,1);
  const uncertain=fixture();t.after(()=>uncertain.manager.dispose());uncertain.b.unknown=true;const lost=await submit(uncertain);await until(uncertain.manager,lost.id,j=>j.state==='submission_unknown');
  const resume=await uncertain.manager.execute({action:'resume',jobId:lost.id});assert.equal(resume.ok,false);assert.equal(uncertain.b.submits,1);
  assert.equal(ok(await uncertain.manager.execute({action:'submit',slotId:uncertain.slotId,intentVersion:1,requestId:'one'})).job.id,lost.id);
});

test('download retry uses the original receipt and cancelled tracking can resume without paying again',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());const job=await submit(f);await until(f.manager,job.id,j=>!!j.providerTaskId);
  ok(await f.manager.execute({action:'cancel',jobId:job.id}));await sleep(30);assert.equal(ok(await f.manager.execute({action:'get',jobId:job.id})).job.state,'cancelled');
  f.b.ready=true;f.b.downloadFails=1;ok(await f.manager.execute({action:'resume',jobId:job.id}));await until(f.manager,job.id,j=>j.state==='blocked');
  await sleep(30);ok(await f.manager.execute({action:'resume',jobId:job.id}));await until(f.manager,job.id,j=>j.state==='succeeded');assert.equal(f.b.submits,1);
});

test('moving a slot is compatible; edits, deletion, overlap and stale revisions reject adoption atomically',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());const job=await submit(f);await until(f.manager,job.id,j=>!!j.providerTaskId);f.b.ready=true;await until(f.manager,job.id,j=>j.state==='succeeded');
  ok(f.store.dispatch({type:'updateGenerationSlot',slotId:f.slotId,startUs:2e6}));assert.equal(f.store.getState().doc.generationSlots![0].intentVersion,1);
  const before=JSON.stringify(f.store.getState().doc);
  assert.equal((await f.manager.execute({action:'adopt',slotId:f.slotId,jobId:job.id,intentVersion:1,expectedRevision:0})).ok,false);assert.equal(JSON.stringify(f.store.getState().doc),before);
  ok(f.store.dispatch({type:'addAsset',id:'occupied',kind:'video',src:'opfs://occupied',name:'Other',durationUs:10e6}));ok(f.store.dispatch({type:'addClip',trackId:'track_1',assetId:'occupied',startUs:3e6,durationUs:1e6}));
  const occupied=JSON.stringify(f.store.getState().doc);assert.equal((await f.manager.execute({action:'adopt',slotId:f.slotId,jobId:job.id,intentVersion:1,expectedRevision:f.store.getState().revision})).ok,false);assert.equal(JSON.stringify(f.store.getState().doc),occupied);
  f.store.undo();ok(f.store.dispatch({type:'updateGenerationSlot',slotId:f.slotId,request:{...request,prompt:'Different shot'}}));
  assert.equal((await f.manager.execute({action:'adopt',slotId:f.slotId,jobId:job.id,intentVersion:2,expectedRevision:f.store.getState().revision})).ok,false);
  ok(f.store.dispatch({type:'removeGenerationSlot',slotId:f.slotId}));assert.equal((await f.manager.execute({action:'adopt',slotId:f.slotId,jobId:job.id,intentVersion:1,expectedRevision:f.store.getState().revision})).ok,false);
  assert.equal(ok(await f.manager.execute({action:'get',jobId:job.id})).job.result.durationUs,8e6);
});

test('two runtime views share one worker and requests; separate projects never see each other results',async t=>{
  const b=backend(),first=fixture(b);t.after(()=>first.manager.dispose());
  const same=new Store(new TsEngineAdapter('same',320,180,30,1));same.loadDocument(first.store.getState().doc);const second=configureGeneration(same,b.adapter());t.after(()=>second.dispose());
  const [a,c]=await Promise.all([submit(first),second.execute({action:'submit',slotId:first.slotId,intentVersion:1,requestId:'one'})]);assert.equal(a.id,ok(c).job.id);
  b.ready=true;await until(first.manager,a.id,j=>j.state==='succeeded');assert.equal(b.submits,1);
  const other=fixture(backend(),'other');t.after(()=>other.manager.dispose());assert.equal(ok(await other.manager.execute({action:'list'})).total,0);assert.equal((await other.manager.execute({action:'get',jobId:a.id})).ok,false);
  assert.equal(first.store.getState().doc.assets.length,0);assert.equal(other.store.getState().doc.assets.length,0);
});

test('durable-write failure cannot submit, and captured references are immutable project records',async t=>{
  const f=fixture();t.after(()=>f.manager.dispose());await f.manager.ready;const captured=ok(await f.manager.execute({action:'captureReference',source:{kind:'timeline',timeUs:0},expectedRevision:f.store.getState().revision})).reference;
  assert.equal(captured.provenance.revision,f.store.getState().revision);assert.equal((await f.manager.referenceBlob(captured.id)).size,3);
  f.b.failWrite=true;assert.equal((await f.manager.execute({action:'submit',slotId:f.slotId,intentVersion:1,requestId:'one'})).ok,false);await sleep(300);assert.equal(f.b.submits,0);
});

test('crash recovery preserves an unknown submission even without a saved receipt',async t=>{
  const b=backend();const seeded=fixture(b);await seeded.manager.ready;seeded.manager.dispose();await sleep(20);
  const now=Date.now();b.ledger={version:1,projectId:'project',references:[],jobs:[{id:'gen_lost',requestId:'lost',slotId:seeded.slotId,intentVersion:1,projectId:'project',request,targetDurationUs:6e6,providerDurationS:10,state:'submitting',binding:'project:test',createdAt:now,updatedAt:now,submissionStartedAt:0}]};
  const next=fixture(b);t.after(()=>next.manager.dispose());await until(next.manager,'gen_lost',j=>j.state==='submission_unknown');
  assert.equal((await next.manager.execute({action:'resume',jobId:'gen_lost'})).ok,false);assert.equal(b.submits,0);assert.equal(b.ledger!.version,2);
  assert.equal(ok(await next.manager.execute({action:'submit',slotId:next.slotId,intentVersion:1,requestId:'lost'})).job.id,'gen_lost');
});

test('out-of-order candidates keep their slot identity and preserve edits when switching takes',async t=>{
  const b=backend(),base=b.adapter.bind(b);b.adapter=(project='project')=>{
    const adapter=base(project);adapter.poll=async job=>job.request.prompt==='second'||b.ready?{state:'succeeded',status:'completed',result:{videoUrl:'https://provider.invalid/result.mp4'}}:{state:'running',status:'processing'};return adapter;
  };
  const f=fixture(b);t.after(()=>f.manager.dispose());ok(f.store.dispatch({type:'addGenerationSlot',trackId:'track_1',startUs:10e6,durationUs:6e6,request:{...request,prompt:'second'}}));const secondSlot=f.store.getState().doc.generationSlots![1];
  const first=await submit(f),second=ok(await f.manager.execute({action:'submit',slotId:secondSlot.id,intentVersion:1,requestId:'second'})).job;
  await until(f.manager,second.id,j=>j.state==='succeeded');assert.equal(ok(await f.manager.execute({action:'get',jobId:first.id})).job.state,'running');
  const secondAdopt=ok(await f.manager.execute({action:'adopt',slotId:secondSlot.id,jobId:second.id,intentVersion:1,expectedRevision:f.store.getState().revision}));assert.equal(f.store.getState().doc.tracks[0].clips[0].startUs,10e6);
  b.ready=true;await until(f.manager,first.id,j=>j.state==='succeeded');ok(await f.manager.execute({action:'adopt',slotId:f.slotId,jobId:first.id,intentVersion:1,expectedRevision:f.store.getState().revision}));
  ok(f.store.dispatch({type:'setClipVolume',clipId:secondAdopt.clipId,volume:.42}));const take=ok(await f.manager.execute({action:'submit',slotId:secondSlot.id,intentVersion:1,requestId:'second-take'})).job;await until(f.manager,take.id,j=>j.state==='succeeded');
  const swapped=ok(await f.manager.execute({action:'adopt',slotId:secondSlot.id,jobId:take.id,intentVersion:1,expectedRevision:f.store.getState().revision}));assert.equal(swapped.clipId,secondAdopt.clipId);assert.equal(f.store.getState().doc.tracks[0].clips[1].volume,.42);assert.equal(b.submits,3);
});

test('a notifying host stays idle without polling storage and wakes for newly queued work',async t=>{
  const b=backend(),store=new Store(new TsEngineAdapter('idle',320,180,30,1));ok(store.dispatch({type:'addTrack',kind:'video'}));ok(store.dispatch({type:'addGenerationSlot',trackId:'track_1',startUs:0,durationUs:6e6,request}));
  const adapter=b.adapter(),read=adapter.read;let reads=0;adapter.read=async()=>{reads++;return read();};adapter.watch=()=>()=>{};
  const manager=configureGeneration(store,adapter);t.after(()=>manager.dispose());await manager.ready;await sleep(25);const idle=reads;await sleep(300);assert.equal(reads,idle);
  b.ready=true;const job=ok(await manager.execute({action:'submit',slotId:'slot_2',intentVersion:1,requestId:'wake'})).job;await until(manager,job.id,j=>j.state==='succeeded');assert.equal(b.submits,1);
});

test('opaque provider handles persist across reload and stay outside public job metadata',async t=>{
  const b=backend(),factory=b.adapter.bind(b);b.adapter=(project='project')=>{
    const a=factory(project),submit=a.submit,poll=a.poll;
    a.submit=async(...args)=>({...await submit(...args),handle:{region:'west',opaque:'private-checkpoint'}});
    a.poll=async(job,signal,handle)=>{assert.equal(handle?.region,'west');assert.equal(handle?.opaque,'private-checkpoint');return {...await poll(job,signal),handle:{...handle,cursor:2}};};return a;
  };
  const f=fixture(b);t.after(()=>f.manager.dispose());const job=await submit(f);await until(f.manager,job.id,j=>!!j.providerTaskId);await sleep(25);assert.ok(!JSON.stringify(ok(await f.manager.execute({action:'get',jobId:job.id}))).includes('private-checkpoint'));f.manager.dispose();
  assert.equal(b.ledger!.jobs[0].providerHandle?.region,'west');const restored=fixture(b);t.after(()=>restored.manager.dispose());b.ready=true;
  const complete=await until(restored.manager,job.id,j=>j.state==='succeeded');assert.equal(b.submits,1);assert.equal(complete.providerHandle,undefined);assert.ok(!JSON.stringify(complete).includes('private-checkpoint'));
});
