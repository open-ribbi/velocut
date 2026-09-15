import type * as THREE from 'three';

const states = new WeakMap<THREE.Object3D, { visible: boolean; opacity: number }>();

export function setVisualState(root: THREE.Object3D, visible: boolean, opacity: number) {
  states.set(root, { visible, opacity });
}

/** Authored visibility is separate from invisible logical instance proxies. */
export function objectIsVisible(root: THREE.Object3D): boolean {
  const mesh = root as THREE.Mesh;
  if (mesh.isMesh) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (materials.length && materials.every(m => m.opacity === 0)) return false;
  }
  for (let node: THREE.Object3D | null = root; node; node = node.parent) {
    const state = states.get(node);
    if (state ? !state.visible || state.opacity === 0 : !node.visible) return false;
  }
  return true;
}

/** Allocate material copies only when opacity first changes. Imported siblings
 * and stages keep sharing their immutable source materials until then. */
export function prepareVisualMeshes(scene: THREE.Scene, excluded: Set<THREE.Object3D>) {
  const owned = new Map<THREE.Object3D, Map<THREE.Material, THREE.Material>>();
  const entries: Array<{
    mesh: THREE.Mesh;
    owner: THREE.Object3D;
    castShadow: boolean;
    source: THREE.Material | THREE.Material[];
    copies?: THREE.Material[];
  }> = [];
  scene.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || excluded.has(node)) return;
    let owner: THREE.Object3D | null = node;
    while (owner && !states.has(owner)) owner = owner.parent;
    if (owner) entries.push({ mesh, owner, source: mesh.material, castShadow: mesh.castShadow });
  });
  return () => {
    for (const entry of entries) {
      const factor = objectOpacity(entry.mesh);
      if (factor === 1 && !entry.copies) continue;
      const originals = Array.isArray(entry.source) ? entry.source : [entry.source];
      if (!entry.copies) {
        const cache = owned.get(entry.owner) ?? new Map<THREE.Material, THREE.Material>();
        owned.set(entry.owner, cache);
        entry.copies = originals.map(original => {
          let copy = cache.get(original);
          if (!copy) { copy = original.clone(); cache.set(original, copy); }
          return copy;
        });
        entry.mesh.material = Array.isArray(entry.source) ? entry.copies : entry.copies[0];
      }
      entry.copies.forEach((material, i) => {
        const original = originals[i];
        const opacity = original.opacity * factor;
        const transparent = original.transparent || opacity < 1;
        if (material.transparent !== transparent) {
          material.transparent = transparent;
          material.needsUpdate = true;
        }
        material.opacity = opacity;
        material.depthWrite = factor < 1 ? false : original.depthWrite;
      });
      entry.mesh.castShadow = entry.castShadow && factor >= 1;
    }
  };
}

export function objectOpacity(root: THREE.Object3D): number {
  let opacity = 1;
  for (let node: THREE.Object3D | null = root; node; node = node.parent) {
    opacity *= states.get(node)?.opacity ?? 1;
  }
  return opacity;
}

export function visibleBounds(three: typeof THREE, root: THREE.Object3D) {
  const result = new three.Box3(), bounds = new three.Box3(), point = new three.Vector3();
  root.updateWorldMatrix(true, true);
  root.traverse(node => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !objectIsVisible(node)) return;
    // expandByObject would include hidden children. Sample only this mesh.
    const position = mesh.geometry.getAttribute('position');
    if (!position) return;
    bounds.makeEmpty();
    for (let i = 0; i < position.count; i++) {
      mesh.getVertexPosition(i, point);
      point.applyMatrix4(mesh.matrixWorld);
      bounds.expandByPoint(point);
    }
    result.union(bounds);
  });
  return result;
}
