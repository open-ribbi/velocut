import type {SceneSpec} from './types.ts';
import type {SceneGeometry} from './geometry.ts';
import {nativeGeometryKey,nativeTopologyKey} from './geometry-fingerprint.ts';

/** Patches preserve vertex/face slot identities. Advance whole-mesh proofs only
 * when the reference matches the exact pre-patch data. Its ordered face witness
 * stays unchanged, so a touched face fails independently and can recover on undo. */
export function advanceSurfacePatch(spec:SceneSpec,geometryId:string,before:SceneGeometry,after:SceneGeometry) {
  const objects=(spec.props??[]).filter(p=>p.geometryId===geometryId&&Object.values(p.anchors??{}).some(a=>a.kind==='surface'));
  if(!objects.length)return;
  const oldTopology=nativeTopologyKey(before),newTopology=nativeTopologyKey(after);
  const oldGeometry=nativeGeometryKey(before),newGeometry=nativeGeometryKey(after);
  for(const object of objects)for(const anchor of Object.values(object.anchors??{})){
    if(anchor.kind!=='surface')continue;
    const r=anchor.surface;
    if(r.sourceKey!=='native-mesh'||r.meshPath.length!==0)continue;
    if(r.topologyKey===oldTopology&&(r.geometryKey===undefined||r.geometryKey===oldGeometry)){
      const original=before.faces[r.triangleIndex];if(!original)continue;
      r.vertexIndices??=[...original];r.topologyKey=newTopology;r.geometryKey=newGeometry;
    }else if(r.geometryKey===undefined&&r.topologyKey===newTopology){
      // A legacy reference can regain validity when a known patch restores its
      // original whole topology. Upgrade it only after that exact match.
      const restored=after.faces[r.triangleIndex];if(!restored)continue;
      r.vertexIndices??=[...restored];r.geometryKey=newGeometry;
    }
  }
}

/** Full replacement supplies no identity-preservation proof. Pin old legacy
 * references to the old geometry bytes instead of accepting a reused index. */
export function pinLegacyGeometryReferences(spec:SceneSpec,geometryId:string,geometryKey:string) {
  for(const p of spec.props??[])if(p.geometryId===geometryId)for(const a of Object.values(p.anchors??{})){
    if(a.kind==='surface'&&a.surface.sourceKey==='native-mesh'&&!a.surface.geometryKey)a.surface.geometryKey=geometryKey;
  }
}
