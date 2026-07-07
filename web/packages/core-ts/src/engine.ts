// @velocut/core-ts — TypeScript reference implementation of the editing
// engine. Semantics are pinned to velocut-core (Rust) by the shared golden
// vectors in protocol/vectors; both test suites execute the same files.
//
// Why it exists (not a stopgap):
// - Node/server agents can run editing logic without a WASM toolchain.
// - The browser falls back to it when the WASM build is absent, so
//   `npm i && npm run dev` works out of the box.
// The Rust engine remains canonical; behaviour disputes are settled by
// adding a vector.

import type {
  Asset,
  Clip,
  Command,
  CmdError,
  Envelope,
  EngineEvent,
  FrameGraph,
  Keyframe,
  Layer,
  Property,
  TimeUs,
  Track,
  VDocument,
} from '@velocut/protocol';

const MAX_HISTORY = 200;

// ----------------------------------------------------------------- helpers

const clone = <T>(v: T): T => structuredClone(v);

const err = (code: string, message: string): CmdError => ({ code, message });
const notFound = (what: string, id: string) => err('notFound', `${what} '${id}' not found`);

class CommandError extends Error {
  e: CmdError;
  constructor(e: CmdError) {
    super(e.message);
    this.e = e;
  }
}
const fail = (e: CmdError): never => {
  throw new CommandError(e);
};

const clipEnd = (c: Clip): TimeUs => c.startUs + c.durationUs;
const sourceTimeAt = (c: Clip, timelineUs: TimeUs): TimeUs => {
  const local = Math.max(0, timelineUs - c.startUs);
  return c.sourceInUs + Math.round(local * c.speed);
};

const overlaps = (t: Track, start: TimeUs, dur: TimeUs, ignore: string | null): boolean => {
  const end = start + dur;
  return t.clips.some((c) => c.id !== ignore && start < clipEnd(c) && c.startUs < end);
};

const sortClips = (t: Track) => t.clips.sort((a, b) => a.startUs - b.startUs);

const defaultTransform = () => ({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 });

function newDocument(name: string, width: number, height: number, fpsNum: number, fpsDen: number): VDocument {
  return { id: 'doc_1', name, width, height, fpsNum, fpsDen, assets: [], tracks: [], nextId: 1 };
}

function mintId(doc: VDocument, prefix: string): string {
  const id = `${prefix}_${doc.nextId}`;
  doc.nextId += 1;
  return id;
}

function locateClip(doc: VDocument, clipId: string): [number, number] | null {
  for (let ti = 0; ti < doc.tracks.length; ti++) {
    const ci = doc.tracks[ti].clips.findIndex((c) => c.id === clipId);
    if (ci >= 0) return [ti, ci];
  }
  return null;
}

// ----------------------------------------------------------- command apply

