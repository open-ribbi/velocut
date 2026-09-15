// Pure, transactional authoring. This is shared by human controls, scripts and
// future transports. Three.js remains a derived view of the returned document.
import { layoutTransforms, transformObject, placementTime, type ObjectTransform, type SceneLayout } from './placement.ts';
import { assemblyParts, mergeAssemblyPart, type AssemblyRecipe } from './assemblies.ts';
import { validateSceneSpec, type SceneSpec, type SceneCharacter, type SceneProp, type SceneGroup, type SceneLight } from './types.ts';
import { sceneBudget, type SceneGeometry } from './geometry.ts';
import type { SceneGeometryResource } from './geometry-resource.ts';
import type { SceneMaterialDefinition } from './materials.ts';
import { isCurveBinding, type SceneCurve } from './animation.ts';
import { anchorIdValid, type SceneAnchor } from './anchors.ts';
import {activeBinding,assertBindingWrite,type SceneBinding} from './bindings.ts';

/** Pure editing requests verified bytes only when an operation actually needs them. */
export class GeometryDataRequired extends Error {
  id: string;
  resource: SceneGeometryResource;
  constructor(id: string, resource: SceneGeometryResource) {
    super(`geometry '${id}' needs resolved source data`); this.id = id; this.resource = resource;
  }
}

export type SceneObjectKind = 'character' | 'prop' | 'group' | 'light';
export type SceneObject = SceneCharacter | SceneProp | SceneGroup | SceneLight;
export interface SceneCopy { prefix: string; rootIds: string[]; idMap: Record<string, string>; bindingIdMap?: Record<string,string> }
export type SceneEdit =
  | {type:'binding.create'|'binding.update';id:string;binding:SceneBinding}
  | {type:'binding.remove';id:string}
  | { type: 'anchor.set'; id: string; anchorId: string; anchor: SceneAnchor }
  | { type: 'anchor.remove'; id: string; anchorId: string }
  | { type: 'curve.create' | 'curve.update'; id: string; curve: SceneCurve }
  | { type: 'curve.remove'; id: string }
  | { type: 'geometry.create'; id: string; geometry: SceneGeometry }
  | { type: 'geometry.update'; id: string; geometry: SceneGeometry }
  | { type: 'geometry.clone'; id: string; newId: string }
  | { type: 'geometry.remove'; id: string }
  | { type: 'geometry.patch'; id: string; attribute: 'vertices' | 'faces' | 'uvs'; updates: Array<{index: number; value: number[]}> }
  | { type: 'makeUnique'; id: string; geometryId?: string }
  | { type: 'material.create' | 'material.update'; id: string; material: SceneMaterialDefinition }
  | { type: 'material.remove'; id: string }
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

const common = ['name', 'parentId', 'position', 'rotationX', 'rotationY', 'rotationZ', 'scale', 'visible', 'opacity', 'animation', 'anchors'];
const fields: Record<SceneObjectKind, string[]> = {
  group: common,
  light: [...common, 'type', 'color', 'intensity', 'distance', 'decay', 'angle', 'penumbra', 'shadow'],
  character: [...common, 'model', 'actions', 'gaze', 'morphs', 'pose', 'color'],
  prop: [...common, 'model', 'geometryId', 'materialId', 'color', 'material', 'attachTo', 'vertices', 'faces', 'uvs', 'points', 'depth', 'holes', 'bevel', 'path', 'radius', 'closed', 'physics'],
};
const fail = (message: string): never => { throw new Error(message); };

