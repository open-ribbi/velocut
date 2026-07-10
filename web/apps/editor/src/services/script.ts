// services/script.ts — host-side execution of velocut_script programs.
//
// This is the velocut analog of "write a shell script, run it once": the agent
// emits a JS editing program, and the HOST runs it — but NOT in the main page
// realm. The program runs inside a throwaway, null-origin sandboxed <iframe>
// (sandbox="allow-scripts", no allow-same-origin) whose srcdoc carries a CSP of
// `connect-src 'none'`. That realm therefore CANNOT:
//   • read localStorage (opaque origin has no storage) — the Anthropic key is safe
//   • fetch / XHR / WebSocket / sendBeacon / EventSource — CSP blocks the network
//   • touch the parent page DOM, cookies, or window.velocut (cross-origin)
// The only thing it can do is call the whitelisted ScriptApi below, which reaches
// the host over a MessageChannel. So a prompt-injected program can drive editing
// but cannot exfiltrate anything. See SECURITY.md.
//
// agent-sdk never evals anything — it forwards the code string to host.runScript
// — so the RPC-clean seam holds: when the agent loop moves to a backend, the
// host still runs the program in whatever sandbox it owns.

import type { ScriptResult } from '@velocut/agent-sdk';

/** The `velocut` surface a script program runs against. Every method is
 *  JSON-in / JSON-out so a program (and its result) crosses the sandbox RPC
 *  boundary unchanged. The app wires these to the same Store/media/observer/tts
 *  the UI and the discrete agent tools use.
 *
 *  NOTE: inside the sandbox every method returns a Promise (it's an RPC hop),
 *  so a program must `await` any call whose return value it reads. Fire-and-
 *  forget (`velocut.apply(cmd)` without await) still executes in order because
 *  the channel preserves message order and the host processes RPCs serially. */
export interface ScriptApi {
  /** Execute one protocol command; returns the engine envelope (events carry
   *  freshly-minted ids). Same path as velocut_apply. */
  apply(cmd: unknown): unknown;
  /** Synthesize one narration clip onto the Narration track; resolves with the
   *  exact duration so the program can size the matching shot/subtitle. */
  tts(opts: { text: string; atUs?: number; trackId?: string; language?: string }): Promise<unknown>;
  /** Render-and-measure; the program gets numbers (no images — there's no model
   *  in the loop to look at them). */
  observe(input: Record<string, unknown>): Promise<{ ok: boolean; summary: string; data?: unknown }>;
  /** Evaluate the composite at a time (FrameGraph). */
  evaluate(timeUs: number): unknown;
  /** Read the full document. */
  document(): unknown;
  /** Move the preview playhead (cosmetic; lets a program leave the UI on a spot). */
  seek(timeUs: number): void;
  /** Create a procedural motion-graphics clip from a declarative spec ({spec, atUs?,
   *  trackId?, name?}). The spec is pure JSON (layers with keyframed transforms), so
   *  it crosses the sandbox boundary as data and nothing is eval'd on the host. */
  motionClip(opts: unknown): Promise<unknown>;
  /** Create a declarative 3D scene clip ({spec, atUs?, trackId?, name?}) — the
   *  Scene Director surface. Same pure-JSON contract as motionClip. */
  sceneClip(opts: unknown): Promise<unknown>;
  /** Discover the 3D asset registry (character models + their animation clips,
   *  environments, lighting, props) — the grounded vocabulary for sceneClip. */
  sceneAssets(): Promise<unknown>;
  /** Generate an AI video clip via a CONFIGURED channel and land it on the
   *  timeline. The sandbox may name a channel id + model + prompt only — the
   *  host resolves endpoint/key from configuration, and reference-URL options
   *  are rejected on this path (see main.tsx). Costs real credits. */
  videoGen(opts: unknown): Promise<unknown>;
  /** Discover configured video-gen channels: [{id, label, models, defaultModel}]
   *  — no endpoints, no keys. */
  videoGenChannels(): unknown;
  /** Render the composite at a time and upload it to the user-configured
   *  store. Returns an OPAQUE {handle: 'upload://…'} usable in videoGen
   *  reference fields — the real URL never crosses into the sandbox. */
  uploadFrame(opts: unknown): Promise<unknown>;
  /** Render ONE clip in isolation to an mp4 (≤ the provider reference budget)
   *  and upload it — the previz-as-reference-video path. Same handle contract. */
  uploadClip(opts: unknown): Promise<unknown>;
  /** Upload an imported IMAGE asset's original file (character photos → the
   *  reference-images field). Same handle contract; video assets are refused. */
  uploadAsset(opts: unknown): Promise<unknown>;
}