function applyCommand(doc: VDocument, cmd: Command): EngineEvent[] {
  switch (cmd.type) {
    case 'addAsset': {
      let assetId: string;
      if (cmd.id != null) {
        if (doc.assets.some((a) => a.id === cmd.id)) {
          fail(err('invalidArg', `asset id '${cmd.id}' already exists`));
        }
        assetId = cmd.id;
      } else {
        assetId = mintId(doc, 'asset');
      }
      const asset: Asset = {
        id: assetId,
        kind: cmd.kind,
        src: cmd.src,
        name: cmd.name,
        durationUs: cmd.durationUs ?? 0,
        width: cmd.width ?? 0,
        height: cmd.height ?? 0,
        hasAudio: cmd.hasAudio ?? cmd.kind !== 'image',
      };
      doc.assets.push(asset);
      return [{ kind: 'assetAdded', assetId }];
    }

    case 'addTrack': {
      const trackId = mintId(doc, 'track');
      const n = doc.tracks.length;
      const at = Math.min(cmd.index ?? n, n);
      doc.tracks.splice(at, 0, {
        id: trackId,
        kind: cmd.kind,
        name: cmd.name ?? `Track ${n + 1}`,
        muted: false,
        locked: false,
        clips: [],
      });
      return [{ kind: 'trackAdded', trackId }];
    }

    case 'removeTrack': {
      const i = doc.tracks.findIndex((t) => t.id === cmd.trackId);
      if (i < 0) fail(notFound('track', cmd.trackId));
      doc.tracks.splice(i, 1);
      return [{ kind: 'trackRemoved', trackId: cmd.trackId }];
    }

    case 'moveTrack': {
      const i = doc.tracks.findIndex((t) => t.id === cmd.trackId);
      if (i < 0) fail(notFound('track', cmd.trackId));
      const to = Math.max(0, Math.min(cmd.toIndex, doc.tracks.length - 1));
      const [t] = doc.tracks.splice(i, 1);
      doc.tracks.splice(to, 0, t);
      return [{ kind: 'trackUpdated', trackId: cmd.trackId }];
    }

    case 'addClip': {
      const asset = doc.assets.find((a) => a.id === cmd.assetId);
      if (!asset) fail(notFound('asset', cmd.assetId));
      const dur = cmd.durationUs ?? Math.max(asset!.durationUs, 1);
      if (dur <= 0 || cmd.startUs < 0) fail(err('invalidArg', 'duration must be > 0 and start >= 0'));
      const clipId = mintId(doc, 'clip');
      const track = doc.tracks.find((t) => t.id === cmd.trackId);
      if (!track) fail(notFound('track', cmd.trackId));
      if (track!.locked) fail(err('locked', `track '${cmd.trackId}' is locked`));
      if (overlaps(track!, cmd.startUs, dur, null)) {
        fail(err('overlap', 'clip would overlap an existing clip on this track'));
      }
      track!.clips.push({
        id: clipId,
        assetId: cmd.assetId,
        startUs: cmd.startUs,
        durationUs: dur,
        sourceInUs: cmd.sourceInUs ?? 0,
        speed: 1,
        transform: defaultTransform(),
        keyframes: {},
        effects: [],
        text: null,
        volume: 1,
      });
      sortClips(track!);
      return [{ kind: 'clipAdded', clipId, trackId: cmd.trackId }];
    }

    case 'addTextClip': {
      if (cmd.durationUs <= 0 || cmd.startUs < 0) {
        fail(err('invalidArg', 'duration must be > 0 and start >= 0'));
      }
      const clipId = mintId(doc, 'clip');
      const track = doc.tracks.find((t) => t.id === cmd.trackId);
      if (!track) fail(notFound('track', cmd.trackId));
      if (track!.locked) fail(err('locked', `track '${cmd.trackId}' is locked`));
      if (overlaps(track!, cmd.startUs, cmd.durationUs, null)) {
        fail(err('overlap', 'clip would overlap an existing clip on this track'));
      }
      track!.clips.push({
        id: clipId,
        assetId: null,
        startUs: cmd.startUs,
        durationUs: cmd.durationUs,
        sourceInUs: 0,
        speed: 1,
        transform: defaultTransform(),
        keyframes: {},
        effects: [],
        text: clone(cmd.text),
        volume: 1,
      });
      sortClips(track!);
      return [{ kind: 'clipAdded', clipId, trackId: cmd.trackId }];
    }

    case 'removeClip': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      if (doc.tracks[ti].locked) fail(err('locked', `track '${doc.tracks[ti].id}' is locked`));
      doc.tracks[ti].clips.splice(ci, 1);
      return [{ kind: 'clipRemoved', clipId: cmd.clipId }];
    }

    case 'moveClip': {
      if (cmd.startUs < 0) fail(err('invalidArg', 'start must be >= 0'));
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      let destTi = ti;
      if (cmd.trackId != null) {
        destTi = doc.tracks.findIndex((t) => t.id === cmd.trackId);
        if (destTi < 0) fail(notFound('track', cmd.trackId));
      }
      if (destTi !== ti && doc.tracks[destTi].kind !== doc.tracks[ti].kind) {
        fail(err('invalidArg', 'cannot move a clip across track kinds'));
      }
      if (doc.tracks[ti].locked || doc.tracks[destTi].locked) {
        fail(err('locked', `track '${doc.tracks[destTi].id}' is locked`));
      }
      const dur = doc.tracks[ti].clips[ci].durationUs;
      const ignore = destTi === ti ? cmd.clipId : null;
      if (overlaps(doc.tracks[destTi], cmd.startUs, dur, ignore)) {
        fail(err('overlap', 'destination range overlaps an existing clip'));
      }
      const [clip] = doc.tracks[ti].clips.splice(ci, 1);
      clip.startUs = cmd.startUs;
      doc.tracks[destTi].clips.push(clip);
      sortClips(doc.tracks[destTi]);
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'trimClip': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      if (doc.tracks[ti].locked) fail(err('locked', `track '${doc.tracks[ti].id}' is locked`));
      const clip = doc.tracks[ti].clips[ci];
      let newStart: TimeUs, newDur: TimeUs, newSrcIn: TimeUs;
      if (cmd.edge === 'in') {
        if (cmd.toUs >= clipEnd(clip)) fail(err('invalidArg', 'in-edge must stay before clip end'));
        const to = Math.max(0, cmd.toUs);
        const delta = to - clip.startUs;
        const srcIn = clip.sourceInUs + Math.round(delta * clip.speed);
        if (srcIn < 0) fail(err('outOfRange', 'cannot extend before source start'));
        newStart = to;
        newDur = clipEnd(clip) - to;
        newSrcIn = srcIn;
      } else {
        if (cmd.toUs <= clip.startUs) fail(err('invalidArg', 'out-edge must stay after clip start'));
        newStart = clip.startUs;
        newDur = cmd.toUs - clip.startUs;
        newSrcIn = clip.sourceInUs;
      }
      if (clip.assetId != null) {
        const asset = doc.assets.find((a) => a.id === clip.assetId);
        if (asset && asset.kind !== 'image' && asset.durationUs > 0) {
          const srcOut = newSrcIn + Math.round(newDur * clip.speed);
          if (srcOut > asset.durationUs) fail(err('outOfRange', 'trim exceeds source media duration'));
        }
      }
      if (overlaps(doc.tracks[ti], newStart, newDur, cmd.clipId)) {
        fail(err('overlap', 'trim would overlap a neighbouring clip'));
      }
      clip.startUs = newStart;
      clip.durationUs = newDur;
      clip.sourceInUs = newSrcIn;
      sortClips(doc.tracks[ti]);
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'splitClip': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      if (doc.tracks[ti].locked) fail(err('locked', `track '${doc.tracks[ti].id}' is locked`));
      const original = clone(doc.tracks[ti].clips[ci]);
      if (cmd.atUs <= original.startUs || cmd.atUs >= clipEnd(original)) {
        fail(err('invalidArg', 'split point must be strictly inside the clip'));
      }
      const rightId = mintId(doc, 'clip');
      const splitLocal = cmd.atUs - original.startUs;
      const track = doc.tracks[ti];
      const left = track.clips[ci];
      left.durationUs = splitLocal;
      const right: Clip = clone(original);
      right.id = rightId;
      right.startUs = cmd.atUs;
      right.durationUs = clipEnd(original) - cmd.atUs;
      right.sourceInUs = sourceTimeAt(original, cmd.atUs);
      // The transition lives at the original clip's start → stays on the left.
      right.transition = null;
      // Re-base clip-relative keyframes onto each half.
      right.keyframes = {};
      for (const [prop, kfs] of Object.entries(original.keyframes) as [Property, Keyframe[]][]) {
        const shifted = kfs
          .filter((k) => k.timeUs >= splitLocal)
          .map((k) => ({ ...k, timeUs: k.timeUs - splitLocal }));
        if (shifted.length) right.keyframes[prop] = shifted;
      }
      for (const prop of Object.keys(left.keyframes) as Property[]) {
        const kept = (left.keyframes[prop] ?? []).filter((k) => k.timeUs <= splitLocal);
        if (kept.length) left.keyframes[prop] = kept;
        else delete left.keyframes[prop];
      }
      track.clips.push(right);
      sortClips(track);
      return [
        { kind: 'clipUpdated', clipId: cmd.clipId },
        { kind: 'clipAdded', clipId: rightId, trackId: track.id },
      ];
    }

    case 'setClipSpeed': {
      if (!(cmd.speed > 0) || !Number.isFinite(cmd.speed)) {
        fail(err('invalidArg', 'speed must be a finite number > 0'));
      }
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      if (doc.tracks[ti].locked) fail(err('locked', `track '${doc.tracks[ti].id}' is locked`));
      const clip = doc.tracks[ti].clips[ci];
      const sourceSpan = clip.durationUs * clip.speed;
      const newDur = Math.round(sourceSpan / cmd.speed);
      if (newDur <= 0) fail(err('invalidArg', 'resulting duration would be zero'));
      if (overlaps(doc.tracks[ti], clip.startUs, newDur, cmd.clipId)) {
        fail(err('overlap', 'speed change would overlap the next clip; move or trim it first'));
      }
      clip.speed = cmd.speed;
      clip.durationUs = newDur;
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setTransform': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      doc.tracks[ti].clips[ci].transform = { ...cmd.transform };
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setClipVolume': {
      if (cmd.volume < 0 || cmd.volume > 4) fail(err('invalidArg', 'volume must be within 0..=4'));
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      doc.tracks[ti].clips[ci].volume = cmd.volume;
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setText': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      const clip = doc.tracks[ti].clips[ci];
      if (clip.text == null) fail(err('invalidArg', 'clip is not a text clip'));
      clip.text = clone(cmd.text);
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setTransition': {
      if (cmd.transition && cmd.transition.durationUs <= 0) {
        fail(err('invalidArg', 'transition duration must be > 0'));
      }
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      doc.tracks[ti].clips[ci].transition = cmd.transition ? clone(cmd.transition) : null;
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setKeyframe': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      const clip = doc.tracks[ti].clips[ci];
      if (cmd.keyframe.timeUs < 0 || cmd.keyframe.timeUs > clip.durationUs) {
        fail(err('outOfRange', 'keyframe time outside clip'));
      }
      const kfs = (clip.keyframes[cmd.property] ??= []);
      const existing = kfs.find((k) => k.timeUs === cmd.keyframe.timeUs);
      if (existing) Object.assign(existing, clone(cmd.keyframe));
      else {
        kfs.push(clone(cmd.keyframe));
        kfs.sort((a, b) => a.timeUs - b.timeUs);
      }
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'removeKeyframe': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      const clip = doc.tracks[ti].clips[ci];
      const kfs = clip.keyframes[cmd.property];
      if (!kfs) fail(err('notFound', 'no keyframes on property'));
      const before = kfs!.length;
      const next = kfs!.filter((k) => k.timeUs !== cmd.timeUs);
      if (next.length === before) fail(err('notFound', 'keyframe not found at that time'));
      if (next.length) clip.keyframes[cmd.property] = next;
      else delete clip.keyframes[cmd.property];
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'addEffect': {
      const effectId = mintId(doc, 'fx');
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      doc.tracks[ti].clips[ci].effects.push({
        id: effectId,
        effect: cmd.effect,
        params: clone(cmd.params ?? {}),
        enabled: true,
      });
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'removeEffect': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      const clip = doc.tracks[ti].clips[ci];
      const before = clip.effects.length;
      clip.effects = clip.effects.filter((e) => e.id !== cmd.effectId);
      if (clip.effects.length === before) fail(notFound('effect', cmd.effectId));
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setEffectParams': {
      const loc = locateClip(doc, cmd.clipId);
      if (!loc) fail(notFound('clip', cmd.clipId));
      const [ti, ci] = loc!;
      const fx = doc.tracks[ti].clips[ci].effects.find((e) => e.id === cmd.effectId);
      if (!fx) fail(notFound('effect', cmd.effectId));
      fx!.params = clone(cmd.params);
      return [{ kind: 'clipUpdated', clipId: cmd.clipId }];
    }

    case 'setTrackMuted': {
      const t = doc.tracks.find((t) => t.id === cmd.trackId);
      if (!t) fail(notFound('track', cmd.trackId));
      t!.muted = cmd.muted;
      return [{ kind: 'trackUpdated', trackId: cmd.trackId }];
    }

    case 'setTrackLocked': {
      const t = doc.tracks.find((t) => t.id === cmd.trackId);
      if (!t) fail(notFound('track', cmd.trackId));
      t!.locked = cmd.locked;
      return [{ kind: 'trackUpdated', trackId: cmd.trackId }];
    }

    case 'batch': {
      // All-or-nothing on a scratch copy.
      const scratch = clone(doc);
      const events: EngineEvent[] = [];
      for (const c of cmd.commands) events.push(...applyCommand(scratch, c));
      Object.assign(doc, scratch);
      return events;
    }

    default: {
      const t = (cmd as { type?: string }).type ?? 'unknown';
      return fail(err('parse', `unknown command type '${t}'`)) as never;
    }
  }
}

