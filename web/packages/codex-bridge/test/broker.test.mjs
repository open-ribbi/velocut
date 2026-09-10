import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBroker } from '../src/broker.mjs';

async function page(broker, projectId) {
  const paired = broker.connect('http://localhost:5173');
  const value = new URL(paired.url).hash.slice(1);
  const token = new URLSearchParams(value).get('velocut-codex').split('.')[1];
  const fetchAs = (path, key, data, method = data === undefined ? 'GET' : 'POST') => fetch(broker.url + path, {
    method, headers: { Origin: 'http://localhost:5173', Authorization: `Bearer ${key}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const response = await fetchAs('/register', token, { projectId, projectName: projectId, revision: 1 });
  assert.equal(response.status, 200);
  const session = await response.json();
  return { ...session, request: (suffix, data, method) => fetchAs(`/sessions/${session.sessionId}${suffix}`, session.sessionKey, data, method) };
}

test('pairing requires loopback, matched Origin and a capability token', async (t) => {
  const broker = await createBroker(); t.after(() => broker.close());
  assert.throws(() => broker.connect('https://example.com'), /loopback/);
  broker.connect();
  const denied = await fetch(broker.url + '/register', { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  const unauthenticated = await fetch(broker.url + '/register', { method: 'POST', headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthenticated.status, 401);
});

test('commands are explicitly scoped and a different session cannot answer them', async (t) => {
  const broker = await createBroker(); t.after(() => broker.close());
  const a = await page(broker, 'a'), b = await page(broker, 'b');
  const pending = broker.call(a.sessionId, 'sceneEdit', { assetId: 'asset_1', edits: [] });
  const command = await (await a.request('/next')).json();
  assert.equal(command.method, 'sceneEdit');
  assert.equal((await b.request('/result', { id: command.id, result: { ok: true } })).status, 409);
  assert.equal((await a.request('/result', { id: command.id, result: { ok: true, revision: 2 } })).status, 200);
  assert.deepEqual(await pending, { ok: true, revision: 2 });
  assert.equal((await a.request('/result', { id: command.id, result: {} })).status, 409);
  assert.equal(broker.list().find((s) => s.sessionId === b.sessionId).lastCommand, null);
});

test('delivered timeouts report uncertainty and late results are consumed without replay', async (t) => {
  const broker = await createBroker({ requestTimeoutMs: 500 }); t.after(() => broker.close());
  const a = await page(broker, 'a');
  const pending = assert.rejects(broker.call(a.sessionId, 'sceneEdit', {}), /outcome may be unknown/);
  const command = await (await a.request('/next')).json();
  await pending;
  assert.equal(broker.list()[0].lastCommand.state, 'uncertain');
  assert.equal((await a.request('/result', { id: command.id, result: { ok: true } })).status, 200);
  const inspect = broker.call(a.sessionId, 'sceneInspect', {});
  const next = await (await a.request('/next')).json();
  assert.notEqual(next.id, command.id); assert.equal(next.method, 'sceneInspect');
  await a.request('/result', { id: next.id, result: { ok: true, revision: 5 } });
  assert.equal((await inspect).revision, 5);
});

test('cancelling an undelivered operation removes it from the queue', async (t) => {
  const broker = await createBroker(); t.after(() => broker.close());
  const a = await page(broker, 'a'), abort = new AbortController();
  const cancelled = assert.rejects(broker.call(a.sessionId, 'sceneEdit', {}, abort.signal), /before dispatch/);
  abort.abort(); await cancelled;
  const read = broker.call(a.sessionId, 'document', {});
  const command = await (await a.request('/next')).json();
  assert.equal(command.method, 'document');
  await a.request('/result', { id: command.id, result: { ok: true } }); await read;
  await a.request('', undefined, 'DELETE');
  assert.equal(broker.list().length, 0);
});
