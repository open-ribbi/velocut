import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mixAudioWindow } from '../dist/audio-mix.js';

function rampSource() {
  const requests: number[] = [];
  return { requests, async requestPcm(_id: string, fromUs: number, durationUs: number) {
    requests.push(durationUs);
    const startUs = Math.floor(fromUs / 10000) * 10000 - 10000;
    const frames = Math.ceil((fromUs + durationUs - startUs) / 1000) + 10;
    return { startUs, sampleRate: 1000, channels: 1, frames,
      planes: [Float32Array.from({ length: frames }, (_, i) => (startUs / 1000 + i) / 10000)] };
  } };
}

test('varispeed, trim and clip-local automation align across padded decoder windows', async () => {
  for (const speed of [0.5, 1, 2, 40]) {
    const source = rampSource();
    const clip = { assetId: 'tone', startUs: 125500, sourceInUs: 215250, durationUs: 1100000,
      speed, gain: 0, gainAt: (localUs: number) => localUs < 400000 ? .2 : .8 };
    const joined: number[] = [];
    for (let off = 0; off < 1500; off += 375) {
      const [left, right] = await mixAudioWindow(source, [clip], off, 375, 1000, 2);
      assert.deepEqual(left, right); joined.push(...left);
    }
    joined.forEach((sample, i) => {
      const local = i * 1000 - clip.startUs;
      const expected = local < 0 || local >= clip.durationUs ? 0 :
        (clip.sourceInUs + local * speed) / 10000000 * clip.gainAt(local);
      assert.ok(Math.abs(sample - expected) < 1e-6, `speed ${speed}, sample ${i}: ${sample} != ${expected}`);
    });
    assert.ok(source.requests.every(duration => duration <= 1001000));
  }
});

test('overlapping clips mix additively and empty PCM leaves silence', async () => {
  const source = rampSource();
  const clip = { assetId: 'a', startUs: 0, sourceInUs: 1000000, durationUs: 100000, gain: .5 };
  const [mixed] = await mixAudioWindow(source, [clip, clip], 0, 100, 1000, 1);
  assert.ok(Math.abs(mixed[0] - .1) < 1e-6);
  const [silent] = await mixAudioWindow({ requestPcm: async () => ({startUs:0,sampleRate:1000,channels:1,frames:0,planes:[]}) }, [clip], 0, 100, 1000, 1);
  assert.ok(silent.every(v => v === 0));
});

test('decode failures and cancellation cannot silently produce incomplete sound', async () => {
  const clip = { assetId: 'a', startUs: 0, sourceInUs: 0, durationUs: 1000000, gain: 1 };
  await assert.rejects(mixAudioWindow({ requestPcm: async () => { throw Error('decode failed'); } }, [clip], 0, 100, 1000, 1), /decode failed/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mixAudioWindow(rampSource(), [clip], 0, 100, 1000, 1, controller.signal), {name:'AbortError'});
});
