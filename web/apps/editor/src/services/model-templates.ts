import {builtinTemplates} from '@velocut/provider-sdk/presets';
import type {ModelSpec} from '@velocut/provider-sdk/declarative';
/** Bundled examples are ordinary definitions; imported models follow exactly the same path. */
export const MODEL_TEMPLATES:ModelSpec[]=[{
 version:1,id:'custom-video',label:'Custom video · async JSON',capability:'video.generate',timeline:{prompt:'prompt',duration:'duration'},
 inputSchema:{type:'object',required:['prompt'],additionalProperties:false,properties:{prompt:{type:'string',minLength:1},duration:{type:'number',exclusiveMinimum:0},camera:{type:'object',properties:{movement:{type:'string'},strength:{type:'number',minimum:0,maximum:1}}}}},
 execution:{type:'async-http',submit:{method:'POST',path:'/tasks',body:{$input:''}},receipt:{id:'$.data.task_id'},poll:{method:'GET',path:'/tasks/{receipt.id}',status:'$.data.status',states:{running:['queued','processing'],succeeded:['completed'],failed:['failed','cancelled']}},outputs:[{kind:'video',url:'$.data.video_url'}]},
},...builtinTemplates()];