/** RPC method names the sandbox may call. motionClip is included: it now takes a
 *  declarative JSON spec (no functions), so it structured-clones cleanly and the
 *  host renders it with a fixed interpreter — no eval. */
const RPC_METHODS = ['apply', 'tts', 'observe', 'evaluate', 'document', 'seek', 'motionClip', 'sceneClip', 'sceneAssets', 'videoGen', 'videoGenChannels', 'uploadFrame', 'uploadClip', 'uploadAsset'] as const;

// Wall-clock cap on SANDBOX-side compute: kills runaway loops / stuck awaits.
// Time spent inside a host RPC doesn't count (the clock pauses while the host
// runs trusted code) — otherwise any videoGen call (minutes of provider-side
// rendering) would kill the program that awaits it. Loops that spam cheap
// RPCs to stay alive are bounded separately by RPC_LIMIT.
const SCRIPT_TIMEOUT_MS = 60_000;

/** The program that runs INSIDE the sandboxed iframe. Authored as a string so it
 *  can be inlined into srcdoc. It builds the `velocut` proxy (each method posts an
 *  RPC over the port and awaits the reply), captures console, runs the agent code
 *  via `new Function` (safe here: this realm has no storage/network/DOM), and
 *  posts the final result back. It never sees the host's real API. */
const SANDBOX_RUNTIME = `
(function () {
  'use strict';
  // Defense-in-depth: CSP connect-src 'none' is the primary network lock, but
  // meta-delivered CSP has browser-specific gaps (observed: sendBeacon returns
  // true, WebSocket constructs without throwing). So we also neutralize every
  // network-capable global BEFORE any user code runs — the native references
  // become unreachable, so a program can't recover them.
  var blocked = function () { throw new Error('network access is blocked in the velocut sandbox'); };
  ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'importScripts', 'Request', 'Response'].forEach(function (k) {
    try { Object.defineProperty(self, k, { value: blocked, writable: false, configurable: false }); } catch (e) { try { self[k] = blocked; } catch (e2) {} }
  });
  try { Object.defineProperty(navigator, 'sendBeacon', { value: function () { return false; }, writable: false, configurable: false }); } catch (e) {}

  var RPC = ${JSON.stringify(RPC_METHODS)};
  var port = null;
  var seq = 0;
  var pending = Object.create(null);
  var logs = [];
  function cap(a) { if (logs.length < 200) logs.push(a); }
  function fmt(args) {
    return Array.prototype.map.call(args, function (x) {
      if (typeof x === 'string') return x;
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    }).join(' ');
  }
  var con = {
    log: function () { cap(fmt(arguments)); },
    info: function () { cap(fmt(arguments)); },
    warn: function () { cap('warn: ' + fmt(arguments)); },
    error: function () { cap('error: ' + fmt(arguments)); },
  };
  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      port.postMessage({ t: 'rpc', id: id, method: method, args: args });
    });
  }
  var velocut = {};
  RPC.forEach(function (m) { velocut[m] = function () { return rpc(m, Array.prototype.slice.call(arguments)); }; });
  function jsonSafe(v) { try { return JSON.parse(JSON.stringify(v == null ? null : v)); } catch (e) { return String(v); } }
  function onPortMessage(ev) {
    var d = ev.data || {};
    if (d.t === 'rpcResult') {
      var p = pending[d.id];
      if (!p) return;
      delete pending[d.id];
      if (d.ok) p.resolve(d.value); else p.reject(new Error(d.error || 'RPC failed'));
    } else if (d.t === 'code') {
      run(d.code);
    }
  }
  function run(code) {
    (async function () {
      try {
        var fn = new Function('velocut', 'console', '"use strict"; return (async () => {\\n' + code + '\\n})();');
        var result = await fn(velocut, con);
        port.postMessage({ t: 'done', ok: true, result: jsonSafe(result), logs: logs });
      } catch (e) {
        var err = (e && e.stack) ? e.stack : String(e);
        port.postMessage({ t: 'done', ok: false, error: err, logs: logs });
      }
    })();
  }
  // Parent hands us the MessageChannel port via the first window message.
  window.addEventListener('message', function initPort(ev) {
    if (!ev.data || ev.data.t !== 'port' || !ev.ports || !ev.ports[0]) return;
    window.removeEventListener('message', initPort);
    port = ev.ports[0];
    port.onmessage = onPortMessage;
    port.postMessage({ t: 'ready' });
  });
})();
`;

