import {sha256} from '@noble/hashes/sha2.js';
import {encodeGeometry, GEOMETRY_SOURCE} from './geometry-resource.ts';
import type {SceneGeometry} from './geometry.ts';
import type {SceneSpec,SceneProp} from './types.ts';

/** Synchronous hashes keep pure SDK edits deterministic. The format matches
 * the native resource hash and the renderer's existing whole-topology stamp. */
export const sha256Hex=(data:ArrayBuffer)=>Array.from(sha256(new Uint8Array(data)),b=>b.toString(16).padStart(2,'0')).join('');
export const nativeGeometryKey=(geometry:SceneGeometry)=>sha256Hex(encodeGeometry(geometry));
export function topologyBytes(vertexCount:number,indexed:boolean,count:number,start:number,end:number,indexAt:(i:number)=>number):ArrayBuffer {
  const bytes=new ArrayBuffer((5+(indexed?count:0))*4),view=new DataView(bytes);
  [vertexCount,indexed?1:0,count,start,end].forEach((v,i)=>view.setUint32(i*4,v,true));
  if(indexed)for(let i=0;i<count;i++)view.setUint32((5+i)*4,indexAt(i),true);
  return bytes;
}
export function nativeTopologyKey(geometry:SceneGeometry):string {
  const count=geometry.faces.length*3;
  return sha256Hex(topologyBytes(geometry.vertices.length,true,count,0,count,i=>geometry.faces[Math.floor(i/3)][i%3]));
}
export function propGeometryKey(spec:SceneSpec,prop:SceneProp):string|undefined {
  if(prop.geometryId){
    const g=spec.geometries?.[prop.geometryId];if(g)return nativeGeometryKey(g);
    const r=spec.geometryResources?.[prop.geometryId];if(r)return GEOMETRY_SOURCE.exec(r.src)?.[1];
  }else if(prop.model==='prop/mesh'&&prop.vertices&&prop.faces)return nativeGeometryKey({vertices:prop.vertices,faces:prop.faces,uvs:prop.uvs});
  return undefined;
}

/** Legacy full-spec replacement has no proof that vertex identities survived.
 * Local patch edits upgrade/rebase their references before reaching this guard. */
export function assertLegacyGeometryReplacement(before:SceneSpec,next:SceneSpec) {
  const old=new Map((before.props??[]).map(p=>[p.id,p]));
  for(const p of next.props??[]){
    const legacy=Object.entries(p.anchors??{}).filter(([,a])=>a.kind==='surface'&&!a.surface.geometryKey);
    if(!legacy.length)continue;
    const previous=old.get(p.id);if(!previous)continue;
    const from=propGeometryKey(before,previous),to=propGeometryKey(next,p);
    if(!from||!to||from===to)continue;
    for(const [id,a] of legacy){
      const prior=previous.anchors?.[id];
      if(prior?.kind==='surface'&&a.kind==='surface'&&prior.surface.sourceKey===a.surface.sourceKey&&prior.surface.topologyKey===a.surface.topologyKey)
        throw new Error(`legacy surface anchor '${p.id}:${id}' needs a verified upgrade before full geometry replacement; use geometry.patch or rebind it`);
    }
  }
}
