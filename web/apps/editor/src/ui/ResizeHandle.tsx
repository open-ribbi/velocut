// ui/ResizeHandle.tsx — a thin drag bar that resizes an adjacent panel.
//
// axis 'x' resizes width (col-resize), axis 'y' resizes height (row-resize).
// It only reports the pointer DELTA each move; the parent decides which panel
// grows/shrinks (sign) and clamps the result.

import type { PointerEvent as ReactPointerEvent } from 'react';

export function ResizeHandle({ axis, onResize }: { axis: 'x' | 'y'; onResize: (delta: number) => void }) {
  const onPointerDown = (e: ReactPointerEvent) => {
    e.preventDefault();
    let last = axis === 'x' ? e.clientX : e.clientY;
    const move = (ev: PointerEvent) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY;
      onResize(cur - last);
      last = cur;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up); // touch/pen/OS-gesture interrupt
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    document.body.style.cursor = axis === 'x' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  };
  return <div className={`resize-handle resize-${axis}`} onPointerDown={onPointerDown} />;
}
