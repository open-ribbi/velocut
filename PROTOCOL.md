# Velocut Data Protocol (AI-native)

One sentence: **the document is JSON, edits are JSON commands, and the render input is a JSON FrameGraph**. Anything that mutates the document — UI gestures, LLM tool calls, server-side jobs — speaks this one language only.

- Canonical implementation: `crates/velocut-core` (Rust)
- Reference implementation: `web/packages/core-ts` (TypeScript, strictly behavior-identical)
- Conformance contract: `protocol/vectors/*.json` (golden vectors; both engines must pass)
- TS type definitions: `web/packages/protocol/src/types.ts`

## Conventions

- **Protocol version: 1** (`PROTOCOL_VERSION`, exported from `@velocut/protocol`). Incremented only on breaking changes to the command set or the error contract; persisted documents carry a separate, independent `formatVersion` (see `migrate.ts`)
- All times are **integer microseconds** (`TimeUs`), 1 second = 1_000_000; boundary validation (zod) rejects fractions — both engines address time as integers, and fractions would produce different rounding results
- All JSON fields are camelCase
- ids are minted by the engine (`clip_N` / `track_N` / `asset_N`); new ids are returned in the command's `events`
- Clips on the same video/text track **must not overlap** (touching end-to-start is allowed)
- When `asset.hasAudio` is omitted it defaults to `kind != image` — the same rule on the command path and the document-load path (pinned by vector 08)

## Envelope (returned by every command)

```jsonc
// success
{ "ok": true, "revision": 42, "events": [{ "kind": "clipAdded", "clipId": "clip_3", "trackId": "track_1" }] }
// failure (zero side effects on the document, including mid-batch failure)
{ "ok": false, "error": { "code": "overlap", "message": "clip would overlap clip_2" } }
```

Error codes: `notFound` | `overlap` | `invalidArg` | `locked` | `parse` | `outOfRange`.

## Command reference

| type | key fields | description |
|---|---|---|
| `addAsset` | kind, src, name, durationUs?, width?, height?, id? | Register asset metadata |
| `addTrack` | kind: video\|audio\|text, name?, index? | Create a track |
| `removeTrack` | trackId | Remove a track (including its clips) |
| `addClip` | trackId, assetId, startUs, durationUs?, sourceInUs? | Put an asset on a track |
| `addTextClip` | trackId, startUs, durationUs, text | Text clip |
| `removeClip` | clipId | Remove a clip |
| `moveClip` | clipId, startUs, trackId? | Move (only between tracks of the **same kind**; cross-kind is rejected with `invalidArg`) |
| `trimClip` | clipId, edge: in\|out, toUs | Trim; the in edge advances sourceIn in step |
| `splitClip` | clipId, atUs (timeline coordinates) | Split in two; keyframes are re-based at the split point |
| `setClipSpeed` | clipId, speed | Change speed; the source range is preserved, duration is recomputed |
| `setTransform` | clipId, transform | Write x/y/scale/rotation/opacity as a whole |
| `setClipVolume` | clipId, volume | 0–2 |
| `setText` | clipId, text | Change text content / font size / color |
| `setKeyframe` | clipId, property, keyframe | Same timeUs overwrites (relative to clip start) |
| `removeKeyframe` | clipId, property, timeUs | |
| `addEffect` / `setEffectParams` / `removeEffect` | clipId, effect/effectId, params | Effects are data; the registry lives in the frontend |
| `setTrackMuted` / `setTrackLocked` | trackId, muted/locked | A locked track rejects all edits |
| `batch` | commands[] | **Atomic**: if any command fails, everything rolls back (including the id counter) |

Keyframe `easing`: `{"kind":"linear"}` | `{"kind":"hold"}` | `{"kind":"bezier","x1":…,"y1":…,"x2":…,"y2":…}` (CSS cubic-bezier semantics).

## LLM usage examples

**"Split the first shot at 1.5s and speed the second half up to 2x"**

```json
{ "type": "batch", "commands": [
  { "type": "splitClip", "clipId": "clip_1", "atUs": 1500000 },
  { "type": "setClipSpeed", "clipId": "clip_2", "speed": 2.0 }
]}
```

(The new clip id produced by split can be read from the previous command's events; within a batch you can exploit the determinism of id minting: the next id is always `clip_{nextId}`.)

**"Add a 2-second title at the start, fading in"**

```json
{ "type": "batch", "commands": [
  { "type": "addTrack", "kind": "text", "name": "Captions", "index": 0 },
  { "type": "addTextClip", "trackId": "track_2", "startUs": 0, "durationUs": 2000000,
    "text": { "content": "New Arrival", "fontSize": 96, "color": "#ffffff" } }
]}
```

Then set opacity keyframes on the returned clipId:

```json
{ "type": "setKeyframe", "clipId": "clip_5", "property": "opacity",
  "keyframe": { "timeUs": 0, "value": 0, "easing": { "kind": "linear" } } }
```

```json
{ "type": "setKeyframe", "clipId": "clip_5", "property": "opacity",
  "keyframe": { "timeUs": 500000, "value": 1, "easing": { "kind": "linear" } } }
```

**Reading state**: `velocut.doc()` returns the full document; `velocut.evaluate(tUs)` returns the FrameGraph at that instant (a layered compositing manifest plus audio slices), used to "understand the current picture" before deciding.

## FrameGraph (evaluation output, renderer input)

```jsonc
{
  "timeUs": 2000000, "width": 1280, "height": 720,
  "layers": [ // in track order, bottom → top
    { "clipId": "clip_1", "assetId": "asset_1", "sourceTimeUs": 3500000,
      "transform": { "x": 0, "y": 0, "scaleX": 1, "scaleY": 1, "rotation": 0, "opacity": 0.8 },
      "effects": [{ "id": "fx_1", "effect": "brightnessContrast", "params": { "brightness": 0.1 } }],
      "text": null }
  ],
  "audio": [ { "clipId": "clip_1", "assetId": "asset_1", "sourceTimeUs": 3500000, "speed": 1, "gain": 1 } ]
}
```

`sourceTimeUs` already includes sourceIn and the speed mapping; `transform` already includes keyframe evaluation results. The renderer/mixer never needs to understand timeline semantics — this is what lets frontend and backend, preview and export, share a single engine.
