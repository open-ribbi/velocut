export type SpatialVector = [number, number, number];

/** Object-local coordinates, before the object's animated transform. */
export interface SceneAnchor {
  name?: string;
  position: SpatialVector;
  /** Local surface normal; defaults to +Y. */
  normal?: SpatialVector;
  /** In-plane direction; defaults to +X, or +Z when parallel to normal. */
  tangent?: SpatialVector;
}

export const spatialVector = (v: unknown): v is SpatialVector => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
export const anchorIdValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(id) && !['__proto__','constructor','prototype'].includes(id);

export function validateAnchor(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'anchor must be an object';
  const a = value as SceneAnchor;
  if (Object.keys(a).some(k => !['name','position','normal','tangent'].includes(k))) return 'unknown anchor field';
  if (a.name != null && typeof a.name !== 'string') return 'anchor name must be a string';
  if (!spatialVector(a.position)) return 'anchor position must be a finite triple';
  for (const key of ['normal','tangent'] as const) if (a[key] !== undefined) {
    if (!spatialVector(a[key]) || !Number.isFinite(Math.hypot(...a[key])) || Math.hypot(...a[key]) === 0) return `anchor ${key} must be a nonzero finite vector`;
  }
  if (a.tangent) {
    const n = a.normal ?? [0,1,0], nl = Math.hypot(...n), tl = Math.hypot(...a.tangent);
    const dot = n.reduce((sum,v,i) => sum + v/nl * a.tangent![i]/tl, 0);
    if (Math.abs(dot) > 1 - 1e-12) return 'anchor tangent must not be parallel to normal';
  }
  return null;
}

export function validateAnchors(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'anchors must be a registry';
  for (const [id, anchor] of Object.entries(value)) {
    if (!anchorIdValid(id)) return 'invalid anchor id';
    const error = validateAnchor(anchor); if (error) return `anchor '${id}': ${error}`;
  }
  return null;
}
