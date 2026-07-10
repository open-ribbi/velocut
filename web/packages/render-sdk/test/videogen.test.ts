// Unit tests for the task-API video-gen provider: submit → poll protocol,
// params mapping, error surfaces. fetch is stubbed — no network, no credits.
// Run: node --experimental-strip-types --test packages/render-sdk/test/videogen.test.ts

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { TaskApiVideoGen, createVideoGen, videoGenProviders } from '../src/videogen.ts';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Call = { url: string; init?: RequestInit };

/** Stub fetch with a scripted sequence of JSON responses; records calls. */
function scriptFetch(responses: Array<{ status?: number; body: unknown }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

const gen = () =>
  new TaskApiVideoGen({ baseUrl: 'https://relay.example/', apiKey: 'hm-test', pollIntervalMs: 1, timeoutMs: 5000 });

test('task-api: submit → poll pending → processing → completed', async () => {
  const calls = scriptFetch([
    { body: { task_id: 't-1', status: 'pending' } },
    { body: { id: 't-1', status: 'pending' } },
    { body: { id: 't-1', status: 'processing' } },
    { body: { id: 't-1', status: 'completed', result: { video_url: 'https://cdn.example/v.mp4', duration: 5, resolution: '720p', ratio: '16:9' }, cost: 2.3 } },
  ]);
  const statuses: string[] = [];
  const r = await gen().generate({
    model: 'seedance-2.0',
    prompt: 'a cat walks on the beach',
    durationS: 5,
    resolution: '720p',
    ratio: '16:9',
    generateAudio: false,
    onStatus: (s) => statuses.push(s),
  });
  assert.equal(r.videoUrl, 'https://cdn.example/v.mp4');
  assert.equal(r.durationS, 5);
  assert.equal(r.cost, 2.3);
  assert.equal(r.taskId, 't-1');
  assert.deepEqual(statuses, ['pending', 'pending', 'processing', 'completed']);

  // Submit call shape: trailing slash trimmed, bearer auth, snake_case params.
  const submit = calls[0];
  assert.equal(submit.url, 'https://relay.example/api/v1/tasks');
  assert.equal((submit.init!.headers as Record<string, string>).authorization, 'Bearer hm-test');
  const body = JSON.parse(submit.init!.body as string);
  assert.equal(body.model, 'seedance-2.0');
  assert.deepEqual(body.params, {
    prompt: 'a cat walks on the beach',
    duration: 5,
    resolution: '720p',
    ratio: '16:9',
    generate_audio: false,
  });
  // Poll call shape.
  assert.equal(calls[1].url, 'https://relay.example/api/v1/tasks/t-1');
});

test('task-api: image conditioning maps to first/last frame + reference params', async () => {
  const calls = scriptFetch([
    { body: { task_id: 't-2' } },
    { body: { id: 't-2', status: 'completed', result: { video_url: 'https://cdn.example/v2.mp4' } } },
  ]);
  await gen().generate({
    model: 'seedance-2.0',
    prompt: 'p',
    firstFrameUrl: 'https://pub.example/first.png',
    lastFrameUrl: 'https://pub.example/last.png',
    referenceImageUrls: ['https://pub.example/a.png'],
    referenceVideoUrls: ['https://pub.example/b.mp4'],
  });
  const body = JSON.parse(calls[0].init!.body as string);
  assert.equal(body.params.first_frame_image, 'https://pub.example/first.png');
  assert.equal(body.params.last_frame_image, 'https://pub.example/last.png');
  assert.deepEqual(body.params.reference_images, ['https://pub.example/a.png']);
  assert.deepEqual(body.params.reference_videos, ['https://pub.example/b.mp4']);
  // Unset optionals must not appear at all (providers reject unknown nulls).
  assert.ok(!('duration' in body.params) && !('generate_audio' in body.params));
});

test('task-api: provider failure surfaces error_message', async () => {
  scriptFetch([
    { body: { task_id: 't-3' } },
    { body: { id: 't-3', status: 'failed', error_message: 'content policy', cost: 0 } },
  ]);
  await assert.rejects(() => gen().generate({ model: 'm', prompt: 'p' }), /content policy/);
});

test('task-api: submit rejection carries the endpoint detail message', async () => {
  scriptFetch([{ status: 401, body: { detail: { error_code: 'UNAUTHORIZED', message: 'API Key 无效' } } }]);
  await assert.rejects(() => gen().generate({ model: 'm', prompt: 'p' }), /API Key 无效/);
});

test('task-api: completed without video_url is a loud error, not a silent empty clip', async () => {
  scriptFetch([{ body: { task_id: 't-4' } }, { body: { id: 't-4', status: 'completed', result: {} } }]);
  await assert.rejects(() => gen().generate({ model: 'm', prompt: 'p' }), /no video_url/);
});

test('task-api: overall deadline aborts an endless pending task', async () => {
  scriptFetch([{ body: { task_id: 't-5' } }, { body: { id: 't-5', status: 'processing' } }]);
  const g = new TaskApiVideoGen({ baseUrl: 'https://relay.example', apiKey: 'k', pollIntervalMs: 1, timeoutMs: 20 });
  await assert.rejects(() => g.generate({ model: 'm', prompt: 'p' }), /timed out/);
});

test('registry: task-api is built in; unknown kinds fail loudly', () => {
  assert.ok(videoGenProviders().some((k) => k.id === 'task-api'));
  assert.ok(createVideoGen('task-api', { baseUrl: 'https://x', apiKey: 'k' }));
  assert.throws(() => createVideoGen('nope', { baseUrl: 'https://x', apiKey: 'k' }), /unknown video-gen provider kind/);
});

test('task-api: empty prompt/model rejected before any network call', async () => {
  const calls = scriptFetch([{ body: {} }]);
  await assert.rejects(() => gen().generate({ model: 'm', prompt: '  ' }), /prompt is required/);
  await assert.rejects(() => gen().generate({ model: '', prompt: 'p' }), /model is required/);
  assert.equal(calls.length, 0);
});
