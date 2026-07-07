// Unit tests for the agent tool-use loop, exercised through an injected
// non-streaming transport (createMessage) — no network, no Anthropic key.
// Run: node --experimental-strip-types --test packages/agent-sdk/test/agent.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgentTurn, type AgentEvent, type AgentHost } from '../src/index.ts';

/** Minimal assistant message factory (only the fields the loop reads). */
function msg(content: Anthropic.ContentBlock[], stopReason: string): Anthropic.Message {
  return { role: 'assistant', content, stop_reason: stopReason } as unknown as Anthropic.Message;
}
const textBlock = (text: string) => ({ type: 'text', text }) as Anthropic.ContentBlock;
const toolBlock = (id: string, name: string, input: unknown) =>
  ({ type: 'tool_use', id, name, input }) as Anthropic.ContentBlock;

/** A transport that replays a fixed script of responses. The loop mutates its
 *  `messages` array in place across iterations, so each call records a
 *  point-in-time snapshot rather than the live reference. */
function scriptedTransport(script: Anthropic.Message[]) {
  let i = 0;
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    createMessage: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
      calls.push({ ...params, messages: [...params.messages] });
      if (i >= script.length) throw new Error('transport script exhausted');
      return script[i++];
    },
  };
}

/** A host that records dispatches and returns canned envelopes. */
function fakeHost(overrides: Partial<AgentHost> = {}) {
  const dispatched: unknown[] = [];
  const host: AgentHost = {
    dispatch(cmd) {
      dispatched.push(cmd);
      return { ok: true, revision: dispatched.length, events: [] };
    },
    document() {
      return { id: 'doc_1', name: 't', width: 16, height: 9, fpsNum: 30, fpsDen: 1, assets: [], tracks: [], nextId: 1 };
    },
    evaluate(timeUs) {
      return { timeUs, width: 16, height: 9, layers: [], audio: [] };
    },
    ...overrides,
  };
  return { host, dispatched };
}

test('a plain text turn produces [user, assistant] and a text event', async () => {
  const t = scriptedTransport([msg([textBlock('Done.')], 'end_turn')]);
  const { host } = fakeHost();
  const events: AgentEvent[] = [];
  const history = await runAgentTurn({
    apiKey: 'unused',
    history: [],
    userText: 'hello',
    host,
    createMessage: t.createMessage,
    onEvent: (e) => events.push(e),
  });
  assert.equal(history.length, 2);
  assert.equal(history[0].role, 'user');
  assert.equal(history[1].role, 'assistant');
  assert.deepEqual(events, [{ kind: 'text', text: 'Done.' }]);
  // System prompt and tools reach the transport on every call.
  assert.ok(t.calls[0].system && t.calls[0].tools!.length > 0);
});

