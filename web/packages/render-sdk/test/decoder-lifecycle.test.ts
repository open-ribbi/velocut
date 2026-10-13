import{test}from'node:test';import assert from'node:assert/strict';
test('codec flushes retain their leases and stream failures cannot masquerade as EOF',async t=>{
 let active=0,peak=0,finishFlush!:()=>void;const pendingFlush=new Promise<void>(r=>finishFlush=r);
 const mocks={self:{postMessage(){}},EncodedVideoChunk:class{},VideoDecoder:class{
  state='unconfigured';decodeQueueSize=0;callbacks:any;constructor(callbacks:any){this.callbacks=callbacks;active++;peak=Math.max(peak,active);}configure(){this.state='configured';}decode(){}flush(){return pendingFlush;}close(){assert.notEqual(this.state,'closed');this.state='closed';active--;}
 }};
 for(const[key,value]of Object.entries(mocks)){const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];});}
 t.mock.timers.enable({apis:['setTimeout']});
 const {Source}=await import('../dist/media.worker.js');
 const sources:any[]=[];t.after(()=>sources.forEach(source=>source.dispose()));
 const create=(id:number)=>{const s:any=new Source(id);Object.assign(s,{cts:[0,100000,200000],byCts:[0,1,2],syncIndices:[0],sync:[true,false,false],offsets:[0,0,0],sizes:[0,0,0],durs:[100000,100000,100000],config:{},feedIndex:3,wantIdx:2,probe:{width:96,height:64},file:{slice:()=>({arrayBuffer:async()=>new ArrayBuffer(0)})}});sources.push(s);s.ensureDecoder();return s;};
 const first=create(1);create(2);create(3);create(4);
 const decoder=first.decoder;first.scheduleStillCheck();t.mock.timers.tick(60);
 first.steer(100000,false);await Promise.resolve();await Promise.resolve();
 assert.equal(first.decoder,decoder);assert.equal(active,4);
 create(5);assert.equal(decoder.state,'configured','a flushing decoder must remain pinned');assert.equal(peak,4);
 first.lastSentCts=100000;finishFlush();await Promise.resolve();await Promise.resolve();await Promise.resolve();
 assert.equal(decoder.state,'closed');assert.equal(active,3);assert.equal(peak,4);
 t.mock.method(console,'error',()=>{});first.streamReset();const streaming=first.strDec;
 streaming.state='closed';active--;streaming.callbacks.error(Error('injected stream failure'));
 await assert.rejects(first.streamPull(),/injected stream failure/);
 first.streamReset();let completeRead!:(data:ArrayBuffer)=>void;first.file={slice:()=>({arrayBuffer:()=>new Promise<ArrayBuffer>(r=>completeRead=r)})};
 const pulling=first.streamPull();const duringRead=first.strDec;duringRead.state='closed';active--;duringRead.callbacks.error(Error('stream failed while reading'));completeRead(new ArrayBuffer(0));
 await assert.rejects(pulling,/stream failed while reading/);
});
