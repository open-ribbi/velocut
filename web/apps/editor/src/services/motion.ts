// services/motion.ts — the velocut.motionClip primitive.
//
// An agent-authored, deterministic, 2D-canvas motion-graphics clip. Per the
// canvas-animation analysis the split is:
//   • GSAP is the TIMING SPINE — the agent builds a PAUSED timeline over plain
//     objects; velocut seeks it to the frame time. GSAP removes the #1 LLM canvas
//     bug (hand-rolled easing/interpolation math) and gives nested timelines,
//     named eases, stagger, etc. It tweens NUMBERS; it never draws.
//   • velocut OWNS the draw via a helper kit (h) that absorbs the chronic canvas
//     pitfalls: fixed-resolution raster (no devicePixelRatio math — the asset IS
//     the output resolution), font-ready gating, text measurement/word-wrap,
//     shadows, gradients, deterministic seeded randomness.
//
// The SPEC is stored, not the frames: render(index) rasterizes on demand at
// preview AND export (MediaLibrary.attachMotion), so a long clip costs ~one
// resident frame and export re-renders deterministically — exactly how the text
// clip behaves. Mirrors services/tts.ts (generate → addAsset + addClip).

import gsap from 'gsap';
import type { MediaLibrary } from '@velocut/render-sdk';
import type { Store } from '../state/store';

type Ctx = OffscreenCanvasRenderingContext2D;

export interface TextOpts {
  x?: number;
  y?: number;
  size?: number;
  font?: string;
  weight?: string | number;
  color?: string | CanvasGradient;
  align?: CanvasTextAlign;
  baseline?: CanvasTextBaseline;
  /** Wrap to this width (measured, CJK-aware); omit for single-line / explicit \n. */
  maxWidth?: number;
  lineHeight?: number;
  opacity?: number;
  /** Outline drawn under the fill (good for legibility over busy footage). */
  stroke?: string;
  strokeWidth?: number;
  shadowColor?: string;
  shadowBlur?: number;
  shadowX?: number;
  shadowY?: number;
}

/** The draw surface handed to build()/draw() — collapses the raw-ctx error surface. */
export interface MotionHelpers {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  /** The GSAP namespace (utils, eases, etc.). Tweens are added to the timeline
   *  passed to build(); use this for gsap.utils / extra timelines. */
  gsap: typeof gsap;
  /** Draw text with measured word-wrap, alignment, optional outline + shadow.
   *  Returns the laid-out block size so you can stack elements. */
  text(str: string, o?: TextOpts): { width: number; height: number; lines: number };
  /** Rounded-rect fill/stroke (e.g. a subtitle bar or card background). */
  roundRect(
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
    o?: { fill?: string | CanvasGradient; stroke?: string; lineWidth?: number },
  ): void;
  linearGradient(x0: number, y0: number, x1: number, y1: number, stops: [number, string][]): CanvasGradient;
  radialGradient(
    x0: number,
    y0: number,
    r0: number,
    x1: number,
    y1: number,
    r1: number,
    stops: [number, string][],
  ): CanvasGradient;
  /** A preloaded image (from motionClip `images`), or undefined if it failed. */
  img(name: string): CanvasImageSource | undefined;
  lerp(a: number, b: number, p: number): number;
  map(v: number, inMin: number, inMax: number, outMin: number, outMax: number, clampTo?: boolean): number;
  clamp(v: number, lo: number, hi: number): number;
  /** Deterministic seeded PRNG factory — GSAP randomness has no seed, so use
   *  this for any per-frame randomness you need reproducible across renders. */
  rng(seed: number): () => number;
}

export interface MotionClipOptions {
  /** Per-frame draw: paint the whole frame to `ctx` using helpers `h`. Called
   *  AFTER the timeline is seeked to `t` (seconds). Must be deterministic. */
  draw: (ctx: Ctx, t: number, h: MotionHelpers) => void;
  /** Optional one-time setup: populate the PAUSED gsap timeline `tl` with tweens
   *  over your own objects (e.g. tl.to(title, {opacity:1, duration:0.4})). */
  build?: (tl: gsap.core.Timeline, h: MotionHelpers) => void;
  durationUs: number;
  fps?: number;
  width?: number;
  height?: number;
  atUs?: number;
  trackId?: string;
  name?: string;
  /** CORS-enabled image URLs preloaded before the first frame, reachable via h.img(name). */
  images?: Record<string, string>;
}

