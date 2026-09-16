import {configureGeneration,atomicRuntime,type GenerationAdapter,type GenerationLedger,type GenerationJob} from '@velocut/runtime';
import {ops,ref,type AtomicOperation} from '@velocut/protocol';
import {createVideoGen,createUploader,type MediaLibrary,type Observer} from '@velocut/render-sdk';
import {kvGet,kvPut,loadMedia,saveMedia} from '@velocut/collab-sdk';
import type {Store} from '../state/store';
import {loadVideoGenConfig} from './videogen';
import {loadUploadConfig} from './upload';
import type {ProjectStorage} from './projects';

export function bindGeneration(store:Store,media:MediaLibrary,observer:Observer,projectId:string,storage:ProjectStorage,flushDocument?:()=>Promise<void>){
  const key=`generation:${projectId}`,channel=new BroadcastChannel(`velocut-generation-${projectId}`);
  const configured=(id:string)=>{const c=loadVideoGenConfig().channels.find(c=>c.id===id);if(!c||!c.apiKey)throw Error('Configure the generation channel and API key in Agent settings');const u=new URL(c.baseUrl);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('Channel needs an HTTP(S) endpoint and a separate API key');return c;};
  const provider=(job:GenerationJob)=>{const c=configured(job.request.channel),p=createVideoGen(c.kind,{baseUrl:c.baseUrl,apiKey:c.apiKey});if(!p.submit||!p.poll)throw Error('Provider must implement submit/poll to support resumable generation');return p;};
  const sanitize=(e:unknown,id:string)=>{let message=e instanceof Error?e.message:String(e);const c=loadVideoGenConfig().channels.find(c=>c.id===id);if(c?.apiKey)message=message.split(c.apiKey).join('[redacted]');if(e instanceof Error){e.message=message;return e;}return Error(message);};
  const png=async(bitmap:ImageBitmap)=>{try{const scale=Math.min(1,1920/Math.max(bitmap.width,bitmap.height));const canvas=new OffscreenCanvas(Math.max(1,Math.round(bitmap.width*scale)),Math.max(1,Math.round(bitmap.height*scale)));canvas.getContext('2d')!.drawImage(bitmap,0,0,canvas.width,canvas.height);return await canvas.convertToBlob({type:'image/png'});}finally{bitmap.close();}};
  const adapter:GenerationAdapter={
    projectId,
    flushDocument,
    channels:()=>loadVideoGenConfig().channels.map(({id,label,models,defaultModel,capabilities})=>({id,label,models,defaultModel,capabilities})),
    binding:async id=>{const c=configured(id),p=createVideoGen(c.kind,{baseUrl:c.baseUrl,apiKey:c.apiKey});if(!p.submit||!p.poll)throw Error('Provider must implement submit/poll to support resumable generation');const bytes=new TextEncoder().encode(JSON.stringify([c.id,c.kind,c.baseUrl.replace(/\/+$/,''),c.apiKey]));return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');},
    read:async()=>{const bytes=await kvGet(key);return bytes?JSON.parse(new TextDecoder().decode(bytes)) as GenerationLedger:null;},
    write:async value=>{await kvPut(key,new TextEncoder().encode(JSON.stringify(value)));channel.postMessage('changed');},
    lock:async work=>await navigator.locks.request(`${key}:ledger`,work),
    lead:async(work,signal)=>{await navigator.locks.request(`${key}:runner`,{signal},work);},
    watch:notify=>{const listen=()=>notify();channel.addEventListener('message',listen);return()=>{channel.removeEventListener('message',listen);channel.close();};},
    prepareReference:async(ref,signal)=>{
      const file=await loadMedia(ref.src,storage.mediaDir);if(!file)throw Error('Reference file is missing from this project');
      const cfg=loadUploadConfig();if(!cfg)throw Error('Configure Upload storage in Agent settings for image-to-video');
      signal.throwIfAborted();const result=await createUploader(cfg.kind,cfg.config).upload(file,{name:ref.name,contentType:'image/png'});signal.throwIfAborted();
      const url=new URL(result.url);if(!['http:','https:'].includes(url.protocol))throw Error('Upload storage returned an invalid reference URL');return result.url;
    },
    submit:async(job,firstFrameUrl,signal)=>{try{return await provider(job).submit!({model:job.request.model,prompt:job.request.prompt,durationS:job.providerDurationS,ratio:job.request.ratio,resolution:job.request.resolution,generateAudio:job.request.generateAudio,firstFrameUrl,signal});}catch(e){throw sanitize(e,job.request.channel);}},
    poll:async(job,signal)=>{try{return await provider(job).poll!(job.providerTaskId!,signal);}catch(e){throw sanitize(e,job.request.channel);}},
    download:async(job,result,signal)=>{
      const filename=`generation-${job.id}.mp4`,src=`opfs://${filename}`;
      let file=await loadMedia(src,storage.mediaDir);
      if(!file){
        const url=new URL(result.videoUrl);if(!['http:','https:'].includes(url.protocol))throw Error('Invalid generated media URL');
        let response=await fetch(url,{signal}).catch(()=>null);
        const match=/^(https?:\/\/[^/]+)\/videogen-proxy\//.exec(configured(job.request.channel).baseUrl);
        if(!response?.ok&&match)response=await fetch(`${match[1]}/videogen-proxy/${url.host}${url.pathname}${url.search}`,{signal});
        if(!response?.ok)throw Error(`Generated video download failed (${response?.status??'network/CORS'}); resume tracking to refresh the result`);
        file=new File([await response.blob()],filename,{type:'video/mp4'});if(!file.size)throw Error('Provider returned an empty video');
      }
      signal.throwIfAborted();const source=await media.probeVideo(file);
      try{const p=source.probe();if(p.durationUs<=0||p.width<=0||p.height<=0)throw Error('Generated video has invalid metadata');signal.throwIfAborted();await saveMedia(file,storage.mediaDir);return {src,name:job.request.prompt.slice(0,60)||'Generated video',durationUs:p.durationUs,width:p.width,height:p.height,hasAudio:p.hasAudio,size:file.size};}
      finally{media.releaseVideoProbe(source);}
    },
    capture:async(input,signal)=>{
      if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Choose an image asset or a timeline frame');
      const doc=store.getState().doc;
      if(input.kind==='asset'){
        if(Object.keys(input).some(k=>!['kind','assetId'].includes(k)))throw Error('Invalid image reference fields');
        const asset=doc.assets.find(a=>a.id===input.assetId);if(!asset||asset.kind!=='image'||!asset.src.startsWith('opfs://'))throw Error('Use an imported image asset, or capture its timeline frame');
        const file=await loadMedia(asset.src,storage.mediaDir);if(!file)throw Error('Image asset is not in project storage');signal?.throwIfAborted();
        return {blob:await png(await createImageBitmap(file)),name:asset.name+'.png',provenance:{kind:'asset',assetId:asset.id}};
      }
      if(input.kind!=='timeline'||Object.keys(input).some(k=>!['kind','timeUs','clipId'].includes(k))||!Number.isSafeInteger(input.timeUs)||(input.timeUs as number)<0)throw Error('Invalid timeline reference');
      const fg=store.evaluate(input.timeUs as number);if(fg.pendingGenerationIds?.length)throw Error('This frame contains unresolved generation; choose a completed frame');
      if(input.clipId!==undefined){if(typeof input.clipId!=='string')throw Error('Invalid clipId');fg.layers=fg.layers.filter(l=>l.clipId===input.clipId).map(l=>({...l,transition:null}));fg.audio=[];}
      if(!fg.layers.length)throw Error('There is no visible media at this frame');
      const captured=await observer.grab({kind:'graph',fg},1920);if(!captured)throw Error('Frame capture failed');if(signal?.aborted){captured.bitmap.close();signal.throwIfAborted();}
      return {blob:await png(captured.bitmap),name:'timeline-frame.png',provenance:{kind:'timeline',timeUs:input.timeUs,...(input.clipId?{clipId:input.clipId}:{composite:true})}};
    },
    saveReference:(id,blob)=>saveMedia(new File([blob],`generation-${id}.png`,{type:'image/png'}),storage.mediaDir),
    referenceBlob:async ref=>{const file=await loadMedia(ref.src,storage.mediaDir);if(!file)throw Error('Reference file is missing');return file;},
    // The document's existing restoreMedia subscription attaches new assets.
    // Starting a second probe here would race it and retain duplicate decoders.
    attach:async()=>{},
    mediaBlob:async result=>{const file=await loadMedia(result.src,storage.mediaDir);if(!file)throw Error('Generated media is missing');return file;},
  };
  const manager=configureGeneration(store,adapter);
  window.addEventListener('pagehide',()=>manager.dispose(),{once:true});
  return manager;
}

export async function createGenerationSlot(store:Store,atUs:number,durationUs:number,trackId?:string){
  const api=atomicRuntime(store),doc=store.getState().doc,channel=loadVideoGenConfig().channels[0];
  const gcd=(a:number,b:number):number=>b?gcd(b,a%b):a;const d=gcd(doc.width,doc.height);
  const operations:AtomicOperation[]=[];
  if(!trackId)operations.push({id:'track',command:ops.addTrack({kind:'video',name:'Generated'})});
  operations.push({id:'slot',command:ops.addGenerationSlot({trackId:trackId??ref('track','trackId'),startUs:atUs,durationUs,request:{channel:channel?.id??'',model:channel?.defaultModel??channel?.models[0]??'',prompt:'',ratio:`${doc.width/d}:${doc.height/d}`}})});
  const r=await api.transaction({action:'commit',runtimeId:api.runtimeId,expectedRevision:store.getState().revision,requestId:'slot-'+crypto.randomUUID(),operations});
  if(!r.ok)throw Error(r.error.message);return (r.data as {results:{slot:{slotId:string}}}).results.slot.slotId;
}
