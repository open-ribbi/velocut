// PreviewPanel — WebGPU canvas + direct-manipulation overlay.
//
// Layers are editable on the picture: click to select, drag (snapping to
// canvas center/edges) to move, corner handles to scale, double-click a text
// layer to edit IN PLACE.
//
// Text editing uses the hidden-input model: a focus-only <textarea>
// (pointer-events: none, focused programmatically) is the keystroke + IME
// sink, while the caret and selection are DRAWN BY US from renderer.textLayout
// — the very same canvas2d measureText() that rasterizes the glyphs. The caret
// therefore can never drift from the rendered text, including with custom
// fonts or mixed CJK/Latin. Click & drag-select also map through that layout,
// not the browser's textarea metrics.
//
// All geometry derives from the canvas's measured on-screen rect, so it stays
// correct under letterboxing / DPR.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PreviewRenderer, Playback, MediaLibrary, TextLayout } from '@velocut/render-sdk';
import type { Store, UiState } from '../state/store';
import type { TextPayload, Transform } from '@velocut/protocol';

/** Source-px padding around rasterized text — must match renderer TEXT_PAD. */
const TEXT_PAD = 8;
/** Pointer travel (doc px) before a press counts as a drag, not a click. */
const DRAG_THRESHOLD = 3;
/** Snap distance (doc px). */
const SNAP = 9;

interface LayerBox {
  clipId: string;
  cx: number;
  cy: number;
  w: number;
  h: number;
  rotation: number;
  transform: Transform;
  text: TextPayload | null;
}

type Gesture =
  | { kind: 'move'; clipId: string; startX: number; startY: number; orig: Transform; moved: boolean }
  | { kind: 'scale'; clipId: string; cx: number; cy: number; startDist: number; orig: Transform; moved: boolean };

function snap1(value: number, targets: { v: number; guide: number }[]): { v: number; guide: number | null } {
  for (const t of targets) if (Math.abs(value - t.v) < SNAP) return { v: t.v, guide: t.guide };
  return { v: value, guide: null };
}

/** Global char index → (line, col), with lines joined by '\n'. */
function locate(lines: TextLayout['lines'], idx: number): { line: number; col: number } {
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    const len = lines[i].text.length;
    if (idx <= acc + len) return { line: i, col: idx - acc };
    acc += len + 1;
  }
  const last = Math.max(0, lines.length - 1);
  return { line: last, col: lines[last]?.text.length ?? 0 };
}