export interface MotionResult {
  ok: boolean;
  assetId?: string;
  clipId?: string;
  trackId?: string;
  atUs?: number;
  durationUs?: number;
  frameCount?: number;
  message?: string;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** mulberry32 — tiny deterministic PRNG; seed in, stream of [0,1) out. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** CJK-aware greedy word-wrap against measured pixel width. */
function wrapText(ctx: Ctx, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const tokens =
      para.match(/[　-〿㐀-鿿＀-￯]|[^\s　-〿㐀-鿿＀-￯]+|\s+/g) ?? [];
    let line = '';
    for (const tk of tokens) {
      const test = line + tk;
      if (line.trim() && ctx.measureText(test).width > maxWidth) {
        out.push(line.replace(/\s+$/, ''));
        line = /^\s+$/.test(tk) ? '' : tk;
      } else {
        line = test;
      }
    }
    out.push(line.replace(/\s+$/, ''));
  }
  return out;
}

function makeHelpers(ctx: Ctx, env: { width: number; height: number; fps: number; images: Map<string, CanvasImageSource> }): MotionHelpers {
  return {
    width: env.width,
    height: env.height,
    fps: env.fps,
    gsap,
    text(str, o = {}) {
      const size = o.size ?? 48;
      const lineHeight = o.lineHeight ?? size * 1.25;
      ctx.save();
      ctx.font = `${o.weight ?? 700} ${size}px ${o.font ?? 'sans-serif'}`;
      ctx.textAlign = o.align ?? 'left';
      ctx.textBaseline = o.baseline ?? 'top';
      if (o.opacity != null) ctx.globalAlpha = o.opacity;
      const lines = o.maxWidth != null ? wrapText(ctx, str, o.maxWidth) : str.split('\n');
      const measured = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
      const x = o.x ?? 0;
      const y0 = o.y ?? 0;
      for (let i = 0; i < lines.length; i++) {
        const y = y0 + i * lineHeight;
        if (o.stroke) {
          ctx.lineWidth = o.strokeWidth ?? Math.max(2, size * 0.08);
          ctx.strokeStyle = o.stroke;
          ctx.lineJoin = 'round';
          ctx.strokeText(lines[i], x, y);
        }
        if (o.shadowColor) {
          ctx.shadowColor = o.shadowColor;
          ctx.shadowBlur = o.shadowBlur ?? 0;
          ctx.shadowOffsetX = o.shadowX ?? 0;
          ctx.shadowOffsetY = o.shadowY ?? 0;
        }
        ctx.fillStyle = o.color ?? '#ffffff';
        ctx.fillText(lines[i], x, y);
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
      }
      ctx.restore();
      return { width: measured, height: lines.length * lineHeight, lines: lines.length };
    },
    roundRect(x, y, w, h, r, o = {}) {
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, r);
      if (o.fill) {
        ctx.fillStyle = o.fill;
        ctx.fill();
      }
      if (o.stroke) {
        ctx.lineWidth = o.lineWidth ?? 2;
        ctx.strokeStyle = o.stroke;
        ctx.stroke();
      }
      ctx.restore();
    },
    linearGradient(x0, y0, x1, y1, stops) {
      const g = ctx.createLinearGradient(x0, y0, x1, y1);
      for (const [off, col] of stops) g.addColorStop(off, col);
      return g;
    },
    radialGradient(x0, y0, r0, x1, y1, r1, stops) {
      const g = ctx.createRadialGradient(x0, y0, r0, x1, y1, r1);
      for (const [off, col] of stops) g.addColorStop(off, col);
      return g;
    },
    img: (name) => env.images.get(name),
    lerp: (a, b, p) => a + (b - a) * p,
    map: (v, inMin, inMax, outMin, outMax, clampTo) => {
      const t = (v - inMin) / (inMax - inMin || 1);
      const c = clampTo ? Math.max(0, Math.min(1, t)) : t;
      return outMin + c * (outMax - outMin);
    },
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    rng: (seed) => mulberry32(seed),
  };
}

/** GSAP is a wall-clock-coupled engine by default; sever lag-smoothing once so a
 *  paused timeline's seek() is a pure function of the value we pass. */
let lagSevered = false;

/**
 * Build a procedural canvas-animation clip and lay it on a 图形 (graphics) video
 * track. Same surface as window.velocut.motionClip and the agent's velocut_script
 * `velocut.motionClip`. The draw program is stored and rasterized per frame, so
 * it composites in preview and re-renders deterministically on export.
 */
