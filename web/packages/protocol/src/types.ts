// @velocut/protocol — the wire types. These mirror the Rust serde shapes
// exactly (camelCase JSON). Anything that edits a document — UI gesture,
// LLM tool call, server job — speaks this protocol and nothing else.
//
// The command surface (Command, the value types it carries, runtime
// validation, the agent command catalogue) is the single source of truth in
// schema.ts and re-exported below. Document / FrameGraph / result types stay
// here and compose from those value types.

import type {
  AssetKind,
  TrackKind,
  Transform,
  Property,
  Keyframe,
  EffectInstance,
  TextPayload,
  Transition,
} from './schema';

export * from './schema';

export type TimeUs = number; // integer microseconds

// ---------------------------------------------------------------- document

export interface Asset {
  id: string;
  kind: AssetKind;
  src: string;
  name: string;
  durationUs: TimeUs;
  width: number;
  height: number;
  hasAudio: boolean;
}

export interface Clip {
  id: string;
  assetId: string | null;
  startUs: TimeUs;
  durationUs: TimeUs;
  sourceInUs: TimeUs;
  speed: number;
  transform: Transform;
  keyframes: Partial<Record<Property, Keyframe[]>>;
  effects: EffectInstance[];
  text: TextPayload | null;
  volume: number;
  /** Transition into this clip from the previous adjacent clip. */
  transition?: Transition | null;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface VDocument {
  id: string;
  name: string;
  width: number;
  height: number;
  fpsNum: number;
  fpsDen: number;
  assets: Asset[];
  tracks: Track[];
  nextId: number;
}

// ---------------------------------------------------------------- results

export type EngineEvent =
  | { kind: 'assetAdded'; assetId: string }
  | { kind: 'trackAdded'; trackId: string }
  | { kind: 'trackRemoved'; trackId: string }
  | { kind: 'trackUpdated'; trackId: string }
  | { kind: 'clipAdded'; clipId: string; trackId: string }
  | { kind: 'clipRemoved'; clipId: string }
  | { kind: 'clipUpdated'; clipId: string }
  | { kind: 'documentReplaced' };

export interface CmdError {
  code: 'notFound' | 'overlap' | 'invalidArg' | 'locked' | 'parse' | 'outOfRange' | string;
  message: string;
}

export type Envelope =
  | { ok: true; revision: number; events: EngineEvent[] }
  | { ok: false; error: CmdError };

// -------------------------------------------------------------- framegraph

export interface ResolvedTransform {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}

export interface Layer {
  clipId: string;
  assetId: string | null;
  sourceTimeUs: TimeUs;
  transform: ResolvedTransform;
  effects: EffectInstance[];
  text: TextPayload | null;
  /** Set on the INCOMING layer during a cross-clip transition window: the
   *  renderer rasterizes this layer (incoming) and `from` (outgoing) and mixes
   *  them by `kind` at `progress`. Absent outside a transition. */
  transition?: LayerTransition | null;
}

/** A cross-clip transition the renderer must composite (eval output, not a
 *  command). `from` is the full outgoing layer (its own transition is null). */
export interface LayerTransition {
  kind: string;
  progress: number;
  from: Layer;
  /** Custom WGSL body (from clip.transition.wgsl); overrides the kind shader. */
  wgsl?: string | null;
}

export interface AudioSlice {
  clipId: string;
  assetId: string;
  sourceTimeUs: TimeUs;
  speed: number;
  gain: number;
}

export interface FrameGraph {
  timeUs: TimeUs;
  width: number;
  height: number;
  layers: Layer[];
  audio: AudioSlice[];
}

// Persisted-document format version + migration chain (see migrate.ts).
export {
  CURRENT_FORMAT_VERSION,
  migrateDocument,
  migrateDocumentOrThrow,
  DocumentFormatError,
  type MigrateResult,
} from './migrate.ts';
