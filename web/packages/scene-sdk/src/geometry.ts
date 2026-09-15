import type { SceneMaterial, SceneProp, SceneSpec } from './types.ts';
import { geometryByteLength } from './geometry-resource.ts';

/** Scene-local editable geometry. Instances reference its registry key. */
export interface SceneGeometry {
  name?: string;
  vertices: [number, number, number][];
  faces: [number, number, number][];
  uvs?: [number, number][];
}

export const SCENE_LIMITS = Object.freeze({
  specBytes: 262_144, props: 200, instances: 1000, geometries: 64,
  groups: 100, geometryVertices: 4096, geometryTriangles: 8192,
  instanceBatches: 128, instanceTriangles: 2_000_000,
  geometryBytes: 16 * 1024 * 1024,
});

export function validateGeometry(value: unknown): string | null {
  const g = value as SceneGeometry;
  const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));
  if (!g || typeof g !== 'object' || Array.isArray(g) || Object.keys(g).some(k => !['name', 'vertices', 'faces', 'uvs'].includes(k))) return 'geometry takes name, vertices, faces and optional uvs';
  if (g.name != null && (typeof g.name !== 'string' || g.name.length > 256)) return 'invalid geometry name';
  if (!Array.isArray(g.vertices) || g.vertices.length < 3 || g.vertices.length > SCENE_LIMITS.geometryVertices || !g.vertices.every(vector)) return 'geometry vertices must contain 3..4096 finite triples';
  if (!Array.isArray(g.faces) || !g.faces.length || g.faces.length > SCENE_LIMITS.geometryTriangles) return 'geometry faces must contain 1..8192 triangles';
  for (const f of g.faces) {
    if (!Array.isArray(f) || f.length !== 3 || new Set(f).size !== 3 || !f.every(i => Number.isInteger(i) && i >= 0 && i < g.vertices.length)) return 'geometry faces need distinct valid vertex indices';
    const [a, b, c] = f.map(i => g.vertices[i]);
    const u = b.map((n, i) => n - a[i]), v = c.map((n, i) => n - a[i]);
    const area = Math.hypot(u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0]);
    if (!Number.isFinite(area) || area < 1e-12) return 'geometry contains a degenerate triangle';
  }
  if (g.uvs != null && (!Array.isArray(g.uvs) || g.uvs.length !== g.vertices.length || !g.uvs.every(v => Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number' && Number.isFinite(n))))) return 'geometry uvs must provide a finite pair per vertex';
  return null;
}

/** Explicit default normalization keeps equivalent materials in one batch.
 * Color is per instance, so changing it does not add a draw batch. */
export function instanceBatchKey(p: SceneProp): string {
  const m: SceneMaterial = p.material ?? {};
  return JSON.stringify([p.geometryId, m.roughness ?? 0.6, m.metalness ?? 0,
    m.opacity ?? 1, m.emissive ?? '#000000', m.emissiveIntensity ?? 1, m.side ?? 'front']);
}

/** Counts describe native instances only; they are not GPU-memory estimates
 * or a triangle census of imported GLBs and procedural primitives. */
export function sceneBudget(spec: SceneSpec) {
  const props = spec.props ?? [], instances = props.filter(p => p?.model === 'prop/instance');
  const geometries = Object.values(spec.geometries ?? {});
  const resources = Object.values(spec.geometryResources ?? {});
  // A deterministic size estimate for the compact manifest. Hash strings have
  // fixed length; preflight can calculate costs without storage or hashing.
  const manifest = { ...spec, geometryResources: { ...spec.geometryResources } };
  delete manifest.geometries;
  for (const [id, g] of Object.entries(spec.geometries ?? {})) manifest.geometryResources[id] = {
    src: `opfs://scene-geometry-${'0'.repeat(64)}.vmesh`, name:g.name,
    vertexCount:g.vertices?.length ?? 0, triangleCount:g.faces?.length ?? 0,
    hasUvs:!!g.uvs, byteLength:geometryByteLength(g.vertices?.length ?? 0,g.faces?.length ?? 0,!!g.uvs),
  };
  if (!Object.keys(manifest.geometryResources).length) delete (manifest as SceneSpec).geometryResources;
  const used = {
    specBytes: new TextEncoder().encode(JSON.stringify(manifest)).length,
    props: props.length - instances.length, instances: instances.length,
    geometries: geometries.length + resources.length, groups: spec.groups?.length ?? 0,
    geometryBytes: geometries.reduce((n,g) => n + geometryByteLength(g.vertices?.length ?? 0,g.faces?.length ?? 0,!!g.uvs),0) + resources.reduce((n,r) => n+r.byteLength,0),
    instanceBatches: new Set(instances.map(instanceBatchKey)).size,
    instanceTriangles: instances.reduce((n, p) => n + (spec.geometries?.[p.geometryId!]?.faces?.length ?? spec.geometryResources?.[p.geometryId!]?.triangleCount ?? 0), 0),
  };
  const violations = (Object.keys(used) as Array<keyof typeof used>).filter(k => used[k] > SCENE_LIMITS[k])
    .map(field => ({ field, used: used[field], limit: SCENE_LIMITS[field] }));
  return { withinLimits: !violations.length, used, limits: SCENE_LIMITS, violations,
    documentBytes: new TextEncoder().encode(JSON.stringify(spec)).length,
    sharedVertices: geometries.reduce((n, g) => n + (g?.vertices?.length ?? 0), 0) + resources.reduce((n,r) => n+r.vertexCount,0),
    sharedTriangles: geometries.reduce((n, g) => n + (g?.faces?.length ?? 0), 0) + resources.reduce((n,r) => n+r.triangleCount,0),
  };
}
