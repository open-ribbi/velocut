// @velocut/agent-sdk — the LLM editing agent.
//
// "AI edits the same way you do": the agent's tools call the SAME dispatch /
// document / evaluate surface that UI gestures and window.velocut use — one
// command language, one validation path, one undo history.
//
// The loop is a manual tool-use loop over the Anthropic Messages API
// (browser-direct via the official SDK). The transport is injectable so the
// loop is testable without network access.

import Anthropic from '@anthropic-ai/sdk';
import type { Command, Envelope, FrameGraph, TimeUs, VDocument } from '@velocut/protocol';
import { SYSTEM_PROMPT } from './protocol-prompt.ts';

export { SYSTEM_PROMPT };

/** Result of an auto-caption run, surfaced back to the model. */
export interface CaptionResult {
  ok: boolean;
  trackId?: string;
  count?: number;
  message?: string;
}

/** Result of a TTS narration synthesis, surfaced back to the model. */
export interface SpeakResult {
  ok: boolean;
  clipId?: string;
  trackId?: string;
  durationUs?: number;
  atUs?: number;
  message?: string;
}

/** Result of a perception (observe) call: a text digest the model reads, plus
 *  zero or more images fed to its vision, plus structured data. The app layer
 *  (which owns the renderer + document) produces this; agent-sdk only relays it
 *  into the tool_result as text + image content blocks. */
export interface ObserveResult {
  ok: boolean;
  summary: string;
  images: { base64: string; mediaType: string }[];
  data?: unknown;
  message?: string;
}

/** Result of running an editing program (velocut_script): a JSON-serializable
 *  return value, captured console output, and an error+stack on failure. Kept
 *  JSON-only so the whole thing crosses an RPC boundary unchanged when the agent
 *  loop moves to a backend (the script runs wherever the runtime lives). */
export interface ScriptResult {
  ok: boolean;
  result?: unknown;
  logs?: string[];
  error?: string;
}

/** Result of a web research call (velocut_search): a cited answer the model
 *  reads, plus the sources behind it. JSON-only → RPC-clean. */
export interface SearchResult {
  ok: boolean;
  answer: string;
  sources: { title: string; url: string }[];
  message?: string;
}

/** What the agent needs from the editor — the Store (+ media) satisfies this.
 *  Every method is JSON-in/JSON-out and may be sync OR async: the in-process
 *  browser host returns synchronously; an RPC host (agent loop on a backend,
 *  runtime in the user's browser) returns promises. The loop awaits either way,
 *  so the SAME agent-sdk runs in-process today and over RPC unchanged. */
export interface AgentHost {
  dispatch(cmd: Command): Envelope | Promise<Envelope>;
  document(): VDocument | Promise<VDocument>;
  evaluate(timeUs: TimeUs): FrameGraph | Promise<FrameGraph>;
  /** Speech → caption track. Optional so the loop degrades gracefully when no
   *  transcriber is wired (the tool then reports it's unavailable). The host
   *  owns ASR + caption layout so agent-sdk stays free of the render layer. */
  caption?(opts: {
    assetId?: string;
    fontSize?: number;
    color?: string;
    /** Whisper language hint, e.g. 'chinese' | 'english'. Undefined = auto. */
    language?: string;
  }): Promise<CaptionResult>;
  /** Perception: render-and-see. The host renders the composite (or a clip /
   *  raw asset), measures it, and returns images + metrics. Params are opaque
   *  here — the app owns the observe schema. Optional so the loop degrades when
   *  no renderer is wired. */
  observe?(input: Record<string, unknown>): Promise<ObserveResult>;
  /** Generate spoken narration from text and lay it down as an audio clip.
   *  The engine knows the clip's exact duration, so sync is structural. Optional
   *  so the loop degrades when no TTS is wired. */
  speak?(opts: { text: string; atUs?: number; trackId?: string; language?: string }): Promise<SpeakResult>;
  /** Run an editing PROGRAM (JS) against the velocut API in one call — the
   *  general "write a script, run it once" primitive (velocut's analog of a
   *  shell loop). The host owns execution: it evals the code in the runtime
   *  realm (the browser today; an RPC stub to the browser when the loop runs on
   *  a backend) with a `velocut` API in scope, and returns JSON. agent-sdk only
   *  forwards the code string — it never evals anything itself, so the seam
   *  stays RPC-clean. Optional so the loop degrades when no runtime is wired. */
  runScript?(code: string): Promise<ScriptResult>;
  /** Web research: returns a cited answer + sources. Lets the agent verify facts
   *  (names, plot order, what's famous) before editing, instead of trusting
   *  training memory. The host owns the call (a proxied grounded search today),
   *  JSON in/out → RPC-clean. Optional so the loop degrades when no search wired. */
  search?(query: string): Promise<SearchResult>;
}

