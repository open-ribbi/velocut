// observe.ts — the AI perception engine ("render-and-see").
//
// Turns the timeline into things a model can actually perceive: a frame-EXACT
// rendered image of any moment (the composite the user sees, or one clip in
// isolation, or raw asset content), plus quantitative metrics (exposure, colour,
// sharpness, loudness) so the agent can both *look* (qualitative) and *measure*
// (quantitative) — and run cheap measure-only optimisation loops without paying
// image tokens every iteration.
//
// Design notes that matter:
//  - Deterministic & == export: renders go through a dedicated offscreen,
//    frame-exact path (exactFrame + an offscreen Renderer), NOT the live preview
//    swapchain (whose pixels can't be read back and whose state depends on the
//    playhead). The image the AI sees is the frame that will be exported.
//  - Resolution-free geometry: the renderer maps layers using the FrameGraph's
//    doc size, so the SAME graph rendered to a small canvas yields a correctly
//    downscaled thumbnail — we render straight at the requested size.
//  - This module stays free of timeline/document semantics (render-sdk's
//    contract). It perceives frames & audio slices; the app layer orchestrates
//    doc-aware modes (storyboard over clips, scan over windows).

import type { FrameGraph, Layer } from '@velocut/protocol';
import { Renderer } from './renderer';
import type { MediaLibrary } from './media';

/** Quantitative readouts of one rendered frame — the "instruments". */
export interface FrameMetrics {
  width: number;
  height: number;
  /** Mean luma 0..255. */
  luma: number;
  /** Luma standard deviation — global contrast. */
  contrast: number;
  /** Fraction (0..1) of pixels crushed to black / blown to white. */
  underexposed: number;
  overexposed: number;
  /** Top dominant colours (coarse-quantised), most-frequent first. */
  dominantColors: { hex: string; pct: number }[];
  /** Average colour and a warm(+)/cool(−) temperature estimate (−1..1). */
  avgColor: string;
  temperature: number;
  /** Relative high-frequency energy — focus/blur proxy (higher = sharper). */
  sharpness: number;
  /** Hasler–Süsstrunk colourfulness (≈0 grey … 100+ vivid). */
  colorfulness: number;
}

/** Loudness of the composite audio in a window around an instant. */
export interface AudioMetrics {
  /** RMS level in dBFS (−∞..0). A loudness proxy (not K-weighted LUFS). */
  loudnessDbfs: number;
  peakDbfs: number;
  silent: boolean;
}

export interface AudioSliceRef {
  assetId: string;
  sourceTimeUs: number;
  gain: number;
}

/** Fine-grained audio structure over a range — the agent's "ears" for editing
 *  decisions a per-instant loudness can't make: where the clean cut points are
 *  (silence gaps between dialogue), and where the hits/beats land (onsets). */
export interface AudioAnalysis {
  fromUs: number;
  toUs: number;
  /** Analysis hop (time resolution) in µs. */
  hopUs: number;
  sampleRate: number;
  /** Loudness curve (dBFS per hop), downsampled for the digest if very long. */
  loudness: number[];
  /** Contiguous below-threshold stretches — safe cut points / dialogue gaps. */
  silences: { startUs: number; endUs: number }[];
  /** Energy onsets (sharp rises / local maxima) — beats, hits, action starts. */
  peaks: { atUs: number; dbfs: number }[];
}

/** One detected shot (a continuous take between two hard cuts). */
export interface Shot {
  index: number;
  startUs: number;
  endUs: number;
  durationUs: number;
  /** Representative (mid) instant — a good time to grab a thumbnail. */
  keyUs: number;
}

/** Shot segmentation of a video asset — the visual peer of {@link AudioAnalysis}.
 *  Where the audio analysis finds clean cut points (silences) and beats (onsets),
 *  this finds where the FOOTAGE itself cuts, so the agent can reason by shot:
 *  cut on real boundaries (never mid-shot), align inserts to cuts, measure pacing,
 *  drop dead/duplicate shots, locate "the shot where X". */
