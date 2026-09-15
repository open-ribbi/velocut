import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Playback } from '../dist/playback.js';
import { AudioEngine } from '../dist/audio.js';

function audioContext(t: TestContext) {
  const sources: any[] = [];
  const ctx = {
    currentTime: 0, state: 'running', destination: {}, resume: async () => {}, close: async () => {},
    createGain: () => ({ connect: () => {}, disconnect: () => {}, gain: { value: 1 } }),
    createAnalyser: () => ({ connect: () => {}, fftSize: 2048 }),
    createBuffer: (_c: number, frames: number, sampleRate: number) => ({ duration: frames / sampleRate, copyToChannel: () => {} }),
    createBufferSource: () => {
      const source = { playbackRate: { value: 1 }, connect: () => {}, start: (...args: number[]) => { source.started = args; }, stop: () => { source.stopped = true; }, started: [] as number[], stopped: false, buffer: null };
      sources.push(source); return source;
    },
  };
  const original = globalThis.AudioContext;
  globalThis.AudioContext = class { constructor() { return ctx; } } as never;
  t.after(() => { globalThis.AudioContext = original; });
  return { ctx, sources };
}

function transport(audio: AudioEngine) {
  const state = { playing: false, playheadUs: 0, durationUs: 20_000_000, revision: 3 };
  const playback = new Playback({ getState: () => state, seek: at => { state.playheadUs = at; }, setPlaying: v => { state.playing = v; }, evaluate: () => ({}) as never }, {} as never, {} as never, audio);
  return { state, playback, time: () => playback.session().state!.timeUs };
}

test('preview clock changes slope without jumps, seeks correctly, and stops/replays at the end', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  let frame: FrameRequestCallback;
  const oldRaf = globalThis.requestAnimationFrame, oldCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = cb => { frame = cb; return 1; };
  globalThis.cancelAnimationFrame = () => {};
  t.after(() => { globalThis.requestAnimationFrame = oldRaf; globalThis.cancelAnimationFrame = oldCancel; });
  const state = { playing: false, playheadUs: 0, durationUs: 10_000_000, revision: 3 };
  const store = { getState: () => state, seek: (time: number) => { state.playheadUs = time; }, setPlaying: (playing: boolean) => { state.playing = playing; }, evaluate: () => ({}) as never };
  let mediaPlaying = false;
  const p = new Playback(store, { version: 0, setPlaying: (v: boolean) => { mediaPlaying = v; } } as never, { version: 0, render: () => {} } as never);
  let notifications = 0; const unsubscribe = p.subscribeRate(() => notifications++);
  p.start(); p.setRate(2); p.play();
  now = 1000; frame!(now); assert.equal(state.playheadUs, 2_000_000);
  now = 1250; p.setRate(0.5); assert.equal(state.playheadUs, 2_500_000);
  now = 2250; frame!(now); assert.equal(state.playheadUs, 3_000_000);
  p.seek(5_000_000); now = 3250; frame!(now); assert.equal(state.playheadUs, 5_500_000);
  p.pause(); now = 5000; p.setRate(4); frame!(now); assert.equal(state.playheadUs, 5_500_000);
  p.play(); now = 7000; frame!(now);
  assert.equal(state.playheadUs, 10_000_000); assert.equal(state.playing, false); assert.equal(mediaPlaying, false);
  p.play(); assert.equal(state.playheadUs, 0);
  assert.equal(p.rate, 4); assert.equal(state.revision, 3); assert.equal(notifications, 3);
  unsubscribe(); p.stop(); assert.equal(state.playing, false);
});

