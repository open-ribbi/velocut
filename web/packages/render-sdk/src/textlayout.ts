// textlayout.ts — text measurement & layout, shared across the thread boundary.
//
// The caret/selection the editor DRAWS and the glyphs the renderer RASTERIZES
// must come from the SAME measureText() math, or the caret drifts from the text
// (the core invariant behind in-place editing). Once compositing moved into the
// render worker, the rasterizer lives there while the editor's caret geometry
// stays on the main thread — so this layout has to run identically on BOTH. It's
// a pure function of the payload + a 2D measuring context, so each thread runs
// it against its own context (worker: OffscreenCanvas; main: a hidden canvas)
// and the metrics match as long as the same fonts are loaded in both.

import type { TextPayload } from '@velocut/protocol';

/** Padding (source px) around rasterized text — shared by layout & raster. */
export const TEXT_PAD = 8;

/** One laid-out line, in source (frame) pixels. */
export interface TextLine {
  text: string;
  width: number;
  /** Left edge of the line within the frame (honours text-align). */
  left: number;
  /** Top of the line within the frame. */
  top: number;
  /** caretXs[c] = x offset (from line.left) of the caret before char c. */
  caretXs: number[];
}

export interface TextLayout {
  fontSize: number;
  lineHeight: number;
  frameW: number;
  frameH: number;
  lines: TextLine[];
}

/** The narrow 2D-context surface layout needs — satisfied by both
 *  CanvasRenderingContext2D (main thread) and OffscreenCanvasRenderingContext2D
 *  (worker), without coupling to either concrete type. */
export type Measure2D = {
  font: string;
  textBaseline: CanvasTextBaseline;
  measureText(text: string): TextMetrics;
};

/** CSS font string honouring italic/bold — the single spec used by both the
 *  layout measurer and the rasterizer so caret metrics can't drift. */
export function fontSpecOf(text: TextPayload): string {
  const fontSize = text.fontSize ?? 64;
  const fontFamily = text.fontFamily ?? 'system-ui, sans-serif';
  return `${text.italic ? 'italic ' : ''}${text.bold ? '700 ' : ''}${fontSize}px ${fontFamily}`;
}

/** Extra padding (source px) beyond TEXT_PAD so stroke / shadow / background
 *  never clip the rasterized frame. Folded into the layout so the editor's
 *  caret (which reads the same layout) stays aligned. */
export function stylePad(text: TextPayload, fontSize: number): number {
  const sw = text.strokeColor ? Math.max(0, text.strokeWidth ?? 0) : 0;
  const sh = text.shadowColor
    ? (text.shadowBlur ?? 0) + Math.max(Math.abs(text.shadowX ?? 0), Math.abs(text.shadowY ?? 0))
    : 0;
  const bg = text.backgroundColor ? fontSize * 0.3 : 0;
  return Math.ceil(Math.max(sw, sh, bg));
}

/**
 * Exact glyph layout of a text payload, in source (frame) pixels — the single
 * source of truth shared by the rasterizer (Renderer.textFrame), hit-testing
 * (measureText), and the editor's self-drawn caret/selection. Because the caret
 * is positioned from the SAME measureText() that draws the glyphs, it can never
 * drift from the rendered text — including with custom fonts, CJK/Latin mixes,
 * or letter-spacing.
 */