function srcdoc(): string {
  // CSP: deny everything, allow only inline+eval SCRIPT (the runtime + the agent's
  // new Function). connect-src 'none' is the load-bearing line — it blocks fetch,
  // XHR, WebSocket, sendBeacon, EventSource, and dynamic import() at the browser
  // layer (not whack-a-mole global overrides).
  const csp =
    "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src 'none'; style-src 'none'; base-uri 'none'; form-action 'none'";
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<script>${SANDBOX_RUNTIME}<\/script></head><body></body></html>`
  );
}

function jsonSafe(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}

/**
 * Run an editing program against the velocut API inside a null-origin, no-network
 * sandbox. Top-level `await` works; the program returns a JSON-serializable value
 * (surfaced to the model) and its console output is captured. Errors come back as
 * message+stack so the agent fixes and re-runs. A wall-clock timeout kills runaway
 * programs. The iframe is created fresh per run and torn down on completion, so no
 * state leaks between runs.
 */
export function runAgentScript(api: ScriptApi, code: string): Promise<ScriptResult> {
  return new Promise<ScriptResult>((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts'); // NO allow-same-origin → opaque origin
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.display = 'none';
    iframe.srcdoc = srcdoc();

    const channel = new MessageChannel();
    const hostPort = channel.port1;
    let settled = false;
    let queue: Promise<void> = Promise.resolve();

    const cleanup = () => {
      clearTimeout(timer);
      hostPort.onmessage = null;
      hostPort.close();
      iframe.remove();
    };
    const finish = (r: ScriptResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    // Pausable sandbox clock: the timer runs only while the SANDBOX holds the
    // ball. It stops when an RPC reaches the host and restarts (with the
    // remaining budget) when the result is posted back.
    let remainingMs = SCRIPT_TIMEOUT_MS;
    let timerStarted = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopClock = () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remainingMs = Math.max(0, remainingMs - (Date.now() - timerStarted));
    };
    const startClock = () => {
      if (settled || timer !== undefined) return;
      timerStarted = Date.now();
      timer = setTimeout(() => {
        finish({ ok: false, error: `Script timed out (>${SCRIPT_TIMEOUT_MS / 1000}s of sandbox compute) and was aborted.` });
      }, remainingMs);
    };
    startClock();

    // Cap total RPC calls per run: a tight loop hammering observe/tts (each a heavy
    // decode / synth on the host) is a bounded CPU-DoS. A ceiling well above any
    // real program stops it cold. apply's persistent effect is already bounded by
    // the history ring buffer.
    let rpcCount = 0;
    const RPC_LIMIT = 5000;

    // Host side of the channel: serve each whitelisted RPC on the REAL api, one at
    // a time (serial) so side-effect ordering matches the program's call order
    // regardless of which methods are sync vs async.
    hostPort.onmessage = (ev: MessageEvent) => {
      const d = ev.data as { t?: string; id?: number; method?: string; args?: unknown[]; ok?: boolean; result?: unknown; error?: string; logs?: string[] };
      if (d?.t === 'ready') {
        hostPort.postMessage({ t: 'code', code });
        return;
      }
      if (d?.t === 'done') {
        finish(d.ok ? { ok: true, result: d.result, logs: d.logs } : { ok: false, error: d.error, logs: d.logs });
        return;
      }
      if (d?.t === 'rpc') {
        const { id, method, args } = d;
        queue = queue.then(async () => {
          if (settled) return;
          stopClock(); // host is doing the work now — don't bill the sandbox
          try {
            if (++rpcCount > RPC_LIMIT) {
              finish({ ok: false, error: `Script exceeded the API call limit (${RPC_LIMIT}) and was aborted.` });
              return;
            }
            if (!method || !(RPC_METHODS as readonly string[]).includes(method)) {
              throw new Error(`unknown script API: ${method}`);
            }
            const fn = api[method as (typeof RPC_METHODS)[number]] as (...a: unknown[]) => unknown;
            const value = await fn.apply(api, args ?? []);
            hostPort.postMessage({ t: 'rpcResult', id, ok: true, value: jsonSafe(value) });
          } catch (e) {
            hostPort.postMessage({ t: 'rpcResult', id, ok: false, error: e instanceof Error ? e.message : String(e) });
          } finally {
            startClock();
          }
        });
      }
    };

    iframe.addEventListener('load', () => {
      // Deliver the channel port to the opaque-origin iframe. Target must be '*'
      // (its origin is null); this single handshake message carries no secrets.
      iframe.contentWindow?.postMessage({ t: 'port' }, '*', [channel.port2]);
    });

    document.body.appendChild(iframe);
  });
}
