import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapCaptionsToClip, transcribeAsset } from '../dist/transcribe.js';

test('captions intersect source trim and map to clip placement at fast and slow speeds', () => {
  const segments = [
    { startUs: 0, endUs: 1000000, text:'before' },
    { startUs: 1500000, endUs: 3000000, text:'first' },
    { startUs: 3000000, endUs: 6500000, text:'last' },
    { startUs: 7000000, endUs: 8000000, text:'after' },
  ];
  assert.deepEqual(mapCaptionsToClip(segments, { startUs:10000000, sourceInUs:2000000, durationUs:2000000, speed:2 }), [
    { startUs:10000000, endUs:10500000, text:'first' },
    { startUs:10500000, endUs:12000000, text:'last' },
  ]);
  assert.deepEqual(mapCaptionsToClip(segments, { startUs:10000000, sourceInUs:2000000, durationUs:8000000, speed:.5 }), [
    { startUs:10000000, endUs:12000000, text:'first' },
    { startUs:12000000, endUs:18000000, text:'last' },
  ]);
});

test('ASR source windows discard decoder padding and retain timestamps and missing-audio gaps', async () => {
  const requests: number[] = [];
  let received!: Float32Array;
  const result = await transcribeAsset({ requestPcm: async (_id, fromUs, durationUs) => {
    requests.push(fromUs);
    const startUs = fromUs - 20000;
    const frames = Math.round((durationUs + 40000) * 16000 / 1e6);
    return { startUs, sampleRate:16000, channels:1, frames,
      planes:[Float32Array.from({length:frames}, (_, i) => (startUs / 1e6 + i / 16000) / 100)] };
  } }, { transcribe: async pcm => { received = pcm; return [{startUs:500000,endUs:1500000,text:'speech'}]; } }, 'a', 31000000, {fromUs:2000000});
  assert.deepEqual(requests,[2000000,32000000]);
  assert.equal(received.length,31*16000);
  for (const i of [0,479999,480000,495999]) assert.ok(Math.abs(received[i] - (2+i/16000)/100) < 1e-7);
  assert.deepEqual(result,[{startUs:2500000,endUs:3500000,text:'speech'}]);
  await transcribeAsset({ requestPcm: async (_id, fromUs, durationUs) => ({startUs:fromUs,sampleRate:16000,channels:1,
    frames:fromUs === 0 ? 0 : 16000,planes:[new Float32Array(16000).fill(.5)]}) },
    { transcribe: async pcm => { assert.equal(pcm.length,31*16000); assert.equal(pcm[0],0); assert.equal(pcm[30*16000],.5); return []; } }, 'a',31000000);
});
