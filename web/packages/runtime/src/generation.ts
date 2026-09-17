import type {JsonObject} from '@velocut/provider-sdk';
import {GenerationRequestSchema,generationInputReferences,generationReferenceIds,type GenerationRequest,type GenerationSlot,type Command,type Envelope} from '@velocut/protocol';
import type {VideoModelCapabilities,VideoGenResult,VideoGenPoll} from '@velocut/provider-sdk/video';
import type {Store} from './store';

export interface GenerationChannel {id:string;label?:string;models:string[];defaultModel?:string;capabilities?:Record<string,VideoModelCapabilities>;modelSettings?:Record<string,import('@velocut/provider-sdk/catalog').ModelSettings>}
export interface GenerationReference {kind?:'image'|'video'|'audio';id:string;name:string;src:string;createdAt:number;provenance:Record<string,unknown>}
export interface GenerationMedia {src:string;name:string;durationUs:number;width:number;height:number;hasAudio:boolean;size:number}
export type GenerationState='queued'|'preparing'|'submitting'|'submission_unknown'|'running'|'downloading'|'succeeded'|'failed'|'blocked'|'cancelled';
export interface GenerationJob {
  id:string;requestId:string;slotId:string;intentVersion:number;projectId:string;
  request:GenerationRequest;targetDurationUs:number;providerDurationS:number;
  state:GenerationState;createdAt:number;updatedAt:number;providerTaskId?:string;providerStatus?:string;
  submissionStartedAt?:number;
  error?:string;result?:GenerationMedia;cost?:number;
}
interface PrivateJob extends GenerationJob {binding:string;providerHandle?:JsonObject;providerResult?:VideoGenResult}
export interface GenerationLedger {version:1|2|3|4;projectId:string;jobs:PrivateJob[];references:GenerationReference[]}
export interface GenerationAdapter {
  projectId:string;channels():GenerationChannel[];binding(channel:string,request?:GenerationRequest):string|Promise<string>;
  resolveRequest?(request:GenerationRequest):GenerationRequest;
  requestedDuration?(request:GenerationRequest):number|undefined;
  materializeRequest?(request:GenerationRequest,durationS:number):GenerationRequest;
  validateRequest?(request:GenerationRequest,durationS:number):void;
  flushDocument?():Promise<void>;
  read():Promise<GenerationLedger|null>;write(value:GenerationLedger):Promise<void>;
  /** Serialize read/modify/write across every runtime sharing this project. */
  lock<T>(work:()=>Promise<T>):Promise<T>;
  /** Exactly one project runner across tabs/processes; resolves on abort. */
  lead(work:()=>Promise<void>,signal:AbortSignal):Promise<void>;
  watch?(notify:()=>void):()=>void;
  prepareReference(reference:GenerationReference,signal:AbortSignal):Promise<string>;
  submit(job:GenerationJob,referenceUrl:string|undefined,signal:AbortSignal,referenceUrls?:Record<string,string>):Promise<{taskId:string;handle?:JsonObject}>;
  poll(job:GenerationJob,signal:AbortSignal,handle?:JsonObject):Promise<VideoGenPoll>;
  download(job:GenerationJob,result:VideoGenResult,signal:AbortSignal):Promise<GenerationMedia>;
  capture(input:Record<string,unknown>,signal?:AbortSignal):Promise<{blob:Blob;name:string;kind?:'image'|'video'|'audio';provenance:Record<string,unknown>}>;
  saveReference(id:string,blob:Blob,name?:string):Promise<string>;
  referenceBlob(ref:GenerationReference):Promise<Blob>;
  attach(assetId:string,result:GenerationMedia):Promise<void>;
  mediaBlob(result:GenerationMedia):Promise<Blob>;
  pollIntervalMs?:number;concurrency?:number;
}
const managers=new WeakMap<Store,GenerationManager>();
export function configureGeneration(store:Store,adapter:GenerationAdapter){if(managers.has(store))throw Error('Generation is already configured');const m=new GenerationManager(store,adapter);managers.set(store,m);return m;}
export function generationManager(store:Store){return managers.get(store);}
export async function generation(store:Store,input:unknown,options?:{dispatch?:(c:Command)=>Envelope;signal?:AbortSignal}){const m=managers.get(store);return m?m.execute(input,options):{ok:false,message:'Video generation is not configured on this host'};}
export const GENERATION_SCHEMA={type:'object',required:['action'],properties:{action:{enum:['capabilities','plan','captureReference','references','submit','get','list','cancel','resume','registerResult','adopt']},slotId:{type:'string'},jobId:{type:'string'},requestId:{type:'string'},intentVersion:{type:'integer'},expectedRevision:{type:'integer'},source:{description:'captureReference: {kind:timeline,timeUs,clipId?} or {kind:asset,assetId}'},fit:{enum:['trim','sourceDuration']},acceptEarlierIntent:{type:'boolean'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:100}},description:'Generation is asynchronous and project-bound. submit needs slotId, intentVersion and a stable requestId. get/list never place a clip. registerResult/adopt require expectedRevision; adopt also requires the current intentVersion. cancel stops local tracking (remote cancellation is not promised). resume never re-submits an unknown submission. No endpoints, keys or reference URLs accepted.'};
const id=(v:unknown)=>{if(typeof v!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v))throw Error('Invalid identifier');return v;};
const err=(e:unknown)=>String(e instanceof Error?e.message:e).replace(/https?:\/\/[^\s]+/g,'[provider URL]').slice(0,1000);
const wait=(ms:number,signal:AbortSignal)=>new Promise<void>(resolve=>{if(signal.aborted)return resolve();const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});});
const fresh=(projectId:string):GenerationLedger=>({version:4,projectId,jobs:[],references:[]});
const publicJob=({binding:_binding,providerResult:_result,providerHandle:_handle,...job}:PrivateJob):GenerationJob=>structuredClone(job);