export function PreviewPanel({
  store,
  media,
  renderer,
  playback,
  state,
}: {
  store: Store;
  media: MediaLibrary;
  renderer: PreviewRenderer;
  playback: Playback;
  state: UiState;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sinkRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const editDrag = useRef<{ anchor: number } | null>(null);
  const composing = useRef(false);
  const [ghost, setGhost] = useState<Partial<Transform> | null>(null);
  const [guides, setGuides] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const [editing, setEditing] = useState<{ clipId: string; text: TextPayload } | null>(null);
  const [value, setValue] = useState('');
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const [rect, setRect] = useState({ w: 1, h: 1 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Size the backing store before the renderer transfers control to its worker.
    // On a StrictMode remount the canvas is ALREADY transferred (init dedups and
    // never re-transfers), and setting width/height then throws — swallow it; the
    // worker already holds the right dimensions from the first init.
    try {
      canvas.width = state.doc.width;
      canvas.height = state.doc.height;
    } catch {
      /* canvas already transferred to the render worker (StrictMode remount) */
    }
    let cancelled = false;
    renderer
      .init(canvas)
      .then(() => {
        if (!cancelled) playback.start();
      })
      .catch((e) => setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
      playback.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const update = () => {
      const r = canvas.getBoundingClientRect();
      setRect({ w: r.width, h: r.height });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(canvas);
    window.addEventListener('resize', update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);

  const docW = state.doc.width;
  const docH = state.doc.height;
  const k = rect.w / docW; // uniform: canvas preserves aspect

  const layerSize = (layer: { text: TextPayload | null; assetId: string | null }) => {
    if (layer.text) return renderer.measureText(layer.text);
    if (layer.assetId) return media.assetSize(layer.assetId);
    return null;
  };

  const boxes: LayerBox[] = useMemo(() => {
    const fg = store.evaluate(state.playheadUs);
    const out: LayerBox[] = [];
    for (const layer of fg.layers) {
      const src = layerSize(layer);
      if (!src) continue;
      const t = layer.transform;
      out.push({
        clipId: layer.clipId,
        cx: docW / 2 + t.x,
        cy: docH / 2 + t.y,
        w: src.width * t.scaleX,
        h: src.height * t.scaleY,
        rotation: t.rotation,
        transform: t,
        text: layer.text,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.revision, state.playheadUs, docW, docH]);

  const selected = boxes.find((b) => b.clipId === state.selectedClipId) ?? null;

  /** Screen px from the canvas origin (== overlay origin). */
  const screenPt = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toDoc = (e: { clientX: number; clientY: number }) => {
    const p = screenPt(e);
    return { x: p.x / k, y: p.y / k };
  };

  const hitTest = (p: { x: number; y: number }): LayerBox | null => {
    for (let i = boxes.length - 1; i >= 0; i--) {
      const b = boxes[i];
      const rad = (-b.rotation * Math.PI) / 180;
      const dx = p.x - b.cx;
      const dy = p.y - b.cy;
      const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
      const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
      if (Math.abs(lx) <= b.w / 2 && Math.abs(ly) <= b.h / 2) return b;
    }
    return null;
  };

  // -------------------------------------------------- editing geometry

  /** Edit layout + screen-space placement (screen px from overlay origin). */
  const editGeom = useMemo(() => {
    if (!editing || !selected) return null;
    const layout = renderer.textLayout({ ...editing.text, content: value });
    const t = selected.transform;
    const sx = t.scaleX * k;
    const sy = t.scaleY * k;
    const w = layout.frameW * sx;
    const h = layout.frameH * sy;
    const boxLeft = (docW / 2 + t.x) * k - w / 2;
    const boxTop = (docH / 2 + t.y) * k - h / 2;
    return { layout, sx, sy, boxLeft, boxTop, w, h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, value, selected?.transform, k, docW, docH]);

  /** Screen point → caret char index, via our layout (font-independent). */
  const caretIndexAt = (sxScreen: number, syScreen: number): number => {
    if (!editGeom) return 0;
    const { layout, sx, sy, boxLeft, boxTop } = editGeom;
    const localX = (sxScreen - boxLeft) / sx;
    const localY = (syScreen - boxTop) / sy;
    // Invert from the actual top of line 0 (= the layout's pad, which grows
    // with stroke/shadow/background styling) — not a hardcoded constant.
    const top0 = layout.lines[0]?.top ?? TEXT_PAD;
    const li = Math.max(0, Math.min(layout.lines.length - 1, Math.floor((localY - top0) / layout.lineHeight)));
    const line = layout.lines[li];
    const within = localX - line.left;
    let col = 0;
    let best = Infinity;
    for (let c = 0; c < line.caretXs.length; c++) {
      const d = Math.abs(line.caretXs[c] - within);
      if (d < best) {
        best = d;
        col = c;
      }
    }
    let acc = 0;
    for (let i = 0; i < li; i++) acc += layout.lines[i].text.length + 1;
    return acc + col;
  };

  // ------------------------------------------------------ pointer flow

  const onPointerDown = (e: React.PointerEvent) => {
    const p = toDoc(e);
    if (editing && editGeom) {
      const s = screenPt(e);
      const inside =
        s.x >= editGeom.boxLeft &&
        s.x <= editGeom.boxLeft + editGeom.w &&
        s.y >= editGeom.boxTop &&
        s.y <= editGeom.boxTop + editGeom.h;
      if (!inside) {
        commitEdit();
        return;
      }
      // Keep focus on the sink (don't let the click blur it), then place the
      // caret from our own layout.
      e.preventDefault();
      const idx = caretIndexAt(s.x, s.y);
      editDrag.current = { anchor: idx };
      setSelRange(idx, idx);
      sinkRef.current?.focus();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    const hit = hitTest(p);
    if (!hit) {
      store.select(null);
      return;
    }
    store.select(hit.clipId);
    gesture.current = { kind: 'move', clipId: hit.clipId, startX: p.x, startY: p.y, orig: hit.transform, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const startScale = (e: React.PointerEvent, b: LayerBox) => {
    e.stopPropagation();
    const p = toDoc(e);
    gesture.current = {
      kind: 'scale',
      clipId: b.clipId,
      cx: b.cx,
      cy: b.cy,
      startDist: Math.max(1, Math.hypot(p.x - b.cx, p.y - b.cy)),
      orig: b.transform,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (editing) {
      if (!editDrag.current) return;
      const s = screenPt(e);
      const idx = caretIndexAt(s.x, s.y);
      const a = editDrag.current.anchor;
      setSelRange(Math.min(a, idx), Math.max(a, idx));
      return;
    }
    const g = gesture.current;
    if (!g) return;
    const p = toDoc(e);
    if (!g.moved) {
      const from =
        g.kind === 'move'
          ? Math.hypot(p.x - g.startX, p.y - g.startY)
          : Math.abs(Math.hypot(p.x - g.cx, p.y - g.cy) - g.startDist);
      if (from < DRAG_THRESHOLD) return;
      g.moved = true;
    }
    if (g.kind === 'move') {
      const box = boxes.find((b) => b.clipId === g.clipId);
      const bw = box?.w ?? 0;
      const bh = box?.h ?? 0;
      let x = g.orig.x + (p.x - g.startX);
      let y = g.orig.y + (p.y - g.startY);
      const sx = snap1(x, [
        { v: 0, guide: docW / 2 },
        { v: bw / 2 - docW / 2, guide: 0 },
        { v: docW / 2 - bw / 2, guide: docW },
      ]);
      const sy = snap1(y, [
        { v: 0, guide: docH / 2 },
        { v: bh / 2 - docH / 2, guide: 0 },
        { v: docH / 2 - bh / 2, guide: docH },
      ]);
      x = sx.v;
      y = sy.v;
      setGuides({ x: sx.guide, y: sy.guide });
      const next = { x, y };
      renderer.setOverride(g.clipId, next);
      setGhost(next);
    } else {
      const ratio = Math.max(0.05, Math.hypot(p.x - g.cx, p.y - g.cy) / g.startDist);
      const next = { scaleX: g.orig.scaleX * ratio, scaleY: g.orig.scaleY * ratio };
      renderer.setOverride(g.clipId, next);
      setGhost(next);
    }
    playback.invalidate();
  };

  const onPointerUp = () => {
    if (editing) {
      editDrag.current = null;
      return;
    }
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    renderer.setOverride(g.clipId, null);
    setGuides({ x: null, y: null });
    if (g.moved && ghost) {
      store.dispatch({ type: 'setTransform', clipId: g.clipId, transform: { ...g.orig, ...ghost } });
    }
    setGhost(null);
    playback.invalidate();
  };

  // ----------------------------------------------------------- text edit

  const beginEdit = (hit: LayerBox) => {
    if (!hit.text) return;
    store.select(hit.clipId);
    setEditing({ clipId: hit.clipId, text: hit.text });
    setValue(hit.text.content);
    setSel({ start: hit.text.content.length, end: hit.text.content.length });
    renderer.setTextOverride(hit.clipId, hit.text);
    playback.invalidate();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (editing) return;
    const hit = hitTest(toDoc(e));
    if (hit?.text) beginEdit(hit);
  };

  // Focus the sink and place the caret once the editor mounts.
  useEffect(() => {
    if (!editing) return;
    const el = sinkRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(value.length, value.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.clipId]);

  // Commit when the pointer goes down anywhere OUTSIDE the preview overlay
  // (timeline, inspector, toolbar). In-canvas clicks are handled by the
  // overlay's own pointerdown (caret placement / commit-on-outside-box).
  // `selectionchange` fires on every caret move (incl. held arrow keys), so
  // the drawn caret tracks instantly instead of waiting for keyup.
  useEffect(() => {
    if (!editing) return;
    const onDocDown = (e: PointerEvent) => {
      if (!overlayRef.current?.contains(e.target as Node)) commitEdit();
    };
    const onSelChange = () => {
      const el = sinkRef.current;
      if (el && document.activeElement === el) setSel({ start: el.selectionStart, end: el.selectionEnd });
    };
    document.addEventListener('pointerdown', onDocDown, true);
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      document.removeEventListener('pointerdown', onDocDown, true);
      document.removeEventListener('selectionchange', onSelChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.clipId]);

  const setSelRange = (start: number, end: number) => {
    sinkRef.current?.setSelectionRange(start, end);
    setSel({ start, end });
  };

  const syncFromEl = () => {
    const el = sinkRef.current;
    if (!el || !editing) return;
    setValue(el.value);
    renderer.setTextOverride(editing.clipId, { ...editing.text, content: el.value });
    playback.invalidate();
    setSel({ start: el.selectionStart, end: el.selectionEnd });
  };


  const commitEdit = () => {
    if (!editing) return;
    const el = sinkRef.current;
    const content = el?.value ?? value;
    renderer.setTextOverride(editing.clipId, null);
    if (content !== editing.text.content) {
      store.dispatch({ type: 'setText', clipId: editing.clipId, text: { ...editing.text, content } });
    }
    setEditing(null);
    editDrag.current = null;
    playback.invalidate();
  };

  const cancelEdit = () => {
    if (!editing) return;
    renderer.setTextOverride(editing.clipId, null);
    setEditing(null);
    editDrag.current = null;
    playback.invalidate();
  };

  // -------------------------------------------------------------- render

  const screenBox = (b: LayerBox) => {
    const g = ghost && gesture.current?.clipId === b.clipId ? { ...b.transform, ...ghost } : b.transform;
    const w = (b.w / b.transform.scaleX) * g.scaleX;
    const h = (b.h / b.transform.scaleY) * g.scaleY;
    const cx = docW / 2 + g.x;
    const cy = docH / 2 + g.y;
    return { left: (cx - w / 2) * k, top: (cy - h / 2) * k, width: w * k, height: h * k };
  };

  // Caret + selection rectangles (overlay coords), from the shared layout.
  const caretRect = useMemo(() => {
    if (!editGeom || sel.start !== sel.end) return null;
    const { layout, sx, sy, boxLeft, boxTop } = editGeom;
    const { line, col } = locate(layout.lines, sel.start);
    const ln = layout.lines[line];
    if (!ln) return null;
    return {
      left: boxLeft + (ln.left + ln.caretXs[col]) * sx,
      top: boxTop + ln.top * sy,
      height: layout.fontSize * sy,
    };
  }, [editGeom, sel]);

  const selRects = useMemo(() => {
    if (!editGeom || sel.start === sel.end) return [];
    const { layout, sx, sy, boxLeft, boxTop } = editGeom;
    const a = Math.min(sel.start, sel.end);
    const b = Math.max(sel.start, sel.end);
    const out: { left: number; top: number; width: number; height: number }[] = [];
    let acc = 0;
    for (const ln of layout.lines) {
      const len = ln.text.length;
      const s = Math.max(a, acc) - acc;
      const e = Math.min(b, acc + len) - acc;
      if (e > s) {
        const x0 = ln.left + ln.caretXs[s];
        const x1 = ln.left + ln.caretXs[e];
        out.push({
          left: boxLeft + x0 * sx,
          top: boxTop + ln.top * sy,
          width: (x1 - x0) * sx,
          height: layout.lineHeight * sy,
        });
      }
      acc += len + 1;
    }
    return out;
  }, [editGeom, sel]);

  return (
    <div className="preview-panel">
      <div className="preview-stage">
        {error ? (
          <div className="preview-error">{error}</div>
        ) : (
          <div className="preview-wrap">
            <canvas ref={canvasRef} className="preview-canvas" />
            <div
              className="preview-overlay"
              ref={overlayRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onDoubleClick={onDoubleClick}
            >
              {guides.x != null && <div className="snap-guide guide-v" style={{ left: guides.x * k }} />}
              {guides.y != null && <div className="snap-guide guide-h" style={{ top: guides.y * k }} />}

              {selected && !editing && (
                <div
                  className="select-box"
                  style={{ ...screenBox(selected), transform: `rotate(${selected.rotation}deg)` }}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                    <div
                      key={corner}
                      className={`scale-handle handle-${corner}`}
                      onPointerDown={(e) => startScale(e, selected)}
                    />
                  ))}
                </div>
              )}

              {editing && editGeom && (
                <>
                  <div
                    className="edit-box"
                    style={{ left: editGeom.boxLeft, top: editGeom.boxTop, width: editGeom.w, height: editGeom.h }}
                  />
                  {selRects.map((r, i) => (
                    <div key={i} className="edit-selection" style={r} />
                  ))}
                  {caretRect && (
                    <div
                      className="edit-caret"
                      style={{ left: caretRect.left, top: caretRect.top, height: caretRect.height }}
                    />
                  )}
                  <textarea
                    ref={sinkRef}
                    key={editing.clipId}
                    className="edit-sink"
                    defaultValue={editing.text.content}
                    spellCheck={false}
                    onInput={syncFromEl}
                    onCompositionStart={() => (composing.current = true)}
                    onCompositionEnd={() => {
                      composing.current = false;
                      syncFromEl();
                    }}
                    onKeyDown={(e) => {
                      if (composing.current) return;
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        commitEdit();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                      e.stopPropagation();
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
