// motionspec.ts — declarative motion-graphics spec + its trusted interpreter.
//
// A motion clip used to be an agent-authored draw(ctx,t,h) CLOSURE that the host
// eval'd per frame. That made it unserializable (lost on reload), unable to cross
// the script sandbox, and a code-execution surface. This replaces the closure with
// a DECLARATIVE spec — a JSON scene graph of layers with keyframed properties —
// that a fixed, tested interpreter here rasterizes. Because the spec is data:
//   • it persists (survives reload / export / import)
//   • it crosses the velocut_script sandbox as a plain value (no eval on the host)
//   • its expressiveness is bounded and predictable (no canvas footguns)
//
// GSAP is used ONLY to resolve named eases (parseEase) — no hand-rolled easing
// math, the one canvas bug worth avoiding — never as a live timeline.

import gsap from 'gsap';

// ---------------------------------------------------------------- spec types

/** A GSAP-named ease ('none', 'power2.out', 'back.out', 'elastic.out', …). */
export type Ease = string;

/** One keyframe: property reaches value `v` at time `t` (seconds), arriving with
 *  ease `ease` (the ease describes the segment ENDING at this keyframe). */
export interface MotionKeyframe {
  t: number;
  v: number;
  ease?: Ease;
}

/** A property value: a constant number, or a keyframe track animated over time. */
export type Animatable = number | MotionKeyframe[];

export interface MotionShadow {
  color: string;
  blur?: number;
  x?: number;
  y?: number;
}

interface LayerBase {
  /** Visible window in seconds [in, out]; omit for the whole clip. */
  in?: number;
  out?: number;
  /** Transform, each animatable. Applied as translate → rotate → scale about (x,y). */
  x?: Animatable;
  y?: Animatable;
  opacity?: Animatable; // 0..1, default 1
  scale?: Animatable; // 1 = 100%
  rotation?: Animatable; // degrees
}

export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  size?: number;
  font?: string;
  weight?: string | number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'alphabetic' | 'bottom';
  /** Wrap to this pixel width (measured, CJK-aware). */
  maxWidth?: number;
  lineHeight?: number;
  stroke?: string;
  strokeWidth?: number;
  shadow?: MotionShadow;
}

