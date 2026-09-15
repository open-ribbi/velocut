import type { SceneMaterial, SceneProp, SceneSpec } from './types.ts';

export interface SceneMaterialDefinition extends SceneMaterial { name?: string; color?: string }
export const MATERIAL_FIELDS = ['roughness','metalness','opacity','emissive','emissiveIntensity','side'] as const;
export function validateMaterial(value: unknown, definition = false): string | null {
  const m = value as SceneMaterialDefinition;
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'material must be an object';
  const allowed: readonly string[] = definition ? [...MATERIAL_FIELDS,'name','color'] : MATERIAL_FIELDS;
  if (Object.keys(m).some(k => !allowed.includes(k))) return 'unknown material field';
  for (const k of ['roughness','metalness','opacity'] as const) if (m[k] != null && (!Number.isFinite(m[k]) || m[k]! < 0 || m[k]! > 1)) return `material.${k} must be 0..1`;
  for (const k of ['emissive','color'] as const) if (m[k] != null && (typeof m[k] !== 'string' || !/^#[a-f0-9]{6}$/i.test(m[k]!))) return `material.${k} must be #RRGGBB`;
  if (m.emissiveIntensity != null && (!Number.isFinite(m.emissiveIntensity) || m.emissiveIntensity < 0 || m.emissiveIntensity > 100)) return 'material.emissiveIntensity must be 0..100';
  if (m.side != null && !['front','double'].includes(m.side)) return 'material.side must be front or double';
  if (m.name != null && (typeof m.name !== 'string' || m.name.length > 256)) return 'invalid material name';
  return null;
}

/** Per-object fields override shared defaults; undefined/null mean inherited.
 * Keep names and color out of the inline material object consumed by Three. */
export function resolvePropAppearance(spec: SceneSpec, p: SceneProp) {
  const base = p.materialId == null || !Object.hasOwn(spec.materials ?? {}, p.materialId) ? undefined : spec.materials![p.materialId];
  const material: SceneMaterial = {};
  for (const k of MATERIAL_FIELDS) {
    const value = p.material?.[k] ?? base?.[k];
    if (value != null) Object.assign(material, { [k]: value });
  }
  return { material, color: p.color ?? base?.color };
}
