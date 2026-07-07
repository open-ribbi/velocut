// @velocut/protocol — the command protocol as a single source of truth.
//
// Commands and the value types they carry are defined ONCE here as zod
// schemas; the TS types are inferred from them (so the wire shape, the runtime
// validator, and the agent's command catalogue can never drift apart). The
// inferred types match the Rust serde shapes exactly (camelCase) — adding a
// field here is the only place it needs to change for validation + the agent.
//
// Document / FrameGraph / result types stay hand-written in types.ts (the
// engine produces them; we never validate them inbound) and compose from the
// value types re-exported here.

import { z } from 'zod';

// ------------------------------------------------------------- value types

export const AssetKind = z.enum(['video', 'audio', 'image']);
export type AssetKind = z.infer<typeof AssetKind>;

export const TrackKind = z.enum(['video', 'audio', 'text']);
export type TrackKind = z.infer<typeof TrackKind>;

export const TrimEdge = z.enum(['in', 'out']);
export type TrimEdge = z.infer<typeof TrimEdge>;

export const Property = z.enum(['x', 'y', 'scaleX', 'scaleY', 'rotation', 'opacity', 'volume']);
export type Property = z.infer<typeof Property>;

export const Easing = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('linear') }),
  z.object({ kind: z.literal('hold') }),
  z.object({ kind: z.literal('bezier'), x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }),
]);
export type Easing = z.infer<typeof Easing>;

export const Transform = z.object({
  x: z.number(),
  y: z.number(),
  scaleX: z.number(),
  scaleY: z.number(),
  rotation: z.number(),
  opacity: z.number(),
});
export type Transform = z.infer<typeof Transform>;

export const Keyframe = z.object({
  timeUs: z.number(),
  value: z.number(),
  easing: Easing,
});
export type Keyframe = z.infer<typeof Keyframe>;

export const EffectInstance = z.object({
  id: z.string(),
  effect: z.string(),
  params: z.record(z.unknown()),
  enabled: z.boolean().nullish(),
});
export type EffectInstance = z.infer<typeof EffectInstance>;

export const TextPayload = z.object({
  content: z.string(),
  fontFamily: z.string().nullish(),
  fontSize: z.number().nullish(),
  color: z.string().nullish(),
  align: z.string().nullish(),
  bold: z.boolean().nullish(),
  italic: z.boolean().nullish(),
  strokeColor: z.string().nullish(),
  strokeWidth: z.number().nullish(),
  shadowColor: z.string().nullish(),
  shadowBlur: z.number().nullish(),
  shadowX: z.number().nullish(),
  shadowY: z.number().nullish(),
  backgroundColor: z.string().nullish(),
  backgroundOpacity: z.number().nullish(),
  // When true, the background fills the full composite width (a subtitle bar
  // that covers burned-in subtitles edge-to-edge) instead of hugging the text.
  backgroundFullWidth: z.boolean().nullish(),
});
export type TextPayload = z.infer<typeof TextPayload>;

export const Transition = z.object({
  kind: z.string(),
  durationUs: z.number(),
  /** Optional custom WGSL transition body (AI-authored): from(uv)/to(uv) =
   *  outgoing/incoming straight-alpha color, progress 0→1; return straight RGBA.
   *  Overrides the built-in `kind` shader. */
  wgsl: z.string().optional(),
});
export type Transition = z.infer<typeof Transition>;

// ---------------------------------------------------------------- commands
// Each command is a standalone schema (precise `type` literal preserved so the
// discriminated union type-checks). Human summaries live in SUMMARIES, beside
// the schemas — adding a command means editing only this file.