export interface RectLayer extends LayerBase {
  type: 'rect';
  w: number;
  h: number;
  radius?: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export interface EllipseLayer extends LayerBase {
  type: 'ellipse';
  w: number;
  h: number;
  fill?: string;
  stroke?: string;
  lineWidth?: number;
}

export interface ImageLayer extends LayerBase {
  type: 'image';
  /** CORS-enabled URL, decoded before the first raster. */
  src: string;
  w?: number;
  h?: number;
}

export type MotionLayer = TextLayer | RectLayer | EllipseLayer | ImageLayer;

/** A complete, serializable motion-graphics clip. */
export interface MotionSpec {
  version: 1;
  durationUs: number;
  fps?: number;
  width?: number;
  height?: number;
  /** Optional solid background fill for the whole frame (else transparent). */
  background?: string;
  layers: MotionLayer[];
}

// ---------------------------------------------------------------- interpreter

type Ctx = OffscreenCanvasRenderingContext2D;

export interface CompiledMotion {
  width: number;
  height: number;
  frameDurUs: number;
  frameCount: number;
  /** Preload images + fonts. Call once before render(). */
  load(): Promise<void>;
  /** Rasterize frame `index` → a fresh VideoFrame (caller owns/closes it). */
  render(index: number): VideoFrame;
}

const easeCache = new Map<string, (p: number) => number>();
function easeFn(name?: string): (p: number) => number {
  const key = name || 'none';
  let f = easeCache.get(key);
  if (!f) {
    try {
      f = gsap.parseEase(key) as (p: number) => number;
    } catch {
      f = (p) => p;
    }
    if (typeof f !== 'function') f = (p) => p;
    easeCache.set(key, f);
  }
  return f;
}

/** Sample an animatable property at time `t` (seconds). Constants pass through;
 *  keyframe tracks hold flat before the first / after the last key and ease
 *  between adjacent keys. Exported (as the shared Animatable sampler) so the
 *  3D scene compiler (@velocut/scene-sdk) evaluates the SAME keyframe grammar
 *  — one vocabulary for agents to learn. */
export function sampleAnimatable(a: Animatable | undefined, t: number, fallback: number): number {
  return sample(a, t, fallback);
}

function sample(a: Animatable | undefined, t: number, fallback: number): number {
  if (a == null) return fallback;
  if (typeof a === 'number') return a;
  if (a.length === 0) return fallback;
  if (t <= a[0].t) return a[0].v;
  const last = a[a.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 1; i < a.length; i++) {
    if (t <= a[i].t) {
      const k0 = a[i - 1];
      const k1 = a[i];
      const span = k1.t - k0.t || 1;
      const p = easeFn(k1.ease)((t - k0.t) / span);
      return k0.v + (k1.v - k0.v) * p;
    }
  }
  return last.v;
}

/** CJK-aware greedy word-wrap against measured pixel width. */
function wrapText(ctx: Ctx, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const tokens = para.match(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]|[^\s\u3000-\u303f\u3400-\u9fff\uff00-\uffef]+|\s+/g) ?? [];
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

function drawText(ctx: Ctx, L: TextLayer): void {
  const size = L.size ?? 48;
  const lineHeight = L.lineHeight ?? size * 1.25;
  ctx.font = `${L.weight ?? 700} ${size}px ${L.font ?? 'sans-serif'}`;
  ctx.textAlign = L.align ?? 'left';
  ctx.textBaseline = L.baseline ?? 'top';
  const lines = L.maxWidth != null ? wrapText(ctx, L.text, L.maxWidth) : L.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const y = i * lineHeight;
    if (L.stroke) {
      ctx.lineWidth = L.strokeWidth ?? Math.max(2, size * 0.08);
      ctx.strokeStyle = L.stroke;
      ctx.lineJoin = 'round';
      ctx.strokeText(lines[i], 0, y);
    }
    if (L.shadow) {
      ctx.shadowColor = L.shadow.color;
      ctx.shadowBlur = L.shadow.blur ?? 0;
      ctx.shadowOffsetX = L.shadow.x ?? 0;
      ctx.shadowOffsetY = L.shadow.y ?? 0;
    }
    ctx.fillStyle = L.color ?? '#ffffff';
    ctx.fillText(lines[i], 0, y);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
  }
}

function drawRect(ctx: Ctx, L: RectLayer): void {
  ctx.beginPath();
  ctx.roundRect(0, 0, L.w, L.h, L.radius ?? 0);
  if (L.fill) {
    ctx.fillStyle = L.fill;
    ctx.fill();
  }
  if (L.stroke) {
    ctx.lineWidth = L.lineWidth ?? 2;
    ctx.strokeStyle = L.stroke;
    ctx.stroke();
  }
}

function drawEllipse(ctx: Ctx, L: EllipseLayer): void {
  ctx.beginPath();
  ctx.ellipse(L.w / 2, L.h / 2, L.w / 2, L.h / 2, 0, 0, Math.PI * 2);
  if (L.fill) {
    ctx.fillStyle = L.fill;
    ctx.fill();
  }
  if (L.stroke) {
    ctx.lineWidth = L.lineWidth ?? 2;
    ctx.strokeStyle = L.stroke;
    ctx.stroke();
  }
}

