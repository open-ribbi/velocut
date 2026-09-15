import type * as THREE from 'three';
import type {Stage} from './stage.ts';
import type {SurfaceReference} from './anchors.ts';

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
      const data = new ArrayBuffer((5 + (geometry.index?.count ?? 0))*4),view=new DataView(data);
      [positions.count, geometry.index ? 1 : 0, count, geometry.drawRange.start, Math.min(count,geometry.drawRange.start+geometry.drawRange.count)].forEach((v,i)=>view.setUint32(i*4,v,true));
      if (geometry.index) for (let i=0;i<geometry.index.count;i++) view.setUint32((5+i)*4,geometry.index.getX(i),true);
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
  return topologyKey ? {sourceKey:surfaceSourceKey(stage,objectId),topologyKey,meshPath:[...meshPath],triangleIndex,barycentric:[...barycentric]} : null;
}

export function surfaceReferenceError(stage:Stage,objectId:string,mesh:THREE.Mesh,reference:SurfaceReference):string|null {
  if(reference.sourceKey!==surfaceSourceKey(stage,objectId))return 'surface source was replaced; rebind this anchor';
  if(reference.topologyKey!==keys.get(mesh.geometry))return 'surface topology changed; rebind this anchor';
  return null;
}