const cAddAsset = z.object({
  type: z.literal('addAsset'),
  kind: AssetKind,
  src: z.string(),
  name: z.string(),
  durationUs: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  hasAudio: z.boolean().nullish(),
  id: z.string().nullish(),
});
const cAddTrack = z.object({
  type: z.literal('addTrack'),
  kind: TrackKind,
  name: z.string().nullish(),
  index: z.number().nullish(),
});
const cRemoveTrack = z.object({ type: z.literal('removeTrack'), trackId: z.string() });
const cMoveTrack = z.object({ type: z.literal('moveTrack'), trackId: z.string(), toIndex: z.number() });
const cAddClip = z.object({
  type: z.literal('addClip'),
  trackId: z.string(),
  assetId: z.string(),
  startUs: z.number(),
  durationUs: z.number().nullish(),
  sourceInUs: z.number().optional(),
});
const cAddTextClip = z.object({
  type: z.literal('addTextClip'),
  trackId: z.string(),
  startUs: z.number(),
  durationUs: z.number(),
  text: TextPayload,
});
const cRemoveClip = z.object({ type: z.literal('removeClip'), clipId: z.string() });
const cMoveClip = z.object({
  type: z.literal('moveClip'),
  clipId: z.string(),
  trackId: z.string().nullish(),
  startUs: z.number(),
});
const cTrimClip = z.object({
  type: z.literal('trimClip'),
  clipId: z.string(),
  edge: TrimEdge,
  toUs: z.number(),
});
const cSplitClip = z.object({ type: z.literal('splitClip'), clipId: z.string(), atUs: z.number() });
const cSetClipSpeed = z.object({ type: z.literal('setClipSpeed'), clipId: z.string(), speed: z.number() });
const cSetTransform = z.object({ type: z.literal('setTransform'), clipId: z.string(), transform: Transform });
const cSetClipVolume = z.object({ type: z.literal('setClipVolume'), clipId: z.string(), volume: z.number() });
const cSetText = z.object({ type: z.literal('setText'), clipId: z.string(), text: TextPayload });
const cSetTransition = z.object({
  type: z.literal('setTransition'),
  clipId: z.string(),
  transition: Transition.nullable(),
});
const cSetKeyframe = z.object({
  type: z.literal('setKeyframe'),
  clipId: z.string(),
  property: Property,
  keyframe: Keyframe,
});
const cRemoveKeyframe = z.object({
  type: z.literal('removeKeyframe'),
  clipId: z.string(),
  property: Property,
  timeUs: z.number(),
});
const cAddEffect = z.object({
  type: z.literal('addEffect'),
  clipId: z.string(),
  effect: z.string(),
  params: z.record(z.unknown()).optional(),
});
const cRemoveEffect = z.object({ type: z.literal('removeEffect'), clipId: z.string(), effectId: z.string() });
const cSetEffectParams = z.object({
  type: z.literal('setEffectParams'),
  clipId: z.string(),
  effectId: z.string(),
  params: z.record(z.unknown()),
});
const cSetTrackMuted = z.object({ type: z.literal('setTrackMuted'), trackId: z.string(), muted: z.boolean() });
const cSetTrackLocked = z.object({ type: z.literal('setTrackLocked'), trackId: z.string(), locked: z.boolean() });

/** All non-batch commands as a discriminated union (zod). */
const NonBatchSchema = z.discriminatedUnion('type', [
  cAddAsset,
  cAddTrack,
  cRemoveTrack,
  cMoveTrack,
  cAddClip,
  cAddTextClip,
  cRemoveClip,
  cMoveClip,
  cTrimClip,
  cSplitClip,
  cSetClipSpeed,
  cSetTransform,
  cSetClipVolume,
  cSetText,
  cSetTransition,
  cSetKeyframe,
  cRemoveKeyframe,
  cAddEffect,
  cRemoveEffect,
  cSetEffectParams,
  cSetTrackMuted,
  cSetTrackLocked,
]);
type NonBatch = z.infer<typeof NonBatchSchema>;

