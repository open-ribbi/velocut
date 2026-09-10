import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fileURLToPath } from 'node:url';
import { toolResult } from '../src/server.mjs';

test('the bundled plugin initializes over stdio and advertises grounded editor tools', async (t) => {
  const entry = fileURLToPath(new URL('../dist/velocut/scripts/server.cjs', import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry, '--stdio'], stderr: 'pipe' });
  const client = new Client({ name: 'velocut-plugin-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of ['velocut_connect', 'velocut_scene_edit', 'velocut_observe', 'velocut_import_model', 'velocut_script']) assert.ok(names.includes(name));
  const paired = await client.callTool({ name: 'velocut_connect', arguments: {} });
  assert.equal(paired.isError, false);
  assert.match(paired.structuredContent.url, /^http:\/\/localhost:5173\/#velocut-codex=/);
  const sessions = await client.callTool({ name: 'velocut_sessions', arguments: {} });
  assert.deepEqual(sessions.structuredContent.sessions, []);
});

test('observations become real MCP image blocks without copying base64 into text', () => {
  const r = toolResult({ ok: true, data: { revision: 3 }, images: [{ mediaType: 'image/png', base64: 'aGVsbG8=' }] });
  assert.deepEqual(r.content[1], { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.ok(!r.content[0].text.includes('aGVsbG8='));
  assert.equal(r.structuredContent.data.revision, 3);
  assert.equal(toolResult({ ok: false, message: 'conflict' }).isError, true);
});

test('the plugin also negotiates the legacy MCP version used by existing clients', async (t) => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const entry = fileURLToPath(new URL('../dist/velocut/scripts/server.cjs', import.meta.url));
  const child = spawn(process.execPath, [entry, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  lines.on('line', (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); });
  const send = (id, method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 5000);
    pending.set(id, (message) => { clearTimeout(timer); pending.delete(id); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  t.after(() => { lines.close(); child.kill(); });
  const initialized = await send(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy-test', version: '1' } });
  assert.equal(initialized.result?.protocolVersion, '2025-11-25');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const listed = await send(2, 'tools/list', {});
  assert.ok(listed.result.tools.some((tool) => tool.name === 'velocut_observe'));
  const called = await send(3, 'tools/call', { name: 'velocut_connect', arguments: {} });
  assert.equal(called.result.isError, false);
  assert.ok(called.result.structuredContent.url);
});