export class GenerationManager {
  readonly ready:Promise<void>;
  private store:Store;private adapter:GenerationAdapter;
  private root=new AbortController();private controllers=new Map<string,AbortController>();
  private listeners=new Set<()=>void>();private stopWatch?:()=>void;
  private published='';private wakeVersion=0;private wakeRunner?:()=>void;
  private wake(){this.wakeVersion++;this.wakeRunner?.();}
  private async waitForWork(version:number){
    if(this.root.signal.aborted||version!==this.wakeVersion)return;
    await new Promise<void>(resolve=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const done=()=>{if(timer)clearTimeout(timer);this.root.signal.removeEventListener('abort',done);this.wakeRunner=undefined;resolve();};
      this.wakeRunner=done;this.root.signal.addEventListener('abort',done,{once:true});
      // Browser hosts notify journal changes. Custom hosts without notifications
      // retain a polling fallback for writes from another runtime.
      if(!this.adapter.watch)timer=setTimeout(done,250);
    });
  }
  private snapshot:{jobs:GenerationJob[];references:GenerationReference[];error?:string}={jobs:[],references:[]};
  constructor(store:Store,adapter:GenerationAdapter){
    this.store=store;this.adapter=adapter;
    this.ready=this.refresh();this.stopWatch=adapter.watch?.(()=>void this.refresh().catch(e=>this.problem(e)));
    void this.ready.then(()=>adapter.lead(()=>this.run(),this.root.signal)).catch(e=>{if(!this.root.signal.aborted)this.problem(e);});
  }
  subscribe=(fn:()=>void)=>{this.listeners.add(fn);return()=>{this.listeners.delete(fn);};};
  getSnapshot=()=>this.snapshot;
  private publish(ledger:GenerationLedger){for(const j of ledger.jobs)if(j.state==='cancelled')this.controllers.get(j.id)?.abort();const signature=JSON.stringify(ledger);if(signature===this.published)return;this.published=signature;this.wake();this.snapshot={jobs:ledger.jobs.map(publicJob),references:structuredClone(ledger.references)};this.listeners.forEach(fn=>fn());}
  private problem(e:unknown){this.snapshot={...this.snapshot,error:err(e)};this.listeners.forEach(fn=>fn());}
  private async read(){const l=await this.adapter.read();if(l&&l.version!==1&&l.version!==2&&l.version!==3&&l.version!==4)throw Error('Unsupported generation ledger version');if(l&&!l.projectId&&l.jobs.every(j=>j.projectId===this.adapter.projectId))l.projectId=this.adapter.projectId;if(l&&l.projectId!==this.adapter.projectId)throw Error('Generation ledger belongs to another project');if(l)l.version=4;return l??fresh(this.adapter.projectId);}
  async refresh(){this.publish(await this.read());}
  private async mutate<T>(fn:(l:GenerationLedger)=>T|Promise<T>):Promise<T>{return this.adapter.lock(async()=>{const l=await this.read(),result=await fn(l);await this.adapter.write(l);this.publish(l);return result;});}
  private async update(jobId:string,fn:(j:PrivateJob)=>void){return this.mutate(l=>{const j=l.jobs.find(j=>j.id===jobId);if(!j)throw Error('Unknown generation job');fn(j);j.updatedAt=Date.now();return structuredClone(j);});}
  private slot(slotId:string):GenerationSlot{const s=this.store.getState().doc.generationSlots?.find(s=>s.id===slotId);if(!s)throw Error('Generation slot no longer exists');return s;}
  private plan(slot:GenerationSlot){
    let request=GenerationRequestSchema.parse(this.adapter.resolveRequest?.(slot.request)??slot.request),channel=this.adapter.channels().find(c=>c.id===request.channel);
    if(!channel||!request.model||channel.models.length&&!channel.models.includes(request.model))throw Error('Choose a configured video channel and model');
    if(!request.input&&!request.prompt.trim())throw Error('Enter a generation prompt');
    const c=channel.capabilities?.[request.model],clip=this.store.getState().doc.tracks.flatMap(t=>t.clips).find(c=>c.id===slot.clipId);
    const required=slot.durationUs*(clip?.speed??1)/1e6;
    if(!Number.isFinite(required)||required<=0)throw Error('Source duration must be finite and positive');
    const explicitDuration=this.adapter.requestedDuration?.(request);
    let duration=explicitDuration??required;
    if(!Number.isFinite(duration)||duration<=0)throw Error('Model source duration must be finite and positive');
    if(c?.durationsS&&explicitDuration===undefined){const durations=[...c.durationsS].filter(n=>Number.isFinite(n)&&n>0).sort((a,b)=>a-b);const fit=durations.find(n=>n>=required);if(fit===undefined)throw Error('Target duration exceeds the configured model durations');duration=fit;}
    if(c?.ratios&&(!request.ratio||!c.ratios.includes(request.ratio)))throw Error('Choose a supported aspect ratio');
    if(c?.resolutions&&(!request.resolution||!c.resolutions.includes(request.resolution)))throw Error('Choose a supported resolution');
    if(request.firstFrameReferenceId&&c?.imageToVideo===false)throw Error('This model does not support an image first frame');
    if(request.generateAudio&&c?.audio===false)throw Error('This model does not support generated audio');
    request=GenerationRequestSchema.parse(this.adapter.materializeRequest?.(request,duration)??request);
    this.adapter.validateRequest?.(request,duration);
    return {slotId:slot.id,intentVersion:slot.intentVersion,request:structuredClone(request),targetDurationUs:slot.durationUs,requiredSourceDurationS:required,providerDurationS:duration,capabilitiesKnown:!!c,fit:duration>required?'trim' as const:'exact' as const};
  }
  async referenceBlob(referenceId:string){await this.ready;const r=(await this.read()).references.find(r=>r.id===referenceId);if(!r)throw Error('Unknown reference');return this.adapter.referenceBlob(r);}
  async resultBlob(jobId:string){await this.ready;const j=(await this.read()).jobs.find(j=>j.id===jobId);if(!j?.result)throw Error('No result');return this.adapter.mediaBlob(j.result);}
  async execute(input:unknown,options:{dispatch?:(c:Command)=>Envelope;signal?:AbortSignal}={}){
    try{
      await this.ready;options.signal?.throwIfAborted();
      if(this.root.signal.aborted)throw Error('Generation runtime is closed; reopen the project');
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid generation request');const p=input as Record<string,any>;
      const allowed:Record<string,string[]>={capabilities:[],plan:['slotId'],captureReference:['source','expectedRevision'],references:['offset','limit'],submit:['slotId','intentVersion','requestId'],get:['jobId'],list:['slotId','offset','limit'],cancel:['jobId'],resume:['jobId'],registerResult:['jobId','expectedRevision'],adopt:['slotId','jobId','expectedRevision','intentVersion','fit','acceptEarlierIntent']};
      if(!allowed[p.action]||Object.keys(p).some(k=>k!=='action'&&!allowed[p.action].includes(k)))throw Error('Unknown generation action or fields');
      const page=<T>(items:T[])=>{const offset=p.offset??0,limit=p.limit??50;if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>100)throw Error('Invalid generation page');return {total:items.length,items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null};};
      if(p.action==='capabilities')return {ok:true,projectId:this.adapter.projectId,channels:structuredClone(this.adapter.channels()),schema:GENERATION_SCHEMA};
      if(p.action==='plan')return {ok:true,...this.plan(this.slot(id(p.slotId)))};
      if(p.action==='captureReference'){
        const revision=this.store.getState().revision;if(p.expectedRevision!==revision)throw Error('Document changed; capture references with the current expectedRevision');
        const captured=await this.adapter.capture(p.source,options.signal);options.signal?.throwIfAborted();if(this.store.getState().revision!==revision)throw Error('Document changed during reference capture');
        const refId='ref_'+crypto.randomUUID(),src=await this.adapter.saveReference(refId,captured.blob,captured.name),reference={id:refId,src,name:captured.name,...(captured.kind?{kind:captured.kind}:{}),createdAt:Date.now(),provenance:{...captured.provenance,revision}};
        await this.mutate(l=>{l.references.push(reference);});return {ok:true,reference};
      }
      if(p.action==='references')return {ok:true,...page((await this.read()).references)};
      if(p.action==='submit'){
        id(p.requestId);id(p.slotId);if(!Number.isSafeInteger(p.intentVersion)||p.intentVersion<1)throw Error('intentVersion is required');
        await this.adapter.flushDocument?.();options.signal?.throwIfAborted();
        const job=await this.mutate(async l=>{
          const old=l.jobs.find(j=>j.requestId===p.requestId);if(old){if(old.slotId!==p.slotId||old.intentVersion!==p.intentVersion)throw Error('requestId was used for another generation intent');return publicJob(old);}
          const slot=this.slot(p.slotId);if(slot.intentVersion!==p.intentVersion)throw Error('Generation intent changed');const plan=this.plan(slot);
          for(const [kind,ids] of [['image',[plan.request.firstFrameReferenceId,plan.request.lastFrameReferenceId,...plan.request.referenceImageIds??[]]],['video',plan.request.referenceVideoIds??[]],['audio',plan.request.referenceAudioIds??[]]] as const)for(const id of ids){if(!id)continue;const reference=l.references.find(r=>r.id===id);if(!reference)throw Error('Reference is not in this project');if((reference.kind??'image')!==kind)throw Error('Reference media kind does not match its role');}
          for(const ref of generationInputReferences(plan.request.input)){const saved=l.references.find(r=>r.id===ref.id);if(!saved||(saved.kind??'image')!==ref.kind)throw Error('Reference is missing or has the wrong media kind');}
          const j:PrivateJob={id:'gen_'+crypto.randomUUID(),requestId:p.requestId,slotId:slot.id,intentVersion:slot.intentVersion,projectId:this.adapter.projectId,request:plan.request,targetDurationUs:slot.durationUs,providerDurationS:plan.providerDurationS,state:'queued',createdAt:Date.now(),updatedAt:Date.now(),binding:await this.adapter.binding(plan.request.channel,plan.request)};
          l.jobs.push(j);return publicJob(j);
        });return {ok:true,job};
      }
      const ledger=await this.read();
      if(p.action==='list')return {ok:true,...page(ledger.jobs.filter(j=>!p.slotId||j.slotId===id(p.slotId)).map(publicJob))};
      const job=ledger.jobs.find(j=>j.id===id(p.jobId));if(!job)throw Error('Unknown generation job');
      if(p.action==='get')return {ok:true,job:publicJob(job)};
      if(p.action==='cancel'){
        const next=await this.update(job.id,j=>{if(j.state!=='succeeded'){j.state='cancelled';j.error=j.providerTaskId?'Local tracking stopped; the provider may still complete the task.':j.submissionStartedAt!==undefined?'Local tracking stopped. An in-flight submission may still be accepted.':'Queued generation stopped before submission.';}});
        this.controllers.get(job.id)?.abort();return {ok:true,job:publicJob(next)};
      }
      if(p.action==='resume'){
        if(this.controllers.has(job.id))throw Error('Job is still stopping; resume after its request settles');
        if(!['cancelled','blocked','submission_unknown','failed'].includes(job.state))throw Error('Only stopped or blocked jobs can resume');
        if(!job.providerTaskId&&job.submissionStartedAt!==undefined)throw Error('No provider receipt is available; an uncertain submission is never automatically re-submitted');
        const j=await this.update(job.id,j=>{j.state=j.providerTaskId?'running':'queued';delete j.error;});return {ok:true,job:publicJob(j)};
      }
      if(!job.result)throw Error('Generation has no downloaded result');
      await this.adapter.mediaBlob(job.result);options.signal?.throwIfAborted();
      if(p.expectedRevision!==this.store.getState().revision)throw Error('Document changed; inspect the current revision before adopting');
      const doc=this.store.getState().doc,result=job.result;
      let asset=doc.assets.find(a=>a.src===result.src&&a.kind==='video');const assetId=asset?.id??'generated_'+job.id;
      const commands:Command[]=asset?[]:[{type:'addAsset',id:assetId,kind:'video',src:result.src,name:result.name,durationUs:result.durationUs,width:result.width,height:result.height,hasAudio:result.hasAudio}];
      if(p.action==='adopt'){
        const slot=this.slot(id(p.slotId));if(p.intentVersion!==slot.intentVersion)throw Error('Generation intent changed');
        if(p.acceptEarlierIntent!==undefined&&typeof p.acceptEarlierIntent!=='boolean')throw Error('acceptEarlierIntent must be boolean');
        if((job.slotId!==slot.id||job.intentVersion!==slot.intentVersion)&&p.acceptEarlierIntent!==true)throw Error('Result belongs to an earlier/different intent; review it and explicitly acceptEarlierIntent to adopt');
        if(p.fit!==undefined&&!['trim','sourceDuration'].includes(p.fit))throw Error('Unknown duration fit');
        const speed=doc.tracks.flatMap(t=>t.clips).find(c=>c.id===slot.clipId)?.speed??1;
        const durationUs=p.fit==='sourceDuration'?Math.floor(result.durationUs/speed):slot.durationUs;
        commands.push({type:'resolveGenerationSlot',slotId:slot.id,intentVersion:slot.intentVersion,assetId,durationUs,jobId:job.id});
      }
      if(commands.length){options.signal?.throwIfAborted();const r=(options.dispatch??this.store.dispatch)({type:'batch',commands});if(!r.ok)throw Error(r.error.message);}
      // Storage is already durable. Decoder attachment can be retried/reloaded
      // without repeating generation or registration.
      let warning:string|undefined;try{await this.adapter.attach(assetId,result);}catch(e){warning=err(e);}
      return {ok:true,assetId,clipId:p.action==='adopt'?this.slot(p.slotId).clipId:undefined,revision:this.store.getState().revision,...(warning?{warning}:{})};
    }catch(e){return {ok:false,message:err(e)};}
  }
  private async run(){
    await this.mutate(l=>{for(const j of l.jobs){if(j.state==='submitting'){j.state='submission_unknown';j.error='The previous session closed before saving a provider receipt. Not re-submitting.';}if(j.state==='preparing')j.state='queued';if(j.state==='downloading'&&j.providerTaskId)j.state='running';}});
    const working=new Map<string,Promise<void>>();
    while(!this.root.signal.aborted){
      const version=this.wakeVersion,ledger=await this.read();this.publish(ledger);
      for(const j of ledger.jobs){
        if(working.size>=(this.adapter.concurrency??2))break;
        if(working.has(j.id)||!['queued','running','downloading'].includes(j.state))continue;
        const task=this.process(j.id).catch(e=>this.problem(e)).finally(()=>{working.delete(j.id);this.wake();});working.set(j.id,task);
      }
      await this.waitForWork(version);
    }
    await Promise.allSettled(working.values());
  }
  private async process(jobId:string){
    const controller=new AbortController();this.controllers.set(jobId,controller);const abort=()=>controller.abort();this.root.signal.addEventListener('abort',abort,{once:true});
    try{
      let job=(await this.read()).jobs.find(j=>j.id===jobId)!;
      if(await this.adapter.binding(job.request.channel,job.request)!==job.binding)throw Error('Channel endpoint, credentials or model preset changed; restore its configuration before resuming');
      if(job.state==='queued'){
        job=await this.update(jobId,j=>{if(j.state!=='queued')throw Error('Generation state changed');j.state='preparing';delete j.error;});
        const references=(await this.read()).references,urls:Record<string,string>={};
        for(const id of generationReferenceIds(job.request)){const ref=references.find(r=>r.id===id);if(!ref)throw Error('Reference is missing');urls[id]=await this.adapter.prepareReference(ref,controller.signal);}
        const referenceUrl=job.request.firstFrameReferenceId?urls[job.request.firstFrameReferenceId]:undefined;
        controller.signal.throwIfAborted();
        if(await this.adapter.binding(job.request.channel,job.request)!==job.binding)throw Error('Channel endpoint, credentials or model preset changed during preparation');
        job=await this.update(jobId,j=>{if(j.state==='cancelled')throw Error('Cancelled');j.state='submitting';j.submissionStartedAt=Date.now();});
        const receipt=await this.adapter.submit(publicJob(job),referenceUrl,controller.signal,urls);
        if(typeof receipt.taskId!=='string'||!receipt.taskId.trim())throw Error('Provider returned no valid task receipt');
        job=await this.update(jobId,j=>{j.providerTaskId=receipt.taskId;if(receipt.handle!==undefined)j.providerHandle=structuredClone(receipt.handle);if(j.state!=='cancelled'){j.state='running';delete j.error;}});
      }
      while(!controller.signal.aborted){
        job=(await this.read()).jobs.find(j=>j.id===jobId)!;
        if(job.state==='cancelled')return;
        if(await this.adapter.binding(job.request.channel,job.request)!==job.binding)throw Error('Channel endpoint, credentials or model preset changed; restore its configuration before resuming');
        if(job.state==='downloading'&&job.providerResult){
          const result=await this.adapter.download(publicJob(job),job.providerResult,controller.signal);
          await this.update(jobId,j=>{j.result=result;if(j.state!=='cancelled'){j.state='succeeded';delete j.error;}});return;
        }
        let poll:VideoGenPoll;
        try{poll=await this.adapter.poll(publicJob(job),controller.signal,job.providerHandle);}catch(e){
          if(controller.signal.aborted)throw e;
          if((e as {retryable?:boolean}).retryable===false)throw e;
          await this.update(jobId,j=>{j.error='Polling interrupted; retrying the saved provider task. '+err(e);});await wait(this.adapter.pollIntervalMs??5000,controller.signal);continue;
        }
        job=await this.update(jobId,j=>{
          j.providerStatus=poll.status;
          if(poll.handle!==undefined)j.providerHandle=structuredClone(poll.handle);
          if(poll.result){j.providerResult=poll.result;j.cost=poll.result.cost;}
          if(j.state==='cancelled')return;
          delete j.error;
          if(poll.state==='succeeded')j.state='downloading';else if(poll.state==='failed'){j.state='failed';j.error=poll.error??'Provider generation failed';}else j.state='running';
        });
        if(job.state==='failed'||job.state==='cancelled')return;
        if(job.state!=='downloading')await wait(this.adapter.pollIntervalMs??5000,controller.signal);
      }
    }catch(e){
      if(!this.root.signal.aborted&&!controller.signal.aborted)await this.update(jobId,j=>{
        if(j.state==='cancelled')return;
        j.error=err(e);j.state=j.providerTaskId?'blocked':j.state==='submitting'&&(e as {outcome?:string}).outcome!=='rejected'?'submission_unknown':'failed';
      });
    }finally{this.root.signal.removeEventListener('abort',abort);this.controllers.delete(jobId);}
  }
  dispose(){this.root.abort();this.controllers.forEach(c=>c.abort());this.stopWatch?.();this.listeners.clear();}
}
