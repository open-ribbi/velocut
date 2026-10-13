import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MediaTaskScheduler} from '../dist/media-scheduler.js';
import {DecoderBudget} from '../dist/decoder-budget.js';
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,0));

test('proxy preemption waits for cleanup, queues behind playback and restarts after foreground work',async()=>{
 const scheduler=new MediaTaskScheduler(),owner={};let starts=0;const cleanup=deferred();const events:string[]=[];
 const proxy=scheduler.run('proxy',async signal=>{starts++;events.push('proxy'+starts);if(starts===1){await new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true}));await cleanup.promise;signal.throwIfAborted();}});
 scheduler.setPreviewActive(owner,true);
 const foreground=scheduler.run('export',async()=>{events.push('export');});
 await tick();assert.deepEqual(events,['proxy1']);cleanup.resolve();await foreground;await tick();
 assert.equal(starts,1);scheduler.setPreviewActive(owner,false);await proxy;
 assert.deepEqual(events,['proxy1','export','proxy2']);assert.equal(scheduler.snapshot().preemptions,1);assert.equal(scheduler.snapshot().running,0);
});
test('queue prioritizes interactive decode, serializes same-source requests and bounds admission',async()=>{
 const s=new MediaTaskScheduler({codec:1,heavy:1,queued:2}),gate=deferred(),order:string[]=[];
 const a=s.run('observe',()=>gate.promise,{key:'source'});
 const b=s.run('export',async()=>{order.push('export');},{lane:'codec',key:'source'});
 const c=s.run('preview',async()=>{order.push('preview');});
 await assert.rejects(s.run('observe',async()=>{}),/queue is full/);gate.resolve();await Promise.all([a,b,c]);
 assert.deepEqual(order,['preview','export']);assert.equal(s.snapshot().peakRunning,1);
});
test('queued cancellation and failed work release keys and allow later jobs',async()=>{
 const s=new MediaTaskScheduler(),owner={};s.setPreviewActive(owner,true);const ac=new AbortController();
 const p=s.run('proxy',async()=>{throw Error('must not run');},{signal:ac.signal});ac.abort();await assert.rejects(p,{name:'AbortError'});
 await assert.rejects(s.run('observe',async()=>{throw Error('broken');},{key:'x'}),/broken/);
 await s.run('observe',async()=>{}, {key:'x'});assert.equal(s.snapshot().queued,0);assert.equal(s.snapshot().running,0);
});
test('decoder budget evicts least recently used idle owners but never active requests',()=>{
 const b=new DecoderBudget(2),closed:string[]=[];
 assert.ok(b.use('a',()=>closed.push('a')));assert.ok(b.use('b',()=>closed.push('b'),true));
 assert.ok(b.use('c',()=>closed.push('c'),true));assert.deepEqual(closed,['a']);assert.equal(b.size,2);
 assert.equal(b.use('d',()=>{},true),false);b.unpin('b');assert.ok(b.use('d',()=>{},true));assert.deepEqual(closed,['a','b']);
 b.release('c');assert.equal(b.size,1);
});
