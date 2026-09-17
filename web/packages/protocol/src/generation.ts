import {z} from 'zod';
type JsonInput = null | string | boolean | number | JsonInput[] | {[key:string]:JsonInput};
const jsonInput:z.ZodType<JsonInput>=z.lazy(()=>z.union([z.null(),z.string(),z.boolean(),z.number().finite(),z.array(jsonInput),z.record(jsonInput)]));
/** Editing intent only. Provider receipts and credentials never live here. */
export const GenerationRequestSchema=z.object({
  channel:z.string(),model:z.string(),prompt:z.string(),
  input:z.record(jsonInput).optional(),modelRevision:z.string().min(1).optional(),
  ratio:z.string().optional(),resolution:z.string().optional(),generateAudio:z.boolean().optional(),
  firstFrameReferenceId:z.string().min(1).optional(),
  lastFrameReferenceId:z.string().min(1).optional(),
  referenceImageIds:z.array(z.string().min(1)).optional(),referenceVideoIds:z.array(z.string().min(1)).optional(),referenceAudioIds:z.array(z.string().min(1)).optional(),
  parameters:z.record(z.union([z.string(),z.number().finite(),z.boolean()])).optional(),
}).strict();
export type GenerationRequest=z.infer<typeof GenerationRequestSchema>;
export interface GenerationSlot {
  id:string;trackId:string;startUs:number;durationUs:number;name:string;
  intentVersion:number;request:GenerationRequest;clipId?:string;selectedJobId?:string;
}
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
export const generationRequestKey=(r:GenerationRequest)=>JSON.stringify([r.channel,r.model,r.prompt,r.modelRevision??null,canonical(r.input??null),r.ratio??null,r.resolution??null,r.generateAudio??null,r.firstFrameReferenceId??null,r.lastFrameReferenceId??null,r.referenceImageIds??[],r.referenceVideoIds??[],r.referenceAudioIds??[],Object.entries(r.parameters??{}).sort(([a],[b])=>a.localeCompare(b))]);

export const generationReferenceIds=(r:GenerationRequest)=>[...new Set([r.firstFrameReferenceId,r.lastFrameReferenceId,...r.referenceImageIds??[],...r.referenceVideoIds??[],...r.referenceAudioIds??[],...generationInputReferences(r.input).map(r=>r.id)].filter((v):v is string=>!!v))];

export function generationInputReferences(input:unknown):{id:string;kind:'image'|'video'|'audio'}[]{
  const result:{id:string;kind:'image'|'video'|'audio'}[]=[];
  const walk=(v:any)=>{if(!v||typeof v!=='object')return;if(typeof v.$mediaRef==='string'&&['image','video','audio'].includes(v.kind))result.push({id:v.$mediaRef,kind:v.kind});else Object.values(v).forEach(walk);};walk(input);return result;
}