/** Progress events surfaced to the chat UI as the loop runs.
 *  text/tool are the non-streaming whole-block events (kept for the fallback
 *  transport); the *Start/*Delta/error events drive incremental streaming UI.
 *  All are plain JSON, so onEvent stays an RPC-clean loop→UI progress channel. */
export type AgentEvent =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      name: string;
      input: unknown;
      ok: boolean;
      detail: string;
      /** observe only: the SAME images & structured data the model received, so
       *  the chat UI can show the human what the agent looked at (base64 strings
       *  + plain JSON → onEvent stays RPC-clean). Absent for other tools. */
      images?: { base64: string; mediaType: string }[];
      data?: unknown;
    }
  | { kind: 'textStart' }
  | { kind: 'textDelta'; delta: string }
  | { kind: 'thinkingStart' }
  | { kind: 'thinkingDelta'; delta: string }
  | { kind: 'toolStart'; name: string; input: unknown }
  | { kind: 'error'; message: string };

/** The MessageStream returned by client.messages.stream() — derived from the
 *  SDK type (it isn't re-exported at the package root) so the loop depends only
 *  on its on('streamEvent')/finalMessage() surface, not an internal path. */
export type AgentMessageStream = ReturnType<InstanceType<typeof Anthropic>['messages']['stream']>;

