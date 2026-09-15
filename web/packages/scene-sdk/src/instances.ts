import type * as THREE from 'three';
import type { SceneProp, SceneSpec } from './types.ts';
import { instanceBatchKey } from './geometry.ts';

export interface InstanceBatch {
  mesh: THREE.InstancedMesh;
  objects: Array<{ root: THREE.Mesh; spec: SceneProp }>;
}

/** Invisible logical meshes retain exact picking, bounds and parent transforms.
 * The only drawn meshes are batches. Logical IDs never depend on batch indices. */
export function buildInstances(three: typeof THREE, spec: SceneSpec) {
  const geometryCache = new Map<string, THREE.BufferGeometry>();
  const groups = new Map<string, Array<{ root: THREE.Mesh; spec: SceneProp }>>();
  const objects: Array<{ root: THREE.Mesh; spec: SceneProp }> = [];
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
    const key = instanceBatchKey(p), group = groups.get(key) ?? [];
    if (!groups.has(key)) groups.set(key, group);
    const m = p.material;
    const material = group[0]?.root.material ?? new three.MeshStandardMaterial({
      color: '#ffffff', roughness: m?.roughness ?? 0.6, metalness: m?.metalness ?? 0,
      emissive: m?.emissive ?? '#000000', emissiveIntensity: m?.emissiveIntensity ?? 1,
      side: m?.side === 'double' ? three.DoubleSide : three.FrontSide,
    });
    const root = new three.Mesh(geometry, material); root.visible = false;
    const object = { root, spec: p }; group.push(object); objects.push(object);
  }
  const batches: InstanceBatch[] = [...groups.values()].map(objects => {
    const mesh = new three.InstancedMesh(objects[0].root.geometry, objects[0].root.material, objects.length);
    mesh.name = 'Velocut instance batch'; mesh.castShadow = mesh.receiveShadow = true;
    // Recompute matrices after posing. Bounds are computed on demand for
    // inspection/picking; disabling batch culling prevents stale animated bounds.
    mesh.frustumCulled = false;
    const color = new three.Color();
    objects.forEach((o, i) => mesh.setColorAt(i, color.set(o.spec.color ?? '#8fa3bf')));
    return { mesh, objects };
  });
  return { objects, batches };
}

/** Also called after a Director gizmo moves a logical root before commit. */
export function syncInstanceBatches(scene: THREE.Scene, batches: InstanceBatch[]) {
  if (!batches.length) return;
  scene.updateMatrixWorld(true);
  for (const batch of batches) {
    batch.objects.forEach((o, i) => batch.mesh.setMatrixAt(i, o.root.matrixWorld));
    batch.mesh.instanceMatrix.needsUpdate = true;
    batch.mesh.boundingBox = null; batch.mesh.boundingSphere = null;
  }
}
