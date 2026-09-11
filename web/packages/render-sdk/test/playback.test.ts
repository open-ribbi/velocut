import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Playback } from '../dist/playback.js';
import { AudioEngine } from '../dist/audio.js';

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
