// Pure, transactional authoring. This is shared by human controls, scripts and
// future transports. Three.js remains a derived view of the returned document.
import { layoutTransforms, transformObject, placementTime, type ObjectTransform, type SceneLayout } from './placement.ts';
import { assemblyParts, type AssemblyRecipe } from './assemblies.ts';
import { validateSceneSpec, type SceneSpec, type SceneCharacter, type SceneProp, type SceneGroup, type SceneLight } from './types.ts';

export type SceneObjectKind = 'character' | 'prop' | 'group' | 'light';
export type SceneObject = SceneCharacter | SceneProp | SceneGroup | SceneLight;
export interface SceneCopy { prefix: string; rootIds: string[]; idMap: Record<string, string> }
export type SceneEdit =
  | { type: 'duplicateMany'; ids: string[]; copies: Array<{ prefix: string; transform?: ObjectTransform; relative?: boolean }>; timeS?: number }
  | { type: 'transform'; ids: string[]; transform: ObjectTransform; relative?: boolean; timeS?: number }
  | { type: 'layout'; ids: string[]; layout: SceneLayout; timeS?: number }
  | { type: 'assembly'; id: string; recipe: AssemblyRecipe }
  | { type: 'array'; id: string; prefix: string; copies: number; offset: { x?: number; y?: number; z?: number } }
  | { type: 'add'; kind: 'character'; object: SceneCharacter }
  | { type: 'add'; kind: 'prop'; object: SceneProp }
  | { type: 'add'; kind: 'group'; object: SceneGroup }
  | { type: 'add'; kind: 'light'; object: SceneLight }
  | { type: 'update'; id: string; patch: Partial<SceneCharacter & SceneProp & SceneLight>; clear?: string[] }
  | { type: 'remove'; id: string; cascade?: boolean }
  | { type: 'duplicate'; id: string; newId: string; offset?: { x?: number; y?: number; z?: number } }
  | { type: 'scene'; patch: Partial<Pick<SceneSpec, 'camera' | 'shots' | 'environment' | 'lighting' | 'physics'>>; clear?: Array<'shots' | 'camera' | 'physics'> };

export function sceneObjects(spec: SceneSpec): Array<{ kind: SceneObjectKind; object: SceneObject }> {
  return [
    ...(spec.characters ?? []).map((object) => ({ kind: 'character' as const, object })),
    ...(spec.props ?? []).map((object) => ({ kind: 'prop' as const, object })),
    ...(spec.groups ?? []).map((object) => ({ kind: 'group' as const, object })),
    ...(spec.lights ?? []).map((object) => ({ kind: 'light' as const, object })),
  ];
}

export function nextSceneId(spec: SceneSpec, prefix = 'object'): string {
  const used = new Set(sceneObjects(spec).map(({ object }) => object.id));
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n++;
  return `${prefix}_${n}`;
}

/** Assign deterministic IDs to legacy anonymous props. On the next authoring
 * commit these become persisted IDs, so subsequent edits never use indices. */
export function normalizeSceneSpec(input: SceneSpec): SceneSpec {
  const spec = structuredClone(input);
  for (const p of spec.props ?? []) if (p.id == null) p.id = nextSceneId(spec, 'prop');
  return spec;
}

const common = ['name', 'parentId', 'position', 'rotationX', 'rotationY', 'rotationZ', 'scale'];
const fields: Record<SceneObjectKind, string[]> = {
  group: common,
  light: [...common, 'type', 'color', 'intensity', 'distance', 'decay', 'angle', 'penumbra', 'shadow'],
  character: [...common, 'model', 'actions', 'gaze', 'morphs', 'pose', 'color'],
  prop: [...common, 'model', 'color', 'material', 'attachTo', 'vertices', 'faces', 'uvs', 'points', 'depth', 'holes', 'bevel', 'path', 'radius', 'closed', 'physics'],
};
const fail = (message: string): never => { throw new Error(message); };

