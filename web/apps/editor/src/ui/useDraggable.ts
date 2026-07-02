// ui/useDraggable.ts — a floating "dock" that is a draggable bubble when
// collapsed and a draggable panel when expanded, sharing ONE anchor position.
//
// Drag the bubble and the panel opens there; drag the panel header and the
// bubble moves with it. A press on the bubble that doesn't cross a threshold is
// a tap (opens); a press that moves drags it. The anchor is persisted.
//
// IMPORTANT: the anchor (`pos`) is the bubble's home. The panel, being larger,
// is rendered at a SEPARATE clamped style so it never spills off-screen — but
// that clamp is display-only and never writes back to `pos`, so opening and
// closing the panel never move the bubble.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';

const INTERACTIVE = 'button, select, input, textarea, a';
const TAP_THRESHOLD = 5; // px of movement before a bubble press counts as a drag, not a tap

function readStored(key: string): { left: number; top: number } | null {
  try {
    const s = localStorage.getItem(key);
    if (s) {
      const p = JSON.parse(s);
      if (typeof p?.left === 'number' && typeof p?.top === 'number') return p;
    }
  } catch {
    /* ignore */
  }
  return null;
}

const anchorStyle = (p: { left: number; top: number }): CSSProperties => ({
  left: p.left,
  top: p.top,
  right: 'auto',
  bottom: 'auto',
});

export function useFloatingDock(storageKey: string, open: boolean, onOpen: () => void) {
  const fabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(() => readStored(storageKey));
  const [panelStyle, setPanelStyle] = useState<CSSProperties | undefined>(undefined);
  const [resizeTick, setResizeTick] = useState(0);

  const persist = (p: { left: number; top: number }) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(p));
    } catch {
      /* ignore */
    }
  };

  // Shared press→drag mechanics. tapToOpen: a press that never crosses the
  // threshold fires onOpen (bubble); the panel header always drags (ignoring its
  // own controls). Updates the shared anchor `pos`.
  const beginDrag = (el: HTMLElement | null, e: ReactPointerEvent, tapToOpen: boolean) => {
    if (e.button !== 0 || !el) return;
    if (!tapToOpen && (e.target as HTMLElement).closest(INTERACTIVE)) return;
    const r = el.getBoundingClientRect();
    const offX = e.clientX - r.left;
    const offY = e.clientY - r.top;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragged = false;
    const move = (ev: PointerEvent) => {
      if (!dragged && Math.hypot(ev.clientX - startX, ev.clientY - startY) < TAP_THRESHOLD) return;
      dragged = true;
      const rr = el.getBoundingClientRect(); // live size (panel can grow mid-drag)
      setPos({
        left: Math.max(4, Math.min(ev.clientX - offX, window.innerWidth - rr.width - 4)),
        top: Math.max(4, Math.min(ev.clientY - offY, window.innerHeight - rr.height - 4)),
      });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      if (!dragged) {
        if (tapToOpen) onOpen();
      } else {
        const rr = el.getBoundingClientRect();
        persist({ left: Math.round(rr.left), top: Math.round(rr.top) });
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    if (!tapToOpen) e.preventDefault();
  };

  const onFabPointerDown = (e: ReactPointerEvent) => beginDrag(fabRef.current, e, true);
  const onPanelDragStart = (e: ReactPointerEvent) => beginDrag(panelRef.current, e, false);

  // Display-only panel position: the anchor clamped to keep the (larger) panel
  // fully on-screen. Computed pre-paint; NEVER writes back to `pos`, so opening
  // the panel from a near-edge bubble doesn't move the bubble on close.
  useLayoutEffect(() => {
    if (!open || !pos) {
      setPanelStyle(pos ? anchorStyle(pos) : undefined);
      return;
    }
    const el = panelRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPanelStyle({
      left: Math.max(4, Math.min(pos.left, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(pos.top, window.innerHeight - r.height - 4)),
      right: 'auto',
      bottom: 'auto',
    });
  }, [open, pos, resizeTick]);

  // On window resize: re-clamp the panel (via tick) and keep the bubble anchor
  // within reach (clamp to ~a bubble's worth of on-screen space).
  useEffect(() => {
    const onResize = () => {
      setResizeTick((t) => t + 1);
      setPos((p) =>
        p
          ? {
              left: Math.max(4, Math.min(p.left, window.innerWidth - 84)),
              top: Math.max(4, Math.min(p.top, window.innerHeight - 44)),
            }
          : p,
      );
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The bubble always sits at the raw anchor.
  const fabStyle: CSSProperties | undefined = pos ? anchorStyle(pos) : undefined;

  return { fabRef, panelRef, fabStyle, panelStyle, onFabPointerDown, onPanelDragStart };
}
