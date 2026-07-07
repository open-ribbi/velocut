// services/observe.ts — doc-aware orchestration of the perception engine.
//
// render-sdk's Observer perceives frames & audio (pixels → numbers, frames →
// images) with no timeline knowledge. This glue adds the document awareness:
// it turns the agent's observe request into the right set of frames to grab
// (a moment, a per-clip storyboard, a measured scan), tiles thumbnails, and
// packages a model-facing result (a text digest + images + structured data).
//
// Shared by the agent's velocut_observe tool and window.velocut.observe.

import { Observer, isolateClip, type FrameMetrics, type AudioSliceRef, type GrabSpec } from '@velocut/render-sdk';
import type { ObserveResult } from '@velocut/agent-sdk';
import type { FrameGraph, VDocument } from '@velocut/protocol';
import type { Store } from '../state/store';

export interface ObserveInput {
  /** frame = one moment; contact = thumbnail grid; scan = measured timeline;
   *  audio = fine-grained audio structure of an asset (silence gaps + onsets);
   *  shots = shot/cut segmentation of a video asset (boundaries + key times). */
  mode?: 'frame' | 'contact' | 'scan' | 'audio' | 'shots';
  /** What to look at. Omit = the composite the user sees. */
  source?: { clipId?: string; assetId?: string };
  /** frame: the instant (timeline µs; or source µs when source=assetId). */
  at?: number;
  /** contact/scan: span + sample count. */
  from?: number;
  to?: number;
  count?: number;
  /** thumb≈240 · preview≈512 · full≈doc (capped). */
  resolution?: 'thumb' | 'preview' | 'full';
  /** frame: normalised crop 0..1 to zoom into detail. */
  region?: { x: number; y: number; w: number; h: number };
  /** Skip images, return numbers only (cheap optimisation loops). */
  metricsOnly?: boolean;
}

const TARGET = { thumb: 240, preview: 512, full: 1280 } as const;
const JPEG = 'image/jpeg';

const visualClips = (doc: VDocument) =>
  doc.tracks
    .filter((t) => t.kind === 'video')
    .flatMap((t) => t.clips)
    .sort((a, b) => a.startUs - b.startUs);

const docDuration = (doc: VDocument) =>
  Math.max(0, ...doc.tracks.flatMap((t) => t.clips.map((c) => c.startUs + c.durationUs)));

const audioSlices = (fg: FrameGraph): AudioSliceRef[] =>
  fg.audio.map((a) => ({ assetId: a.assetId, sourceTimeUs: a.sourceTimeUs, gain: a.gain }));

function graphSummary(fg: FrameGraph): string {
  return (
    fg.layers
      .map((l) => {
        let s = l.assetId ? l.clipId : `${l.clipId}(text)`;
        const fx = l.effects?.map((e) => e.effect).filter(Boolean);
        if (fx?.length) s += ` effects:${fx.join('+')}`;
        if (l.transition) s += ` ←transition ${l.transition.kind}(from ${l.transition.from?.clipId})`;
        return s;
      })
      .join(', ') || '(empty frame)'
  );
}

function metricsLine(m: FrameMetrics): string {
  const tone = m.luma < 60 ? 'dark' : m.luma > 180 ? 'bright' : 'mid';
  const temp = m.temperature > 0.08 ? 'warm' : m.temperature < -0.08 ? 'cold' : 'neutral';
  return (
    `luma ${m.luma}(${tone}) contrast ${m.contrast} ${temp} sharpness ${m.sharpness} colorfulness ${m.colorfulness}` +
    (m.overexposed > 0.02 ? ` overexposed ${Math.round(m.overexposed * 100)}%` : '') +
    (m.underexposed > 0.3 ? ` underexposed ${Math.round(m.underexposed * 100)}%` : '')
  );
}

