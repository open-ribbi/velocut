import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createModelHost} from '../src/models.mjs';
const definition={version:1,id:'custom',capability:'video.generate',inputSchema:{type:'object',properties:{prompt:{type:'string'}}},execution:{type:'async-http',submit:{method:'POST',path:'/tasks',body:{$input:''}},receipt:{id:'$.id'},poll:{method:'GET',path:'/tasks/{receipt.id}',status:'$.status',states:{running:['running'],succeeded:['done'],failed:['failed']}},outputs:[{kind:'video',url:'$.url'}]}};
test('persisted definitions load without source registration, pin old revisions and never disclose tokens',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'velocut-model-host-'));try{
 const requests=[];const fetcher=async(url,init)=>{requests.push({url,init});return Response.json(init.method==='POST'?{id:'task'}:{status:'done',url:'https://cdn.invalid/video'});};
 const h=createModelHost({directory,fetch:fetcher}),saved=await h.execute({action:'upsert',definition});await h.execute({action:'connections',connection:{id:'channel',modelId:'custom',baseUrl:'https://first.invalid'}});await h.execute({action:'setCredential',id:'channel',token:'private-token'});
 const preview=await h.execute({action:'preview',connectionId:'channel',input:{prompt:'x'}});assert.equal(requests.length,0);assert.equal(JSON.stringify(preview).includes('private-token'),false);
 const list=await h.execute({action:'list'});assert.equal(JSON.stringify(list).includes('private-token'),false);assert.equal(list.connections[0].credentialConfigured,true);
 const receipt=await h.execute({action:'submit',connectionId:'channel',revision:saved.revision,input:{prompt:'x'}});
 const updated=structuredClone(definition);updated.execution.poll.path='/new-tasks/{receipt.id}';await h.execute({action:'upsert',definition:updated,expectedRevision:saved.revision});
 const restarted=createModelHost({directory,fetch:fetcher});await restarted.execute({action:'poll',connectionId:'channel',revision:saved.revision,receipt});assert.equal(requests.at(-1).url,'https://first.invalid/tasks/task');assert.equal(requests[0].init.headers.authorization,'Bearer private-token');
 await assert.rejects(()=>h.execute({action:'upsert',definition,expectedRevision:saved.revision}),/changed/);
 const connection=(await h.execute({action:'list'})).connections[0];await h.execute({action:'connections',connection:{id:'channel',modelId:'custom',baseUrl:'https://second.invalid'},expectedRevision:connection.revision});assert.equal((await h.execute({action:'list'})).connections[0].credentialConfigured,false);
 // Windows stat exposes DOS permission emulation, not POSIX owner-only mode bits.
 if(process.platform!=='win32')assert.equal((await stat(join(directory,'config.json'))).mode&0o777,0o600);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('local HTTP host rejects cross-origin administration and streams only recorded result URLs without credentials',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'velocut-model-http-'));let downloaded=false;
 const host=createModelHost({directory,fetch:async(url,init)=>{
   if(String(url).startsWith('https://cdn.invalid')){assert.equal(init.headers,undefined);downloaded=true;return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'video/mp4'}});}
   return Response.json(init.method==='POST'?{id:'task'}:{status:'done',url:'https://cdn.invalid/result'});
 }}),server=createServer((req,res)=>{void host.handle(req,res);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 const request=body=>fetch(base+'/__velocut/models',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());
 try{
 assert.equal((await fetch(base+'/__velocut/models',{method:'POST',headers:{origin:'https://other.invalid','content-type':'application/json'},body:'{"action":"list"}'})).status,403);
 const saved=await request({action:'upsert',definition});assert.equal(saved.ok,true);await request({action:'connections',connection:{id:'one',modelId:'custom',baseUrl:'https://service.invalid'}});await request({action:'setCredential',id:'one',token:'private-token'});
 const receipt=(await request({action:'submit',connectionId:'one',input:{}})).data;const polled=(await request({action:'poll',connectionId:'one',receipt})).data;const downloadId=polled.result.outputs[0].metadata.localDownloadId;
 const response=await fetch(base+'/__velocut/models/download/'+downloadId,{headers:{origin:base}});assert.equal(response.status,200);assert.deepEqual(new Uint8Array(await response.arrayBuffer()),new Uint8Array([1,2,3]));assert.equal(downloaded,true);
 assert.equal((await fetch(base+'/__velocut/models/download/'+downloadId,{headers:{origin:'https://other.invalid'}})).status,403);
 }finally{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});
