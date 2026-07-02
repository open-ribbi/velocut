// services/script.ts — host-side execution of velocut_script programs.
//
// This is the velocut analog of "write a shell script, run it once": the agent
// emits a JS editing program, and the HOST runs it here, in the browser realm
// where the runtime (engine / media / WebGPU / TTS) lives. agent-sdk never evals
// anything — it only forwards the code string to host.runScript — so the seam
// stays RPC-clean: when the agent loop moves to a backend, this same function is
// reached over RPC (or via a connected-browser stub) unchanged.
//
// Security: the program runs in the main page realm with full `velocut` access.
// That is the SAME trust boundary the agent already has (it can dispatch any
// command); the script just collapses many round-trips into one. Multi-tenant
// productization should move this behind an iframe/worker sandbox with a
// capability-whitelisted postMessage bridge — that's a swap of THIS function's
// body, not of the interface.

import type { ScriptResult } from '@velocut/agent-sdk';

/** The `velocut` surface a script program runs against. Every method is
 *  JSON-in / JSON-out so a program (and its result) crosses an RPC boundary
 *  unchanged. The app wires these to the same Store/media/observer/tts the UI
 *  and the discrete agent tools use. */
export interface ScriptApi {
  /** Execute one protocol command; returns the engine envelope (events carry
   *  freshly-minted ids). Synchronous, same path as velocut_apply. */
  apply(cmd: unknown): unknown;
  /** Synthesize one narration clip onto the 旁白 track; resolves with the exact
   *  duration so the program can size the matching shot/subtitle. */
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
  /** Build a procedural canvas-animation clip (GSAP timing spine + 2D-canvas draw)
   *  and lay it on a 图形 track. Unlike the JSON-in/out methods this takes draw/build
   *  FUNCTIONS — but they're created INSIDE the script's own browser realm (it's the
   *  code STRING that crosses RPC, not these closures), so the RPC-clean seam holds at
   *  the code-string level. Resolves with {ok, assetId, clipId, trackId, frameCount}. */
  motionClip(opts: unknown): Promise<unknown>;
}

/** Best-effort JSON projection — a program's return value must survive an RPC
 *  hop, so strip anything non-serializable rather than throwing. */
function jsonSafe(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v ?? null));
  } catch {
    return String(v);
  }
}

function fmt(args: unknown[]): string {
  return args
    .map((x) => {
      if (typeof x === 'string') return x;
      try {
        return JSON.stringify(x);
      } catch {
        return String(x);
      }
    })
    .join(' ');
}

/**
 * Run an editing program against the velocut API. Top-level `await` works; the
 * program returns a JSON-serializable value (surfaced to the model) and its
 * console output is captured. Errors come back as message+stack so the agent
 * fixes and re-runs — the same loop it uses for a rejected command.
 */
export async function runAgentScript(api: ScriptApi, code: string): Promise<ScriptResult> {
  const logs: string[] = [];
  const cappedConsole = {
    log: (...a: unknown[]) => void (logs.length < 200 && logs.push(fmt(a))),
    warn: (...a: unknown[]) => void (logs.length < 200 && logs.push('warn: ' + fmt(a))),
    error: (...a: unknown[]) => void (logs.length < 200 && logs.push('error: ' + fmt(a))),
    info: (...a: unknown[]) => void (logs.length < 200 && logs.push(fmt(a))),
  };
  try {
    // Async IIFE wrapper so the program can use top-level await; `velocut` and a
    // captured `console` are the only injected globals.
    const fn = new Function('velocut', 'console', `"use strict"; return (async () => {\n${code}\n})();`);
    const result = await fn(api, cappedConsole);
    return { ok: true, result: jsonSafe(result), logs };
  } catch (e) {
    const error = e instanceof Error ? e.stack || e.message : String(e);
    return { ok: false, error, logs };
  }
}
