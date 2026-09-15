import { normalizeSceneSpec } from './authoring.ts';
import type { SceneSpec } from './types.ts';

/** Conservative compatibility key. Only instance/group transforms can change
 * without reloading resources, rebuilding batches or re-baking physics. */
export function sceneStructureKey(input: SceneSpec): string {
  const spec = normalizeSceneSpec(input);
  const strip = (object: Record<string, unknown>) => {
    const { position, rotationX, rotationY, rotationZ, scale, visible, opacity, animation, anchors, ...rest } = object;
    return rest;
  };
  const metadata = <T extends {anchors?: unknown}>(object:T) => {const {anchors,...rest}=object;return rest;};
  return JSON.stringify({ ...spec,
    groups: spec.groups?.map(g => strip(g as unknown as Record<string, unknown>)),
    props: spec.props?.map(p => p.model === 'prop/instance' ? strip(p as unknown as Record<string, unknown>) : metadata(p)),
    characters: spec.characters?.map(metadata), lights: spec.lights?.map(metadata),
  });
}