// ----------------------------------------------------------------- eval

function bezierEase(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const sample = (c1: number, c2: number, t: number) => {
    const omt = 1 - t;
    return 3 * omt * omt * t * c1 + 3 * omt * t * t * c2 + t * t * t;
  };
  let lo = 0,
    hi = 1,
    t = x;
  for (let i = 0; i < 24; i++) {
    const xs = sample(x1, x2, t);
    if (Math.abs(xs - x) < 1e-6) break;
    if (xs < x) lo = t;
    else hi = t;
    t = 0.5 * (lo + hi);
  }
  return sample(y1, y2, t);
}

export function evalKeyframes(kfs: Keyframe[], localUs: TimeUs): number | null {
  if (kfs.length === 0) return null;
  if (localUs <= kfs[0].timeUs) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (localUs >= last.timeUs) return last.value;
  let i = 0;
  while (i + 1 < kfs.length && kfs[i + 1].timeUs <= localUs) i++;
  const a = kfs[i],
    b = kfs[i + 1];
  const p = Math.min(1, Math.max(0, (localUs - a.timeUs) / (b.timeUs - a.timeUs)));
  let eased: number;
  switch (a.easing.kind) {
    case 'hold':
      eased = 0;
      break;
    case 'linear':
      eased = p;
      break;
    case 'bezier':
      eased = bezierEase(a.easing.x1, a.easing.y1, a.easing.x2, a.easing.y2, p);
      break;
  }
  return a.value + (b.value - a.value) * eased;
}

