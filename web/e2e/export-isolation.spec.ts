import {test,expect} from './test-fixtures';
async function ready(page:any) {
 await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.motionClip);
 const supported=await page.evaluate(async()=>{try{return !!(await navigator.gpu?.requestAdapter())&&(await VideoEncoder.isConfigSupported({codec:'avc1.42E01F',width:96,height:64,framerate:10})).supported;}catch{return false;}});
 test.skip(!supported,'WebGPU or H.264 encoder unavailable');
}
test('queued exports pin distinct revisions and procedural sources despite edits, then release their own files',async({page})=>{
 await ready(page);
 const result=await page.evaluate(async()=>{
  const v=(window as any).velocut;
  const doc=structuredClone(v.doc());Object.assign(doc,{width:96,height:64,fpsNum:10,fpsDen:1});v.store.loadDocument(doc);
  const spec={version:1,durationUs:1000000,background:'#ff0000',layers:[]};
  const made=await v.motionClip({spec});if(!made.ok)throw Error(made.message);
  const root=await navigator.storage.getDirectory();
  const names=async()=>{const all=[];for await(const [name] of (root as any).entries())if(name.startsWith('velocut-export-'))all.push(name);return all;};
  const first=v.exportFilm();
  const edit=v.apply({type:'setAssetSpec',assetId:made.assetId,spec:JSON.stringify({...spec,background:'#00ff00'})});if(!edit.ok)throw Error(JSON.stringify(edit));
  const second=v.exportFilm();
  const queued=second.state==='queued';
  // A later edit must affect neither submitted snapshot.
  v.apply({type:'setAssetSpec',assetId:made.assetId,spec:JSON.stringify({...spec,background:'#0000ff'})});
  const outputs=await Promise.all([first.result,second.result]);
  const colors=[];
  for(const output of outputs){
   const probe=new v.media.constructor();try{
    const file=new File([output],'output.mp4',{type:'video/mp4'});probe.attachVideo('output',await probe.probeVideo(file),file);
    const frame=await probe.exactFrame('output',800000);if(!frame)throw Error('Missing output frame');
    const canvas=new OffscreenCanvas(96,64),ctx=canvas.getContext('2d')!;ctx.drawImage(frame,0,0);frame.close();colors.push([...ctx.getImageData(48,32,1,1).data]);
   }finally{probe.dispose();}
  }
  const before=await names();await first.releaseOutput();const middle=await names();
  const secondStillReadable=(await outputs[1].arrayBuffer()).byteLength>0;
  await second.releaseOutput();const after=await names();
  return {queued,revisions:[first.revision,second.revision],states:[first.state,second.state],colors,before,middle,after,secondStillReadable,scheduling:v.media.scheduler.snapshot()};
 });
 expect(result.queued).toBe(true);expect(result.revisions[1]).toBeGreaterThan(result.revisions[0]);
 expect(result.states).toEqual(['completed','completed']);
 expect(result.colors[0][0]).toBeGreaterThan(180);expect(result.colors[0][1]).toBeLessThan(50);
 expect(result.colors[1][1]).toBeGreaterThan(180);expect(result.colors[1][0]).toBeLessThan(50);
 expect(result.before.length).toBe(2);expect(result.middle.length).toBe(1);expect(result.after.length).toBe(0);
 expect(result.secondStillReadable).toBe(true);expect(result.scheduling.running).toBe(0);
});
test('cancelling queued or running exports leaves no partial output and later jobs still work',async({page})=>{
 await ready(page);
 const result=await page.evaluate(async()=>{
  const v=(window as any).velocut;
  const doc=structuredClone(v.doc());Object.assign(doc,{width:96,height:64,fpsNum:10,fpsDen:1});v.store.loadDocument(doc);
  await v.motionClip({spec:{version:1,durationUs:1000000,background:'#ff0000',layers:[]}});
  let release!:()=>void;const gate=v.media.scheduler.run('export',()=>new Promise<void>(r=>release=r));
  const queued=v.exportFilm();queued.cancel();await queued.result.catch(()=>{});release();await gate;
  const abort=new AbortController();const active=v.exportFilm({signal:abort.signal,onProgress:(fraction:number)=>{if(fraction>.2)abort.abort();}});
  await active.result.catch(()=>{});
  const failed=v.exportFilm({onProgress:(fraction:number)=>{if(fraction>.2)throw Error('injected render failure');}});await failed.result.catch(()=>{});
  const root=await navigator.storage.getDirectory();const partial=[];for await(const [name]of(root as any).entries())if(name.startsWith('velocut-export-'))partial.push(name);
  const retry=v.exportFilm();const output=await retry.result;const size=output.size;await retry.releaseOutput();
  return {queued:queued.state,active:active.state,failed:failed.state,partial,retry:retry.state,size,scheduling:v.media.scheduler.snapshot()};
 });
 expect(result.queued).toBe('cancelled');expect(result.active).toBe('cancelled');expect(result.failed).toBe('failed');expect(result.partial).toEqual([]);
 expect(result.retry).toBe('completed');expect(result.size).toBeGreaterThan(0);expect(result.scheduling.running).toBe(0);
});

test('3D export uses an independent scene even when the live material is edited',async({page})=>{
 await ready(page);
 const result=await page.evaluate(async()=>{
  const v=(window as any).velocut;
  const doc=structuredClone(v.doc());Object.assign(doc,{width:96,height:64,fpsNum:10,fpsDen:1});v.store.loadDocument(doc);
  const spec={version:1,durationUs:1000000,width:96,height:64,camera:{position:{x:0,y:1,z:5},lookAt:{x:0,y:1,z:0}},props:[{id:'cube',model:'prop/cube',position:{x:0,y:1,z:0},scale:{x:2,y:2,z:2},color:'#ff0000'}]};
  const made=await v.sceneClip({spec});if(!made.ok)throw Error(made.message);
  let edited=false,editedBeforeEnd=false,pendingEdit:Promise<any>|undefined;
  const job=v.exportFilm({onProgress:(fraction:number)=>{
   if(fraction>.1&&!edited){edited=true;pendingEdit=v.sceneEdit({assetId:made.assetId,edits:[{type:'update',id:'cube',patch:{color:'#0000ff'}}]}).then((r:any)=>{if(!r.ok)throw Error(JSON.stringify(r));editedBeforeEnd=job.state!=='completed';});void pendingEdit.catch(()=>{});}
  }});
  const output=await job.result;await pendingEdit;const probe=new v.media.constructor();let color;
  try{const file=new File([output],'scene.mp4',{type:'video/mp4'});probe.attachVideo('output',await probe.probeVideo(file),file);
   const frame=await probe.exactFrame('output',800000);if(!frame)throw Error('Missing scene frame');
   const canvas=new OffscreenCanvas(96,64),ctx=canvas.getContext('2d')!;ctx.drawImage(frame,0,0);frame.close();color=[...ctx.getImageData(48,32,1,1).data];
  }finally{probe.dispose();await job.releaseOutput();}
  return {edited,editedBeforeEnd,state:job.state,color,liveColor:JSON.parse(v.doc().assets.find((a:any)=>a.id===made.assetId).spec).props[0].color};
 });
 expect(result.edited).toBe(true);expect(result.editedBeforeEnd).toBe(true);expect(result.state).toBe('completed');expect(result.liveColor).toBe('#0000ff');
 expect(result.color[0]).toBeGreaterThan(80);expect(result.color[0]).toBeGreaterThan(result.color[2]*2);
});
