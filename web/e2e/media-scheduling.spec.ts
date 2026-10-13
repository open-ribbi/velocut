import {test,expect} from './test-fixtures';
import {resolve} from 'node:path';
test('proxy jobs defer during playback, yield on playback restart, and preserve source time',async({page})=>{
 await page.goto('/');await page.waitForFunction(()=>(window as any).velocut?.media);
 const supported=await page.evaluate(async()=>{try{return(await VideoEncoder.isConfigSupported({codec:'avc1.42E01F',width:96,height:64,framerate:30})).supported;}catch{return false;}});
 test.skip(!supported,'H.264 encoder unavailable');
 const chooser=page.waitForEvent('filechooser');await page.getByRole('button',{name:'Import Media',exact:true}).click();await(await chooser).setFiles(resolve('e2e/fixtures/red-tone.mp4'));
 await expect.poll(()=>page.evaluate(()=>(window as any).velocut.doc().assets.length)).toBe(1);
 const result=await page.evaluate(async()=>{
  const v=(window as any).velocut,media=v.media,id=v.doc().assets[0].id;
  // Use a separate owner to model a second active preview sharing the same host budget.
  const owner={};media.scheduler.setPreviewActive(owner,true);
  let finished=false,interrupted=false;
  const building=media.buildProxy(id,{force:true,onProgress:()=>{
   if(!interrupted){interrupted=true;media.scheduler.setPreviewActive(owner,true);setTimeout(()=>media.scheduler.setPreviewActive(owner,false),30);}
  }}).then(()=>finished=true);
  await new Promise(r=>setTimeout(r,30));const deferred=!finished&&media.scheduler.snapshot().queued>0;
  media.scheduler.setPreviewActive(owner,false);await building;
  const root=await navigator.storage.getDirectory();
  // Read proxy directory through the media library's actual project scope.
  let proxy:File|null=null;for await(const [name,entry] of (root as any).entries())if(name==='proxy'||name.startsWith('proxy-')){try{proxy=await(await entry.getFileHandle(id+'.mp4')).getFile();break;}catch{}}
  if(!proxy)throw Error('No proxy file');const source=await media.probeVideo(proxy);const duration=source.durationUs;media.releaseVideoProbe(source);
  return {deferred,interrupted,hasProxy:media.hasProxy(id),duration,diagnostics:media.diagnostics()};
 });
 expect(result.deferred).toBe(true);expect(result.interrupted).toBe(true);expect(result.hasProxy).toBe(true);
 expect(Math.abs(result.duration-2000000)).toBeLessThan(110000);
 expect(result.diagnostics.scheduling.preemptions).toBeGreaterThan(0);
 expect(result.diagnostics.pendingRequests).toBe(0);
});
