/** Replay a real project and its original history in a fresh browser profile.
 * Only the fixture files are read. The original browser data stays untouched. */
import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
if(process.platform!=='darwin')throw Error('This native footprint profiler requires macOS');
if(process.argv.length<4)throw Error('Usage: node profile-project-memory.mjs <fixture directory> <output directory> [without-history] [short] [intern-experiment]');
const exec=promisify(execFile),source=resolve(process.argv[2]),out=resolve(process.argv[3]);
const withHistory=process.argv[4]!=='without-history',short=process.argv[5]==='short';
const meta=JSON.parse(await readFile(resolve(source,'metadata.json'),'utf8'));
const root=resolve('apps/editor/dist');await mkdir(out,{recursive:true});
const mime={'.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json','.html':'text/html','.png':'image/png','.glb':'model/gltf-binary'};
const server=createServer(async(req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  const path=new URL(req.url,'http://local').pathname;
  if(path==='/__blank'){res.setHeader('Content-Type','text/html');res.end('<title>Memory fixture staging</title>');return;}
  const file=path==='/__history'?resolve(source,'history.bin'):path==='/__ydoc'?resolve(source,'ydoc.bin'):resolve(root,path==='/'?'index.html':'.'+decodeURIComponent(path));
  if(!file.startsWith(root+'/')&&!['/__history','/__ydoc'].includes(path)){res.writeHead(403);res.end();return;}
  try{const s=await stat(file);res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.setHeader('Content-Length',s.size);createReadStream(file).pipe(res);}catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']});
const results={sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),browser:browser.version(),workingTreeDirty:!!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),withHistory,project:meta.project,originalHistory:meta.historyNodes,originalHistoryBytes:meta.historyBytes,samples:[],warnings:[]};
try{
 const context=await browser.newContext({viewport:{width:1280,height:800}}),page=await context.newPage();
 page.on('console',m=>{if(['warning','error'].includes(m.type())&&results.warnings.length<80)results.warnings.push(m.text());});
 const cdp=await context.newCDPSession(page),global=await browser.newBrowserCDPSession();
 const info=await global.send('SystemInfo.getInfo');results.gpu=info.gpu.auxAttributes?.glRenderer;
 async function snapshot(name,gc=true){
  if(gc)await cdp.send('HeapProfiler.collectGarbage');
  const heap=await cdp.send('Runtime.getHeapUsage'),dom=await cdp.send('Memory.getDOMCounters');
  const processes=(await global.send('SystemInfo.getProcessInfo')).processInfo;
  const file=resolve(out,`footprint-${results.samples.length}.json`);
  await exec('/usr/bin/footprint',[...processes.flatMap(p=>['-p',String(p.id)]),'--noCategories','-f','bytes','-j',file],{timeout:10000,maxBuffer:500000});
  const raw=JSON.parse(await readFile(file,'utf8')),types=new Map(processes.map(p=>[p.id,p.type]));
  const native=raw.processes.map(p=>({pid:p.pid,type:types.get(p.pid),footprintMiB:p.footprint/2**20,peakMiB:p.auxiliary.phys_footprint_peak/2**20}));
  const view=await page.evaluate(()=>window.velocut?.previewSession().state??null);
  const sample={name,gc,view,heapMiB:heap.usedSize/2**20,backingStorageMiB:heap.backingStorageSize/2**20,embedderMiB:heap.embedderHeapUsedSize/2**20,dom,native,groupFootprintMiB:raw['total footprint']/2**20};
  results.samples.push(sample);await writeFile(resolve(out,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(sample));
 }
 await page.goto(url);await page.waitForFunction(()=>window.velocut?.sceneInspect);await page.waitForTimeout(500);await snapshot('empty-studio');
 await page.goto(url+'/__blank');
 await page.evaluate(async({meta,withHistory})=>{
  const ydoc=new Uint8Array(await(await fetch('/__ydoc')).arrayBuffer());
  const history=withHistory?new Uint8Array(await(await fetch('/__history')).arrayBuffer()):null;
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('velocut',1);r.onupgradeneeded=()=>r.result.createObjectStore('kv');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  await new Promise((resolve,reject)=>{const tx=db.transaction('kv','readwrite'),kv=tx.objectStore('kv');
   kv.put(new TextEncoder().encode(JSON.stringify([meta.project])),'projects');kv.put(ydoc,meta.project.id==='default'?'ydoc':'ydoc:'+meta.project.id);if(history)kv.put(history,meta.project.id==='default'?'history':'history:'+meta.project.id);
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();localStorage.setItem('velocut.project',meta.project.id);
 },{meta,withHistory});
 await page.goto(url);await page.waitForFunction(name=>window.velocut?.doc().name===name,meta.project.name);
 await page.waitForFunction(()=>window.velocut.doc().assets.every(a=>window.velocut.media.hasAsset(a.id)));
 results.loaded=await page.evaluate(()=>{const v=window.velocut,d=v.doc();return {name:d.name,assets:d.assets.length,tracks:d.tracks.length,clips:d.tracks.reduce((n,t)=>n+t.clips.length,0),durationUs:v.store.getState().durationUs,historyNodes:v.store.getHistory().all().length,documentBytes:new TextEncoder().encode(JSON.stringify(d)).length};});
 const assetId=await page.evaluate(()=>window.velocut.doc().assets[0].id);
 await snapshot('loaded-before-gc',false);await page.waitForTimeout(800);await snapshot('loaded-paused');
 if(process.argv[6]==='intern-experiment') {
  results.internExperiment=await page.evaluate(()=>{
   const v=window.velocut,h=v.store.getHistory(),pool=new Map(),docBefore=JSON.stringify(v.doc());let reused=0;
   const intern=s=>{if(pool.has(s)){reused++;return pool.get(s)}pool.set(s,s);return s};
   const command=c=>{if(!c)return;if(typeof c.spec==='string')c.spec=intern(c.spec);for(const child of c.commands??[])command(child)};
   for(const node of h.all()){for(const asset of node.snapshot.assets)if(typeof asset.spec==='string')asset.spec=intern(asset.spec);command(node.command);}
   for(const asset of v.doc().assets)if(typeof asset.spec==='string')asset.spec=intern(asset.spec);
   return {uniqueSpecStrings:pool.size,reused,historyNodes:h.all().length,sameDocument:JSON.stringify(v.doc())===docBefore};
  });
  await snapshot('history-strings-shared');
 }
 await page.evaluate(assetId=>window.velocut.directorSession({assetId,open:true,timeS:122,view:'perspective',playing:false}),assetId);
 await page.waitForTimeout(700);await snapshot('director-final-model');
 await page.evaluate(()=>window.velocut.directorSession({open:false}));
 if(!short){
 await page.evaluate(()=>window.velocut.previewSession({timeUs:0,rate:4,playing:true}));
 for(let i=1;i<=7;i++){await page.waitForTimeout(5000);await snapshot('timeline-play-'+i,false);}
 await page.evaluate(()=>window.velocut.previewSession({playing:false}));await page.waitForTimeout(1500);await snapshot('after-full-playback');
 await page.evaluate(async()=>{const v=window.velocut;for(const t of [122,0,107,10,99,23,91,49,76,138,0]){v.previewSession({timeUs:t*1e6});await new Promise(r=>setTimeout(r,250));}});
 await snapshot('after-seek-sequence');
 await page.evaluate(()=>window.velocut.previewSession({timeUs:0,rate:4,playing:true}));
 for(let i=1;i<=7;i++){await page.waitForTimeout(5000);if(i===3||i===7)await snapshot('second-play-'+i,false);}
 await page.evaluate(()=>window.velocut.previewSession({playing:false}));await page.waitForTimeout(1000);await snapshot('after-second-playback');
 for(let i=0;i<3;i++)await page.evaluate(async assetId=>{const r=await window.velocut.observe({mode:'scene',source:{assetId},at:122_000_000,view:'perspective'});if(!r.ok)throw Error(r.summary);},assetId);
 await snapshot('after-three-observations');
 }
 await page.reload();await page.waitForFunction(name=>window.velocut?.doc().name===name,meta.project.name);await page.waitForTimeout(1000);await snapshot('after-reload');
 results.finalState=await page.evaluate(()=>({name:window.velocut.doc().name,historyNodes:window.velocut.store.getHistory().all().length}));
 await writeFile(resolve(out,'results.json'),JSON.stringify(results,null,2));
}finally{await browser.close();await new Promise(r=>server.close(r));}
