/** Executed only inside an isolated benchmark browser, against the built app. */
export async function runScenario({id,profile,samples}) {
  const v=window.velocut,metrics={},config=profile==='quick'
    ?{tracks:4,clipsPerTrack:25,audioSeconds:60,props:256}
    :{tracks:8,clipsPerTrack:200,audioSeconds:600,props:4096};
  const start=performance.now();
  const seekToAcknowledgedFrame=async timeUs=>{
    const before=v.diagnostics().preview.acknowledged;v.seek(timeUs);
    const deadline=performance.now()+10000;
    for(;;){
      const preview=v.diagnostics().preview;
      if(preview.acknowledged>before&&preview.latest?.timeUs===timeUs&&preview.latest.ok&&preview.latest.missingSources===0&&preview.latest.sourceTimeErrorUs<=1000)return;
      if(performance.now()>deadline)throw Error('Preview did not acknowledge a source-aligned seek: '+JSON.stringify({timeUs,latest:preview.latest,inflight:preview.inflight,dropped:preview.dropped,failed:preview.failed,media:v.media.diagnostics(true)}));
      await new Promise(resolve=>setTimeout(resolve,1));
    }
  };
  const apply=command=>{const result=v.apply(command);if(!result.ok)throw Error(JSON.stringify(result));return result;};
  const blank=structuredClone(v.doc());Object.assign(blank,{width:640,height:360,fpsNum:12,fpsDen:1});v.store.loadDocument(blank);
  const addVideo=async(url,name)=>{
    const file=new File([await(await fetch(url)).blob()],name,{type:'video/mp4'});
    const source=await v.media.probeVideo(file);
    const assetId=apply({type:'addAsset',kind:'video',name,src:'local://'+name,durationUs:source.durationUs,width:source.width,height:source.height,hasAudio:source.hasAudio}).events[0].assetId;
    v.media.attachVideo(assetId,source,file);return {assetId,file,source};
  };
  const sample=async(name,operation)=>{
    await operation(-1); // explicit warmup, excluded from the reported samples
    const values=[];
    for(let i=0;i<samples;i++){
      await new Promise(resolve=>setTimeout(resolve,0));const at=performance.now();await operation(i);values.push(performance.now()-at);
    }
    metrics[name]=values;
  };
  const exportCurrent=async()=>{
    const job=v.exportFilm({videoCodec:'avc'});try{const output=await job.result;if(!output.size)throw Error('Empty export');}
    finally{await job.releaseOutput();}
  };
  let fixture,sourceDurationUs=0;
  if(id==='video4k')fixture=await addVideo('/fixtures/video4k.mp4','video4k.mp4');
  if(id==='multitrack') {
    const assets=[];for(let i=0;i<4;i++)assets.push((await addVideo('/fixtures/video1080.mp4',`video-${i}.mp4`)).assetId);
    const doc=structuredClone(v.doc());
    const transform={x:0,y:0,scaleX:1,scaleY:1,rotation:0,opacity:1};
    // Load a fixed fixture document directly, excluding construction/history cost
    // from timeline evaluation measurements.
    doc.tracks=Array.from({length:config.tracks},(_,track)=>({id:`bench-track-${track}`,kind:'video',name:`Track ${track}`,muted:false,locked:false,
      clips:Array.from({length:config.clipsPerTrack},(_,clip)=>({id:`bench-clip-${track}-${clip}`,assetId:assets[track%assets.length],startUs:clip*2000000,durationUs:2000000,sourceInUs:0,speed:1,volume:0,
        transform:{...transform,opacity:1/config.tracks},keyframes:{},effects:[],text:null}))}));
    v.store.loadDocument(doc);
  }
  if(id==='audio') {
    const file=new File([await(await fetch('/fixtures/audio.wav')).blob()],'audio.wav',{type:'audio/wav'});
    const at=performance.now(),probe=await v.media.probeAudio(file);
    const assetId=apply({type:'addAsset',kind:'audio',src:'local://audio.wav',name:'Long tone',durationUs:probe.durationUs,width:0,height:0,hasAudio:true}).events[0].assetId;
    await v.media.attachAudio(assetId,probe.buffer);metrics.importAudioMs=[performance.now()-at];fixture={assetId};sourceDurationUs=probe.durationUs;
  }
  if(id==='scene') {
    const side=Math.ceil(Math.sqrt(config.props));
    const spec={version:1,durationUs:2000000,width:640,height:360,geometries:{box:{vertices:[[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]],faces:[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[3,7,6],[3,6,2],[0,4,7],[0,7,3],[1,2,6],[1,6,5]]}},groups:Array.from({length:8},(_,i)=>({id:`g${i}`,rotationY:[{t:0,v:0},{t:2,v:45}]})),
      camera:{position:{x:0,y:side*.8,z:side*1.2},lookAt:{x:0,y:0,z:0}},
      props:Array.from({length:config.props},(_,i)=>({id:`p${i}`,model:'prop/instance',geometryId:'box',parentId:`g${i%8}`,position:{x:(i%side)-side/2,y:(i%5)*.25,z:Math.floor(i/side)-side/2},scale:{x:.6,y:.6,z:.6},color:i%2?'#8fb8e8':'#e6b774'}))};
    const at=performance.now(),made=await v.sceneClip({spec});if(!made.ok)throw Error(made.message);metrics.sceneBuildMs=[performance.now()-at];fixture=made;
  }
  const setupMs=performance.now()-start;
  const previewBefore=v.diagnostics().preview;
  // Responsiveness measurements cover only the timed operations, not fixture setup.
  let previous=performance.now();const gaps=[];
  const timer=setInterval(()=>{const now=performance.now();gaps.push(now-previous);previous=now;},10);
  const longTasks=[];const observer=new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>entry.duration)));
  try{observer.observe({type:'longtask',buffered:false});}catch{}
  try {
    if(id==='video4k') {
      const positions=[1700000,100000,1200000,500000,1800000,0];
      await sample('seekExactMs',async i=>{const frame=await v.media.exactFrame(fixture.assetId,positions[(i+1)%positions.length]);if(!frame)throw Error('Missing 4K frame');try{if(frame.displayWidth!==3840||frame.displayHeight!==2160||Math.abs(frame.timestamp-positions[(i+1)%positions.length])>100000)throw Error('4K seek changed resolution or returned the wrong source time');}finally{frame.close();}});
      await sample('proxyBuildMs',async i=>{
        const source=await v.media.probeVideo(fixture.file),assetId=`proxy-${i}`;v.media.attachVideo(assetId,source,fixture.file);
        await v.media.buildProxy(assetId,{force:true});if(!v.media.hasProxy(assetId))throw Error('Proxy not ready');
      });
    }
    if(id==='multitrack') {
      await sample('seekToWorkerAckMs',i=>seekToAcknowledgedFrame(((i+2)*700003)%(config.clipsPerTrack*2000000)));
      await sample('evaluate100FramesMs',async i=>{for(let frame=0;frame<100;frame++){const fg=v.store.evaluate(Math.round((((i+1)*37+frame*19)%(config.clipsPerTrack*24))*1000000/12));if(fg.layers.length!==config.tracks)throw Error('Missing active timeline layers');}});
      // Export a fixed two-second range without exporting the entire stress timeline.
      const doc=structuredClone(v.doc());for(const track of doc.tracks)track.clips=track.clips.slice(0,1);v.store.loadDocument(doc);
      await sample('export2SecondsMs',exportCurrent);
      v.previewSession({timeUs:0,playing:true});await new Promise(resolve=>setTimeout(resolve,1200));v.previewSession({playing:false});
    }
    if(id==='audio') {
      await sample('randomPcmWindowMs',async i=>{
        const from=((i+2)*7919%Math.max(1,Math.floor(sourceDurationUs/1000000)-1))*1000000;
        const pcm=await v.media.requestPcm(fixture.assetId,from,1000000);if(pcm.frames<47000)throw Error('Missing long-audio samples');
      });
    }
    if(id==='scene') {
      await sample('poseAndSubmitFrameMs',async i=>{const frame=await v.media.exactFrame(fixture.assetId,((i+1)%5)*300000);if(!frame)throw Error('Missing scene frame');frame.close();});
      await sample('export2SecondsMs',exportCurrent);
    }
    await new Promise(resolve=>setTimeout(resolve,20));
    const diagnostics=v.media.diagnostics();
    if(diagnostics.pendingRequests||diagnostics.scheduling.running||diagnostics.scheduling.queued)throw Error('Media work did not settle');
    const preview=v.diagnostics().preview;
    if(preview.peakInflight>2||preview.failed>previewBefore.failed)throw Error('Preview queue budget or rendering failed');
    return {id,config,setupMs,metrics,preview:{submitted:preview.submitted-previewBefore.submitted,acknowledged:preview.acknowledged-previewBefore.acknowledged,dropped:preview.dropped-previewBefore.dropped,peakInflight:preview.peakInflight,workerAckLatenciesMs:preview.acknowledged>previewBefore.acknowledged?preview.latencySamplesMs.slice(-Math.min(512,preview.acknowledged-previewBefore.acknowledged)):[]},responsiveness:{timerIntervalMs:10,maxTimerGapMs:gaps.length?Math.max(...gaps):null,longTaskCount:longTasks.length,longTaskDurationsMs:longTasks},diagnostics};
  } finally {clearInterval(timer);observer.disconnect();}
}
