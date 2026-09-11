import type * as THREE from 'three';
import { buildStage } from './stage.ts';
import { normalizeSceneSpec } from './authoring.ts';
import { expandShots } from './shots.ts';
import { applySpecCamera, specCameraPosition } from './compile.ts';
import { validateGlb, type SceneResources } from './models.ts';
import type { SceneSpec } from './types.ts';

export interface SceneGlbOptions {
  timeS?: number;
  /** Omit to export the scene. Selected objects include descendants and keep world placement. */
  objectIds?: string[];
  includeEnvironment?: boolean;
  includeCamera?: boolean;
  maxTextureSize?: number;
  assetBase?: string;
  resources?: SceneResources;
  signal?: AbortSignal;
}
export interface SceneGlbResult {
  blob: Blob;
  timeS: number;
  objectIds: string[];
  warnings: string[];
}

/** Match Three.js's morph/skin vertex evaluation without carrying a rig that
 * another application may rebuild into its bind pose on import. */
function bakePose(mesh: THREE.Mesh, three: typeof THREE) {
  const skin = mesh as THREE.SkinnedMesh;
  const geometry = mesh.geometry.clone();
  const source = mesh.geometry.getAttribute('position');
  const position = new three.Float32BufferAttribute(new Float32Array(source.count * 3), 3);
  const normalSource = mesh.geometry.getAttribute('normal');
  const tangentSource = mesh.geometry.getAttribute('tangent');
  const normal = normalSource
    ? new three.Float32BufferAttribute(new Float32Array(source.count * 3), 3)
    : null;
  const tangent = tangentSource
    ? new three.Float32BufferAttribute(new Float32Array(source.count * 4), 4)
    : null;
  const point = new three.Vector3(),
    n = new three.Vector3(),
    t = new three.Vector3();
  const bone = new three.Matrix4(),
    sum = new three.Matrix4(),
    transform = new three.Matrix4();
  for (let i = 0; i < source.count; i++) {
    mesh.getVertexPosition(i, point);
    position.setXYZ(i, point.x, point.y, point.z);
    if (normalSource) {
      n.fromBufferAttribute(normalSource, i);
      const morphs = mesh.geometry.morphAttributes.normal ?? [];
      for (let j = 0; j < morphs.length; j++) {
        const weight = mesh.morphTargetInfluences?.[j] ?? 0;
        point.fromBufferAttribute(morphs[j], i);
        if (!mesh.geometry.morphTargetsRelative)
          point.sub(new three.Vector3().fromBufferAttribute(normalSource, i));
        n.addScaledVector(point, weight);
      }
    }
    if (tangentSource) t.fromBufferAttribute(tangentSource, i);
    if (skin.isSkinnedMesh) {
      sum.elements.fill(0);
      const indices = mesh.geometry.getAttribute('skinIndex'),
        weights = mesh.geometry.getAttribute('skinWeight');
      for (let k = 0; k < 4; k++) {
        const index = indices.getComponent(i, k),
          weight = weights.getComponent(i, k);
        if (!weight) continue;
        bone.multiplyMatrices(
          skin.skeleton.bones[index].matrixWorld,
          skin.skeleton.boneInverses[index],
        );
        for (let e = 0; e < 16; e++) sum.elements[e] += weight * bone.elements[e];
      }
      transform.copy(skin.bindMatrixInverse).multiply(sum).multiply(skin.bindMatrix);
      if (normal) n.transformDirection(transform);
      if (tangent) t.transformDirection(transform);
    }
    if (normal) {
      n.normalize();
      normal.setXYZ(i, n.x, n.y, n.z);
    }
    if (tangent) {
      t.normalize();
      tangent.setXYZW(i, t.x, t.y, t.z, tangentSource!.getW(i));
    }
  }
  geometry.setAttribute('position', position);
  if (normal) geometry.setAttribute('normal', normal);
  else geometry.computeVertexNormals();
  if (tangent) geometry.setAttribute('tangent', tangent);
  geometry.deleteAttribute('skinIndex');
  geometry.deleteAttribute('skinWeight');
  geometry.morphAttributes = {};
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const baked = new three.Mesh();
  baked.copy(mesh, false);
  baked.geometry = geometry;
  baked.morphTargetDictionary = undefined;
  baked.morphTargetInfluences = undefined;
  mesh.parent?.add(baked);
  for (const child of [...mesh.children]) baked.add(child);
  mesh.removeFromParent();
}

/** Export a fresh evaluated stage, never the live Director with its gizmos.
 * Skinning and morphs are baked into static mesh attributes; animation tracks,
 * rigs, procedural recipes and physics remain in the native SceneSpec. */
