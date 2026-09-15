import type { VDocument } from '@velocut/protocol';
import { normalizeSceneSpec, sceneObjects, validateSceneSpec, sceneBudget } from '@velocut/scene-sdk';

export type QueryKind = 'document' | 'snapshot' | 'assets' | 'tracks' | 'clips' | 'sceneObjects' | 'sceneGeometries' | 'sceneMaterials' | 'sceneCurves' | 'sceneBudget' | 'selection';
export interface AtomicQuery {
  kind: QueryKind;
  snapshotId?: string;
  ids?: string[];
  trackId?: string;
  assetId?: string;
  fromUs?: number;
  toUs?: number;
  offset?: number;
  limit?: number;
  fields?: string[];
}
export class AtomicFault extends Error {
  constructor(public code: string, message: string, public field?: string) { super(message); }
}
export function fault(code: string, message: string, field?: string): never { throw new AtomicFault(code, message, field); }
export function object(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fault('invalidArg', `${label} must be an object`, label);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fault('invalidArg', `unknown ${label} field '${key}'`, key);
}
export function integer(value: unknown, min: number, max: number, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) fault('invalidArg', `${field} must be an integer in ${min}..${max}`, field);
}
const FIELDS = {
  assets: ['id', 'name', 'kind', 'src', 'durationUs', 'width', 'height', 'hasAudio', 'spec'],
  tracks: ['id', 'name', 'kind', 'muted', 'locked', 'clipIds'],
  clips: ['id', 'trackId', 'assetId', 'startUs', 'endUs', 'durationUs', 'sourceInUs', 'speed', 'transform', 'volume', 'text', 'keyframes', 'effects', 'transition'],
  sceneObjects: ['id', 'kind', 'name', 'parentId', 'model', 'geometryId', 'materialId', 'object'],
  sceneGeometries: ['id', 'name', 'vertexCount', 'triangleCount', 'instanceCount', 'objectCount', 'storage', 'resource', 'geometry'],
  sceneMaterials: ['id', 'name', 'objectCount', 'material'],
  sceneCurves: ['id', 'name', 'mode', 'keyCount', 'objectCount', 'curve'],
};
const DEFAULT_FIELDS = {
  assets: ['id', 'name', 'kind', 'durationUs', 'width', 'height', 'hasAudio'],
  tracks: FIELDS.tracks,
  clips: ['id', 'trackId', 'assetId', 'startUs', 'endUs', 'durationUs', 'sourceInUs', 'speed'],
  sceneObjects: ['id', 'kind', 'name', 'parentId', 'model', 'geometryId', 'materialId'],
  sceneGeometries: ['id', 'name', 'vertexCount', 'triangleCount', 'instanceCount', 'objectCount', 'storage'],
  sceneMaterials: ['id', 'name', 'objectCount'],
  sceneCurves: ['id', 'name', 'mode', 'keyCount', 'objectCount'],
};
export const QUERY_FIELDS = Object.fromEntries(Object.keys(FIELDS).map(kind => [kind, {
  allowed: FIELDS[kind as keyof typeof FIELDS], defaults: DEFAULT_FIELDS[kind as keyof typeof DEFAULT_FIELDS],
}]));
export const QUERY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['kind'], properties: {
    kind: { enum: ['document', 'snapshot', 'assets', 'tracks', 'clips', 'sceneObjects', 'sceneGeometries', 'sceneMaterials', 'sceneCurves', 'sceneBudget', 'selection'] },
    snapshotId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100, uniqueItems: true },
    trackId: { type: 'string' }, assetId: { type: 'string' },
    fromUs: { type: 'integer', minimum: 0 }, toUs: { type: 'integer', minimum: 0 },
    offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
    fields: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
  },
};
export function validateQuery(input: unknown): AtomicQuery {
  object(input, Object.keys(QUERY_SCHEMA.properties), 'query');
  if (!QUERY_SCHEMA.properties.kind.enum.includes(input.kind as string)) fault('invalidArg', 'unknown query kind', 'kind');
  const q = input as unknown as AtomicQuery;
  for (const key of ['snapshotId', 'trackId', 'assetId'] as const) if (q[key] !== undefined && (typeof q[key] !== 'string' || !q[key])) fault('invalidArg', `${key} must be a nonempty string`, key);
  for (const key of ['offset', 'fromUs', 'toUs'] as const) if (q[key] !== undefined) integer(q[key], 0, Number.MAX_SAFE_INTEGER, key);
  if (q.limit !== undefined) integer(q.limit, 1, 100, 'limit');
  if (q.fromUs !== undefined && q.toUs !== undefined && q.toUs <= q.fromUs) fault('invalidArg', 'toUs must exceed fromUs', 'toUs');
  for (const key of ['ids', 'fields'] as const) if (q[key] !== undefined) {
    const values = q[key]!;
    if (!Array.isArray(values) || !values.length || values.length > (key === 'ids' ? 100 : 20) || values.some(v => typeof v !== 'string' || !v) || new Set(values).size !== values.length)
      fault('invalidArg', `${key} must contain bounded, unique strings`, key);
  }
  if (q.kind === 'sceneBudget') {
    for (const key of Object.keys(q)) if (!['kind', 'assetId', 'snapshotId'].includes(key)) fault('invalidArg', `sceneBudget does not accept ${key}`, key);
  } else if (['document', 'snapshot', 'selection'].includes(q.kind)) {
    for (const key of Object.keys(q)) if (key !== 'kind' && !(q.kind === 'document' && key === 'snapshotId')) fault('invalidArg', `${q.kind} does not accept ${key}`, key);
  } else {
    if (q.kind !== 'clips' && [q.trackId, q.fromUs, q.toUs].some(v => v !== undefined)) fault('invalidArg', 'track/time filters require kind:clips');
    if (q.assetId !== undefined && !['clips', 'sceneObjects', 'sceneGeometries', 'sceneMaterials', 'sceneCurves'].includes(q.kind)) fault('invalidArg', 'assetId filter requires clips or a scene query');
    for (const f of q.fields ?? []) if (!FIELDS[q.kind as keyof typeof FIELDS].includes(f)) fault('invalidArg', `unknown ${q.kind} field '${f}'`, 'fields');
  }
  return q;
}
export function documentSummary(doc: VDocument) {
  return { id: doc.id, name: doc.name, width: doc.width, height: doc.height, fpsNum: doc.fpsNum, fpsDen: doc.fpsDen,
    assetCount: doc.assets.length, trackCount: doc.tracks.length, clipCount: doc.tracks.reduce((n, t) => n + t.clips.length, 0) };
}
export function queryDocument(doc: VDocument, q: AtomicQuery) {
  if (q.kind === 'document') return documentSummary(doc);
  let items: Record<string, unknown>[];
  if (q.kind === 'assets') items = doc.assets.map(a => ({ ...a }));
  else if (q.kind === 'tracks') items = doc.tracks.map(({ clips, ...t }) => ({ ...t, clipIds: clips.map(c => c.id) }));
  else if (q.kind === 'clips') {
    items = doc.tracks.filter(t => !q.trackId || t.id === q.trackId).flatMap(t => t.clips
      .filter(c => (!q.assetId || c.assetId === q.assetId) && (q.fromUs === undefined || c.startUs + c.durationUs > q.fromUs) && (q.toUs === undefined || c.startUs < q.toUs))
      .map(c => ({ ...c, trackId: t.id, endUs: c.startUs + c.durationUs })))
      .sort((a, b) => a.startUs - b.startUs || a.trackId.localeCompare(b.trackId) || a.id.localeCompare(b.id));
  } else if (['sceneObjects', 'sceneGeometries', 'sceneMaterials', 'sceneCurves', 'sceneBudget'].includes(q.kind)) {
    const asset = doc.assets.find(a => a.id === q.assetId && a.src.startsWith('scene://'));
    if (!asset?.spec) fault('notFound', 'scene queries require a scene assetId', 'assetId');
    const spec = JSON.parse(asset.spec);
    const error = validateSceneSpec(spec); if (error) fault('invalidScene', error);
    if (q.kind === 'sceneBudget') return sceneBudget(spec);
    const counts = new Map<string, number>(), instances = new Map<string, number>(), materials = new Map<string, number>();
    for (const p of spec.props ?? []) {
      if (p.geometryId) { counts.set(p.geometryId, (counts.get(p.geometryId) ?? 0) + 1); if (p.model === 'prop/instance') instances.set(p.geometryId, (instances.get(p.geometryId) ?? 0) + 1); }
      if (p.materialId) materials.set(p.materialId, (materials.get(p.materialId) ?? 0) + 1);
    }
    const curveUsers = new Map<string,Set<string>>();
    for(const {object} of sceneObjects(spec)) for(const value of Object.values(object.animation?.channels ?? {})) {
      if(value && typeof value === 'object' && 'curveId' in value){const ids=curveUsers.get(value.curveId)??new Set<string>();ids.add(object.id!);curveUsers.set(value.curveId,ids);}
    }
    items = q.kind === 'sceneCurves' ? Object.entries(spec.curves ?? {}).map(([id, raw]) => {const curve=raw as import('@velocut/scene-sdk').SceneCurve;return {id,name:curve.name,mode:curve.mode??'continuous',keyCount:curve.keys.length,objectCount:curveUsers.get(id)?.size??0,curve};}) : q.kind === 'sceneMaterials' ? Object.entries(spec.materials ?? {}).map(([id, material]: [string, any]) => ({id, name:material.name, objectCount:materials.get(id) ?? 0, material})) : q.kind === 'sceneGeometries' ? [...Object.entries(spec.geometries ?? {}), ...Object.entries(spec.geometryResources ?? {})].map(([id, geometry]) => {
      const g = geometry as import('@velocut/scene-sdk').SceneGeometry;
      const resource = spec.geometryResources?.[id];
      return { id, name: g.name, vertexCount: resource?.vertexCount ?? g.vertices.length, triangleCount: resource?.triangleCount ?? g.faces.length,
        instanceCount: instances.get(id) ?? 0, objectCount: counts.get(id) ?? 0, storage: resource ? 'resource' : 'inline', ...(resource ? {resource} : {geometry:g}) };
    }) : sceneObjects(normalizeSceneSpec(spec)).map(({ kind, object }) => ({ id: object.id, kind, name: object.name, parentId: object.parentId, ...('model' in object ? { model: object.model } : {}), ...('geometryId' in object ? { geometryId: object.geometryId } : {}), ...('materialId' in object ? { materialId: object.materialId } : {}), object }));
  } else fault('invalidArg', 'unsupported entity query');
  if (q.ids) items = items.filter(item => q.ids!.includes(item.id as string));
  const total = items.length, offset = q.offset ?? 0, limit = q.limit ?? 50;
  const fields = q.fields ?? DEFAULT_FIELDS[q.kind as keyof typeof DEFAULT_FIELDS];
  return { items: structuredClone(items.slice(offset, offset + limit).map(item => Object.fromEntries(fields.filter(f => Object.hasOwn(item, f) && item[f] !== undefined).map(f => [f, item[f]])))),
    total, nextOffset: offset + limit < total ? offset + limit : null };
}