test('invalid preview sessions have no partial effects and reads return live rate/state', () => {
  const state = { playing: false, playheadUs: 2_000_000, durationUs: 10_000_000, revision: 0 };
  const p = new Playback({ getState: () => state, seek: t => { state.playheadUs = t; }, setPlaying: v => { state.playing = v; }, evaluate: () => ({}) as never }, {} as never, {} as never);
  for (const opts of [{ rate: 2, timeUs: -1 }, { rate: 2, playing: 'yes' }, { rate: 0 }, { rate: Infinity }, { rate: 3 }, { rate: 2, speed: 2 }]) {
    assert.equal(p.session(opts as never).ok, false); assert.equal(p.rate, 1); assert.equal(state.playheadUs, 2_000_000);
  }
  assert.deepEqual(p.session({ rate: 0.25, timeUs: 4_000_000 }), { ok: true, state: { rate: 0.25, playing: false, timeUs: 4_000_000, durationUs: 10_000_000 } });
});

test('late audio activation joins preview time without jumping backwards', t => {
  let now = 0, active = false, anchor = 0;
  t.mock.method(performance, 'now', () => now);
  const state = { playing: false, playheadUs: 0, durationUs: 10_000_000, revision: 0 };
  const audio = { clockUs: () => active ? anchor : null, onPlay: () => {}, onPause: () => {}, onSeek: (at: number) => { anchor = at; } };
  const p = new Playback({ getState: () => state, seek: at => { state.playheadUs = at; }, setPlaying: v => { state.playing = v; }, evaluate: () => ({}) as never }, {} as never, {} as never, audio as never);
  p.setRate(2); p.play(); now = 500;
  assert.equal(p.session().state!.timeUs, 1_000_000);
  active = true;
  assert.equal(p.session().state!.timeUs, 1_000_000); assert.equal(anchor, 1_000_000);
  p.pause();
});

test('audio preview rate scales the master clock and PCM schedule; stale chunks cannot replay', async t => {
  const { ctx, sources } = audioContext(t);
  const requests: Array<{ from: number; duration: number; resolve: (pcm: any) => void }> = [];
  const audio = new AudioEngine({ requestPcm: (_id: string, from: number, duration: number) => new Promise(resolve => requests.push({ from, duration, resolve })) } as never);
  audio.onPlay(1_000_000, 2);
  assert.equal(audio.clockUs(), null); // Running context, output clock not started yet.
  ctx.currentTime = 0.25;
  assert.equal(audio.clockUs(), 1_500_000);
  const frame = { audio: [{ clipId: 'a', assetId: 'media', speed: 1, gain: 1, sourceTimeUs: 1_500_000 }] } as never;
  audio.update(frame, 1_500_000);
  assert.deepEqual([requests[0].from, requests[0].duration], [1_500_000, 1_000_000]);
  ctx.currentTime = 0.35;
  const pcm = (startUs: number) => ({ startUs, frames: 48000, channels: 1, sampleRate: 48000, planes: [new Float32Array(48000)] });
  requests[0].resolve(pcm(1_500_000)); await Promise.resolve();
  assert.equal(sources[0].playbackRate.value, 2);
  assert.equal(sources[0].started[0], 0.35);
  assert.ok(Math.abs(sources[0].started[1] - 0.2) < 1e-9);
  audio.update(frame, 1_500_000); // Queue a chunk at the old rate.
  audio.onPlay(1_700_000, 0.5);
  assert.equal(sources[0].stopped, true);
  requests[1].resolve(pcm(2_500_000)); await Promise.resolve();
  assert.equal(sources.length, 1);
  ctx.currentTime = 0.85; assert.equal(audio.clockUs(), 1_950_000);
  audio.update(frame, 1_950_000);
  assert.equal(requests[2].duration, 250_000);
  requests[2].resolve(pcm(requests[2].from)); await Promise.resolve();
  assert.equal(sources[1].playbackRate.value, 0.5);
  audio.onSeek(4_000_000); assert.equal(audio.clockUs(), 4_000_000);
  audio.onPause(); assert.equal(audio.clockUs(), null); audio.dispose();
});

