import { test, expect, type Page } from './test-fixtures';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';

async function importTone(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => (window as any).velocut?.media);
  const canDecode = await page.evaluate(async () => {
    try {
      return (await VideoDecoder.isConfigSupported({codec:'avc1.42E01E',codedWidth:96,codedHeight:64})).supported &&
        (await (globalThis as any).AudioDecoder.isConfigSupported({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:1})).supported;
    } catch { return false; }
  });
  test.skip(!canDecode, 'This browser does not provide the H.264/AAC decoders required by the fixture');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', {name:'Import Media',exact:true}).click();
  await (await chooser).setFiles(resolve('e2e/fixtures/red-tone.mp4'));
  await expect.poll(() => page.evaluate(() => (window as any).velocut.doc().assets.length)).toBe(1);
}

for (const speed of [.5, 2]) test(`real MP4 export retains ${speed}x audio and volume automation`, async ({page}, testInfo) => {
  await importTone(page);
  const canExport = await page.evaluate(async () => {
    try {
      return !!(await (navigator as any).gpu?.requestAdapter()) &&
        (await VideoEncoder.isConfigSupported({codec:'avc1.42E01F',width:320,height:180,framerate:20})).supported &&
        (await (globalThis as any).AudioEncoder.isConfigSupported({codec:'mp4a.40.2',sampleRate:48000,numberOfChannels:2,bitrate:192000})).supported;
    } catch { return false; }
  });
  test.skip(!canExport, 'This browser does not provide WebGPU and H.264/AAC encoders');
  const duration = await page.evaluate(speed => {
    const v = (window as any).velocut;
    const doc = structuredClone(v.doc()); doc.width = 320; doc.height = 180; doc.fpsNum = 20; doc.fpsDen = 1;
    v.store.loadDocument(doc);
    const apply = (cmd: any) => { const r=v.apply(cmd); if(!r.ok)throw Error(JSON.stringify(r)); return r; };
    const trackId=apply({type:'addTrack',kind:'video',name:'Tone'}).events[0].trackId;
    const clipId=apply({type:'addClip',trackId,assetId:doc.assets[0].id,startUs:200000,sourceInUs:300000,durationUs:1200000}).events[0].clipId;
    apply({type:'setClipSpeed',clipId,speed});
    const durationUs=1200000/speed;
    apply({type:'setKeyframe',clipId,property:'volume',keyframe:{timeUs:0,value:0,easing:{kind:'hold'}}});
    apply({type:'setKeyframe',clipId,property:'volume',keyframe:{timeUs:durationUs/2,value:1,easing:{kind:'linear'}}});
    v.store.select(clipId);
    return durationUs/1e6;
  }, speed);
  await page.locator('.export-trigger').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button',{name:'Export MP4',exact:true}).click();
  const file = await download;
  const path = testInfo.outputPath(`varispeed-${speed}.mp4`); await file.saveAs(path);
  const base64 = (await readFile(path)).toString('base64');
  const result = await page.evaluate(async ({base64,duration}) => {
    const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
    const context=new OfflineAudioContext(2,1,48000);
    const audio=await context.decodeAudioData(bytes.buffer);
    const samples=audio.getChannelData(0),sr=audio.sampleRate;
    const window=(from:number,to:number)=>samples.subarray(Math.round(from*sr),Math.round(to*sr));
    const quiet=window(.2+duration*.1,.2+duration*.35);
    const loud=window(.2+duration*.65,.2+duration*.9);
    const rms=(data:Float32Array)=>Math.sqrt(data.reduce((sum,x)=>sum+x*x,0)/data.length);
    let crossings=0;for(let i=1;i<loud.length;i++)if(loud[i-1]<=0&&loud[i]>0)crossings++;
    return {duration:audio.duration,quiet:rms(quiet),loud:rms(loud),hz:crossings*sr/loud.length};
  }, {base64,duration});
  expect(Math.abs(result.duration-(.2+duration))).toBeLessThan(.08);
  expect(result.quiet).toBeLessThan(.005);
  expect(result.loud).toBeGreaterThan(.04);
  expect(Math.abs(result.hz-440*speed)).toBeLessThan(25);
});

test('captions follow the selected cut and reject stale or ambiguous placements', async ({page}) => {
  await importTone(page);
  const result=await page.evaluate(async () => {
    const v=(window as any).velocut;
    const apply=(cmd:any)=>{const r=v.apply(cmd);if(!r.ok)throw Error(JSON.stringify(r));return r;};
    const assetId=v.doc().assets[0].id;
    const trackId=apply({type:'addTrack',kind:'video',name:'Cuts'}).events[0].trackId;
    const clipId=apply({type:'addClip',trackId,assetId,startUs:5000000,sourceInUs:200000,durationUs:1200000}).events[0].clipId;
    apply({type:'setClipSpeed',clipId,speed:2});v.store.select(clipId);
    // Stub recognition only: actual media-worker PCM decoding, caption service,
    // engine commands and resulting text clips run without model downloads.
    v.transcriber.transcribe=async()=>[{startUs:200000,endUs:800000,text:'hello'}];
    const made=await v.caption();
    const caption=v.doc().tracks.find((t:any)=>t.id===made.trackId)?.clips[0];
    apply({type:'duplicateClip',clipId,startUs:7000000});v.store.select(null);
    const ambiguous=await v.caption({assetId});
    const before=v.doc().tracks.length;
    v.transcriber.transcribe=async()=>{apply({type:'moveClip',clipId,startUs:9000000});return [{startUs:0,endUs:500000,text:'stale'}];};
    const stale=await v.caption({clipId});
    return {made,caption,ambiguous,stale,before,after:v.doc().tracks.length};
  });
  expect(result.made.ok).toBe(true);
  expect(result.caption.startUs).toBe(5100000);
  expect(result.caption.durationUs).toBe(300000);
  expect(result.ambiguous.ok).toBe(false);
  expect(result.stale.ok).toBe(false);
  expect(result.stale.message).toContain('changed');
  expect(result.after).toBe(result.before);
});