export function computeTextLayout(text: TextPayload, ctx: Measure2D): TextLayout {
  const fontSize = text.fontSize ?? 64;
  ctx.font = fontSpecOf(text);
  const lineHeight = fontSize * 1.25;
  const align = (text.align as CanvasTextAlign) ?? 'left';
  const raw = text.content.split('\n');
  const widths = raw.map((l) => ctx.measureText(l).width);
  const pad = TEXT_PAD + stylePad(text, fontSize);
  const frameW = Math.ceil(Math.max(1, ...widths) + 2 * pad);
  const frameH = Math.ceil(raw.length * lineHeight + 2 * pad);
  const lines: TextLine[] = raw.map((line, i) => {
    // Cumulative caret offsets: caretXs[c] = width of line.slice(0, c).
    const caretXs: number[] = new Array(line.length + 1);
    caretXs[0] = 0;
    for (let c = 1; c <= line.length; c++) caretXs[c] = ctx.measureText(line.slice(0, c)).width;
    const left =
      align === 'center'
        ? (frameW - widths[i]) / 2
        : align === 'right'
          ? frameW - pad - widths[i]
          : pad;
    return { text: line, width: widths[i], left, top: pad + i * lineHeight, caretXs };
  });
  return { fontSize, lineHeight, frameW, frameH, lines };
}

/** Tight rectangle around what a text payload actually SHOWS, in frame px
 *  (origin = the raster frame's top-left). */
export interface InkRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Visible (ink) bounds of a text payload within its raster frame: glyph ink
 * from actualBoundingBox metrics, widened by the centered stroke, the shadow
 * (directional: blur all around, the offset only where it falls), and the
 * background pills — the same extents the rasterizer paints.
 *
 * This is DISPLAY chrome only. The frame (frameW/frameH) remains the shared
 * geometry for rasterizing, hit-testing and caret math; this rect exists so
 * selection boxes can hug what the user sees instead of the padded frame.
 */
export function computeInkRect(text: TextPayload, ctx: Measure2D, layout?: TextLayout): InkRect {
  const l = layout ?? computeTextLayout(text, ctx);
  const fontSize = l.fontSize;
  ctx.font = fontSpecOf(text);
  // Measure against baseline 'top' — the anchor the rasterizer draws with —
  // so ascent/descent are offsets from line.top, not from an alphabetic line.
  const prevBaseline = ctx.textBaseline;
  ctx.textBaseline = 'top';
  const strokeW = text.strokeColor ? Math.max(0, text.strokeWidth ?? 0) : 0;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const line of l.lines) {
    if (!line.text.trim()) continue; // whitespace leaves no ink
    const m = ctx.measureText(line.text);
    // Stroke is drawn centered with lineWidth = 2×strokeWidth → strokeWidth beyond the ink.
    left = Math.min(left, line.left - m.actualBoundingBoxLeft - strokeW);
    right = Math.max(right, line.left + m.actualBoundingBoxRight + strokeW);
    top = Math.min(top, line.top - m.actualBoundingBoxAscent - strokeW);
    bottom = Math.max(bottom, line.top + m.actualBoundingBoxDescent + strokeW);
  }
  ctx.textBaseline = prevBaseline;
  if (text.shadowColor && left < right) {
    const blur = text.shadowBlur ?? 0;
    const ox = text.shadowX ?? 0;
    const oy = text.shadowY ?? 0;
    left = Math.min(left, left + ox - blur);
    right = Math.max(right, right + ox + blur);
    top = Math.min(top, top + oy - blur);
    bottom = Math.max(bottom, bottom + oy + blur);
  }
  if (text.backgroundColor) {
    // Same pill geometry the rasterizer fills (Renderer.textFrame).
    const padX = fontSize * 0.3;
    const padY = fontSize * 0.08;
    const pillH = l.lineHeight - fontSize * 0.05 + 2 * padY;
    for (const line of l.lines) {
      left = Math.min(left, line.left - padX);
      right = Math.max(right, line.left + line.width + padX);
      top = Math.min(top, line.top - padY);
      bottom = Math.max(bottom, line.top - padY + pillH);
    }
  }
  // Nothing visible (empty / all-whitespace, no background): fall back to the frame.
  if (!(left < right && top < bottom)) return { left: 0, top: 0, width: l.frameW, height: l.frameH };
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(l.frameW, right);
  bottom = Math.min(l.frameH, bottom);
  return { left, top, width: right - left, height: bottom - top };
}