function prop(clip: Clip, p: Property, base: number, localUs: TimeUs): number {
  const kfs = clip.keyframes[p];
  if (!kfs) return base;
  return evalKeyframes(kfs, localUs) ?? base;
}

/** Render layer for a clip at an absolute time, opacity scaled by opacityMul.
 *  sourceTimeAt continues past the out-point — used for the transition "from"
 *  frame (freezes at source end). Mirrors the Rust build_layer. */
function buildLayer(clip: Clip, timeUs: TimeUs, opacityMul: number): Layer {
  const local = Math.max(0, timeUs - clip.startUs);
  const t = clip.transform;
  return {
    clipId: clip.id,
    assetId: clip.assetId,
    sourceTimeUs: sourceTimeAt(clip, timeUs),
    transform: {
      x: prop(clip, 'x', t.x, local),
      y: prop(clip, 'y', t.y, local),
      scaleX: prop(clip, 'scaleX', t.scaleX, local),
      scaleY: prop(clip, 'scaleY', t.scaleY, local),
      rotation: prop(clip, 'rotation', t.rotation, local),
      opacity: Math.min(1, Math.max(0, prop(clip, 'opacity', t.opacity, local) * opacityMul)),
    },
    effects: clip.effects.filter((e) => e.enabled ?? true),
    text: clip.text ? clone(clip.text) : null,
    transition: null,
  };
}

