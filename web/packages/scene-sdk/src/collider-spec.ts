import type {SceneProp, SceneSpec} from './types.ts';
import {anchorIdValid, spatialVector, type SpatialVector} from './anchors.ts';

type ColliderPose = {position?:SpatialVector; rotation?:SpatialVector; name?:string};
export type SceneCollider =
  | {shape:'auto';name?:string}
  | (ColliderPose & {shape:'box';halfExtents:SpatialVector})
  | (ColliderPose & {shape:'sphere';radius:number})
  | (ColliderPose & {shape:'convexHull'|'mesh';geometryId?:string});

export function colliderDefinitions(p:SceneProp):Record<string,SceneCollider> {
  if(!p.physics)return {};
  return typeof p.physics==='string'||p.physics.colliders===undefined ? {default:{shape:'auto'}} : p.physics.colliders;
}
export function usesColliderGeometry(p:SceneProp,id:string):boolean {
  return Object.values(colliderDefinitions(p)).some(c=>'geometryId' in c&&c.geometryId===id);
}
export function validateColliders(p:SceneProp,spec:SceneSpec):string|null {
  const physics=p.physics;if(!physics||typeof physics==='string'||physics.colliders===undefined)return null;
  const defs=physics.colliders;
  if(!defs||typeof defs!=='object'||Array.isArray(defs))return 'physics.colliders must be a registry (empty disables collision)';
  for(const [id,c] of Object.entries(defs)){
    if(!anchorIdValid(id))return 'invalid collider id';
    if(!c||typeof c!=='object'||Array.isArray(c)||!['auto','box','sphere','convexHull','mesh'].includes(c.shape))return `collider '${id}': invalid shape`;
    const keys=['shape','name',...(c.shape==='auto'?[]:['position','rotation']),...(c.shape==='box'?['halfExtents']:c.shape==='sphere'?['radius']:['convexHull','mesh'].includes(c.shape)?['geometryId']:[])];
    if(Object.keys(c).some(k=>!keys.includes(k))||c.name!==undefined&&typeof c.name!=='string')return `collider '${id}': invalid fields`;
    if(c.shape!=='auto')for(const k of ['position','rotation'] as const)if(c[k]!==undefined&&!spatialVector(c[k]))return `collider '${id}': ${k} must be [x,y,z]`;
    if(c.shape==='box'&&(!spatialVector(c.halfExtents)||c.halfExtents.some(v=>v<=0)))return `collider '${id}': halfExtents must be positive meters`;
    if(c.shape==='sphere'&&(!Number.isFinite(c.radius)||c.radius<=0))return `collider '${id}': radius must be positive meters`;
    if(c.shape==='mesh'&&physics.type==='dynamic')return `collider '${id}': dynamic bodies require convex colliders; compose several boxes or convexHull shapes on one body`;
    if('geometryId' in c&&c.geometryId!==undefined&&(!anchorIdValid(c.geometryId)||!Object.hasOwn(spec.geometries??{},c.geometryId)&&!Object.hasOwn(spec.geometryResources??{},c.geometryId)))return `collider '${id}': unknown geometryId`;
    const s=typeof p.scale==='number'?[p.scale,p.scale,p.scale]:[p.scale?.x??1,p.scale?.y??1,p.scale?.z??1];
    if(c.shape==='sphere'&&(s[0]!==s[1]||s[1]!==s[2]))return `collider '${id}': sphere requires uniform object scale; use a convexHull for a stretched shape`;
  }
  return null;
}
