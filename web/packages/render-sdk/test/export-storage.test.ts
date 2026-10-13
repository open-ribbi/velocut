import {test}from'node:test';import assert from'node:assert/strict';
import{Exporter}from'../dist/exporter.js';import{MediaTaskScheduler}from'../dist/media-scheduler.js';
test('stream storage quota errors fail before allocating an in-memory export or render context',async t=>{
 const removed:string[]=[];const quota=new DOMException('Disk quota exceeded','QuotaExceededError');
 const mocks={navigator:{storage:{getDirectory:async()=>({getFileHandle:async()=>({createWritable:async()=>{throw quota;}}),removeEntry:async(name:string)=>{removed.push(name);}})}},
  VideoEncoder:class{static async isConfigSupported(){return{supported:true};}constructor(){throw Error('Encoder should not be allocated after storage failure');}}};
 for(const[key,value]of Object.entries(mocks)){const descriptor=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>{if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];});}
 const scheduler=new MediaTaskScheduler();
 await assert.rejects(new Exporter({scheduler}as any).export({width:96,height:64,fpsNum:10,fpsDen:1,durationUs:1000000,evaluate:()=>({}as any)}),{name:'QuotaExceededError'});
 assert.equal(removed.length,1);assert.match(removed[0],/^velocut-export-[0-9a-f-]+\.mp4$/);assert.equal(scheduler.snapshot().running,0);
});