export interface AgentTurnOptions {
  /** Key for the default transport. With auth = 'bearer' it is sent as
   *  `Authorization: Bearer`; otherwise as Anthropic's native `x-api-key`. */
  apiKey: string;
  /** Anthropic-protocol endpoint root. Defaults to the official API; point it
   *  at any protocol-compatible relay/gateway (LiteLLM, one-api, a corporate
   *  proxy) to route the agent elsewhere. Ignored when a transport is injected. */
  baseURL?: string;
  auth?: 'x-api-key' | 'bearer';
  model?: string;
  /** Prior conversation (user/assistant turns incl. tool blocks). */
  history: Anthropic.MessageParam[];
  userText: string;
  host: AgentHost;
  /** Extra guidance appended to the system prompt — e.g. the render-sdk effect
   *  registry's docs, so new effects are documented without touching agent-sdk. */
  systemExtra?: string;
  onEvent?: (e: AgentEvent) => void;
  /** Non-streaming transport (injectable for tests; defaults to the Anthropic SDK
   *  when no streaming transport is wired). */
  createMessage?: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  /** Streaming transport (optional). When present, the loop streams: it relays
   *  text/thinking deltas to onEvent and awaits finalMessage() for the complete
   *  content fed back into the tool loop. Both the real-key path
   *  (client.messages.stream) and the dev path (an Anthropic client pointed at
   *  the /llm-proxy SSE) return this same MessageStream, so the loop is
   *  transport- and backend-agnostic (RPC-clean). Omit → falls back to
   *  createMessage. */
  createStream?: (params: Anthropic.MessageStreamParams) => AgentMessageStream;
  maxIterations?: number;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'velocut_apply',
    description:
      'Apply one editing command to the document (or an atomic batch via type:"batch"). Returns the engine envelope: on success it carries revision and events (freshly minted ids are in there); on failure, an error code and reason.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'object',
          description: 'Velocut protocol command JSON, e.g. {"type":"splitClip","clipId":"clip_1","atUs":1500000}',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'velocut_get_document',
    description: 'Read the full project document (tracks, clips, assets, nextId, duration). Take a look before making changes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'velocut_evaluate',
    description: 'Evaluate the composite manifest FrameGraph (layered picture + audio slices) at a given time, to understand what is on screen at that moment.',
    input_schema: {
      type: 'object',
      properties: { timeUs: { type: 'number', description: 'Time in microseconds' } },
      required: ['timeUs'],
    },
  },
  {
    name: 'velocut_observe',
    description:
      'See and measure the picture (render-and-see): returns actually rendered composite frame images + numeric readings (brightness/contrast/color temperature/sharpness/vibrance, audio loudness). This is your eyes and ears — look before you act, look again after you change, and decide from the actual picture instead of reading structure alone.\n' +
      'mode:"frame" looks at one instant (returns 1 image + metrics); "contact" is a thumbnail grid (by default one cell per video clip as a storyboard, or sampled across the full duration of source.assetId — used to map a long asset\'s scenes onto a timeline); "scan" returns a metrics-only timeline (per-window loudness/brightness/likely shot-change score), no images, for roughly locating silence gaps, the loudest highlights, and shot cut points; "audio" runs a **fine-grained** (~21ms) analysis of source.assetId\'s raw audio over [from,to], returning precise silence **segments** {startUs,endUs} (clean cut points / dialogue gaps — cut at a segment midpoint so no line gets clipped) and energy **peaks/onsets** (beat matching / locating highlight starts), no images — use scan for coarse localization first, then audio to refine cut points within that window.\n' +
      '"shots" performs whole-video **shot segmentation** on a video asset (pass {assetId} or {clipId} in source; omitted = first video): returns a list of shot boundaries (each {index,startUs,endUs,keyUs}, all in source time) + a frame-difference curve, no images. Use it to **reason shot by shot** — align cuts/inserts to real cut points (never cut mid-shot), pace by shot length (speed up or trim long shots), and locate "that particular shot". Far more precise than scan\'s coarse shot-change score; the first run is one forward decode (seconds), and results are cached per asset so you can reference them repeatedly.\n' +
      'Omit source = look at the composite the user sees; {clipId} looks at one clip in isolation; {assetId} looks at the asset\'s raw content (ignoring the timeline).\n' +
      'metricsOnly:true returns metrics without images (cheap; for the "tweak a parameter → read a number → tweak again" optimization loop). Survey with contact/scan first, then inspect closely with frame; when a number can decide, skip the image.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['frame', 'contact', 'scan', 'audio', 'shots'], description: 'Observation mode, default frame' },
        source: {
          type: 'object',
          description: 'What to look at; omitted = the composite',
          properties: {
            clipId: { type: 'string', description: 'Look at this clip only (isolated from the composite)' },
            assetId: { type: 'string', description: "Look at the asset's raw content; at/from/to are source times" },
          },
        },
        at: { type: 'number', description: 'frame: the instant to observe (microseconds). Timeline time for the composite, source time with assetId' },
        from: { type: 'number', description: 'Start of the contact/scan range (microseconds)' },
        to: { type: 'number', description: 'End of the contact/scan range (microseconds)' },
        count: { type: 'number', description: 'Number of contact sample cells (≤24) / scan windows (≤120)' },
        resolution: { type: 'string', enum: ['thumb', 'preview', 'full'], description: 'Resolution; defaults: frame=preview, contact=thumb; use full only when scrutinizing fine detail' },
        region: {
          type: 'object',
          description: 'frame: normalized crop 0~1, zoom into a region (e.g. checking whether a face or a subtitle is sharp)',
          properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } },
        },
        metricsOnly: { type: 'boolean', description: 'Return metrics only, no images (optimization loop)' },
      },
    },
  },
  {
    name: 'velocut_tts',
    description:
      'Generate narration voice-over: synthesize one line of narration text into speech and lay it down as an audio clip on the "Narration" track. The engine knows the exact duration of the audio (returns durationUs), so audio-visual sync is structural — you never need to align by hand.\n' +
      'When atUs is omitted, the clip is appended at the end of the Narration track (call once per line and they line up in order). Pass language as "chinese"/"english" to match the text. The first run downloads the voice model (tens of seconds). Returns clipId / durationUs / atUs.\n' +
      'This is "creation", not "trimming" — for a recap/commentary video, first study the footage (observe) and write the script, then generate narration line by line with velocut_tts, place the shots (clips trimmed from the original) at the matching narration times, and add subtitles with addTextClip.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The narration text for this line' },
        atUs: { type: 'number', description: 'Placement start (microseconds); omitted = appended at the end of the Narration track' },
        trackId: { type: 'string', description: 'Target audio track; omitted = automatically use/create the "Narration" track' },
        language: { type: 'string', description: 'Text language: "chinese" / "english"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'velocut_transcribe',
    description:
      'Automatic speech-to-subtitles: transcribes the speech in an asset and generates a "Captions" text track (bottom-centered, one text clip per sentence, all normal re-editable text). When assetId is omitted, the first asset with audio is picked automatically. The first run downloads the speech model and may take tens of seconds. Returns the generated track id and the subtitle count.',
    input_schema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset id; omitted = the first asset with audio is picked automatically' },
        fontSize: { type: 'number', description: 'Font size (pixels); omitted = adapts to the frame height' },
        color: { type: 'string', description: 'Text color #RRGGBB, default white' },
        language: {
          type: 'string',
          description:
            "Language of the speech, so recognition outputs that language (otherwise it auto-detects, and Chinese is often mis-transcribed as English). Pass 'chinese' for Chinese audio, 'english' for English.",
        },
      },
    },
  },
  {
    name: 'velocut_search',
    description:
      'Grounded web search: given a question, returns a cited answer + a sources list. Use it to verify facts before acting — people/character names, plot order, who is who, which scene is the famous one, proper nouns, release/version info — instead of writing from training memory (especially for recap/commentary videos, where a narration getting a fact wrong is fatal).\n' +
      'In the planning phase of a long-to-short cut: understand the footage with observe + verify plot facts with velocut_search, and only write the script after combining both. Make the question as specific as possible (include the title/version/episode). Returns {answer, sources}.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The question to verify; as specific as possible (include qualifiers like title/version/episode)' } },
      required: ['query'],
    },
  },
  {
    name: 'velocut_script',
    description:
      'Run an editing program (JavaScript) — complete many editing steps in a single call, i.e. "write a script and run it once". This is your workhorse for batch tasks of dozens of units (long-to-short cuts, mashups, bulk speed changes, beat-synced cutting): instead of dozens of single-step tool calls, plan first with velocut_get_document/velocut_observe, then lay everything down with one script.\n' +
      'Inside the script you can await the global velocut API:\n' +
      '• velocut.apply(cmd) → execute one protocol command; returns the engine envelope (on success it carries revision and events; freshly minted ids are in events).\n' +
      '• await velocut.tts({text, atUs?, trackId?, language}) → generate a narration audio clip; returns {ok, clipId, durationUs, atUs}. Call once per line and use the returned durationUs to size the matching shot/subtitle.\n' +
      '• await velocut.observe(input) → look at the picture / read metrics; returns {ok, summary, data} (no images inside a script — use the numbers in data).\n' +
      '• await velocut.motionClip({spec, atUs?, trackId?, name?}) → generate a motion-graphics clip (title card / lower third / animated caption / infographic) from a declarative spec; it lands automatically on the "Graphics" video track. The spec is pure JSON (not code) and is persisted — it reproduces identically after refresh/export.\n' +
      '  spec = {version:1, durationUs, fps?, width?, height?, background? (full-frame fill color), layers:[…]}. Each layer has animatable transforms: x, y, opacity (0..1), scale (1 = 100%), rotation (degrees), plus optional in/out (seconds, the layer\'s visibility window). Any transform value can be a constant, or a list of keyframes [{t (seconds), v (value), ease?}] (ease takes GSAP names: "none"/"power2.out"/"back.out"/"elastic.out"…, describing the easing of the segment arriving at that keyframe; the value holds before the first and after the last keyframe).\n' +
      '  Layer types: ①{type:"text", text, size?, weight?, color?, align? ("left"/"center"/"right"), baseline?, maxWidth? (auto-measured line wrapping, CJK supported), lineHeight?, stroke?, strokeWidth?, shadow?:{color,blur?,x?,y?}} ②{type:"rect", w, h, radius?, fill?, stroke?, lineWidth?} ③{type:"ellipse", w, h, fill?, stroke?, lineWidth?} ④{type:"image", src (CORS URL), w?, h?}. Transforms apply translate→rotate→scale around the (x,y) origin; the layer\'s own coordinates are relative to that origin (text draws from the origin; rect/ellipse extend w×h down-right from it). Coordinate system = output resolution (defaults to the full frame w×h; usually read doc.width/height from velocut.document()). Returns {ok, assetId, clipId, trackId, frameCount}.\n' +
      '  Example: opening title card (fade in + rise over 0.5s, fade out over the final 0.4s): velocut.motionClip({atUs:0, spec:{version:1, durationUs:2_500_000, layers:[{type:"text", text:"Opening Title", size:96, weight:800, color:"#fff", align:"center", x:960, y:[{t:0,v:580},{t:0.5,v:540,ease:"power3.out"}], opacity:[{t:0,v:0},{t:0.5,v:1,ease:"power2.out"},{t:2.1,v:1},{t:2.5,v:0}], shadow:{color:"rgba(0,0,0,.6)",blur:24}}]}}). Animated captions aligned to narration: for each line, take the durationUs from tts and create a motionClip caption with the same atUs/durationUs, with opacity keyframes for the entrance/exit.\n' +
      '• await velocut.sceneClip({spec, atUs?, trackId?, name?}) → generate a 3D character/scene animation clip (the Scene Director) from a declarative spec; it lands on the "Scenes" video track. Pure JSON like motionClip — persisted, deterministic, re-renders identically on export.\n' +
      '  spec = {version:1, durationUs, fps?, width?, height?, environment? ("env/stage"/"env/grid"/"env/void"), lighting? ("day"/"night"/"indoor"), characters?:[…], props?:[…], camera?}. World units are METERS (y up, ground y=0).\n' +
      '  Character: {id, model (registry id), position?:{x?,y?,z?}, rotationY? (degrees; 0 faces +Z, toward the default camera), scale?, actions?:[{clip, start (s), loop?, fade? (cross-fade s, default 0.3)}], gaze?: "camera" | {character: id}}. Each axis / rotationY takes a constant or MotionSpec-style keyframes [{t,v,ease?}]. Actions: action i plays from its start until the next action\'s start (the last runs to the end); walking = play a locomotion clip AND keyframe position at the clip\'s gait speed so feet don\'t skate. gaze turns the HEAD toward the shot camera or another character (clamped, follows movement) — use it for dialogue staging and to-camera beats.\n' +
      '  Prop: {model ("prop/cube"/"prop/sphere"/"prop/pillar"), position?, rotationY?, scale?, color?}. scale is a number (uniform) or per-axis {x?,y?,z?} — e.g. a lamp post = prop/pillar with scale {x:0.2, y:3, z:0.2}. BLOCKOUT: rooms/sets are built from scaled cubes — a wall = prop/cube scale {x:4, y:2.5, z:0.12} positioned at y:1.25; a table = cube {x:1.2, y:0.05, z:0.8} at y:0.75 plus pillar legs. Greybox layouts read perfectly on camera.\n' +
      '  Camera: {fov? (default 40), position?, lookAt?: {x,y,z} | {character: id} (tracks as it moves), roll? (dutch angle, degrees), shake?: {amplitude? (m, ~0.03), rotAmplitude? (deg, ~0.5), frequency? (Hz, ~1.1)} — deterministic handheld wobble}.\n' +
      '  MULTI-SHOT: instead of one camera, give shots: [{start (s; first must be 0, ascending), camera: {…}}] — a hard CUT happens at each shot\'s start; keyframes inside a shot\'s camera are relative to the shot start. All shots must share one lookAt mode (all points, or all tracking the same character). Prefer shots over manual step keyframes for anything with 2+ camera setups.\n' +
      '  FIRST call await velocut.sceneAssets() → {doc, manifest}: the registry of character models + their animation clip names (with gait speeds), environments, lighting and props. Only names from the registry exist — inventing one fails the compile.\n' +
      '  Example (robot walks in and waves, camera pushes in and tracks): velocut.sceneClip({atUs:0, spec:{version:1, durationUs:6_000_000, environment:"env/stage", lighting:"day", characters:[{id:"hero", model:"char/robot", position:{x:[{t:0,v:-4.2},{t:3,v:0,ease:"none"}], z:0}, rotationY:[{t:0,v:90},{t:3,v:90},{t:3.4,v:0}], actions:[{clip:"Walking", start:0},{clip:"Wave", start:3.2, fade:0.4}]}], camera:{position:{x:[{t:0,v:6},{t:6,v:3.5}], y:2, z:[{t:0,v:8},{t:6,v:5.5}]}, lookAt:{character:"hero"}}}}). Returns {ok, assetId, clipId, trackId, frameCount}. To EDIT an existing scene, read the asset\'s spec (velocut.document(), assets[].spec is the JSON string), modify it, and velocut.apply({type:"setAssetSpec", assetId, spec: JSON.stringify(updated)}) — one undoable step.\n' +
      '• velocut.evaluate(timeUs) → evaluate the composite manifest at an instant; velocut.document() → read the full document.\n' +
      'Loops/conditionals/computing the next step from the previous return value are all supported. Typical pattern (laying down a long-to-short cut in one pass): keep a time cursor T; for each unit { const r = await velocut.tts({text, atUs:T, language:"chinese"}); velocut.apply(add the shot at startUs:T with duration r.durationUs and its source offset…); velocut.apply(add the subtitle bar at the same T and duration); T += r.durationUs; }.\n' +
      'return a JSON value as the result (e.g. {units, totalUs}); console.log output inside the script is sent back to you; a thrown error comes back with message + stack — fix and re-run. Command field names follow the document structure seen via velocut_get_document and the command reference.',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript source. Top-level await is allowed; use return to produce a JSON-serializable result. Globals: velocut (apply/tts/observe/motionClip/sceneClip/sceneAssets/evaluate/document/seek) and console.',
        },
      },
      required: ['code'],
    },
  },
];

