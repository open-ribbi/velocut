import { normalizeSceneSpec } from './authoring.ts';
import type { SceneSpec } from './types.ts';

/** Conservative compatibility key. Only instance/group transforms can change
 * without reloading resources, rebuilding batches or re-baking physics. */
export function sceneStructureKey(input: SceneSpec): string {
  const spec = normalizeSceneSpec(input);
  const jointAnchors=new Map<string,Set<string>>();
  for(const j of Object.values(spec.joints??{}))for(const e of [j.a,j.b])if(e.anchorId!==undefined){const ids=jointAnchors.get(e.objectId)??new Set<string>();ids.add(e.anchorId);jointAnchors.set(e.objectId,ids);}
  const strip = (object: Record<string, unknown>) => {
    const { position, rotationX, rotationY, rotationZ, scale, visible, opacity, animation, anchors, ...rest } = object;
    return rest;
  };
  const metadata = <T extends {id?:string;anchors?: import('./types.ts').SceneTransform['anchors']}>(object:T) => {
    const {anchors,...rest}=object,ids=jointAnchors.get(object.id!);
    return ids?{...rest,jointAnchors:[...ids].sort().map(id=>{const a=anchors?.[id];return [id,a&&a.kind!=='surface'?a.position:null];})}:rest;
  };
  return JSON.stringify({ ...spec,
    groups: spec.groups?.map(g => strip(g as unknown as Record<string, unknown>)),
    props: spec.props?.map(p => p.model === 'prop/instance' ? strip(p as unknown as Record<string, unknown>) : metadata(p)),
    characters: spec.characters?.map(metadata), lights: spec.lights?.map(metadata),
  });
}
