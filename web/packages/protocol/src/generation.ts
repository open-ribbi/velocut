import {z} from 'zod';
/** Editing intent only. Provider receipts and credentials never live here. */
export const GenerationRequestSchema=z.object({
  channel:z.string(),model:z.string(),prompt:z.string(),
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
export const generationRequestKey=(r:GenerationRequest)=>JSON.stringify([r.channel,r.model,r.prompt,r.ratio??null,r.resolution??null,r.generateAudio??null,r.firstFrameReferenceId??null,r.lastFrameReferenceId??null,r.referenceImageIds??[],r.referenceVideoIds??[],r.referenceAudioIds??[],Object.entries(r.parameters??{}).sort(([a],[b])=>a.localeCompare(b))]);

export const generationReferenceIds=(r:GenerationRequest)=>[...new Set([r.firstFrameReferenceId,r.lastFrameReferenceId,...r.referenceImageIds??[],...r.referenceVideoIds??[],...r.referenceAudioIds??[]].filter((v):v is string=>!!v))];