export interface ShotAnalysis {
  assetId: string;
  fromUs: number;
  toUs: number;
  /** Frame-sampling grid spacing (µs). */
  sampleUs: number;
  shots: Shot[];
  /** Per-sample frame-to-frame difference (0..1), downsampled for the digest. */
  diffCurve: number[];
  /** Cut threshold used (adaptive) — for tuning/debug. */
  threshold: number;
}

/** A thing to render: the composite (or a clip-isolated) FrameGraph, or raw
 *  asset content at a source instant. */
export type GrabSpec =
  | { kind: 'graph'; fg: FrameGraph }
  | { kind: 'asset'; assetId: string; sourceTimeUs: number };

export interface GrabResult {
  bitmap: ImageBitmap;
  metrics: FrameMetrics;
}

/** Restrict a FrameGraph to a single clip's layer (drop other layers and any
 *  transition) — used to render one clip "in isolation". */
export function isolateClip(fg: FrameGraph, clipId: string): FrameGraph {
  const layer = fg.layers.find((l) => l.clipId === clipId);
  const layers: Layer[] = layer ? [{ ...layer, transition: undefined }] : [];
  return { ...fg, layers };
}

export class Observer {
  private renderer: Renderer | null = null;
  private gl: OffscreenCanvas | null = null;
  private glReady: Promise<void> | null = null;
  /** 2D scratch for readback / tiling. */
  private c2d = new OffscreenCanvas(16, 16);
  private ctx = this.c2d.getContext('2d', { willReadFrequently: true })!;
  /** Shot segmentation is a full forward decode — cache per asset (an asset's
   *  source never changes within a session) so repeat calls are free. */
  private shotCache = new Map<string, ShotAnalysis>();

  constructor(private media: MediaLibrary) {}

  private async ensureRenderer(): Promise<Renderer> {
    if (this.renderer) return this.renderer;
    if (!this.glReady) {
      this.gl = new OffscreenCanvas(16, 16);
      const r = new Renderer();
      this.renderer = r;
      this.glReady = r.init(this.gl);
    }
    await this.glReady;
    return this.renderer!;
  }

  /** Fit (w,h) into a `target` longest side, even dimensions, ≥2px. */
  private fit(w: number, h: number, target: number): [number, number] {
    const s = Math.min(1, target / Math.max(w, h));
    const round2 = (n: number) => Math.max(2, Math.round((n * s) / 2) * 2);
    return [round2(w), round2(h)];
  }

  /** Render a spec to a target longest-side size and return a bitmap + metrics.
   *  `region` (normalised 0..1 crop of the frame) zooms in for fine detail. */
  async grab(
    spec: GrabSpec,
    target: number,
    region?: { x: number; y: number; w: number; h: number },
  ): Promise<GrabResult | null> {
    let vf: VideoFrame | null = null;
    let srcW: number;
    let srcH: number;
    if (spec.kind === 'asset') {
      vf = await this.media.exactFrame(spec.assetId, spec.sourceTimeUs);
      if (!vf) return null;
      srcW = vf.displayWidth;
      srcH = vf.displayHeight;
    } else {
      const fg = spec.fg;
      const r = await this.ensureRenderer();
      const [cw, ch] = this.fit(fg.width, fg.height, target);
      this.gl!.width = cw;
      this.gl!.height = ch;
      // Gather frame-exact source frames for every layer (and any transition's
      // outgoing side) — the offline, deterministic decode path.
      const frames = new Map<string, VideoFrame>();
      for (const layer of fg.layers) {
        if (layer.assetId && !frames.has(layer.clipId)) {
          const f = await this.media.exactFrame(layer.assetId, layer.sourceTimeUs);
          if (f) frames.set(layer.clipId, f);
        }
        const from = layer.transition?.from;
        if (from?.assetId && !frames.has(from.clipId)) {
          const f = await this.media.exactFrame(from.assetId, from.sourceTimeUs);
          if (f) frames.set(from.clipId, f);
        }
      }
      r.render(fg, this.media, (id) => frames.get(id) ?? null);
      await r.workDone();
      frames.forEach((f) => f.close());
      vf = new VideoFrame(this.gl!, { timestamp: 0 });
      // The gl canvas was already rendered AT the fitted size (cw×ch) — the
      // composite is resolution-independent. So the source rect is the canvas
      // size, NOT the doc size (using fg.width/height here shrinks the content
      // into a corner whenever target < doc width).
      srcW = cw;
      srcH = ch;
    }

    // Source crop (region) in source pixels.
    const sx = region ? Math.round(region.x * srcW) : 0;
    const sy = region ? Math.round(region.y * srcH) : 0;
    const sw = region ? Math.max(1, Math.round(region.w * srcW)) : srcW;
    const sh = region ? Math.max(1, Math.round(region.h * srcH)) : srcH;
    const [dw, dh] = this.fit(sw, sh, target);
    this.c2d.width = dw;
    this.c2d.height = dh;
    this.ctx.drawImage(vf, sx, sy, sw, sh, 0, 0, dw, dh);
    vf.close();

    const img = this.ctx.getImageData(0, 0, dw, dh);
    const metrics = computeFrameMetrics(img);
    const bitmap = await createImageBitmap(this.c2d);
    return { bitmap, metrics };
  }