export function applySceneEdits(input: SceneSpec, edits: SceneEdit[], geometryData: ReadonlyMap<string, SceneGeometry> = new Map()): { spec: SceneSpec; changedIds: string[]; createdIds: string[]; geometryIds: string[]; materialIds: string[]; curveIds: string[]; bindingIds: string[]; copies: SceneCopy[] } {
  if (!Array.isArray(edits) || !edits.length || edits.length > 500) fail('edits must contain 1..500 operations');
  const initialError = validateSceneSpec(input);
  if (initialError) fail(initialError);
  const spec = normalizeSceneSpec(input);
  const changed = new Set<string>();
  const geometryIds = new Set<string>();
  const materialIds = new Set<string>();
  const curveIds = new Set<string>();
  const bindingIds = new Set<string>();
  const validResourceId = (id: string) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(id) && !['__proto__','constructor','prototype'].includes(id);
  const hasGeometry = (id: string) => Object.hasOwn(spec.geometries ?? {}, id) || Object.hasOwn(spec.geometryResources ?? {}, id);
  const cloneGeometry = (id: string, newId: string) => {
    if (!validResourceId(id) || !hasGeometry(id)) fail('unknown source geometry');
    if (!validResourceId(newId) || hasGeometry(newId)) fail('new geometry id is invalid or already exists');
    if (Object.hasOwn(spec.geometries ?? {}, id)) (spec.geometries ??= {})[newId] = structuredClone(spec.geometries![id]);
    else (spec.geometryResources ??= {})[newId] = structuredClone(spec.geometryResources![id]);
    geometryIds.add(newId);
  };
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
    if (edit.type === 'binding.create' || edit.type === 'binding.update' || edit.type === 'binding.remove') {
      if(!validResourceId(edit.id))fail('invalid binding id');
      const registry=spec.bindings??={},old=Object.hasOwn(registry,edit.id)?registry[edit.id]:undefined;
      if(edit.type==='binding.create'&&old)fail('binding already exists');
      if(edit.type!=='binding.create'&&!old)fail('unknown binding');
      if(old?.target?.objectId)changed.add(old.target.objectId);
      if(edit.type==='binding.remove')delete registry[edit.id];
      else {registry[edit.id]=structuredClone(edit.binding);if(edit.binding?.target?.objectId)changed.add(edit.binding.target.objectId);}
      bindingIds.add(edit.id);
    } else if (edit.type === 'anchor.set' || edit.type === 'anchor.remove') {
      const {object} = find(edit.id);
      if (!anchorIdValid(edit.anchorId)) fail('invalid anchor id');
      if (edit.type === 'anchor.set') (object.anchors ??= {})[edit.anchorId] = structuredClone(edit.anchor);
      else {
        if (!Object.hasOwn(object.anchors ?? {}, edit.anchorId)) fail('unknown anchor');
        delete object.anchors![edit.anchorId];
      }
      changed.add(edit.id);
    } else if (edit.type === 'curve.create' || edit.type === 'curve.update' || edit.type === 'curve.remove') {
      if (!validResourceId(edit.id)) fail('invalid curve id');
      const registry = spec.curves ??= {}, exists = Object.hasOwn(registry, edit.id);
      if (edit.type === 'curve.create' && exists) fail('curve already exists');
      if (edit.type !== 'curve.create' && !exists) fail('unknown curve');
      const users = sceneObjects(spec).filter(e => Object.values(e.object.animation?.channels ?? {}).some(v => isCurveBinding(v) && v.curveId === edit.id));
      if (edit.type === 'curve.remove') { if (users.length) fail('curve is referenced by objects'); delete registry[edit.id]; }
      else registry[edit.id] = structuredClone(edit.curve);
      curveIds.add(edit.id); users.forEach(e => changed.add(e.object.id!));
    } else if (edit.type === 'geometry.clone') {
      cloneGeometry(edit.id, edit.newId);
    } else if (edit.type === 'material.create' || edit.type === 'material.update' || edit.type === 'material.remove') {
      if (!validResourceId(edit.id)) fail('invalid material id');
      const registry = spec.materials ??= {}, exists = Object.hasOwn(registry, edit.id);
      if (edit.type === 'material.create' && exists) fail('material already exists');
      if (edit.type !== 'material.create' && !exists) fail('unknown material');
      const users = (spec.props ?? []).filter(p => p.materialId === edit.id);
      if (edit.type === 'material.remove') {
        if (users.length) fail('material is referenced by objects');
        delete registry[edit.id];
      } else registry[edit.id] = structuredClone(edit.material);
      materialIds.add(edit.id); users.forEach(p => changed.add(p.id!));
    } else if (edit.type === 'geometry.patch') {
      let g = spec.geometries?.[edit.id];
      if (!g && Object.hasOwn(spec.geometryResources ?? {}, edit.id)) {
        const resource = spec.geometryResources![edit.id], data = geometryData.get(resource.src);
        if (!data) throw new GeometryDataRequired(edit.id, structuredClone(resource));
        g = { ...structuredClone(data), name: resource.name };
        (spec.geometries ??= {})[edit.id] = g; delete spec.geometryResources![edit.id];
      }
      if (!g) fail('geometry.patch requires resolved geometry data');
      if (!['vertices','faces','uvs'].includes(edit.attribute) || !Array.isArray(edit.updates) || !edit.updates.length || edit.updates.length > 1024) fail('geometry.patch requires an attribute and 1..1024 updates');
      const data = g![edit.attribute]; if (!data) fail('geometry attribute does not exist');
      const seen = new Set<number>();
      for (const update of edit.updates) {
        if (!Number.isInteger(update?.index) || update.index < 0 || update.index >= data!.length || seen.has(update.index)) fail('geometry patch indices must be unique and in range');
        seen.add(update.index); data![update.index] = structuredClone(update.value) as [number, number, number];
      }
      geometryIds.add(edit.id); for (const p of spec.props ?? []) if (p.geometryId === edit.id) changed.add(p.id!);
    } else if (edit.type === 'geometry.create' || edit.type === 'geometry.update' || edit.type === 'geometry.remove') {
      if (typeof edit.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(edit.id) || ['__proto__', 'constructor', 'prototype'].includes(edit.id)) fail('invalid geometry id');
      const registry = spec.geometries ??= {};
      const exists = Object.hasOwn(registry, edit.id) || Object.hasOwn(spec.geometryResources ?? {}, edit.id);
      if (edit.type === 'geometry.create' && exists) fail(`geometry '${edit.id}' already exists`);
      if (edit.type !== 'geometry.create' && !exists) fail(`unknown geometry '${edit.id}'`);
      const users = (spec.props ?? []).filter(p => p.geometryId === edit.id);
      if (edit.type === 'geometry.remove') {
        if (users.length) fail(`geometry '${edit.id}' is referenced by ${users.length} instances`);
        delete registry[edit.id];
      } else registry[edit.id] = structuredClone(edit.geometry);
      if (spec.geometryResources) delete spec.geometryResources[edit.id];
      geometryIds.add(edit.id); users.forEach(p => changed.add(p.id!));
    } else if (edit.type === 'makeUnique') {
      const { kind, object } = find(edit.id);
      if (kind !== 'prop' || (object as SceneProp).model !== 'prop/instance') fail('makeUnique requires an instance');
      const p = object as SceneProp;
      let newId = edit.geometryId;
      if (newId == null) { let n = 1; while (hasGeometry(`unique_${n}`)) n++; newId = `unique_${n}`; }
      cloneGeometry(p.geometryId!, newId);
      p.model = 'prop/mesh'; p.geometryId = newId; changed.add(edit.id);
    } else if (edit.type === 'assembly') {
      if (typeof edit.id !== 'string' || !edit.id.trim()) fail('assembly requires an id');
      let parts = assemblyParts(edit.id, edit.recipe);
      const existing = sceneObjects(spec).find((e) => e.object.id === edit.id);
      if (existing && (existing.kind !== 'group' || !('assembly' in existing.object) || !existing.object.assembly)) fail('assembly id already belongs to another object');
      const group = existing?.object as SceneGroup | undefined;
      const previous = new Map(group?.assembly ? assemblyParts(edit.id, group.assembly).map(p => [p.id, p]) : []);
      const oldIds = new Set(previous.keys());
      parts = parts.flatMap(p => {
        const old = sceneObjects(spec).find((e) => e.object.id === p.id);
        if (old && !oldIds.has(p.id)) fail(`assembly part id collision '${p.id}'`);
        // A removed generated part stays removed while it remains in the recipe.
        if (!old && previous.has(p.id)) return [];
        if (old && old.kind !== 'prop') fail(`assembly part '${p.id}' is no longer a prop`);
        const merged=old ? mergeAssemblyPart(previous.get(p.id)!, old.object as SceneProp, p) : p;
        if(old){
          if(activeBinding(spec,p.id!,'position'))merged.position=structuredClone(old.object.position);
          if(activeBinding(spec,p.id!,'orientation'))for(const key of ['rotationX','rotationY','rotationZ'] as const)merged[key]=structuredClone(old.object[key]);
        }
        return [merged];
      });
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
      assertBindingWrite(spec,edit.id,[...Object.keys(edit.patch),...(edit.clear??[])]);
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
        assertBindingWrite(spec,object.id!,[...(transforms[i].position?['position']:[]),...(transforms[i].rotation?['rotationX']:[])]);
        transformObject(object, kind, transforms[i], edit.type === 'transform' && (edit.relative ?? false), timeS, spec);
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
      const linked=Object.entries(spec.bindings??{}).filter(([,b])=>ids.has(b.target.objectId));
      if (entries.length * requests.length > 500) fail('duplication exceeds 500 generated objects');
      for (const request of requests) {
        if (!request || typeof request.prefix !== 'string' || !request.prefix.trim()) fail('duplicate requires a nonempty prefix/newId');
        if (Object.keys(request).some(k => !['prefix', 'transform', 'relative'].includes(k))) fail('unknown copy request field');
        if ('relative' in request && request.relative != null && typeof request.relative !== 'boolean') fail('relative must be boolean');
        for(const root of roots){
          const transform='transform' in request?request.transform:undefined;
          assertBindingWrite(spec,root,[...(edit.type==='duplicate'&&edit.offset||transform?.position?['position']:[]),...(transform?.rotation?['rotationX']:[])]);
        }
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
            if (edit.type === 'duplicate' && edit.offset) transformObject(o, kind, { position: edit.offset }, true, 0, spec);
            if ('transform' in request && request.transform !== undefined) transformObject(o, kind, request.transform!, request.relative ?? false, timeS, spec);
          }
          append(kind, o); changed.add(o.id);
        }
        const bindingIdMap:Record<string,string>={};
        for(const [id,b] of linked){
          let newId=`${request.prefix}/${id}`;
          if(!validResourceId(newId)||Object.hasOwn(spec.bindings??{},newId)){let n=1;while(Object.hasOwn(spec.bindings??{},`binding_${n}`))n++;newId=`binding_${n}`;}
          const clone=structuredClone(b);clone.target.objectId=mapped.get(b.target.objectId)!;clone.source.objectId=mapped.get(b.source.objectId)??b.source.objectId;
          (spec.bindings??={})[newId]=clone;bindingIds.add(newId);bindingIdMap[id]=newId;
        }
        copies.push({ prefix: request.prefix, rootIds: roots.map(id => mapped.get(id)!), idMap: Object.fromEntries(mapped),...(linked.length?{bindingIdMap}:{}) });
      }
    } else if (edit.type === 'remove') {
      find(edit.id);
      const ids = descendants(edit.id);
      const linked=Object.entries(spec.bindings??{}).filter(([,b])=>ids.has(b.source.objectId)||ids.has(b.target.objectId));
      const referenced = linked.length>0 || (spec.characters ?? []).some((c) => typeof c.gaze === 'object' && ids.has(c.gaze.character)) ||
        [spec.camera, ...(spec.shots ?? []).map((s) => s.camera)].some((c) => c?.lookAt && 'character' in c.lookAt && ids.has(c.lookAt.character));
      if (!edit.cascade && (ids.size > 1 || referenced)) fail('object has children or references; use cascade:true to remove and clear them');
      for(const [id,b] of linked){delete spec.bindings![id];bindingIds.add(id);if(!ids.has(b.target.objectId))changed.add(b.target.objectId);}
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
  if (error) {
    const failure = new Error(error);
    try { Object.assign(failure, { budget: sceneBudget(spec) }); } catch { /* malformed candidate has no trustworthy counts */ }
    throw failure;
  }
  // Report driven objects affected by a source or source-parent edit.
  const affected=new Set(changed);let progress=true;
  while(progress){progress=false;for(const {object:o} of sceneObjects(spec)){const parent=o.parentId??('attachTo' in o?o.attachTo?.character:undefined);if(parent&&affected.has(parent)&&!affected.has(o.id!)){affected.add(o.id!);progress=true;}}
    for(const b of Object.values(spec.bindings??{}))if(b.enabled!==false&&affected.has(b.source.objectId)&&!affected.has(b.target.objectId)){affected.add(b.target.objectId);changed.add(b.target.objectId);progress=true;}}
  return { spec, changedIds: [...changed], createdIds: sceneObjects(spec).map(e => e.object.id!).filter(id => !initialIds.has(id)), geometryIds: [...geometryIds], materialIds: [...materialIds], curveIds: [...curveIds], bindingIds: [...bindingIds], copies };
}
