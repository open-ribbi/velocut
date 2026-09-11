import { sampleAnimatable, type Animatable } from '@velocut/render-sdk';
import type { SceneObject, SceneObjectKind } from './authoring.ts';
import type { Scale3 } from './types.ts';

export type PlacementVector = { x?: number; y?: number; z?: number };
export interface ObjectTransform {
  /** Parent-local meters. Only supplied axes change. */
  position?: PlacementVector;
  /** XYZ Euler components in degrees; relative mode adds components. */
  rotation?: PlacementVector;
  /** Absolute scale, or positive multipliers in relative mode. */
  scale?: Scale3;
}
export type SceneLayout =
  | { mode: 'line'; origin: PlacementVector; step: PlacementVector }
  | { mode: 'grid'; origin: PlacementVector; columns: number; spacing: { x: number; z: number } }
  | { mode: 'radial'; center: PlacementVector; radius: number; startAngle?: number; sweepAngle?: number; facing?: 'keep' | 'inward' | 'outward' | 'tangent'; rotationOffset?: number };

const axes = ['x', 'y', 'z'] as const;
function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be finite`);
}
function vector(value: PlacementVector, name: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !axes.includes(k as typeof axes[number])))
    throw new Error(`${name} must be {x?,y?,z?}`);
  for (const axis of axes) if (axis in value) finite(value[axis], `${name}.${axis}`);
}
export function placementTime(timeS = 0) {
  finite(timeS, 'timeS');
  if (timeS < 0) throw new Error('timeS must be nonnegative');
  return timeS;
}
function shifted(value: Animatable | undefined, fallback: number, amount: number, relative: boolean, timeS: number): Animatable {
  const delta = relative ? amount : amount - sampleAnimatable(value, timeS, fallback);
  return Array.isArray(value) ? value.map(k => ({ ...k, v: k.v + delta })) : (value ?? fallback) + delta;
}

/** Shift animation paths rather than replacing them with constants. */
export function transformObject(object: SceneObject, kind: SceneObjectKind, transform: ObjectTransform, relative = false, timeS = 0) {
  placementTime(timeS);
  if (!transform || typeof transform !== 'object' || Array.isArray(transform) || !Object.keys(transform).length ||
      Object.keys(transform).some(k => !['position', 'rotation', 'scale'].includes(k))) throw new Error('invalid transform');
  if ('physics' in object && object.physics && timeS !== 0) throw new Error('transform physics props at timeS:0');
  if (transform.position !== undefined) {
    vector(transform.position, 'position');
    for (const axis of axes) if (transform.position[axis] !== undefined) {
      const fallback = kind === 'prop' && !('attachTo' in object && object.attachTo) && axis === 'y' ? 0.5 : 0;
      (object.position ??= {})[axis] = shifted(object.position?.[axis], fallback, transform.position[axis], relative, timeS);
    }
  }
  if (transform.rotation !== undefined) {
    vector(transform.rotation, 'rotation');
    for (const axis of axes) if (transform.rotation[axis] !== undefined) {
      const key = { x: 'rotationX', y: 'rotationY', z: 'rotationZ' }[axis] as 'rotationX' | 'rotationY' | 'rotationZ';
      object[key] = shifted(object[key], 0, transform.rotation[axis], relative, timeS);
    }
  }
  if (transform.scale !== undefined) {
    const s = transform.scale;
    if (typeof s === 'number') finite(s, 'scale'); else vector(s, 'scale');
    const old = object.scale ?? 1;
    const scale: PlacementVector = typeof old === 'number' ? { x: old, y: old, z: old } : { ...old };
    for (const axis of axes) {
      const n = typeof s === 'number' ? s : s[axis];
      if (n === undefined) continue;
      if (n <= 0) throw new Error('scale must be positive');
      scale[axis] = relative ? (scale[axis] ?? 1) * n : n;
    }
    object.scale = scale;
  }
}

/** Layout addresses object origins, in one shared parent frame, in caller order. */
export function layoutTransforms(layout: SceneLayout, count: number): ObjectTransform[] {
  if (!layout || typeof layout !== 'object') throw new Error('layout is required');
  const allowed = layout.mode === 'line' ? ['mode', 'origin', 'step'] : layout.mode === 'grid'
    ? ['mode', 'origin', 'columns', 'spacing']
    : ['mode', 'center', 'radius', 'startAngle', 'sweepAngle', 'facing', 'rotationOffset'];
  if (Object.keys(layout).some(k => !allowed.includes(k))) throw new Error('unknown layout field');
  if (layout.mode === 'line') {
    vector(layout.origin, 'origin'); vector(layout.step, 'step');
    return Array.from({ length: count }, (_, i) => ({ position: Object.fromEntries(axes.map(axis => [axis, (layout.origin[axis] ?? 0) + i * (layout.step[axis] ?? 0)])) }));
  }
  if (layout.mode === 'grid') {
    vector(layout.origin, 'origin'); vector(layout.spacing, 'spacing');
    if (Object.keys(layout.spacing).some(k => k !== 'x' && k !== 'z')) throw new Error('grid spacing must be {x,z}');
    if (!Number.isInteger(layout.columns) || layout.columns < 1 || layout.columns > 200) throw new Error('columns must be 1..200');
    for (const axis of ['x', 'z'] as const) { finite(layout.spacing[axis], `spacing.${axis}`); if (layout.spacing[axis] <= 0) throw new Error('grid spacing must be positive'); }
    return Array.from({ length: count }, (_, i) => ({ position: {
      x: (layout.origin.x ?? 0) + i % layout.columns * layout.spacing.x,
      y: layout.origin.y ?? 0,
      z: (layout.origin.z ?? 0) + Math.floor(i / layout.columns) * layout.spacing.z,
    } }));
  }
  if (layout.mode !== 'radial') throw new Error('unknown layout mode');
  vector(layout.center, 'center'); finite(layout.radius, 'radius');
  if (layout.radius <= 0) throw new Error('radius must be positive');
  const start = layout.startAngle ?? 0, sweep = layout.sweepAngle ?? 360, offset = layout.rotationOffset ?? 0;
  finite(start, 'startAngle'); finite(sweep, 'sweepAngle'); finite(offset, 'rotationOffset');
  if (!sweep || Math.abs(sweep) > 360) throw new Error('sweepAngle must be nonzero and within -360..360');
  const facing = layout.facing ?? 'keep';
  if (!['keep', 'inward', 'outward', 'tangent'].includes(facing)) throw new Error('unknown radial facing');
  // A closed ring omits the repeated endpoint; an arc includes both endpoints.
  const divisor = Math.abs(sweep) === 360 ? count : Math.max(1, count - 1);
  return Array.from({ length: count }, (_, i) => {
    const angle = start + i * sweep / divisor, radians = angle * Math.PI / 180;
    return { position: { x: (layout.center.x ?? 0) + Math.sin(radians) * layout.radius, y: layout.center.y ?? 0,
      z: (layout.center.z ?? 0) + Math.cos(radians) * layout.radius },
      ...(facing === 'keep' ? {} : { rotation: { y: angle + (facing === 'inward' ? 180 : facing === 'tangent' ? Math.sign(sweep) * 90 : 0) + offset } }) };
  });
}