/** Validate a spec (structural). Returns an error message or null. */
export function validateMotionSpec(spec: unknown): string | null {
  if (!spec || typeof spec !== 'object') return 'spec must be an object.';
  const s = spec as MotionSpec;
  if (s.version !== 1) return 'spec.version must be 1.';
  if (!(typeof s.durationUs === 'number' && s.durationUs > 0)) return 'durationUs must be a positive number (microseconds).';
  if (!Array.isArray(s.layers)) return 'layers must be an array.';
  if (s.layers.length > 200) return 'too many layers (limit 200).';
  for (const L of s.layers) {
    if (!L || typeof L !== 'object' || !('type' in L)) return 'layer is missing type.';
    const t = (L as MotionLayer).type;
    if (t !== 'text' && t !== 'rect' && t !== 'ellipse' && t !== 'image') return `unknown layer.type: ${t}`;
    if (t === 'text' && typeof (L as TextLayer).text !== 'string') return 'text layer requires a text string.';
    if (t === 'image' && typeof (L as ImageLayer).src !== 'string') return 'image layer requires a src string.';
  }
  return null;
}

/**
 * Compile a declarative MotionSpec into a per-frame rasterizer. The returned
 * render(index) is a pure function of the spec + frame index (deterministic in
 * preview and export). `defaults` supply width/height/fps from the document when
 * the spec omits them.
 */
export function compileMotionSpec(
  spec: MotionSpec,
  defaults: { width: number; height: number; fps: number },
): CompiledMotion {
  const width = Math.round(spec.width ?? defaults.width);
  const height = Math.round(spec.height ?? defaults.height);
  const fps = (spec.fps ?? defaults.fps) || 30;
  const frameDurUs = Math.max(1, Math.round(1e6 / fps));
  const frameCount = Math.max(1, Math.ceil(spec.durationUs / frameDurUs));

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Failed to create a 2D canvas context.');

  const images = new Map<string, CanvasImageSource>();

  async function load(): Promise<void> {
    const srcs = new Set<string>();
    for (const L of spec.layers) if (L.type === 'image' && L.src) srcs.add(L.src);
    await Promise.all(
      [...srcs].map(async (url) => {
        try {
          const res = await fetch(url, { mode: 'cors' });
          images.set(url, await createImageBitmap(await res.blob()));
        } catch {
          /* leave missing — the image layer draws nothing */
        }
      }),
    );
    try {
      // Font readiness (main-thread only); ignore where document is absent.
      const d = (globalThis as { document?: { fonts?: { ready?: Promise<unknown> } } }).document;
      if (d?.fonts?.ready) await d.fonts.ready;
    } catch {
      /* fall back to loaded fonts */
    }
  }

  function render(index: number): VideoFrame {
    const clamped = Math.max(0, Math.min(frameCount - 1, index));
    const t = (clamped * frameDurUs) / 1e6;
    ctx!.clearRect(0, 0, width, height);
    if (spec.background) {
      ctx!.fillStyle = spec.background;
      ctx!.fillRect(0, 0, width, height);
    }
    for (const L of spec.layers) {
      if (L.in != null && t < L.in) continue;
      if (L.out != null && t > L.out) continue;
      const opacity = sample(L.opacity, t, 1);
      if (opacity <= 0) continue;
      const x = sample(L.x, t, 0);
      const y = sample(L.y, t, 0);
      const scale = sample(L.scale, t, 1);
      const rot = sample(L.rotation, t, 0);
      ctx!.save();
      ctx!.globalAlpha = Math.max(0, Math.min(1, opacity));
      ctx!.translate(x, y);
      if (rot) ctx!.rotate((rot * Math.PI) / 180);
      if (scale !== 1) ctx!.scale(scale, scale);
      try {
        if (L.type === 'text') drawText(ctx!, L);
        else if (L.type === 'rect') drawRect(ctx!, L);
        else if (L.type === 'ellipse') drawEllipse(ctx!, L);
        else if (L.type === 'image') {
          const im = images.get(L.src);
          if (im) ctx!.drawImage(im, 0, 0, L.w ?? width, L.h ?? height);
        }
      } catch {
        /* one bad layer must not abort the whole frame */
      }
      ctx!.restore();
    }
    return new VideoFrame(canvas, { timestamp: clamped * frameDurUs, duration: frameDurUs });
  }

  return { width, height, frameDurUs, frameCount, load, render };
}