  /** Encode a bitmap to a base64 JPEG (no data: prefix). */
  async toJpeg(bitmap: ImageBitmap, quality = 0.82): Promise<string> {
    this.c2d.width = bitmap.width;
    this.c2d.height = bitmap.height;
    this.ctx.drawImage(bitmap, 0, 0);
    return encodeJpeg(this.c2d, quality);
  }

  /** Tile bitmaps into one contact sheet (row-major), returning a base64 JPEG.
   *  Cells are uniform; labels are drawn in a corner if provided. */
  async toSheet(
    cells: { bitmap: ImageBitmap; label?: string }[],
    cols: number,
    cellW: number,
    cellH: number,
    quality = 0.82,
  ): Promise<string> {
    const rows = Math.ceil(cells.length / cols);
    const pad = 2;
    const W = cols * (cellW + pad) + pad;
    const H = rows * (cellH + pad) + pad;
    this.c2d.width = W;
    this.c2d.height = H;
    const ctx = this.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'top';
    cells.forEach((cell, i) => {
      const cx = pad + (i % cols) * (cellW + pad);
      const cy = pad + Math.floor(i / cols) * (cellH + pad);
      ctx.drawImage(cell.bitmap, cx, cy, cellW, cellH);
      if (cell.label) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(cx, cy, ctx.measureText(cell.label).width + 6, 15);
        ctx.fillStyle = '#fff';
        ctx.fillText(cell.label, cx + 3, cy + 2);
      }
    });
    return encodeJpeg(this.c2d, quality);
  }

  /** Loudness of the mixed audio in a window around each slice's source time
   *  (the slices already carry the evaluate-time source positions). */
  async audio(slices: AudioSliceRef[], _atUs: number, windowUs = 300_000): Promise<AudioMetrics> {
    const half = windowUs / 2;
    let sumSq = 0;
    let n = 0;
    let peak = 0;
    for (const s of slices) {
      let pcm;
      try {
        pcm = await this.media.requestPcm(s.assetId, Math.max(0, s.sourceTimeUs - half), windowUs);
      } catch {
        continue;
      }
      if (!pcm?.frames) continue;
      const ch = pcm.planes[0];
      for (let i = 0; i < pcm.frames; i++) {
        const v = ch[i] * s.gain;
        sumSq += v * v;
        n++;
        const a = Math.abs(v);
        if (a > peak) peak = a;
      }
    }
    const rms = n ? Math.sqrt(sumSq / n) : 0;
    const toDb = (x: number) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
    const loudnessDbfs = Math.round(toDb(rms) * 10) / 10;
    return { loudnessDbfs, peakDbfs: Math.round(toDb(peak) * 10) / 10, silent: loudnessDbfs < -45 };
  }

  /** Fine-grained audio structure of ONE asset's raw audio over a source range.
   *  Audio-only (no frame render), so it runs at ~hop resolution (≈21 ms) and
   *  stays cheap even over tens of seconds — the agent uses it to find clean cut
   *  points (silence gaps in dialogue) and onsets (beats/hits) that the coarse,
   *  per-window scan can't resolve. Pulls PCM in chunks to bound memory. */
  async analyzeAudio(
    assetId: string,
    fromUs: number,
    toUs: number,
    opts: { silenceDb?: number; minSilenceUs?: number } = {},
  ): Promise<AudioAnalysis> {
    const silenceDb = opts.silenceDb ?? -40;
    const minSilenceUs = opts.minSilenceUs ?? 200_000;
    const dur = Math.max(0, toUs - fromUs);
    const CHUNK = 12_000_000; // pull ≤12 s of PCM at a time
    const HOP = 1024; // samples per analysis window
    const rms: number[] = [];
    let sampleRate = 48000;
    let hopUs = Math.round((HOP / sampleRate) * 1e6);
    for (let off = 0; off < dur; off += CHUNK) {
      const clen = Math.min(CHUNK, dur - off);
      let pcm;
      try {
        pcm = await this.media.requestPcm(assetId, fromUs + off, clen);
      } catch {
        break;
      }
      if (!pcm?.frames) break;
      sampleRate = pcm.sampleRate;
      hopUs = Math.round((HOP / sampleRate) * 1e6);
      // Mono downmix (mean of channels) before RMS — matches what silencedetect
      // and a listener hear, vs. trusting one channel that may differ.
      const chans = pcm.planes;
      const nc = Math.max(1, chans.length);
      for (let i = 0; i + HOP <= pcm.frames; i += HOP) {
        let s = 0;
        for (let j = 0; j < HOP; j++) {
          let m = 0;
          for (let c = 0; c < nc; c++) m += chans[c][i + j];
          m /= nc;
          s += m * m;
        }
        rms.push(Math.sqrt(s / HOP));
      }
    }
    const toDb = (x: number) => (x > 1e-6 ? 20 * Math.log10(x) : -120);
    const loud = rms.map((r) => Math.round(toDb(r) * 10) / 10);

    // Silences: contiguous hops below threshold lasting ≥ minSilence.
    const silences: { startUs: number; endUs: number }[] = [];
    const minHops = Math.max(1, Math.round(minSilenceUs / hopUs));
    let run = 0;
    for (let i = 0; i <= loud.length; i++) {
      const silent = i < loud.length && loud[i] < silenceDb;
      if (silent) run++;
      else {
        if (run >= minHops) silences.push({ startUs: fromUs + (i - run) * hopUs, endUs: fromUs + i * hopUs });
        run = 0;
      }
    }

    // Onsets: local maxima that jump ≥3 dB over the previous hop and aren't
    // quiet — beats, hits, the start of an action surge.
    const peaks: { atUs: number; dbfs: number }[] = [];
    for (let i = 1; i < loud.length - 1; i++) {
      if (loud[i] > -28 && loud[i] - loud[i - 1] >= 3 && loud[i] >= loud[i + 1]) {
        peaks.push({ atUs: fromUs + i * hopUs, dbfs: loud[i] });
      }
    }

    // Downsample the curve so the digest stays small for long ranges.
    const STEP = Math.max(1, Math.ceil(loud.length / 200));
    const loudness = STEP === 1 ? loud : loud.filter((_, i) => i % STEP === 0);
    return { fromUs, toUs, hopUs, sampleRate, loudness, silences, peaks: peaks.slice(0, 80) };
  }

  /** Normalised 4×4×4 RGB colour histogram (64 bins, Σ=1) of a small frame —
   *  the per-frame signature whose change between frames signals a cut. Reuses
   *  the c2d scratch (frames are already downscaled by the stream decoder). */
  private frameHistogram(frame: VideoFrame): Float32Array {
    const w = frame.displayWidth;
    const h = frame.displayHeight;
    if (this.c2d.width !== w || this.c2d.height !== h) {
      this.c2d.width = w;
      this.c2d.height = h;
    }
    this.ctx.drawImage(frame, 0, 0);
    const { data } = this.ctx.getImageData(0, 0, w, h);
    const hist = new Float32Array(64);
    const px = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      const key = ((data[i] >> 6) << 4) | ((data[i + 1] >> 6) << 2) | (data[i + 2] >> 6);
      hist[key]++;
    }
    if (px) for (let k = 0; k < 64; k++) hist[k] /= px;
    return hist;
  }

  /** Segment a video asset into shots (hard cuts). One forward streaming decode
   *  (decimated to ~4fps and downscaled IN the worker — the cheap proxy path,
   *  immune to open-GOP seek hangs), a colour-histogram difference per adjacent
   *  pair, then adaptive-threshold spikes = cuts. Audio's structural sibling
   *  ({@link analyzeAudio}). Cached per asset. */
  async analyzeShots(
    assetId: string,
    opts: { everyUs?: number; longSide?: number; minShotUs?: number; sensitivity?: number; force?: boolean } = {},
  ): Promise<ShotAnalysis> {
    const cached = this.shotCache.get(assetId);
    if (cached && !opts.force) return cached;

    const sampleUs = opts.everyUs ?? 250_000; // ~4 fps — fine enough for sub-second shots
    const minShotUs = opts.minShotUs ?? 400_000;
    const sensitivity = opts.sensitivity ?? 3;
    const size = this.media.assetSize(assetId);
    const [pw, ph] = size ? this.fit(size.width, size.height, opts.longSide ?? 128) : [128, 72];

    const times: number[] = [];
    const diffs: number[] = []; // diffs[i] = distance(frame i, frame i-1); diffs[0] = 0
    let prev: Float32Array | null = null;
    this.media.startStream(assetId, { everyUs: sampleUs, pw, ph });
    try {
      for (;;) {
        const pulled = await this.media.pullStreamFrame(assetId);
        if (!pulled) break;
        const hist = this.frameHistogram(pulled.frame);
        pulled.frame.close();
        if (prev) {
          let d = 0;
          for (let k = 0; k < 64; k++) d += Math.abs(hist[k] - prev[k]);
          diffs.push(d / 2); // L1 of two prob. distributions ∈ [0,2] → [0,1]
        } else {
          diffs.push(0);
        }
        times.push(pulled.cts);
        prev = hist;
      }
    } finally {
      this.media.endStream(assetId);
    }

    const fromUs = times[0] ?? 0;
    const toUs = (times[times.length - 1] ?? 0) + sampleUs;
    let shots: Shot[] = [];
    let threshold = 1;
    if (times.length) {
      // Adaptive threshold: cuts are outliers in the difference distribution.
      const body = diffs.slice(1);
      const mean = body.reduce((s, x) => s + x, 0) / Math.max(1, body.length);
      const variance = body.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, body.length);
      threshold = Math.max(0.22, mean + sensitivity * Math.sqrt(variance));
      // A hard cut is a single spike (the next frame is already in the new shot),
      // so require a local maximum to avoid double-marking a fast transition.
      const bounds = [fromUs];
      for (let i = 1; i < diffs.length; i++) {
        const isCut = diffs[i] >= threshold && diffs[i] >= diffs[i - 1] && (i + 1 >= diffs.length || diffs[i] >= diffs[i + 1]);
        if (isCut && times[i] - bounds[bounds.length - 1] >= minShotUs) bounds.push(times[i]);
      }
      bounds.push(toUs);
      shots = [];
      for (let i = 0; i < bounds.length - 1; i++) {
        const s = bounds[i];
        const e = bounds[i + 1];
        shots.push({ index: i, startUs: s, endUs: e, durationUs: e - s, keyUs: Math.round((s + e) / 2) });
      }
    }

    // Downsample the curve for the digest (like analyzeAudio's loudness).
    const STEP = Math.max(1, Math.ceil(diffs.length / 200));
    const diffCurve = (STEP === 1 ? diffs : diffs.filter((_, i) => i % STEP === 0)).map((d) => Math.round(d * 100) / 100);
    const result: ShotAnalysis = { assetId, fromUs, toUs, sampleUs, shots, diffCurve, threshold: Math.round(threshold * 100) / 100 };
    this.shotCache.set(assetId, result);
    return result;
  }

  dispose() {
    this.renderer?.dispose();
    this.renderer = null;
    this.glReady = null;
    this.shotCache.clear();
  }
}

