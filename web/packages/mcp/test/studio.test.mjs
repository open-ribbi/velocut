import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createStudioLauncher} from '../src/studio.mjs';

async function serve(t,info){const server=createServer((_req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(info));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));return server.address().port;}
test('compatible prebuilt or development Studio is reused without loading a CLI or starting a process',async t=>{
 for(const mode of ['prebuilt','development']){
  const port=await serve(t,{app:'velocut',version:'1.2.3',bridgeProtocol:2,mode});
  const launcher=createStudioLauncher({version:'1.2.3',loadStudio:()=>{throw Error('must not load');}});
  const result=await launcher.ensure(port);assert.equal(result.status,mode==='development'?'reused-development':'reused');assert.equal(result.url,`http://localhost:${port}`);
 }
});
test('occupied or mismatched ports fail without changing the project origin or starting another service',async t=>{
 const launcher=createStudioLauncher({version:'1.2.3',loadStudio:()=>{throw Error('must not load');}});
 const occupied=await serve(t,{app:'other'});await assert.rejects(()=>launcher.ensure(occupied),/occupied/);
 const older=await serve(t,{app:'velocut',version:'1.2.2',bridgeProtocol:2});await assert.rejects(()=>launcher.ensure(older),/1.2.2.*1.2.3/);
});
test('concurrent callers launch one detached service, redirect its output and reuse it from another MCP',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'velocut-launcher-'));let pid;t.after(async()=>{if(pid){try{process.kill(pid,'SIGTERM');}catch{}}await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const worker=join(directory,'worker.mjs');await writeFile(worker,`import{createServer}from'node:http';console.log('daemon-log');const server=createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:'velocut',version:'1.2.3',bridgeProtocol:2,managed:true,pid:process.pid}));});server.listen(Number(process.argv[3]),'127.0.0.1');process.on('SIGTERM',()=>{server.close();server.closeAllConnections();});`);
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 let loads=0;const launcher=createStudioLauncher({version:'1.2.3',logDirectory:directory,loadStudio:async()=>{loads++;return {VERSION:'1.2.3',managedWorkerPath:worker};}});
 const [a,b]=await Promise.all([launcher.ensure(port),launcher.ensure(port)]);assert.equal(loads,1);assert.equal(a.status,'started');assert.deepEqual(a,b);
 const info=await (await fetch(a.url+'/__velocut/health')).json();pid=info.pid;
 const other=createStudioLauncher({version:'1.2.3',loadStudio:()=>{throw Error('must not load');}});assert.equal((await other.ensure(port)).status,'reused');
 assert.match(await readFile(join(directory,`studio-${port}.log`),'utf8'),/daemon-log/);
});