export function evaluate(doc: VDocument, timeUs: TimeUs): FrameGraph {
  const layers: Layer[] = [];
  const audio: FrameGraph['audio'] = [];
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => timeUs >= c.startUs && timeUs < clipEnd(c));
    if (!clip) continue;
    const local = timeUs - clip.startUs;
    const sourceTime = sourceTimeAt(clip, timeUs);
    const isVisual = track.kind === 'video' || track.kind === 'text';
    if (isVisual && !track.muted) {
      // A transition is BETWEEN this clip and its predecessor: hand the renderer
      // this (incoming) layer + the `from` (outgoing) layer + progress, and it
      // mixes their pixels by kind. No predecessor → no transition (a clip can't
      // transition from nothing). Mirrors the Rust eval.
      const layer = buildLayer(clip, timeUs, 1);
      if (clip.transition) {
        const prev = track.clips.find((c) => c.id !== clip.id && clipEnd(c) === clip.startUs);
        if (prev) {
          const d = Math.max(1, Math.min(clip.transition.durationUs, clip.durationUs, prev.durationUs));
          if (local < d) {
            layer.transition = {
              kind: clip.transition.kind,
              progress: Math.min(1, Math.max(0, local / d)),
              from: buildLayer(prev, timeUs, 1),
              wgsl: clip.transition.wgsl ?? null,
            };
          }
        }
      }
      layers.push(layer);
    }
    if (!track.muted && clip.assetId != null) {
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      if (asset && asset.hasAudio && (asset.kind === 'video' || asset.kind === 'audio')) {
        const gain = prop(clip, 'volume', clip.volume, local);
        audio.push({
          clipId: clip.id,
          assetId: clip.assetId,
          sourceTimeUs: sourceTime,
          speed: clip.speed,
          gain: Math.max(0, gain),
        });
      }
    }
  }
  return { timeUs, width: doc.width, height: doc.height, layers, audio };
}

