import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MediaLibrary, RemoteVideoSource} from '../dist/media.js';
import {MediaTaskScheduler} from '../dist/media-scheduler.js';
function mockWorker(t:any) {
 const workers:any[]=[];const original=globalThis.Worker;
 globalThis.Worker=class {onmessage:any;onerror:any;posts:any[]=[];terminated=false;
 constructor(){workers.push(this);} postMessage(msg:any){this.posts.push(msg);} terminate(){this.terminated=true;}
 receive(data:any){this.onmessage({data});}
 } as any;t.after(()=>globalThis.Worker=original);return workers;
}
const probe={width:1920,height:1080,durationUs:2000000,hasAudio:true};
test('decoder frames are capped on arrival even when no render consumes them',()=>{
 let closed=0;const source=new RemoteVideoSource(1,probe,()=>{});
 for(let i=0;i<100;i++)source.receive({close:()=>closed++} as any,i*1000,1000);
 assert.equal(closed,76);assert.equal(source.cacheBytes,24*1920*1080*4);
 source.disposeFrames();assert.equal(closed,100);assert.equal(source.cacheBytes,0);
});
test('worker teardown rejects pending opens, and late frames are closed',async t=>{
 const workers=mockWorker(t),media=new MediaLibrary(undefined,{scheduler:new MediaTaskScheduler()});
 const opening=media.probeVideo({} as any);media.dispose();await assert.rejects(opening,{name:'AbortError'});
 let closed=0;workers[0].receive({type:'exportFrame',reqId:10,frame:{close:()=>closed++}});
 assert.equal(closed,1);assert.equal(media.diagnostics().pendingRequests,0);assert.equal(workers[0].terminated,true);
});
test('global estimated frame budget evicts idle sources and releases frames',async t=>{
 const workers=mockWorker(t),media=new MediaLibrary(undefined,{frameCacheBytes:1920*1080*4*2});
 const p=media.probeVideo({} as any);workers[0].receive({type:'ready',id:1,probe});const source=await p;media.attachVideo('a',source);
 let closed=0;for(let i=0;i<10;i++)workers[0].receive({type:'frame',id:1,timestampUs:i,durationUs:1,frame:{close:()=>closed++}});
 assert.equal(closed,8);assert.ok(media.diagnostics().frameCacheBytes<=media.diagnostics().frameCacheBudget);
 media.dispose();assert.equal(closed,10);
});
test('a stuck worker request fails within the deadline and terminates codec ownership',async t=>{
 const workers=mockWorker(t),media=new MediaLibrary(undefined,{requestTimeoutMs:10});
 await assert.rejects(media.probeVideo({} as any),/timed out/);assert.equal(workers[0].terminated,true);
 assert.equal(media.diagnostics().pendingRequests,0);
});

test('captured images survive disposal of the live project and have independent ownership',async t=>{
 mockWorker(t);let alive=0;
 const frame=():any=>{alive++;let closed=false;return {displayWidth:64,displayHeight:64,clone:()=>{assert.equal(closed,false);return frame();},close:()=>{assert.equal(closed,false);closed=true;alive--;}};};
 const live=new MediaLibrary();live.attachImage('image',frame());const snapshot=live.capture(['image']);
 live.dispose();assert.equal(alive,1);const copy=await snapshot.open();snapshot.dispose();assert.equal(alive,1);
 const exported=await copy.exactFrame('image',0);assert.equal(alive,2);exported!.close();copy.dispose();assert.equal(alive,0);
});
test('snapshot preparation failures release private renderers without disposing the live project',async t=>{
 const workers=mockWorker(t);const live=new MediaLibrary();let disposed=0;
 const renderers=new Map<string,()=>Promise<any>>([
 ['a',async()=>({width:64,height:64,frameDurUs:100000,frameCount:10,render:()=>null,dispose:()=>disposed++})],
 ['b',async()=>{throw Error('missing model');}],
 ]);
 const snapshot=live.capture(['a','b'],renderers);await assert.rejects(snapshot.open(),/missing model/);
 assert.equal(disposed,1);assert.equal(workers[0].terminated,false);assert.equal(workers[1].terminated,true);
 snapshot.dispose();live.dispose();
});

test('frame pressure retains requested frames across sources and explicitly refreshes evicted times',async t=>{
 const workers=mockWorker(t),media=new MediaLibrary(undefined,{frameCacheBytes:1920*1080*4*2});
 const sources=[];
 for(let id=1;id<=2;id++){const p=media.probeVideo({}as any);workers[0].receive({type:'ready',id,probe});const source=await p;media.attachVideo(String(id),source);source.requestFrame(100000,false);sources.push(source);}
 for(let id=1;id<=2;id++)for(let i=0;i<8;i++)workers[0].receive({type:'frame',id,timestampUs:i*100000,durationUs:100000,frame:{close(){}}});
 assert.deepEqual(sources.map(source=>source.cachedFrames),[1,1]);
 assert.ok(sources[0].requestFrame(100000,false));assert.ok(sources[1].requestFrame(100000,false));
 sources[0].requestFrame(600000,false);
 assert.equal(workers[0].posts.at(-1).refresh,true,'worker must re-decode an already delivered but evicted timestamp');
 media.dispose();
});