function colorDist(a: string, b: string): number {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  return (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / 3;
}

export async function observeForAgent(
  store: Store,
  observer: Observer,
  input: ObserveInput,
): Promise<ObserveResult> {
  const doc = store.getState().doc;
  if (!doc.tracks.length && !doc.assets.length) return { ok: false, summary: 'The project is empty; there is nothing to observe.', images: [] };
  const frameDur = (1e6 * doc.fpsDen) / doc.fpsNum;
  const snap = (t: number) => Math.max(0, Math.round(t / frameDur) * frameDur);
  const mode = input.mode ?? 'frame';
  const res = input.resolution ?? (mode === 'contact' ? 'thumb' : 'preview');
  const target = res === 'full' ? Math.min(TARGET.full, Math.max(doc.width, doc.height)) : TARGET[res];
  const aid = input.source?.assetId;
  const cid = input.source?.clipId;

  // ---------------------------------------------------------------- frame
  if (mode === 'frame') {
    let spec: GrabSpec;
    let audioRefs: AudioSliceRef[];
    let head: string;
    let gfx = '';
    let at: number;
    if (aid) {
      at = snap(input.at ?? 0);
      spec = { kind: 'asset', assetId: aid, sourceTimeUs: at };
      audioRefs = [{ assetId: aid, sourceTimeUs: at, gain: 1 }];
      head = `asset ${aid} source ${(at / 1e6).toFixed(2)}s`;
    } else {
      const clip = cid ? visualClips(doc).find((c) => c.id === cid) : null;
      at = snap(input.at ?? (clip ? clip.startUs + clip.durationUs / 2 : 0));
      const full = store.evaluate(at);
      spec = { kind: 'graph', fg: cid ? isolateClip(full, cid) : full };
      audioRefs = audioSlices(full);
      gfx = cid ? `clip ${cid} only` : graphSummary(full);
      head = `${cid ? 'clip ' + cid : 'composite'} @${(at / 1e6).toFixed(2)}s`;
    }
    const grab = await observer.grab(spec, target, input.region);
    if (!grab) return { ok: false, summary: `${head}: nothing renderable (not decoded yet, or out of range).`, images: [] };
    const audio = await observer.audio(audioRefs, at);
    const images = input.metricsOnly ? [] : [{ base64: await observer.toJpeg(grab.bitmap), mediaType: JPEG }];
    grab.bitmap.close();
    return {
      ok: true,
      summary: `${head} | ${metricsLine(grab.metrics)} | audio ${audio.loudnessDbfs}dBFS${audio.silent ? '(silent)' : ''}${gfx ? ' | ' + gfx : ''}`,
      images,
      data: { metrics: grab.metrics, audio, graph: gfx },
    };
  }

  // -------------------------------------------------------------- contact
  if (mode === 'contact') {
    const cap = 24;
    const points: { t: number; label: string }[] = [];
    const span = input.from != null && input.to != null;
    if (aid) {
      const dur = doc.assets.find((a) => a.id === aid)?.durationUs ?? 0;
      const from = input.from ?? 0;
      const to = input.to ?? dur;
      const n = Math.min(cap, Math.max(2, input.count ?? 12));
      for (let i = 0; i < n; i++) {
        const t = from + ((to - from) * i) / (n - 1 || 1);
        points.push({ t: snap(t), label: `${(t / 1e6).toFixed(0)}s` });
      }
    } else if (span) {
      const n = Math.min(cap, Math.max(2, input.count ?? 12));
      for (let i = 0; i < n; i++) {
        const t = input.from! + ((input.to! - input.from!) * i) / (n - 1 || 1);
        points.push({ t: snap(t), label: `${(t / 1e6).toFixed(1)}s` });
      }
    } else {
      // storyboard: one frame per video clip (midpoint).
      const clips = visualClips(doc);
      if (clips.length <= cap) {
        clips.forEach((c) => points.push({ t: snap(c.startUs + c.durationUs / 2), label: c.id }));
      } else {
        const total = docDuration(doc);
        for (let i = 0; i < cap; i++) {
          const t = (total * i) / (cap - 1 || 1);
          points.push({ t: snap(t), label: `${(t / 1e6).toFixed(0)}s` });
        }
      }
    }
    const cells: { bitmap: ImageBitmap; label: string }[] = [];
    const index: { label: string; timeUs: number; luma: number; temperature: number; sharpness: number }[] = [];
    for (const p of points) {
      const spec: GrabSpec = aid ? { kind: 'asset', assetId: aid, sourceTimeUs: p.t } : { kind: 'graph', fg: store.evaluate(p.t) };
      const g = await observer.grab(spec, target);
      if (!g) continue;
      cells.push({ bitmap: g.bitmap, label: p.label });
      index.push({ label: p.label, timeUs: p.t, luma: g.metrics.luma, temperature: g.metrics.temperature, sharpness: g.metrics.sharpness });
    }
    if (!cells.length) return { ok: false, summary: 'No renderable frames (assets may not be decoded yet).', images: [] };
    const cols = Math.min(cells.length, Math.ceil(Math.sqrt(cells.length)));
    const sheet = await observer.toSheet(cells, cols, cells[0].bitmap.width, cells[0].bitmap.height);
    cells.forEach((c) => c.bitmap.close());
    const what = aid ? `asset ${aid}` : span ? 'timeline range' : 'timeline storyboard';
    return {
      ok: true,
      summary: `${what} contact sheet: ${cells.length} cells (${cols} columns); each cell is labeled with ${aid || span ? 'its time' : 'its clip id'}.`,
      images: [{ base64: sheet, mediaType: JPEG }],
      data: { cells: index },
    };
  }

  // ---------------------------------------------------------------- audio
  // Fine-grained audio structure of ONE asset's raw audio over a source range:
  // precise silence SEGMENTS (clean cut points / dialogue gaps) and energy
  // onsets (beats/hits). No images, no frame render — cheap at ~21 ms resolution.
  if (mode === 'audio') {
    const a = aid ?? doc.assets.find((x) => x.kind === 'audio' || x.hasAudio)?.id;
    if (!a) return { ok: false, summary: 'No audio asset to analyze (pass {assetId} in source, or import an asset with audio first).', images: [] };
    const assetDur = doc.assets.find((x) => x.id === a)?.durationUs ?? 0;
    const from = Math.max(0, input.from ?? 0);
    // Default to a 30 s window (fine analysis over the whole source is wasteful —
    // narrow with scan first, then analyze the window of interest).
    const to = Math.min(assetDur || from + 30_000_000, input.to ?? from + 30_000_000);
    const r = await observer.analyzeAudio(a, from, to);
    const sil = r.silences.map((s) => `${(s.startUs / 1e6).toFixed(2)}–${(s.endUs / 1e6).toFixed(2)}`);
    const pk = r.peaks.map((p) => (p.atUs / 1e6).toFixed(2));
    return {
      ok: true,
      summary:
        `Asset ${a} audio analysis ${(from / 1e6).toFixed(1)}–${(to / 1e6).toFixed(1)}s (resolution ${Math.round(r.hopUs / 1000)}ms).` +
        ` Silent segments≈[${sil.slice(0, 15).join(', ')}]s (clean cut points / dialogue gaps; cutting at a segment's midpoint avoids clipping speech);` +
        ` energy peaks≈[${pk.slice(0, 20).join(', ')}]s (for beat-syncing / locating highlight starts).`,
      images: [],
      data: r,
    };
  }

  // ----------------------------------------------------------------- shots
  // Shot/cut segmentation of ONE video asset's source footage — the visual peer
  // of the audio analysis. One forward decode (cheap, cached), returns the shot
  // boundaries so the agent can reason BY SHOT: cut on real boundaries, align
  // inserts to cuts, measure pacing, locate a shot. Times are SOURCE µs.
  if (mode === 'shots') {
    const target =
      aid ??
      (cid ? visualClips(doc).find((c) => c.id === cid)?.assetId : undefined) ??
      doc.assets.find((a) => a.kind === 'video')?.id;
    if (!target) return { ok: false, summary: 'No video asset to analyze (pass {assetId}/{clipId} in source, or import a video first).', images: [] };
    const r = await observer.analyzeShots(target);
    if (!r.shots.length) return { ok: false, summary: `Asset ${target} produced no decodable frames; cannot segment shots.`, images: [], data: r };
    const durs = r.shots.map((s) => s.durationUs / 1e6);
    const avg = durs.reduce((s, x) => s + x, 0) / durs.length;
    const minD = durs.reduce((m, x) => Math.min(m, x), Infinity);
    const maxD = durs.reduce((m, x) => Math.max(m, x), 0);
    const cuts = r.shots.slice(1).map((s) => +(s.startUs / 1e6).toFixed(1)); // cut times (skip the 0 start)
    return {
      ok: true,
      summary:
        `Asset ${target} shot segmentation: ${r.shots.length} shots (source ${(r.fromUs / 1e6).toFixed(1)}–${(r.toUs / 1e6).toFixed(1)}s, sampled at ${Math.round(1e6 / r.sampleUs)}fps).` +
        ` Average shot ${avg.toFixed(1)}s (shortest ${minD.toFixed(1)} / longest ${maxD.toFixed(1)}).` +
        ` Cut points (source time)≈[${cuts.slice(0, 20).join(', ')}]s${cuts.length > 20 ? ' …' : ''}.` +
        ` Cutting/inserting at cut points looks more natural; shot duration = pacing, so long shots can be sped up or trimmed accordingly.`,
      images: [],
      data: r,
    };
  }

  // ----------------------------------------------------------------- scan
  // Measured timeline (no images): loudness + brightness + scene-change score.
  const cap = 120;
  const from = input.from ?? 0;
  const to = input.to ?? (aid ? doc.assets.find((a) => a.id === aid)?.durationUs ?? 0 : docDuration(doc));
  const n = Math.min(cap, Math.max(2, input.count ?? 60));
  const windows: { atUs: number; loudnessDbfs: number; silent: boolean; luma: number | null; sceneScore: number }[] = [];
  let prev: FrameMetrics | null = null;
  for (let i = 0; i < n; i++) {
    const t = snap(from + ((to - from) * i) / (n - 1 || 1));
    let spec: GrabSpec;
    let audioRefs: AudioSliceRef[];
    if (aid) {
      spec = { kind: 'asset', assetId: aid, sourceTimeUs: t };
      audioRefs = [{ assetId: aid, sourceTimeUs: t, gain: 1 }];
    } else {
      const fg = store.evaluate(t);
      spec = { kind: 'graph', fg };
      audioRefs = audioSlices(fg);
    }
    const g = await observer.grab(spec, 160);
    const a = await observer.audio(audioRefs, t, 200_000);
    const m = g?.metrics ?? null;
    if (g) g.bitmap.close();
    const sceneScore =
      prev && m ? Math.round(Math.abs(m.luma - prev.luma) + colorDist(m.avgColor, prev.avgColor) + Math.abs(m.colorfulness - prev.colorfulness)) : 0;
    if (m) prev = m;
    windows.push({ atUs: t, loudnessDbfs: a.loudnessDbfs, silent: a.silent, luma: m?.luma ?? null, sceneScore });
  }
  // Digest: silence gaps, loud peaks, big visual changes.
  const silences = windows.filter((w) => w.silent).map((w) => +(w.atUs / 1e6).toFixed(1));
  const cuts = windows
    .map((w, i) => ({ w, i }))
    .filter(({ w }) => w.sceneScore > 60)
    .map(({ w }) => +(w.atUs / 1e6).toFixed(1));
  const loud = [...windows].sort((a, b) => b.loudnessDbfs - a.loudnessDbfs).slice(0, 3).map((w) => +(w.atUs / 1e6).toFixed(1));
  return {
    ok: true,
    summary:
      `Scan ${(from / 1e6).toFixed(1)}–${(to / 1e6).toFixed(1)}s, ${n} windows.` +
      ` Silence points≈[${silences.slice(0, 12).join(', ')}]s;` +
      ` likely shot changes≈[${cuts.slice(0, 12).join(', ')}]s;` +
      ` loudest moments≈[${loud.join(', ')}]s.`,
    images: [],
    data: { windows },
  };
}