export async function exportSceneGlb(
  raw: SceneSpec,
  options: SceneGlbOptions = {},
): Promise<SceneGlbResult> {
  const spec = expandShots(normalizeSceneSpec(structuredClone(raw)));
  const timeS = options.timeS ?? 0;
  if (!Number.isFinite(timeS) || timeS < 0 || timeS > spec.durationUs / 1e6)
    throw new Error('timeS is outside the scene');
  if (
    options.objectIds !== undefined &&
    (!Array.isArray(options.objectIds) ||
      !options.objectIds.length ||
      options.objectIds.some((id) => typeof id !== 'string' || !id))
  )
    throw new Error('objectIds must be a non-empty list of object IDs');
  if (
    options.maxTextureSize != null &&
    (!Number.isInteger(options.maxTextureSize) ||
      options.maxTextureSize < 1 ||
      options.maxTextureSize > 16384)
  )
    throw new Error('maxTextureSize must be an integer from 1 to 16384');
  for (const key of ['includeEnvironment', 'includeCamera'] as const)
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw new Error(`${key} must be boolean`);
  options.signal?.throwIfAborted();
  const stage = await buildStage(spec, options.assetBase, options.resources);
  const { three } = stage;
  const warnings = [
    'Static snapshot: rigs and morphs are baked into geometry; animation tracks, physics and parametric editing recipes are not included.',
  ];
  stage.poseAt(timeS, { cameraPos: specCameraPosition(spec, timeS) });
  stage.scene.updateMatrixWorld(true);
  const entries = [...stage.groups, ...stage.characters, ...stage.props, ...stage.lights];
  for (const e of entries) {
    e.root.name = e.spec.name ?? e.spec.id!;
    e.root.userData = { velocutObjectId: e.spec.id };
  }
  const ids = options.objectIds ? [...new Set(options.objectIds)] : entries.map((e) => e.spec.id!);
  const selected = options.objectIds?.map((id) => {
    const e = entries.find((e) => e.spec.id === id);
    if (!e) throw new Error(`unknown object '${id}'`);
    return e.root;
  });
  // Preserve the ancestor chain, including non-uniform scale/shear, while
  // removing sibling geometry. Reparenting via TRS decomposition loses shear.
  if (selected) {
    const keep = new Set<THREE.Object3D>(),
      descendants = new Set<THREE.Object3D>();
    for (const root of selected) {
      root.traverse((o) => {
        keep.add(o);
        descendants.add(o);
      });
      for (let p = root.parent; p; p = p.parent) keep.add(p);
    }
    const strip: THREE.Object3D[] = [];
    stage.scene.traverse((o) => {
      if (!keep.has(o)) strip.push(o);
    });
    for (const o of strip) o.removeFromParent();
    for (const o of keep)
      if (
        o !== stage.scene &&
        !descendants.has(o) &&
        ((o as THREE.Mesh).isMesh || (o as THREE.Light).isLight || (o as THREE.Camera).isCamera)
      ) {
        const parent = new three.Group();
        parent.name = o.name;
        parent.matrix.copy(o.matrix);
        parent.matrixAutoUpdate = false;
        o.parent?.add(parent);
        for (const child of [...o.children]) parent.add(child);
        o.removeFromParent();
      }
  } else if (options.includeEnvironment === false) {
    stage.scene.children.find(node => node.name === 'stage-ground' && !entries.some(entry => entry.root === node))?.removeFromParent();
  }
  const nodes: THREE.Object3D[] = [];
  stage.scene.traverse((o) => nodes.push(o));
  let meshCount = 0, vertexCount = 0;
  for (const o of nodes) {
    if (o.type === 'GridHelper') {
      o.removeFromParent();
      continue;
    }
    const light = o as THREE.Light;
    if (light.isLight && !['DirectionalLight', 'SpotLight', 'PointLight'].includes(light.type)) {
      warnings.push(
        'Ambient/hemisphere lighting is not represented by glTF; lighting may differ in other applications.',
      );
      // Retain any authored children while dropping unsupported light semantics.
      const group = new three.Group();
      group.name = o.name;
      group.matrix.copy(o.matrix);
      group.matrixAutoUpdate = false;
      o.parent?.add(group);
      for (const child of [...o.children]) group.add(child);
      o.removeFromParent();
    } else if (light.type === 'DirectionalLight' || light.type === 'SpotLight') {
      const aimed = light as THREE.DirectionalLight | THREE.SpotLight;
      const target = aimed.target.getWorldPosition(new three.Vector3());
      if (!stage.lights.some((entry) => entry.light === aimed) && aimed.target.parent !== aimed)
        aimed.lookAt(target);
      aimed.add(aimed.target);
      aimed.target.position.set(0, 0, -1);
    }
    const mesh = o as THREE.SkinnedMesh;
    if (mesh.isMesh) {
      meshCount++;
      vertexCount += mesh.geometry.getAttribute('position')?.count ?? 0;
      if (vertexCount > 2_000_000) throw new Error('Export exceeds 2 million vertices; choose a smaller selection');
      if (mesh.isSkinnedMesh) {
        if (mesh.skeleton.bones.some((bone) => !nodes.includes(bone)))
          throw new Error(
            'Selected skin uses joints outside the selection; export its parent character or the whole scene',
          );
        mesh.skeleton.update();
      }
      if (mesh.isSkinnedMesh || mesh.morphTargetInfluences?.length) bakePose(mesh, three);
    }
  }
  if (!meshCount) throw new Error('The export selection contains no mesh geometry');
  if (!selected && options.includeCamera !== false) {
    const camera = new three.PerspectiveCamera(
      40,
      (spec.width ?? 1280) / (spec.height ?? 720),
      0.1,
      500,
    );
    camera.name = 'Shot camera';
    applySpecCamera(camera, spec, stage, timeS);
    stage.scene.add(camera);
  }
  if (!selected)
    warnings.push(
      'Scene background and renderer-specific shadows/post-processing are not embedded in GLB.',
    );
  stage.scene.background = null;
  stage.scene.updateMatrixWorld(true);
  options.signal?.throwIfAborted();
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const data = await new GLTFExporter().parseAsync(stage.scene, {
    binary: true,
    onlyVisible: true,
    animations: [],
    maxTextureSize: options.maxTextureSize ?? Infinity,
  });
  options.signal?.throwIfAborted();
  if (!(data instanceof ArrayBuffer)) throw new Error('Exporter did not return a GLB buffer');
  validateGlb(data);
  return {
    blob: new Blob([data], { type: 'model/gltf-binary' }),
    timeS,
    objectIds: ids,
    warnings: [...new Set(warnings)],
  };
}
