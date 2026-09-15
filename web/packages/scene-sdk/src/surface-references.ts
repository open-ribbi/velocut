import type * as THREE from 'three';
import type {Stage} from './stage.ts';
import type {SurfaceReference} from './anchors.ts';
import {topologyBytes} from './geometry-fingerprint.ts';

const keys = new WeakMap<THREE.BufferGeometry, string>();
const pending = new WeakMap<THREE.BufferGeometry, Promise<void>>();

/** Connectivity, not vertex positions: deformation retains an attachment.
 * One SHA-256 digest per shared geometry, prepared outside the frame loop. */
async function prepare(geometry: THREE.BufferGeometry) {
  if (keys.has(geometry)) return;
  let job = pending.get(geometry);
  if (!job) {
    job = (async () => {
      const positions = geometry.getAttribute('position');
      if (!positions) return;
      const count = geometry.index?.count ?? positions.count;
      const data=topologyBytes(positions.count,!!geometry.index,count,geometry.drawRange.start,Math.min(count,geometry.drawRange.start+geometry.drawRange.count),i=>geometry.index!.getX(i));
      const digest = await crypto.subtle.digest('SHA-256',data);
      keys.set(geometry,Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join(''));
    })();
    pending.set(geometry,job);
  }
  try { await job; } finally { pending.delete(geometry); }
}

export async function prepareSurfaceReferences(stage: Stage) {
  const geometries = new Set<THREE.BufferGeometry>();
  for (const e of [...stage.props,...stage.characters]) e.root.traverse(node=>{
    const mesh=node as THREE.Mesh;if(mesh.isMesh)geometries.add(mesh.geometry);
  });
  await Promise.all([...geometries].map(prepare));
}

export function surfaceSourceKey(stage:Stage, objectId:string):string {
  const known=stage.surfaceSources?.get(objectId);if(known!==undefined)return known;
  const e=[...stage.props,...stage.characters,...stage.groups,...stage.lights].find(e=>e.spec.id===objectId);
  return stage.surfaceSources?.get(objectId) ?? ('model' in (e?.spec??{}) ? (e!.spec as {model:string}).model : 'group');
}

export function surfaceReference(stage:Stage,objectId:string,mesh:THREE.Mesh,meshPath:number[],triangleIndex:number,barycentric:[number,number,number]):SurfaceReference|null {
  const topologyKey=keys.get(mesh.geometry);
  const geometryKey=stage.surfaceGeometryKeys?.get(objectId);
  const vertexIndices=[0,1,2].map(i=>mesh.geometry.index?.getX(triangleIndex*3+i)??triangleIndex*3+i) as [number,number,number];
  return topologyKey ? {sourceKey:surfaceSourceKey(stage,objectId),topologyKey,meshPath:[...meshPath],triangleIndex,barycentric:[...barycentric],vertexIndices,...(geometryKey?{geometryKey}:{})} : null;
}

export function surfaceReferenceScopeError(stage:Stage,objectId:string,mesh:THREE.Mesh,reference:SurfaceReference):string|null {
  if(reference.sourceKey!==surfaceSourceKey(stage,objectId))return 'surface source was replaced; rebind this anchor';
  if(reference.geometryKey!==undefined&&reference.geometryKey!==stage.surfaceGeometryKeys?.get(objectId))return 'surface geometry was replaced or reindexed; rebind this anchor';
  if(reference.topologyKey!==keys.get(mesh.geometry))return 'surface topology changed; rebind this anchor';
  return null;
}

export function surfaceReferenceError(stage:Stage,objectId:string,mesh:THREE.Mesh,reference:SurfaceReference):string|null {
  const error=surfaceReferenceScopeError(stage,objectId,mesh,reference);if(error)return error;
  if(reference.vertexIndices?.some((v,i)=>v!==(mesh.geometry.index?.getX(reference.triangleIndex*3+i)??reference.triangleIndex*3+i)))
    return `referenced face ${reference.triangleIndex} topology changed; rebind this anchor`;
  return null;
}
