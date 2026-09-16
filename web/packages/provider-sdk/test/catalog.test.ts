import {test} from 'node:test';import assert from 'node:assert/strict';
import {MODEL_PRESETS,parameterDefaults,parameterFields,validateParameters,validateVideoModel} from '../dist/catalog.js';
test('model presets separate MiniMax H3 video from speech/music and retain native parameter limits',()=>{
 assert.throws(()=>validateVideoModel(undefined,{referenceImageIds:'image-id'}),/Invalid referenceImageIds/);
 const h3=MODEL_PRESETS.find(p=>p.id==='minimax-h3')!;assert.equal(h3.protocol,'task-api');assert.deepEqual(h3.capabilities?.resolutions,['2K','768P']);assert.equal(MODEL_PRESETS.find(p=>p.id==='speech-2.8-hd')!.kind,'speech');assert.equal(MODEL_PRESETS.find(p=>p.id==='music-2.5')!.kind,'music');
 assert.throws(()=>validateVideoModel({presetId:'minimax-h3'},{parameters:{},referenceAudioIds:['a']}),/require image/);
 assert.throws(()=>validateVideoModel({presetId:'minimax-h3'},{firstFrameReferenceId:'i',referenceImageIds:['j']}),/cannot be combined/);
 validateVideoModel({presetId:'seedance-2.5'},{referenceAudioIds:['a'],parameters:{output_format:'mp4'}});
 assert.throws(()=>validateVideoModel({presetId:'seedance-2.5'},{firstFrameReferenceId:'i'}),/frame role/);
 assert.throws(()=>validateVideoModel({presetId:'hailuo-2.3'},{durationS:10,resolution:'1080P'}),/6-second/);
});
test('custom model controls are typed and reserved routing/credential fields cannot become model parameters',()=>{
 const config={presetId:'task-generic',parameters:[{key:'seed',label:'Seed',type:'number' as const,integer:true,min:0,default:7},{key:'negative_prompt',label:'Negative prompt',type:'text' as const}]};
 assert.equal(parameterDefaults(config).seed,7);validateParameters({seed:8,negative_prompt:'blur'},parameterFields(config));assert.throws(()=>validateParameters({seed:.2},parameterFields(config)),/Invalid Seed/);assert.throws(()=>parameterFields({parameters:[{key:'callback_url',label:'URL',type:'text'}]}),/reserved/);assert.throws(()=>validateParameters({apiKey:'x'},parameterFields(config)),/not configured/);
});