/** tool_result content: text for most tools, or text+image blocks for observe. */
type ToolContent = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

async function executeTool(
  host: AgentHost,
  name: string,
  input: unknown,
): Promise<{
  ok: boolean;
  content: ToolContent;
  summary: string;
  /** observe only — relayed verbatim into the tool event for the chat UI. */
  images?: { base64: string; mediaType: string }[];
  data?: unknown;
}> {
  const text = (ok: boolean, result: string) => ({ ok, content: result, summary: result });
  try {
    switch (name) {
      case 'velocut_apply': {
        const cmd = (input as { command: Command }).command;
        const resp = await host.dispatch(cmd);
        return text(resp.ok, JSON.stringify(resp));
      }
      case 'velocut_get_document':
        return text(true, JSON.stringify(await host.document()));
      case 'velocut_evaluate': {
        const t = Math.round((input as { timeUs: number }).timeUs);
        return text(true, JSON.stringify(await host.evaluate(t)));
      }
      case 'velocut_observe': {
        if (!host.observe) return text(false, 'Observe capability not wired (no renderer)');
        const r = await host.observe((input ?? {}) as Record<string, unknown>);
        const digest = r.summary + (r.data ? '\n' + JSON.stringify(r.data) : '') + (r.message ? '\n' + r.message : '');
        const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [{ type: 'text', text: digest }];
        for (const img of r.images) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType as 'image/jpeg', data: img.base64 },
          });
        }
        // Relay the same images & data to the chat UI so the human sees exactly
        // what the agent saw (the model already got them in `blocks`).
        return { ok: r.ok, content: blocks, summary: r.summary, images: r.images, data: r.data };
      }
      case 'velocut_tts': {
        if (!host.speak) return text(false, 'TTS capability not wired (no speech synthesizer)');
        const r = await host.speak((input ?? {}) as { text: string; atUs?: number; trackId?: string; language?: string });
        return text(r.ok, JSON.stringify(r));
      }
      case 'velocut_transcribe': {
        if (!host.caption) return text(false, 'Transcription capability not wired (no transcriber)');
        const r = await host.caption(
          (input ?? {}) as { assetId?: string; fontSize?: number; color?: string; language?: string },
        );
        return text(r.ok, JSON.stringify(r));
      }
      case 'velocut_search': {
        if (!host.search) return text(false, 'Web search capability not wired (no search backend)');
        const r = await host.search((input as { query: string }).query);
        if (!r.ok) return text(false, r.message ?? 'Search failed');
        const src = r.sources.length ? '\nSources: ' + r.sources.map((s) => `${s.title || s.url}`).join('; ') : '';
        return { ok: true, content: r.answer + src, summary: r.answer.slice(0, 80) };
      }
      case 'velocut_script': {
        if (!host.runScript) return text(false, 'Script execution capability not wired (no runtime)');
        const r = await host.runScript((input as { code: string }).code);
        // JSON in/out: result + logs the model reads, error+stack on failure.
        const digest = JSON.stringify({ ok: r.ok, result: r.result, logs: r.logs, error: r.error });
        return { ok: r.ok, content: digest, summary: r.error ? `Script error: ${r.error.split('\n')[0]}` : 'Script completed' };
      }
      default:
        return text(false, `unknown tool: ${name}`);
    }
  } catch (e) {
    return text(false, String(e instanceof Error ? e.message : e));
  }
}