test('velocut_apply dispatches the command and feeds the envelope back as a tool_result', async () => {
  const cmd = { type: 'addTrack', kind: 'video' };
  const t = scriptedTransport([
    msg([toolBlock('tu_1', 'velocut_apply', { command: cmd })], 'tool_use'),
    msg([textBlock('Added.')], 'end_turn'),
  ]);
  const { host, dispatched } = fakeHost();
  const events: AgentEvent[] = [];
  const history = await runAgentTurn({
    apiKey: 'unused',
    history: [],
    userText: 'add a track',
    host,
    createMessage: t.createMessage,
    onEvent: (e) => events.push(e),
  });

  assert.deepEqual(dispatched, [cmd]);
  // user, assistant(tool_use), user(tool_result), assistant(text)
  assert.equal(history.length, 4);
  const results = history[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(results[0].tool_use_id, 'tu_1');
  assert.equal(results[0].is_error, undefined);
  assert.match(results[0].content as string, /"ok":true/);
  // The second request carries the tool_result back to the model.
  assert.equal(t.calls[1].messages.length, 3);
  assert.deepEqual(
    events.map((e) => e.kind),
    ['toolStart', 'tool', 'text'],
  );
});

test('a failed command marks the tool_result as is_error', async () => {
  const t = scriptedTransport([
    msg([toolBlock('tu_1', 'velocut_apply', { command: { type: 'removeClip', clipId: 'nope' } })], 'tool_use'),
    msg([textBlock('Could not.')], 'end_turn'),
  ]);
  const { host } = fakeHost({
    dispatch: () => ({ ok: false, error: { code: 'notFound', message: "clip 'nope' not found" } }),
  });
  const history = await runAgentTurn({
    apiKey: 'unused',
    history: [],
    userText: 'remove it',
    host,
    createMessage: t.createMessage,
  });
  const results = history[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content as string, /notFound/);
});

test('an unwired optional capability degrades to an is_error tool_result, not a throw', async () => {
  const t = scriptedTransport([
    msg([toolBlock('tu_1', 'velocut_tts', { text: 'hi' })], 'tool_use'),
    msg([textBlock('ok')], 'end_turn'),
  ]);
  const { host } = fakeHost(); // no speak()
  const history = await runAgentTurn({
    apiKey: 'unused',
    history: [],
    userText: 'narrate',
    host,
    createMessage: t.createMessage,
  });
  const results = history[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content as string, /not wired/);
});

test('velocut_evaluate rounds fractional timeUs before it reaches the host', async () => {
  const seen: number[] = [];
  const t = scriptedTransport([
    msg([toolBlock('tu_1', 'velocut_evaluate', { timeUs: 1500000.7 })], 'tool_use'),
    msg([textBlock('ok')], 'end_turn'),
  ]);
  const { host } = fakeHost({
    evaluate(timeUs) {
      seen.push(timeUs);
      return { timeUs, width: 16, height: 9, layers: [], audio: [] };
    },
  });
  await runAgentTurn({ apiKey: 'unused', history: [], userText: 'look', host, createMessage: t.createMessage });
  assert.deepEqual(seen, [1500001]);
});

test('observe relays images to the model (blocks) and to the UI (tool event)', async () => {
  const t = scriptedTransport([
    msg([toolBlock('tu_1', 'velocut_observe', { mode: 'frame' })], 'tool_use'),
    msg([textBlock('seen')], 'end_turn'),
  ]);
  const { host } = fakeHost({
    observe: async () => ({
      ok: true,
      summary: 'one frame',
      images: [{ base64: 'QUJD', mediaType: 'image/jpeg' }],
      data: { brightness: 0.5 },
    }),
  });
  const events: AgentEvent[] = [];
  const history = await runAgentTurn({
    apiKey: 'unused',
    history: [],
    userText: 'look',
    host,
    createMessage: t.createMessage,
    onEvent: (e) => events.push(e),
  });
  const results = history[2].content as Anthropic.ToolResultBlockParam[];
  const blocks = results[0].content as Array<{ type: string }>;
  assert.deepEqual(
    blocks.map((b) => b.type),
    ['text', 'image'],
  );
  const toolEvent = events.find((e) => e.kind === 'tool') as Extract<AgentEvent, { kind: 'tool' }>;
  assert.equal(toolEvent.images?.[0].base64, 'QUJD');
  assert.deepEqual(toolEvent.data, { brightness: 0.5 });
});

test('an unknown tool name yields an is_error result instead of crashing the loop', async () => {
  const t = scriptedTransport([
    msg([toolBlock('tu_1', 'velocut_frobnicate', {})], 'tool_use'),
    msg([textBlock('ok')], 'end_turn'),
  ]);
  const { host } = fakeHost();
  const history = await runAgentTurn({ apiKey: 'unused', history: [], userText: 'x', host, createMessage: t.createMessage });
  const results = history[2].content as Anthropic.ToolResultBlockParam[];
  assert.equal(results[0].is_error, true);
  assert.match(results[0].content as string, /unknown tool/);
});

test('maxIterations caps a runaway tool loop', async () => {
  // A transport that ALWAYS asks for another tool call.
  let calls = 0;
  const createMessage = async () => {
    calls++;
    return msg([toolBlock(`tu_${calls}`, 'velocut_get_document', {})], 'tool_use');
  };
  const { host } = fakeHost();
  const history = await runAgentTurn({
    apiKey: 'unused',
    history: [],
    userText: 'loop forever',
    host,
    createMessage,
    maxIterations: 3,
  });
  assert.equal(calls, 3);
  // user + 3 × (assistant + tool_result user)
  assert.equal(history.length, 1 + 3 * 2);
});
