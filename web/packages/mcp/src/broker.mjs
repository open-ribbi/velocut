import { BRIDGE_PROTOCOL_VERSION, SUPPORTED_BRIDGE_PROTOCOLS } from '@velocut/protocol';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const json = (res, status, value) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); } };
async function body(req, limit = 96 * 1024 * 1024) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON content type required');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function metadata(input) {
  if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 128) throw new Error('invalid project identity');
  return { projectId: input.projectId, projectName: String(input.projectName ?? '').slice(0, 256),
    documentName: String(input.documentName ?? '').slice(0, 256), revision: Number.isSafeInteger(input.revision) ? input.revision : 0 };
}

/** One MCP process owns one ephemeral loopback listener. No shared global port,
 * no guessing the foreground page, and no automatic replay of delivered writes. */
export async function createBroker({ requestTimeoutMs = 90_000 } = {}) {
  const pairingKey = secret(), origins = new Set(), sessions = new Map(), jobs = new Map();
  let port;
  const failSession = (s, message) => {
    if (s.poll) { json(s.poll.res, 410, { error: message }); s.poll = null; }
    for (const job of jobs.values()) if (job.session === s) {
      job.finish(new Error(`${message}${job.delivered ? '; outcome may be unknown. Inspect the scene before retrying.' : ''}`)); jobs.delete(job.id);
    }
    sessions.delete(s.id);
  };
  const deliver = (s) => {
    if (!s.poll || s.inflight) return;
    let job;
    while (s.queue.length && !job) { const candidate = jobs.get(s.queue.shift()); if (candidate && !candidate.settled) job = candidate; }
    if (!job) return;
    const poll = s.poll; s.poll = null; clearTimeout(poll.timer);
    if (poll.res.destroyed) { s.queue.unshift(job.id); return; }
    job.delivered = true; s.inflight = job.id;
    s.lastCommand = { id: job.id, method: job.method, state: 'running' };
    json(poll.res, 200, { id: job.id, method: job.method, args: job.args });
  };
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.host !== `127.0.0.1:${port}`) return json(res, 403, { error: 'invalid host' });
      const origin = req.headers.origin;
      if (!origin || !origins.has(origin)) return json(res, 403, { error: 'origin is not paired' });
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204); return res.end();
      }
      const key = req.headers.authorization?.replace(/^Bearer /, '');
      if (req.url === '/register' && req.method === 'POST') {
        if (!equal(key, pairingKey)) return json(res, 401, { error: 'invalid pairing token' });
        if (sessions.size >= 12) return json(res, 429, { error: 'too many connected pages' });
        const registration = await body(req, 16_384);
        const supported = registration?.protocolVersions ?? [1];
        if (!Array.isArray(supported)) return json(res, 400, { error: 'invalid protocol versions' });
        const protocol = SUPPORTED_BRIDGE_PROTOCOLS.find(version => supported.includes(version));
        if (!protocol) return json(res, 409, { error: `incompatible editor protocol; MCP supports ${SUPPORTED_BRIDGE_PROTOCOLS.join(', ')}` });
        const info = metadata(registration);
        const session = { id: randomUUID(), key: secret(), origin, ...info, queue: [], poll: null, inflight: null, lastSeen: Date.now(), lastCommand: null };
        sessions.set(session.id, session);
        return json(res, 200, { sessionId: session.id, sessionKey: session.key, protocol, serverProtocol: BRIDGE_PROTOCOL_VERSION });
      }
      const match = /^\/sessions\/([a-f0-9-]+)(?:\/(next|result|ping))?$/.exec(req.url ?? '');
      const s = match && sessions.get(match[1]);
      if (!s || s.origin !== origin || !equal(key, s.key)) return json(res, 401, { error: 'session is disconnected or unauthenticated' });
      s.lastSeen = Date.now();
      if (req.method === 'DELETE' && !match[2]) { failSession(s, 'page disconnected'); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && match[2] === 'ping') {
        const info = metadata(await body(req, 16_384));
        if (info.projectId !== s.projectId) { failSession(s, 'project changed'); return json(res, 409, { error: 'project changed; pair the new page' }); }
        Object.assign(s, info); return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && match[2] === 'next') {
        if (s.poll) return json(res, 409, { error: 'a poll is already active' });
        const poll = { res, timer: setTimeout(() => { if (s.poll === poll) s.poll = null; json(res, 200, { idle: true }); }, 20_000) };
        s.poll = poll;
        res.on('close', () => { clearTimeout(poll.timer); if (s.poll === poll) s.poll = null; });
        return deliver(s);
      }
      if (req.method === 'POST' && match[2] === 'result') {
        const reply = await body(req);
        const job = jobs.get(reply.id);
        if (!job || job.session !== s || !job.delivered || s.inflight !== job.id) return json(res, 409, { error: 'unknown or already completed request' });
        s.inflight = null;
        s.lastCommand = { id: job.id, method: job.method, state: 'done', ok: reply.result?.ok !== false && !reply.error };
        job.finish(reply.error ? new Error(String(reply.error).slice(0, 2000)) : null, reply.result);
        jobs.delete(job.id); json(res, 200, { ok: true }); deliver(s); return;
      }
      json(res, 404, { error: 'unknown bridge endpoint' });
    } catch (e) { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  port = server.address().port;
  const interval = setInterval(() => {
    for (const s of sessions.values()) if (Date.now() - s.lastSeen > 65_000) failSession(s, 'page heartbeat expired');
  }, 15_000);
  interval.unref();
  return {
    url: `http://127.0.0.1:${port}`,
    connect(editorUrl = 'http://localhost:5173') {
      const url = new URL(editorUrl);
      if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('the local plugin connects only to an HTTP loopback Velocut editor');
      origins.add(url.origin);
      const hash = new URLSearchParams(url.hash.slice(1));
      hash.set('velocut-codex', `${port}.${pairingKey}`); url.hash = hash.toString();
      return { ok: true, url: url.href, instructions: 'Open this URL in a browser. Then list sessions and explicitly pass the intended sessionId to every tool. This URL contains a temporary local pairing capability.' };
    },
    list() { return [...sessions.values()].map(({ id, projectId, projectName, documentName, revision, lastSeen, lastCommand }) => ({ sessionId: id, projectId, projectName, documentName, revision, connected: Date.now() - lastSeen < 30_000, lastCommand })); },
    call(sessionId, method, args, signal) {
      const s = sessions.get(sessionId);
      if (!s || Date.now() - s.lastSeen > 30_000) return Promise.reject(new Error('page is not connected; use velocut_connect and list sessions'));
      if (s.queue.length >= 8) return Promise.reject(new Error('too many pending commands for this page'));
      if (signal?.aborted) return Promise.reject(new Error('cancelled before dispatch'));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const job = { id, session: s, method, args, delivered: false, settled: false, finish: null };
        const abort = () => job.finish(new Error(job.delivered ? 'request cancelled after delivery; outcome may be unknown. Inspect before retrying.' : 'cancelled before dispatch'));
        const timer = setTimeout(() => job.finish(new Error(job.delivered ? 'page response timed out; outcome may be unknown. Inspect before retrying.' : 'page did not receive the command; reconnect before retrying')), requestTimeoutMs);
        job.finish = (error, result) => {
          if (job.settled) return;
          job.settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (!job.delivered) { s.queue = s.queue.filter((v) => v !== id); jobs.delete(id); }
          if (error) { s.lastCommand = { id, method, state: job.delivered ? 'uncertain' : 'cancelled' }; reject(error); }
          else resolve(result);
        };
        signal?.addEventListener('abort', abort, { once: true });
        jobs.set(id, job); s.queue.push(id); deliver(s);
      });
    },
    async close() {
      clearInterval(interval);
      for (const s of [...sessions.values()]) failSession(s, 'MCP server stopped');
      server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    },
  };
}