test('a running but frozen audio clock falls back at every preview rate and rejoins without losing time', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { ctx } = audioContext(t), audio = new AudioEngine({} as never);
  const { playback: p, time, state } = transport(audio);
  for (const rate of [0.25, 0.5, 1, 1.5, 2, 4]) {
    p.setRate(rate); p.seek(0); p.play();
    now += 10; ctx.currentTime += .01;
    assert.equal(time(), 10_000 * rate);
    now += 40; ctx.currentTime += .04;
    assert.equal(time(), 50_000 * rate);
    now += 10;
    assert.equal(time(), 50_000 * rate); // Ordinary audio quanta still own the clock.
    now += 490; // Device remains "running" but has stopped producing samples.
    assert.equal(time(), 550_000 * rate);
    assert.equal(time(), 550_000 * rate); // Reads do not restart the fallback clock.
    now += 100;
    assert.equal(time(), 650_000 * rate);
    // No rendered frame updated the stored playhead during these reads.
    assert.equal(state.playheadUs, 0);
    now += 20; ctx.currentTime += .02;
    assert.equal(time(), 670_000 * rate);
    now += 50; ctx.currentTime += .05;
    assert.equal(time(), 720_000 * rate);
    p.pause(); now += 1000;
    assert.equal(time(), 720_000 * rate);
  }
  assert.equal(state.revision, 3); audio.dispose();
});

test('suspended audio requires new clock progress; rate changes and seeks during loss keep their new anchors', t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { ctx } = audioContext(t), audio = new AudioEngine({} as never);
  const { playback: p, time } = transport(audio);
  ctx.state = 'suspended'; p.setRate(2); p.play();
  now = 500; assert.equal(time(), 1_000_000);
  ctx.state = 'running'; now = 510; assert.equal(time(), 1_020_000);
  ctx.currentTime = .01; now = 520; assert.equal(time(), 1_040_000);
  ctx.state = 'suspended'; now = 530; assert.equal(time(), 1_060_000);
  now = 1030; p.setRate(.5); assert.equal(time(), 2_060_000);
  now = 1130; assert.equal(time(), 2_110_000);
  p.seek(4_000_000); now = 1230; assert.equal(time(), 4_050_000);
  ctx.state = 'running'; now = 1330; assert.equal(time(), 4_100_000);
  ctx.currentTime = .02; now = 1340; assert.equal(time(), 4_105_000);
  ctx.currentTime = .12; now = 1440; assert.equal(time(), 4_155_000);
  p.pause(); audio.dispose();
});

test('clock loss stops scheduled audio and rejects in-flight PCM; recovery schedules from the current preview position', async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const { ctx, sources } = audioContext(t);
  const requests: Array<{ from: number; resolve: (pcm: any) => void }> = [];
  const audio = new AudioEngine({ requestPcm: (_id: string, from: number) => new Promise(resolve => requests.push({ from, resolve })) } as never);
  const { playback: p, time } = transport(audio);
  const pcm = (startUs: number) => ({ startUs, frames: 48000, channels: 1, sampleRate: 48000, planes: [new Float32Array(48000)] });
  const frame = (at: number) => ({ audio: [{ clipId: 'a', assetId: 'media', speed: 1, gain: 1, sourceTimeUs: at }] }) as never;
  p.setRate(2); p.play(); now = 10; ctx.currentTime = .01;
  audio.update(frame(time()), time()); requests[0].resolve(pcm(requests[0].from)); await Promise.resolve();
  assert.equal(sources.length, 1);
  now = 20; ctx.currentTime = .02; audio.update(frame(time()), time());
  assert.equal(requests.length, 2);
  now = 400; const fallback = time(); assert.equal(fallback, 800_000);
  assert.equal(sources[0].stopped, true);
  audio.update(frame(fallback), fallback); assert.equal(requests.length, 2);
  requests[1].resolve(pcm(requests[1].from)); await Promise.resolve(); assert.equal(sources.length, 1);
  now = 500; ctx.currentTime = .03; const resumed = time(); assert.equal(resumed, 1_000_000);
  audio.update(frame(resumed), resumed); assert.equal(requests[2].from, resumed);
  requests[2].resolve(pcm(resumed)); await Promise.resolve();
  assert.equal(sources.length, 2); assert.equal(sources[1].started[0], ctx.currentTime);
  assert.equal(sources[1].playbackRate.value, 2);
  p.pause(); audio.dispose();
});
