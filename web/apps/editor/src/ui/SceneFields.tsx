// SceneFields — small shared form controls for SceneSpec editing, used by the
// SceneInspector (scene-level fields) and the Director panel's selection card
// (per-object fields). Both commit through the same validated setAssetSpec
// path; these are just the input widgets.

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
  return (
    <input
      type="number"
      step={step}
      value={Math.round(((value ?? fallback) as number) * 100) / 100}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
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