export function applySceneEdits(input: SceneSpec, edits: SceneEdit[]): { spec: SceneSpec; changedIds: string[]; createdIds: string[]; copies: SceneCopy[] } {
  if (!Array.isArray(edits) || !edits.length || edits.length > 500) fail('edits must contain 1..500 operations');
  const initialError = validateSceneSpec(input);
  if (initialError) fail(initialError);
  const spec = normalizeSceneSpec(input);
  const changed = new Set<string>();
  const initialIds = new Set(sceneObjects(spec).map(e => e.object.id));
  const copies: SceneCopy[] = [];
  const find = (id: string) => sceneObjects(spec).find((e) => e.object.id === id) ?? fail(`unknown object '${id}'`);
  const append = (kind: SceneObjectKind, object: SceneObject) => {
    if (kind === 'character') (spec.characters ??= []).push(object as SceneCharacter);
    else if (kind === 'prop') (spec.props ??= []).push(object as SceneProp);
    else if (kind === 'light') (spec.lights ??= []).push(object as SceneLight);
    else (spec.groups ??= []).push(object as SceneGroup);
  };
  const descendants = (id: string) => {
    const ids = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const { object } of sceneObjects(spec)) {
        if (object.id && !ids.has(object.id) &&
          ((object.parentId && ids.has(object.parentId)) || ('attachTo' in object && object.attachTo && ids.has(object.attachTo.character)))) {
          ids.add(object.id); grew = true;
        }
      }
    }
    return ids;
  };
  const selection = (ids: string[]) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200 || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length)
      fail('ids must contain 1..200 unique object IDs');
    const entries = ids.map(find);
    for (const id of ids) for (const child of descendants(id))
      if (child !== id && ids.includes(child)) fail('selection cannot include both an object and its descendant');
    return entries;
  };
  const expanded = edits.flatMap((edit): SceneEdit[] => {
    if (edit?.type !== 'array') return [edit];
    if (!Number.isInteger(edit.copies) || edit.copies < 1 || edit.copies > 100 || !edit.prefix?.trim()) fail('array needs copies 1..100 and a prefix');
    if (!edit.offset || Object.keys(edit.offset).some((k) => !['x', 'y', 'z'].includes(k))) fail('array offset must be {x?,y?,z?}');
    return Array.from({ length: edit.copies }, (_, i) => ({ type: 'duplicate' as const, id: edit.id, newId: `${edit.prefix}_${i + 1}`,
      offset: { x: (edit.offset.x ?? 0) * (i + 1), y: (edit.offset.y ?? 0) * (i + 1), z: (edit.offset.z ?? 0) * (i + 1) } }));
  });
  if (expanded.length > 500) fail('expanded batch exceeds 500 operations');
  for (const edit of expanded) {
    if (!edit || typeof edit !== 'object') fail('invalid scene edit');
    if (edit.type === 'assembly') {
      if (typeof edit.id !== 'string' || !edit.id.trim()) fail('assembly requires an id');
      const parts = assemblyParts(edit.id, edit.recipe);
      const existing = sceneObjects(spec).find((e) => e.object.id === edit.id);
      if (existing && (existing.kind !== 'group' || !('assembly' in existing.object) || !existing.object.assembly)) fail('assembly id already belongs to another object');
      const group = existing?.object as SceneGroup | undefined;
      const oldIds = new Set(group?.assembly ? assemblyParts(edit.id, group.assembly).map((p) => p.id) : []);
      for (const p of parts) {
        const old = sceneObjects(spec).find((e) => e.object.id === p.id);
        if (old && !oldIds.has(p.id)) fail(`assembly part id collision '${p.id}'`);
        if (old && old.kind === 'prop') { const prev = old.object as SceneProp; p.color = prev.color; p.material = prev.material; }
      }
      spec.props = (spec.props ?? []).filter((p) => !oldIds.has(p.id));
      spec.props.push(...parts);
      if (group) group.assembly = structuredClone(edit.recipe);
      else (spec.groups ??= []).push({ id: edit.id, name: edit.recipe.template, assembly: structuredClone(edit.recipe) });
      changed.add(edit.id); for (const p of parts) changed.add(p.id!); for (const id of oldIds) changed.add(id!);
    } else if (edit.type === 'add') {
      if (!(edit.kind in fields) || !edit.object || typeof edit.object !== 'object') fail('invalid add operation');
      const o = structuredClone(edit.object);
      o.id ??= nextSceneId(spec, edit.kind);
      if (sceneObjects(spec).some((e) => e.object.id === o.id)) fail(`duplicate object id '${o.id}'`);
      if (Object.keys(o).some((k) => k !== 'id' && !fields[edit.kind].includes(k))) fail('unknown object field');
      append(edit.kind, o); changed.add(o.id);
    } else if (edit.type === 'update') {
      const { kind, object } = find(edit.id);
      if (!edit.patch || typeof edit.patch !== 'object' || Array.isArray(edit.patch)) fail('patch must be an object');
      for (const key of [...Object.keys(edit.patch), ...(edit.clear ?? [])]) {
        if (!fields[kind].includes(key)) fail(`cannot edit '${key}' on ${kind}`);
      }
      Object.assign(object, structuredClone(edit.patch));
      for (const k of edit.clear ?? []) delete (object as unknown as Record<string, unknown>)[k];
      changed.add(edit.id);
    } else if (edit.type === 'transform' || edit.type === 'layout') {
      const entries = selection(edit.ids);
      const timeS = placementTime(edit.timeS);
      if (edit.type === 'transform' && edit.relative != null && typeof edit.relative !== 'boolean') fail('relative must be boolean');
      if (edit.type === 'layout') {
        const frame = (o: SceneObject) => 'attachTo' in o && o.attachTo ? `bone:${o.attachTo.character}:${o.attachTo.bone}` : `parent:${o.parentId ?? ''}`;
        if (new Set(entries.map(e => frame(e.object))).size !== 1) fail('layout objects must share a parent frame; use sceneArrange for world-space placement');
      }
      const transforms = edit.type === 'layout' ? layoutTransforms(edit.layout, entries.length) : entries.map(() => edit.transform);
      entries.forEach(({ kind, object }, i) => {
        transformObject(object, kind, transforms[i], edit.type === 'transform' && (edit.relative ?? false), timeS);
        changed.add(object.id!);
      });
    } else if (edit.type === 'duplicate' || edit.type === 'duplicateMany') {
      const roots = edit.type === 'duplicate' ? [edit.id] : edit.ids;
      selection(roots);
      const timeS = edit.type === 'duplicateMany' ? placementTime(edit.timeS) : 0;
      const requests = edit.type === 'duplicate' ? [{ prefix: edit.newId }] : edit.copies;
      if (!Array.isArray(requests) || !requests.length || requests.length > 100) fail('copies must contain 1..100 copy requests');
      const ids = new Set(roots.flatMap(id => [...descendants(id)]));
      // Snapshot once: later copies must never recursively copy earlier copies.
      const entries = sceneObjects(spec).filter(e => ids.has(e.object.id!));
      if (entries.length * requests.length > 500) fail('duplication exceeds 500 generated objects');
      for (const request of requests) {
        if (!request || typeof request.prefix !== 'string' || !request.prefix.trim()) fail('duplicate requires a nonempty prefix/newId');
        if (Object.keys(request).some(k => !['prefix', 'transform', 'relative'].includes(k))) fail('unknown copy request field');
        if ('relative' in request && request.relative != null && typeof request.relative !== 'boolean') fail('relative must be boolean');
        const mapped = new Map<string, string>();
        const used = new Set(sceneObjects(spec).map(e => e.object.id));
        for (const { object } of entries) {
          const oldId = object.id!;
          const id = edit.type === 'duplicate'
            ? oldId === edit.id ? request.prefix : oldId.startsWith(edit.id + '/') ? request.prefix + oldId.slice(edit.id.length) : `${request.prefix}/${oldId}`
            : `${request.prefix}/${oldId}`;
          if (used.has(id)) fail(`duplicate object id '${id}'`);
          used.add(id); mapped.set(oldId, id);
        }
        for (const { kind, object } of entries) {
          const o = structuredClone(object);
          o.id = mapped.get(o.id!)!;
          if (o.parentId && mapped.has(o.parentId)) o.parentId = mapped.get(o.parentId);
          if ('attachTo' in o && o.attachTo && mapped.has(o.attachTo.character)) o.attachTo.character = mapped.get(o.attachTo.character)!;
          if ('gaze' in o && typeof o.gaze === 'object' && mapped.has(o.gaze.character)) o.gaze.character = mapped.get(o.gaze.character)!;
          if (roots.includes(object.id!)) {
            if (edit.type === 'duplicate' && edit.offset) transformObject(o, kind, { position: edit.offset }, true);
            if ('transform' in request && request.transform !== undefined) transformObject(o, kind, request.transform!, request.relative ?? false, timeS);
          }
          append(kind, o); changed.add(o.id);
        }
        copies.push({ prefix: request.prefix, rootIds: roots.map(id => mapped.get(id)!), idMap: Object.fromEntries(mapped) });
      }
    } else if (edit.type === 'remove') {
      find(edit.id);
      const ids = descendants(edit.id);
      const referenced = (spec.characters ?? []).some((c) => typeof c.gaze === 'object' && ids.has(c.gaze.character)) ||
        [spec.camera, ...(spec.shots ?? []).map((s) => s.camera)].some((c) => c?.lookAt && 'character' in c.lookAt && ids.has(c.lookAt.character));
      if (!edit.cascade && (ids.size > 1 || referenced)) fail('object has children or references; use cascade:true to remove and clear them');
      spec.characters = spec.characters?.filter((c) => !ids.has(c.id));
      spec.props = spec.props?.filter((p) => !ids.has(p.id!));
      spec.groups = spec.groups?.filter((g) => !ids.has(g.id));
      spec.lights = spec.lights?.filter((l) => !ids.has(l.id));
      for (const c of spec.characters ?? []) if (typeof c.gaze === 'object' && ids.has(c.gaze.character)) { delete c.gaze; changed.add(c.id); }
      for (const cam of [spec.camera, ...(spec.shots ?? []).map((s) => s.camera)]) {
        if (cam?.lookAt && 'character' in cam.lookAt && ids.has(cam.lookAt.character)) cam.lookAt = { x: 0, y: 1, z: 0 };
      }
      for (const id of ids) changed.add(id);
    } else if (edit.type === 'scene') {
      if (!edit.patch || Object.keys(edit.patch).some((k) => !['camera', 'shots', 'environment', 'lighting', 'physics'].includes(k))) fail('invalid scene patch');
      Object.assign(spec, structuredClone(edit.patch));
      for (const k of edit.clear ?? []) {
        if (!['shots', 'camera', 'physics'].includes(k)) fail('invalid scene clear field');
        delete spec[k];
      }
    } else fail('unknown scene operation');
  }
  const error = validateSceneSpec(spec);
  if (error) fail(error);
  return { spec, changedIds: [...changed], createdIds: sceneObjects(spec).map(e => e.object.id!).filter(id => !initialIds.has(id)), copies };
}