// ----------------------------------------------------------------- engine

export class TsEngine {
  private doc: VDocument;
  private undoStack: VDocument[] = [];
  private redoStack: VDocument[] = [];
  private rev = 0;

  constructor(name = 'Untitled', width = 1920, height = 1080, fpsNum = 30, fpsDen = 1) {
    this.doc = newDocument(name, width, height, fpsNum, fpsDen);
  }

  document(): VDocument {
    return this.doc;
  }
  revision(): number {
    return this.rev;
  }
  durationUs(): TimeUs {
    let max = 0;
    for (const t of this.doc.tracks) for (const c of t.clips) max = Math.max(max, clipEnd(c));
    return max;
  }

  apply(cmd: Command): Envelope {
    const snapshot = clone(this.doc);
    try {
      const events = applyCommand(this.doc, cmd);
      this.undoStack.push(snapshot);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this.rev += 1;
      return { ok: true, revision: this.rev, events };
    } catch (e) {
      this.doc = snapshot; // zero side effects on failure
      if (e instanceof CommandError) return { ok: false, error: e.e };
      return { ok: false, error: err('invalidArg', String(e)) };
    }
  }

  applyJson(cmdJson: string): Envelope {
    let cmd: Command;
    try {
      cmd = JSON.parse(cmdJson);
    } catch (e) {
      return { ok: false, error: err('parse', String(e)) };
    }
    return this.apply(cmd);
  }

  undo(): Envelope {
    const prev = this.undoStack.pop();
    if (!prev) return { ok: false, error: err('invalidArg', 'nothing to undo') };
    this.redoStack.push(this.doc);
    this.doc = prev;
    this.rev += 1;
    return { ok: true, revision: this.rev, events: [{ kind: 'documentReplaced' }] };
  }

  redo(): Envelope {
    const next = this.redoStack.pop();
    if (!next) return { ok: false, error: err('invalidArg', 'nothing to redo') };
    this.undoStack.push(this.doc);
    this.doc = next;
    this.rev += 1;
    return { ok: true, revision: this.rev, events: [{ kind: 'documentReplaced' }] };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  evaluate(timeUs: TimeUs): FrameGraph {
    return evaluate(this.doc, timeUs);
  }

  load(doc: VDocument): Envelope {
    this.doc = clone(doc);
    // Normalize legacy documents that omit asset.hasAudio — fill it with the
    // same kind-aware default the addAsset command applies, mirroring the
    // Rust engine's load_json, so both engines resolve identical values.
    for (const asset of this.doc.assets) {
      asset.hasAudio = asset.hasAudio ?? asset.kind !== 'image';
    }
    this.undoStack = [];
    this.redoStack = [];
    this.rev += 1;
    return { ok: true, revision: this.rev, events: [{ kind: 'documentReplaced' }] };
  }
}
