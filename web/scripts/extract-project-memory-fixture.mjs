// Read a copied localhost IndexedDB only. Never open the user's live database.
import {chromium} from '@playwright/test';
import {cp,mkdir,mkdtemp,readdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
if(process.argv.length<5)throw Error('Usage: node extract-project-memory-fixture.mjs <IndexedDB directory> <project name> <output directory>');
const originDb=resolve(process.argv[2]),name=process.argv[3],out=resolve(process.argv[4]);
const profile=await mkdtemp(resolve(tmpdir(),'velocut-db-read-'));
await mkdir(resolve(profile,'Default/IndexedDB'),{recursive:true});await mkdir(out,{recursive:true});
for(const entry of await readdir(originDb))if(entry.startsWith('http_localhost_5173.indexeddb.'))await cp(resolve(originDb,entry),resolve(profile,'Default/IndexedDB',entry),{recursive:true});
const context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chrome',acceptDownloads:true});
try{
 const page=await context.newPage();await page.route('http://localhost:5173/**',r=>r.fulfill({contentType:'text/html',body:'<html><title>Read-only Velocut data copy</title></html>'}));await page.goto('http://localhost:5173/');
 const downloads=[];page.on('download',d=>downloads.push(d.saveAs(resolve(out,d.suggestedFilename()))));
 const result=await page.evaluate(async name=>{
  const databases=await indexedDB.databases();if(!databases.some(d=>d.name==='velocut'))throw Error('copied origin database missing');
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('velocut');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const get=key=>new Promise((resolve,reject)=>{const r=db.transaction('kv','readonly').objectStore('kv').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
  const decode=b=>JSON.parse(new TextDecoder().decode(b));
  const projects=decode(await get('projects')),project=projects.find(p=>p.name===name);if(!project)throw Error('project not in copied registry: '+projects.map(p=>p.name).join(', '));
  const historyKey=project.id==='default'?'history':'history:'+project.id;
  const history=await get(historyKey+':compact-v1')??await get(historyKey),ydoc=await get(project.id==='default'?'ydoc':'ydoc:'+project.id);
  if(!history||!ydoc)throw Error('project history or document missing');
  const h=decode(history);db.close();
  for(const [name,data] of [['history.bin',history],['ydoc.bin',ydoc]]){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([data]));a.download=name;a.click();}
  return {project,historyBytes:history.byteLength,ydocBytes:ydoc.byteLength,historyNodes:h.nodes.length,headId:h.headId};
 },name);
 await page.waitForTimeout(250);if(downloads.length!==2)throw Error('expected two data files');await Promise.all(downloads);
 const meta=result;
 await writeFile(resolve(out,'metadata.json'),JSON.stringify(meta,null,2));console.log(JSON.stringify(meta));
}finally{await context.close();await rm(profile,{recursive:true,force:true});}