// ---------------------------------------------------------------- metrics

const HEX = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');

/** Compute frame metrics from RGBA pixels. Samples a stride for speed on large
 *  frames; bins colour into a coarse 4×4×4 cube for dominant-colour detection. */
export function computeFrameMetrics(img: ImageData): FrameMetrics {
  const { data, width, height } = img;
  const px = width * height;
  // Stride so we touch ≈ up to 40k pixels regardless of size.
  const stride = Math.max(1, Math.floor(Math.sqrt(px / 40000)));
  let sum = 0;
  let sumSq = 0;
  let under = 0;
  let over = 0;
  let count = 0;
  let rS = 0;
  let gS = 0;
  let bS = 0;
  // colourfulness accumulators
  let rgS = 0;
  let rgSq = 0;
  let ybS = 0;
  let ybSq = 0;
  const bins = new Map<number, number>();
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      sum += l;
      sumSq += l * l;
      if (l < 16) under++;
      if (l > 240) over++;
      rS += r;
      gS += g;
      bS += b;
      const rg = r - g;
      const yb = 0.5 * (r + g) - b;
      rgS += rg;
      rgSq += rg * rg;
      ybS += yb;
      ybSq += yb * yb;
      const key = ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
      bins.set(key, (bins.get(key) ?? 0) + 1);
      count++;
    }
  }
  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  // Sharpness: mean abs horizontal+vertical luma gradient (full-res, capped work).
  let grad = 0;
  let gn = 0;
  const gstride = Math.max(1, Math.floor(stride / 2));
  for (let y = 0; y < height - gstride; y += gstride) {
    for (let x = 0; x < width - gstride; x += gstride) {
      const i = (y * width + x) * 4;
      const l = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const ix = (y * width + x + gstride) * 4;
      const iy = ((y + gstride) * width + x) * 4;
      const lx = 0.299 * data[ix] + 0.587 * data[ix + 1] + 0.114 * data[ix + 2];
      const ly = 0.299 * data[iy] + 0.587 * data[iy + 1] + 0.114 * data[iy + 2];
      grad += Math.abs(l - lx) + Math.abs(l - ly);
      gn++;
    }
  }
  const rgMean = rgS / count;
  const ybMean = ybS / count;
  const rgStd = Math.sqrt(Math.max(0, rgSq / count - rgMean * rgMean));
  const ybStd = Math.sqrt(Math.max(0, ybSq / count - ybMean * ybMean));
  const colorfulness = Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean);

  const top = [...bins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
  const dominantColors = top.map(([key, c]) => {
    const r = ((key >> 4) & 3) * 64 + 32;
    const g = ((key >> 2) & 3) * 64 + 32;
    const b = (key & 3) * 64 + 32;
    return { hex: HEX(r, g, b), pct: Math.round((c / count) * 100) / 100 };
  });
  const avgR = rS / count;
  const avgG = gS / count;
  const avgB = bS / count;
  return {
    width,
    height,
    luma: Math.round(mean),
    contrast: Math.round(Math.sqrt(variance)),
    underexposed: Math.round((under / count) * 100) / 100,
    overexposed: Math.round((over / count) * 100) / 100,
    dominantColors,
    avgColor: HEX(avgR, avgG, avgB),
    temperature: Math.round(((avgR - avgB) / 255) * 100) / 100,
    sharpness: Math.round((grad / Math.max(1, gn)) * 10) / 10,
    colorfulness: Math.round(colorfulness),
  };
}

async function encodeJpeg(canvas: OffscreenCanvas, quality: number): Promise<string> {
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  const buf = await blob.arrayBuffer();
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}
