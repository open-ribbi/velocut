import { evaluate } from '@velocut/core-ts';
import { Exporter, compileMotionSpec, releaseExportOutput, type ExportOptions, type MediaLibrary, type SnapshotRenderer } from '@velocut/render-sdk';
import { compileSceneSpec } from '@velocut/scene-sdk';
import { sceneResources } from '@velocut/runtime';
import type { Store } from '../state/store';
import { exportAudioPlan } from './export-audio';

export type ExportJobState = 'queued' | 'preparing' | 'rendering' | 'completed' | 'cancelled' | 'failed';
export interface ExportJob {
  id: string; revision: number; name: string; state: ExportJobState; error?: string;
  result: Promise<Blob>; cancel(): void; releaseOutput(): Promise<void>;
}
export type FilmExportOptions = Pick<ExportOptions,'videoCodec'|'videoBitrate'|'audioBitrate'|'onProgress'> & {signal?:AbortSignal};

/** The snapshot is captured synchronously, before this job can wait in a queue.
 * Each admitted job owns its decode worker and independently compiled scenes. */
export function startFilmExport(store: Store, media: MediaLibrary, options: FilmExportOptions = {}): ExportJob {
  const {revision}=store.getState(),doc=structuredClone(store.getState().doc);
  const durationUs=Math.max(0,...doc.tracks.flatMap(track=>track.clips.map(clip=>clip.startUs+clip.durationUs)),...(doc.generationSlots??[]).map(slot=>slot.startUs+slot.durationUs));
  if(durationUs<=0)throw Error('Cannot export an empty timeline');
  const assetIds=[...new Set(doc.tracks.filter(track=>!track.muted).flatMap(track=>track.clips.flatMap(clip=>clip.assetId?[clip.assetId]:[])))];
  const factories=new Map<string,()=>Promise<SnapshotRenderer>>();
  const defaults={width:doc.width,height:doc.height,fps:doc.fpsNum/doc.fpsDen};
  const resources=sceneResources(store);
  for(const asset of doc.assets) {
    if(!assetIds.includes(asset.id)||!asset.spec)continue;
    if(asset.src.startsWith('motion://'))factories.set(asset.id,async()=>{
      const compiled=compileMotionSpec(JSON.parse(asset.spec!),defaults);await compiled.load();return compiled;
    });
    if(asset.src.startsWith('scene://'))factories.set(asset.id,async()=>{
      const compiled=compileSceneSpec(JSON.parse(asset.spec!),{...defaults,resources,assetBase:'/scene-assets'});
      try {await compiled.load();return compiled;}catch(error){compiled.dispose();throw error;}
    });
  }
  const capture=media.capture(assetIds,factories),controller=new AbortController();
  const signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
  let output:Blob|undefined;
  const job:ExportJob={id:crypto.randomUUID(),revision,name:doc.name,state:'queued',result:null as never,
    cancel:()=>controller.abort(),releaseOutput:async()=>{if(output){await releaseExportOutput(output);output=undefined;}}};
  job.result=new Exporter(media,async currentSignal=>{
    job.state='preparing';options.onProgress?.(0,'Preparing export snapshot');return capture.open(currentSignal);
  }).export({
    ...options,width:doc.width,height:doc.height,fpsNum:doc.fpsNum,fpsDen:doc.fpsDen,durationUs,
    evaluate:t=>evaluate(doc,t),audioClips:exportAudioPlan(doc),signal,
    onProgress:(fraction,label)=>{job.state='rendering';options.onProgress?.(fraction,label);},
  }).then(blob=>{output=blob;job.state='completed';return blob;},error=>{
    job.state=signal.aborted?'cancelled':'failed';job.error=String(error);throw error;
  }).finally(()=>capture.dispose());
  return job;
}
