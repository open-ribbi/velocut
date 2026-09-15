export type SpatialVector = [number, number, number];

/** Object-local coordinates, before the object's animated transform. */
export interface LocalAnchor {
  kind?: 'local';
  name?: string;
  position: SpatialVector;
  /** Local surface normal; defaults to +Y. */
  normal?: SpatialVector;
  /** In-plane direction; defaults to +X, or +Z when parallel to normal. */
  tangent?: SpatialVector;
}

export interface SurfaceReference {
  meshPath: number[];
  triangleIndex: number;
  barycentric: SpatialVector;
  sourceKey: string;
  topologyKey: string;
  /** Native immutable geometry version; advanced only by verified local patches. */
  geometryKey?: string;
  /** Ordered vertex identities expected at triangleIndex. */
  vertexIndices?: [number,number,number];
}
export interface SurfaceAnchor {
  kind: 'surface'; name?: string; surface: SurfaceReference;
  /** Optional object-local heading projected into the current surface plane. */
  tangent?: SpatialVector;
}
export type SceneAnchor = LocalAnchor | SurfaceAnchor;

export function validateSurfaceReference(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'surface reference must be an object';
  const r = value as SurfaceReference;
  if (Object.keys(r).some(k => !['meshPath','triangleIndex','barycentric','sourceKey','topologyKey','geometryKey','vertexIndices'].includes(k))) return 'unknown surface reference field';
  if (!Array.isArray(r.meshPath) || r.meshPath.some(i => !Number.isSafeInteger(i) || i < 0)) return 'invalid surface meshPath';
  if (!Number.isSafeInteger(r.triangleIndex) || r.triangleIndex < 0) return 'invalid surface triangleIndex';
  if (!spatialVector(r.barycentric) || r.barycentric.some(v => v < 0 || v > 1) || Math.abs(r.barycentric.reduce((s,v)=>s+v,0)-1)>1e-6) return 'invalid surface barycentric weights';
  if (typeof r.sourceKey !== 'string' || !r.sourceKey || typeof r.topologyKey !== 'string' || !/^[a-f0-9]{64}$/.test(r.topologyKey)) return 'surface source/topology keys must come from a surface query';
  if(r.geometryKey!==undefined&&(typeof r.geometryKey!=='string'||!/^[a-f0-9]{64}$/.test(r.geometryKey)))return 'invalid surface geometryKey';
  if(r.vertexIndices!==undefined&&(!Array.isArray(r.vertexIndices)||r.vertexIndices.length!==3||new Set(r.vertexIndices).size!==3||r.vertexIndices.some(i=>!Number.isSafeInteger(i)||i<0)))return 'surface vertexIndices must contain three distinct nonnegative indices';
  return null;
}

export function sameSurfaceReference(a:SurfaceReference,b:SurfaceReference):boolean {
  return a.sourceKey===b.sourceKey&&a.topologyKey===b.topologyKey&&a.geometryKey===b.geometryKey&&a.triangleIndex===b.triangleIndex&&
    JSON.stringify(a.meshPath)===JSON.stringify(b.meshPath)&&JSON.stringify(a.barycentric)===JSON.stringify(b.barycentric)&&JSON.stringify(a.vertexIndices)===JSON.stringify(b.vertexIndices);
}

export const spatialVector = (v: unknown): v is SpatialVector => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
export const anchorIdValid = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(id) && !['__proto__','constructor','prototype'].includes(id);

export function validateAnchor(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'anchor must be an object';
  const raw = value as SceneAnchor;
  if (raw.kind === 'surface') {
    if (Object.keys(raw).some(k => !['kind','name','surface','tangent'].includes(k)) || raw.name !== undefined && typeof raw.name !== 'string') return 'invalid surface anchor fields';
    if(raw.tangent!==undefined&&(!spatialVector(raw.tangent)||!Math.hypot(...raw.tangent)||!Number.isFinite(Math.hypot(...raw.tangent))))return 'surface tangent must be a nonzero finite vector';
    return validateSurfaceReference(raw.surface);
  }
  if (raw.kind !== undefined && raw.kind !== 'local') return 'unknown anchor kind';
  const a = raw as LocalAnchor;
  if (Object.keys(a).some(k => !['kind','name','position','normal','tangent'].includes(k))) return 'unknown anchor field';
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