/** type → one-line summary for the agent prompt's command table. */
const SUMMARIES: Record<string, string> = {
  addAsset: 'kind:video|audio|image, src, name, durationUs?, width?, height?, hasAudio? — register an asset',
  addTrack: 'kind:video|audio|text, name?, index? — create a track',
  removeTrack: 'trackId — remove a track (including its clips)',
  moveTrack: 'trackId, toIndex — reorder the track to position toIndex (0 = top of the render order)',
  addClip: 'trackId, assetId, startUs, durationUs?, sourceInUs? — place an asset on a track',
  addTextClip: 'trackId, startUs, durationUs, text:TextPayload (see below) — text clip',
  removeClip: 'clipId — remove a clip',
  moveClip: 'clipId, startUs, trackId? — move (may cross tracks of the same kind)',
  trimClip: 'clipId, edge:in|out, toUs — trim; the in edge advances sourceIn in step',
  splitClip: 'clipId, atUs (timeline coordinates) — split into two',
  setClipSpeed: 'clipId, speed — change playback speed',
  setTransform: 'clipId, transform:{x,y,scaleX,scaleY,rotation,opacity} — write the whole transform (origin = frame center, in pixels)',
  setClipVolume: 'clipId, volume:0–2 — volume',
  setText: 'clipId, text:TextPayload — edit text (replaces the whole text object, see below)',
  setTransition: 'clipId, transition:{kind,durationUs}|null — entrance transition, see below',
  setKeyframe: 'clipId, property:x|y|scaleX|scaleY|rotation|opacity|volume, keyframe:{timeUs,value,easing} — timeUs is relative to the clip start',
  removeKeyframe: 'clipId, property, timeUs — remove a keyframe',
  addEffect: 'clipId, effect:brightnessContrast|colorGrade, params: see "color grading" — add an effect',
  removeEffect: 'clipId, effectId — remove an effect',
  setEffectParams: 'clipId, effectId, params — update effect params',
  setTrackMuted: 'trackId, muted — mute/unmute a track',
  setTrackLocked: 'trackId, locked — lock/unlock a track',
};

/** A command — value types inferred from zod; batch is the recursive wrapper. */
export type Command = NonBatch | { type: 'batch'; commands: Command[] };

/** Runtime schema for a full command (incl. recursive batch). */
export const CommandSchema: z.ZodType<Command> = z.lazy(() =>
  z.union([
    NonBatchSchema,
    z.object({ type: z.literal('batch'), commands: z.array(CommandSchema) }),
  ]),
) as z.ZodType<Command>;

/** type → one-line summary, for generating the agent prompt's command table. */
export const COMMAND_CATALOG: Array<{ type: string; summary: string }> = [
  ...Object.entries(SUMMARIES).map(([type, summary]) => ({ type, summary })),
  { type: 'batch', summary: 'commands[] — atomic batch (if any command fails, all roll back)' },
];

/** Validate a command at the dispatch boundary. Returns a machine-readable
 *  error the agent can act on, instead of letting a malformed command reach
 *  (and confuse) the engine. */
/** Dig through union-error aggregation for the most specific (deepest-path)
 *  issue so the agent gets e.g. "speed: Required" not a generic union error. */
function deepestIssue(err: z.ZodError): { path: Array<string | number>; message: string } | null {
  let best: { path: Array<string | number>; message: string } | null = null;
  const walk = (issues: z.ZodIssue[]): void => {
    for (const i of issues) {
      const sub = (i as { unionErrors?: z.ZodError[] }).unionErrors;
      if (sub) sub.forEach((e) => walk(e.issues));
      else if (!best || i.path.length > best.path.length) best = { path: i.path, message: i.message };
    }
  };
  walk(err.issues);
  return best;
}

export function validateCommand(cmd: unknown): { ok: true } | { ok: false; code: string; message: string } {
  const r = CommandSchema.safeParse(cmd);
  if (r.success) return { ok: true };
  const issue = deepestIssue(r.error);
  const where = issue && issue.path.length ? issue.path.join('.') : 'command';
  return { ok: false, code: 'invalidArg', message: `${where}: ${issue?.message ?? 'invalid command'}` };
}
