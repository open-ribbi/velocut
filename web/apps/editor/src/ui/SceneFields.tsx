// SceneFields — small shared form controls for SceneSpec editing, used by the
// SceneInspector (scene-level fields) and the Director panel's selection card
// (per-object fields). Both commit through the same validated setAssetSpec
// path; these are just the input widgets.

import { useEffect, useState } from 'react';
import type { Animatable } from '@velocut/render-sdk';

/** Constant Animatable → number input; keyframed → read-only badge (edit via
 *  the JSON tab, which can express the full grammar). */
export function AnimatableField({
  value,
  fallback,
  step = 0.1,
  onChange,
}: {
  value: Animatable | undefined;
  fallback: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  if (Array.isArray(value)) {
    return (
      <span className="kf-chip" title="Keyframed — edit via the JSON tab">
        ◆ {value.length} keys
      </span>
    );
  }
  return <NumberField value={Math.round(((value ?? fallback) as number) * 100) / 100} step={step} onCommit={onChange} />;

}

export function Vec3Row({
  label,
  value,
  onAxis,
}: {
  label: string;
  value: { x?: Animatable; y?: Animatable; z?: Animatable } | undefined;
  onAxis: (axis: 'x' | 'y' | 'z', v: number) => void;
}) {
  return (
    <div className="prop-row scene-vec3">
      <span className="prop-label">{label}</span>
      {(['x', 'y', 'z'] as const).map((axis) => (
        <AnimatableField key={axis} value={value?.[axis]} fallback={0} onChange={(v) => onAxis(axis, v)} />
      ))}
    </div>
  );
}

/** Draft locally while typing; compilation happens once on blur/Enter. */
export function NumberField({ value, step = 0.1, min, max, onCommit }: {
  value: number; step?: number; min?: number; max?: number; onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!draft.trim() || !Number.isFinite(n) || (min != null && n < min) || (max != null && n > max)) {
      setDraft(String(value)); return;
    }
    if (n !== value) onCommit(n);
  };
  return <input type="number" value={draft} step={step} min={min} max={max} onChange={(e) => setDraft(e.target.value)}
    onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setDraft(String(value)); } }} />;
}