/**
 * Run one user turn through the agent loop. Returns the new history
 * (caller keeps it for the next turn).
 */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<Anthropic.MessageParam[]> {
  const model = opts.model ?? 'claude-opus-4-8';
  // One default Anthropic client for the real-key path — built only when NO
  // transport is injected. Tests inject createMessage (non-streaming); the dev
  // app injects createStream (the proxy SSE). With nothing injected we have a
  // real key, so we stream by default.
  const client =
    !opts.createMessage && !opts.createStream
      ? new Anthropic({
          // 'bearer' routes the key through Authorization (gateway convention);
          // the SDK's apiKey field is Anthropic's native x-api-key header.
          apiKey: opts.auth === 'bearer' ? null : opts.apiKey,
          authToken: opts.auth === 'bearer' ? opts.apiKey : null,
          baseURL: opts.baseURL,
          dangerouslyAllowBrowser: true,
        })
      : null;
  const createStream =
    opts.createStream ?? (client ? (p: Anthropic.MessageStreamParams) => client.messages.stream(p) : undefined);
  const createMessage =
    opts.createMessage ?? (client ? (p: Anthropic.MessageCreateParamsNonStreaming) => client.messages.create(p) : undefined);

  const messages: Anthropic.MessageParam[] = [...opts.history, { role: 'user', content: opts.userText }];
  const maxIterations = opts.maxIterations ?? 24;
  const system = opts.systemExtra ? `${SYSTEM_PROMPT}\n\n${opts.systemExtra}` : SYSTEM_PROMPT;

  for (let i = 0; i < maxIterations; i++) {
    const params: Anthropic.MessageStreamParams = {
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system,
      tools: TOOLS,
      messages,
    };

    let response: Anthropic.Message;
    if (createStream) {
      // Streaming: relay text/thinking deltas to the UI as they arrive; the SDK
      // accumulates the full message (thinking signatures + tool_use inputs are
      // assembled internally), so the response below is byte-identical to the
      // non-streaming path and the tool loop is unchanged.
      try {
        const stream = createStream(params);
        stream.on('streamEvent', (ev: Anthropic.MessageStreamEvent) => {
          if (ev.type === 'content_block_start') {
            if (ev.content_block.type === 'text') opts.onEvent?.({ kind: 'textStart' });
            else if (ev.content_block.type === 'thinking') opts.onEvent?.({ kind: 'thinkingStart' });
          } else if (ev.type === 'content_block_delta') {
            if (ev.delta.type === 'text_delta') opts.onEvent?.({ kind: 'textDelta', delta: ev.delta.text });
            else if (ev.delta.type === 'thinking_delta')
              opts.onEvent?.({ kind: 'thinkingDelta', delta: ev.delta.thinking });
            // input_json_delta is intentionally not surfaced — the tool input is
            // only complete (and safe to execute) after finalMessage().
          }
        });
        response = await stream.finalMessage();
      } catch (e) {
        // A mid-stream upstream error / abort: report it and stop the turn.
        // Do NOT push a half-streamed assistant block into messages (it would
        // make the next request invalid).
        opts.onEvent?.({ kind: 'error', message: String(e instanceof Error ? e.message : e) });
        break;
      }
    } else if (createMessage) {
      response = await createMessage(params as Anthropic.MessageCreateParamsNonStreaming);
    } else {
      throw new Error('runAgentTurn: no transport (provide apiKey, createStream, or createMessage)');
    }

    // Echo the assistant turn back verbatim — thinking blocks (with
    // signatures) and tool_use blocks must be preserved.
    messages.push({ role: 'assistant', content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        // Streaming already surfaced this text via textDelta; only the
        // non-streaming fallback needs the whole-block text event.
        if (!createStream) opts.onEvent?.({ kind: 'text', text: block.text });
      } else if (block.type === 'tool_use') {
        opts.onEvent?.({ kind: 'toolStart', name: block.name, input: block.input });
        const { ok, content, summary, images, data } = await executeTool(opts.host, block.name, block.input);
        opts.onEvent?.({ kind: 'tool', name: block.name, input: block.input, ok, detail: summary, images, data });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content,
          is_error: !ok || undefined,
        });
      }
    }

    if (response.stop_reason !== 'tool_use' || toolResults.length === 0) break;
    messages.push({ role: 'user', content: toolResults });
  }

  return messages;
}
