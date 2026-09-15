import { validateGeometry, SCENE_LIMITS, type SceneGeometry } from './geometry.ts';
import type { SceneResources } from './models.ts';
import type { SceneSpec } from './types.ts';

export interface SceneGeometryResource {
  src: string;
  name?: string;
  vertexCount: number;
  triangleCount: number;
  hasUvs: boolean;
  byteLength: number;
}
export const GEOMETRY_SOURCE = /^opfs:\/\/scene-geometry-([a-f0-9]{64})\.vmesh$/;
const HEADER = 24, MAGIC = 0x48534d56; // VMSH, little endian, version 1
export const geometryByteLength = (vertices: number, triangles: number, uvs: boolean) => HEADER + vertices * (uvs ? 40 : 24) + triangles * 12;
export function validateGeometryResource(r: SceneGeometryResource): string | null {
  if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['src','name','vertexCount','triangleCount','hasUvs','byteLength'].includes(k))) return 'invalid geometry resource fields';
  if (typeof r.src !== 'string' || !GEOMETRY_SOURCE.test(r.src)) return 'invalid geometry resource source';
  if (!Number.isInteger(r.vertexCount) || r.vertexCount < 3 || r.vertexCount > SCENE_LIMITS.geometryVertices || !Number.isInteger(r.triangleCount) || r.triangleCount < 1 || r.triangleCount > SCENE_LIMITS.geometryTriangles || typeof r.hasUvs !== 'boolean') return 'invalid geometry resource counts';
  if (r.byteLength !== geometryByteLength(r.vertexCount, r.triangleCount, r.hasUvs)) return 'invalid geometry resource byteLength';
  if (r.name != null && (typeof r.name !== 'string' || r.name.length > 256)) return 'invalid geometry resource name';
  return null;
}

/** Float64 keeps authored numbers exact through save/load and history. GPU
 * Float32 conversion happens in the renderer, never in the source resource. */
export function encodeGeometry(g: SceneGeometry): ArrayBuffer {
  const error = validateGeometry(g); if (error) throw new Error(error);
  const data = new ArrayBuffer(geometryByteLength(g.vertices.length, g.faces.length, !!g.uvs)), view = new DataView(data);
  [MAGIC, 1, g.vertices.length, g.faces.length, g.uvs ? 1 : 0, 0].forEach((v, i) => view.setUint32(i * 4, v, true));
  let offset = HEADER;
  for (const tuple of g.vertices) for (const n of tuple) { view.setFloat64(offset, n, true); offset += 8; }
  for (const tuple of g.faces) for (const n of tuple) { view.setUint32(offset, n, true); offset += 4; }
  for (const tuple of g.uvs ?? []) for (const n of tuple) { view.setFloat64(offset, n, true); offset += 8; }
  return data;
}
export function decodeGeometry(data: ArrayBuffer): SceneGeometry {
  if (!(data instanceof ArrayBuffer) || data.byteLength < HEADER) throw new Error('invalid geometry file');
  const v = new DataView(data), vertices = v.getUint32(8, true), faces = v.getUint32(12, true), uvs = v.getUint32(16, true);
  if (v.getUint32(0,true) !== MAGIC || v.getUint32(4,true) !== 1 || v.getUint32(20,true) !== 0 || uvs > 1 ||
    vertices < 3 || vertices > SCENE_LIMITS.geometryVertices || faces < 1 || faces > SCENE_LIMITS.geometryTriangles || data.byteLength !== geometryByteLength(vertices, faces, !!uvs)) throw new Error('invalid geometry header or length');
  let offset = HEADER;
  const floats = () => { const n = v.getFloat64(offset,true); offset += 8; return n; };
  const index = () => { const n = v.getUint32(offset,true); offset += 4; return n; };
  const result: SceneGeometry = {
    vertices: Array.from({length:vertices}, () => [floats(),floats(),floats()]),
    faces: Array.from({length:faces}, () => [index(),index(),index()]),
    ...(uvs ? {uvs:Array.from({length:vertices}, (): [number,number] => [floats(),floats()])} : {}),
  };
  const error = validateGeometry(result); if (error) throw new Error(error);
  return result;
}
export async function geometryHash(data: ArrayBuffer) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map(n => n.toString(16).padStart(2,'0')).join('');
}
export async function resolveSceneGeometry(spec: SceneSpec, id: string, resources?: SceneResources): Promise<SceneGeometry> {
  if (Object.hasOwn(spec.geometries ?? {}, id)) return structuredClone(spec.geometries![id]);
  const r = Object.hasOwn(spec.geometryResources ?? {}, id) ? spec.geometryResources![id] : undefined;
  if (!r) throw new Error(`unknown geometry '${id}'`);
  const error = validateGeometryResource(r); if (error) throw new Error(error);
  if (!resources?.geometryBytes) throw new Error('configure a project geometryBytes resolver');
  const bytes = await resources.geometryBytes(r.src);
  if (bytes.byteLength !== r.byteLength || await geometryHash(bytes) !== GEOMETRY_SOURCE.exec(r.src)![1]) throw new Error('geometry bytes are missing or changed');
  const g = decodeGeometry(bytes);
  if (g.vertices.length !== r.vertexCount || g.faces.length !== r.triangleCount || !!g.uvs !== r.hasUvs) throw new Error('geometry metadata does not match its resource');
  return { ...g, ...(r.name != null ? {name:r.name} : {}) };
}
