import type * as THREE from 'three';
import type { SceneProp, SceneSpec } from './types.ts';
import { instanceBatchKey } from './geometry.ts';
import { resolvePropAppearance } from './materials.ts';
import { objectIsVisible, objectOpacity, setVisualState } from './visual.ts';

export interface InstanceBatch {
  mesh: THREE.InstancedMesh;
  objects: Array<{ root: THREE.Mesh; spec: SceneProp; color: THREE.Color; base: THREE.MeshStandardMaterial; fadeMaterial?: THREE.MeshStandardMaterial }>;
}

/** Invisible logical meshes retain exact picking, bounds and parent transforms.
 * Opaque instances draw in batches; fades draw individual shared-geometry meshes.
 * Logical IDs never depend on batch indices. */
export function buildInstances(three: typeof THREE, spec: SceneSpec) {
  const geometryCache = new Map<string, THREE.BufferGeometry>();
  const groups = new Map<string, InstanceBatch['objects']>();
  const objects: InstanceBatch['objects'] = [];
  for (const p of spec.props ?? []) {
    if (p.model !== 'prop/instance') continue;
    let geometry = geometryCache.get(p.geometryId!);
    if (!geometry) {
      const data = spec.geometries![p.geometryId!];
      geometry = new three.BufferGeometry();
      geometry.setAttribute('position', new three.Float32BufferAttribute(data.vertices.flat(), 3));
      geometry.setIndex(data.faces.flat());
      if (data.uvs) geometry.setAttribute('uv', new three.Float32BufferAttribute(data.uvs.flat(), 2));
      geometry.computeVertexNormals(); geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      geometryCache.set(p.geometryId!, geometry);
    }
    const key = instanceBatchKey(p, spec), group = groups.get(key) ?? [];
    if (!groups.has(key)) groups.set(key, group);
    const m = resolvePropAppearance(spec, p).material;
    const material = group[0]?.base ?? new three.MeshStandardMaterial({
      color: '#ffffff', roughness: m?.roughness ?? 0.6, metalness: m?.metalness ?? 0,
      emissive: m?.emissive ?? '#000000', emissiveIntensity: m?.emissiveIntensity ?? 1,
      side: m?.side === 'double' ? three.DoubleSide : three.FrontSide,
      opacity:m.opacity ?? 1,transparent:(m.opacity ?? 1)<1,
    });
    const root = new three.Mesh(geometry, material); root.visible = false;
    setVisualState(root,true,1);
    const object = { root, spec: p, base:material, color:new three.Color(resolvePropAppearance(spec,p).color ?? '#8fa3bf') }; group.push(object); objects.push(object);
  }
  const batches: InstanceBatch[] = [...groups.values()].map(objects => {
    const mesh = new three.InstancedMesh(objects[0].root.geometry, objects[0].root.material, objects.length);
    mesh.name = 'Velocut instance batch'; mesh.castShadow = mesh.receiveShadow = true;
    // Recompute matrices after posing. Bounds are computed on demand for
    // inspection/picking; disabling batch culling prevents stale animated bounds.
    mesh.frustumCulled = false;
    const color = new three.Color();
    objects.forEach((o, i) => mesh.setColorAt(i, color.set(resolvePropAppearance(spec, o.spec).color ?? '#8fa3bf')));
    return { mesh, objects };
  });
  return { objects, batches };
}

/** Also called after a Director gizmo moves a logical root before commit. */
export function syncInstanceBatches(scene: THREE.Scene, batches: InstanceBatch[]) {
  if (!batches.length) return;
  scene.updateMatrixWorld(true);
  for (const batch of batches) {
    let count=0;
    for(const o of batch.objects){
      // Reset before querying visibility: a previous transparent sample must
      // not hide an opaque sample when scrubbing backwards.
      o.root.material=o.base;
      const alpha=o.base.opacity*objectOpacity(o.root),visible=objectIsVisible(o.root)&&alpha>0;
      if(visible&&alpha>=1){o.root.visible=false;batch.mesh.setMatrixAt(count,o.root.matrixWorld);batch.mesh.setColorAt(count,o.color);count++;}
      else if(visible){
        const material=o.fadeMaterial??=o.base.clone();material.color.copy(o.color);material.opacity=alpha;material.transparent=true;material.depthWrite=false;
        o.root.material=material;o.root.visible=true;o.root.castShadow=false;o.root.receiveShadow=true;
      }else o.root.visible=false;
    }
    batch.mesh.count=count;
    batch.mesh.instanceMatrix.needsUpdate = true;
    if(batch.mesh.instanceColor)batch.mesh.instanceColor.needsUpdate=true;
    batch.mesh.boundingBox = null; batch.mesh.boundingSphere = null;
  }
}