export async function createMotionClip(store: Store, media: MediaLibrary, opts: MotionClipOptions): Promise<MotionResult> {
  if (typeof opts?.draw !== 'function') return { ok: false, message: '需要 draw(ctx, t, h) 函数。' };
  const durationUs = Math.round(opts.durationUs);
  if (!(durationUs > 0)) return { ok: false, message: 'durationUs 必须为正整数(微秒)。' };

  const doc = store.getState().doc;
  const width = Math.round(opts.width ?? doc.width);
  const height = Math.round(opts.height ?? doc.height);
  const fps = opts.fps ?? (doc.fpsNum / doc.fpsDen || 30);
  const frameDurUs = Math.max(1, Math.round(1e6 / fps));
  const frameCount = Math.max(1, Math.ceil(durationUs / frameDurUs));

  // Readiness gate: decode images (CORS) + fonts BEFORE the first raster, so text
  // metrics and pixels exist (the two classic canvas-readiness bugs).
  const images = new Map<string, CanvasImageSource>();
  if (opts.images) {
    await Promise.all(
      Object.entries(opts.images).map(async ([k, url]) => {
        try {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.src = url;
          await im.decode();
          images.set(k, im);
        } catch {
          /* leave missing — h.img(name) returns undefined, draw handles it */
        }
      }),
    );
  }
  try {
    await document.fonts.ready;
  } catch {
    /* ignore — fall back to whatever is loaded */
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) return { ok: false, message: '无法创建 2D canvas 上下文。' };
  const h = makeHelpers(ctx, { width, height, fps, images });

  // GSAP timing spine: a PAUSED master timeline the agent populates; seek per frame.
  if (!lagSevered) {
    gsap.ticker.lagSmoothing(0);
    lagSevered = true;
  }
  const tl = gsap.timeline({ paused: true });
  try {
    opts.build?.(tl, h);
  } catch (e) {
    return { ok: false, message: 'build() 出错:' + errMsg(e) };
  }

  const render = (index: number): VideoFrame => {
    const clamped = Math.max(0, Math.min(frameCount - 1, index));
    const tSec = (clamped * frameDurUs) / 1e6;
    if (tl.duration() > 0) tl.seek(tSec); // suppressEvents defaults true → no callback double-fire on scrub
    ctx.clearRect(0, 0, width, height);
    opts.draw(ctx, tSec, h);
    return new VideoFrame(canvas, { timestamp: clamped * frameDurUs, duration: frameDurUs });
  };

  // Validate frame 0 once so a broken draw fails the script with a message
  // instead of silently breaking preview/export later.
  try {
    render(0).close();
  } catch (e) {
    return { ok: false, message: 'draw() 首帧渲染出错:' + errMsg(e) };
  }

  // Resolve the graphics track (reuse a video track named 图形, else create one
  // — appended last so overlays composite on top).
  let trackId = opts.trackId;
  if (!trackId) {
    const existing = store.getState().doc.tracks.find((t) => t.kind === 'video' && t.name === '图形');
    if (existing) trackId = existing.id;
    else {
      const r = store.dispatch({ type: 'addTrack', kind: 'video', name: '图形' });
      const ev = r.ok ? r.events.find((e) => e.kind === 'trackAdded') : undefined;
      trackId = ev?.kind === 'trackAdded' ? ev.trackId : undefined;
    }
  }
  if (!trackId) return { ok: false, message: '无法创建图形轨。' };

  const atUs = Math.max(0, Math.round(opts.atUs ?? 0));
  const name = opts.name ?? '动态图形';
  const aResp = store.dispatch({
    type: 'addAsset',
    kind: 'image',
    src: `motion://${encodeURIComponent(name)}`,
    name,
    durationUs,
    width,
    height,
  });
  const aEv = aResp.ok ? aResp.events.find((e) => e.kind === 'assetAdded') : undefined;
  const assetId = aEv?.kind === 'assetAdded' ? aEv.assetId : undefined;
  if (!assetId) return { ok: false, message: '登记图形素材失败。' };
  media.attachMotion(assetId, render, { width, height, frameDurUs, frameCount });

  const cResp = store.dispatch({ type: 'addClip', trackId, assetId, startUs: atUs, durationUs });
  if (!cResp.ok) return { ok: false, message: `上轨失败:${cResp.error?.message ?? ''}` };
  const cEv = cResp.events.find((e) => e.kind === 'clipAdded');
  const clipId = cEv?.kind === 'clipAdded' ? cEv.clipId : undefined;
  return { ok: true, assetId, clipId, trackId, atUs, durationUs, frameCount };
}
