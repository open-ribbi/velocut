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
        let s = l.assetId ? l.clipId : `${l.clipId}(文字)`;
        const fx = l.effects?.map((e) => e.effect).filter(Boolean);
        if (fx?.length) s += ` 特效:${fx.join('+')}`;
        if (l.transition) s += ` ←转场${l.transition.kind}(自${l.transition.from?.clipId})`;
        return s;
      })
      .join(', ') || '(空帧)'
  );
}

function metricsLine(m: FrameMetrics): string {
  const tone = m.luma < 60 ? '暗' : m.luma > 180 ? '亮' : '中';
  const temp = m.temperature > 0.08 ? '暖' : m.temperature < -0.08 ? '冷' : '中性';
  return (
    `luma ${m.luma}(${tone}) 对比 ${m.contrast} ${temp} 锐度 ${m.sharpness} 鲜艳 ${m.colorfulness}` +
    (m.overexposed > 0.02 ? ` 过曝${Math.round(m.overexposed * 100)}%` : '') +
    (m.underexposed > 0.3 ? ` 欠曝${Math.round(m.underexposed * 100)}%` : '')
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
  if (!doc.tracks.length && !doc.assets.length) return { ok: false, summary: '工程为空,没有可观察的内容。', images: [] };
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
      head = `素材 ${aid} 源${(at / 1e6).toFixed(2)}s`;
    } else {
      const clip = cid ? visualClips(doc).find((c) => c.id === cid) : null;
      at = snap(input.at ?? (clip ? clip.startUs + clip.durationUs / 2 : 0));
      const full = store.evaluate(at);
      spec = { kind: 'graph', fg: cid ? isolateClip(full, cid) : full };
      audioRefs = audioSlices(full);
      gfx = cid ? `仅片段 ${cid}` : graphSummary(full);
      head = `${cid ? '片段 ' + cid : '合成'} @${(at / 1e6).toFixed(2)}s`;
    }
    const grab = await observer.grab(spec, target, input.region);
    if (!grab) return { ok: false, summary: `${head}: 无可渲染内容(未解码或越界)。`, images: [] };
    const audio = await observer.audio(audioRefs, at);
    const images = input.metricsOnly ? [] : [{ base64: await observer.toJpeg(grab.bitmap), mediaType: JPEG }];
    grab.bitmap.close();
    return {
      ok: true,
      summary: `${head} | ${metricsLine(grab.metrics)} | 音频 ${audio.loudnessDbfs}dBFS${audio.silent ? '(静音)' : ''}${gfx ? ' | ' + gfx : ''}`,
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
    if (!cells.length) return { ok: false, summary: '没有可渲染的帧(素材可能尚未解码)。', images: [] };
    const cols = Math.min(cells.length, Math.ceil(Math.sqrt(cells.length)));
    const sheet = await observer.toSheet(cells, cols, cells[0].bitmap.width, cells[0].bitmap.height);
    cells.forEach((c) => c.bitmap.close());
    const what = aid ? `素材 ${aid}` : span ? '时间轴区间' : '时间轴分镜';
    return {
      ok: true,
      summary: `${what} 接触印像 ${cells.length} 格(${cols} 列),格上标注为${aid || span ? '时间' : '片段 id'}。`,
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
    if (!a) return { ok: false, summary: '没有可分析的音频素材(source 传 {assetId} 或先导入含音频的素材)。', images: [] };
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
        `素材 ${a} 音频分析 ${(from / 1e6).toFixed(1)}–${(to / 1e6).toFixed(1)}s(分辨率 ${Math.round(r.hopUs / 1000)}ms)。` +
        ` 静音段≈[${sil.slice(0, 15).join(', ')}]s(可做干净切点/对白缝,在段中点切不切断台词);` +
        ` 能量峰≈[${pk.slice(0, 20).join(', ')}]s(卡节拍/找高光起点)。`,
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
    if (!target) return { ok: false, summary: '没有可分析的视频素材(source 传 {assetId}/{clipId},或先导入视频)。', images: [] };
    const r = await observer.analyzeShots(target);
    if (!r.shots.length) return { ok: false, summary: `素材 ${target} 未能解码出帧,无法切分镜头。`, images: [], data: r };
    const durs = r.shots.map((s) => s.durationUs / 1e6);
    const avg = durs.reduce((s, x) => s + x, 0) / durs.length;
    const minD = durs.reduce((m, x) => Math.min(m, x), Infinity);
    const maxD = durs.reduce((m, x) => Math.max(m, x), 0);
    const cuts = r.shots.slice(1).map((s) => +(s.startUs / 1e6).toFixed(1)); // cut times (skip the 0 start)
    return {
      ok: true,
      summary:
        `素材 ${target} 镜头切分:${r.shots.length} 个镜头(源 ${(r.fromUs / 1e6).toFixed(1)}–${(r.toUs / 1e6).toFixed(1)}s,采样 ${Math.round(1e6 / r.sampleUs)}fps)。` +
        ` 平均镜头 ${avg.toFixed(1)}s(最短 ${minD.toFixed(1)} / 最长 ${maxD.toFixed(1)})。` +
        ` 切点(源时间)≈[${cuts.slice(0, 20).join(', ')}]s${cuts.length > 20 ? ' …' : ''}。` +
        ` 在切点处剪辑/插入更自然;镜头时长=节奏,可据此对长镜头提速或裁剪。`,
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
      `扫描 ${(from / 1e6).toFixed(1)}–${(to / 1e6).toFixed(1)}s,${n} 窗。` +
      ` 静音点≈[${silences.slice(0, 12).join(', ')}]s;` +
      ` 疑似镜头切换≈[${cuts.slice(0, 12).join(', ')}]s;` +
      ` 最响时刻≈[${loud.join(', ')}]s。`,
    images: [],
    data: { windows },
  };
}
