import type { SceneProp } from './types.ts';

export type AssemblyTemplate = 'table' | 'chair' | 'stairs';
export interface AssemblyRecipe {
  template: AssemblyTemplate;
  parameters?: { width?: number; depth?: number; height?: number; thickness?: number; steps?: number };
}
export const ASSEMBLY_DEFAULTS = {
  table: { width: 1.6, depth: 0.9, height: 0.75, thickness: 0.08 },
  chair: { width: 0.5, depth: 0.5, height: 0.9, thickness: 0.05 },
  stairs: { width: 1.2, depth: 2.4, height: 1.5, steps: 6 },
};

export function validateAssembly(recipe: AssemblyRecipe): string | null {
  if (!recipe || typeof recipe !== 'object' || !Object.hasOwn(ASSEMBLY_DEFAULTS, recipe.template)) return 'unknown assembly template';
  if (Object.keys(recipe).some((k) => k !== 'template' && k !== 'parameters')) return 'unknown assembly recipe field';
  const p = recipe.parameters ?? {};
  if (typeof p !== 'object' || Array.isArray(p)) return 'assembly parameters must be an object';
  if (Object.keys(p).some((k) => !['width', 'depth', 'height', 'thickness', 'steps'].includes(k))) return 'unknown assembly parameter';
  for (const [k, v] of Object.entries(p)) if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 100) return `assembly ${k} must be >0 and <=100`;
  if (p.steps != null && (recipe.template !== 'stairs' || !Number.isInteger(p.steps) || p.steps > 64)) return 'steps applies to stairs and must be an integer 1..64';
  if (recipe.template === 'stairs' && p.thickness != null) return 'thickness applies only to table/chair';
  const d = { thickness: 0.08, ...ASSEMBLY_DEFAULTS[recipe.template], ...p };
  if (recipe.template !== 'stairs' && d.thickness * 2 >= Math.min(d.width, d.depth, d.height / 2)) return 'assembly thickness is too large for its dimensions';
  return null;
}

/** Generated parts are ordinary editable props. Regeneration replaces these
 * IDs, preserves custom children, and keeps per-part color/material choices. */
export function assemblyParts(id: string, recipe: AssemblyRecipe): SceneProp[] {
  const error = validateAssembly(recipe);
  if (error) throw new Error(error);
  const { width: w, depth: d, height: h, thickness: th } = { thickness: 0.08, ...ASSEMBLY_DEFAULTS[recipe.template], ...recipe.parameters };
  const parts: SceneProp[] = [];
  const box = (part: string, x: number, y: number, z: number, sx: number, sy: number, sz: number) => {
    parts.push({ id: `${id}/${part}`, parentId: id, model: 'prop/cube', name: part,
      position: { x, y, z }, scale: { x: sx, y: sy, z: sz }, color: '#b18a62' });
  };
  if (recipe.template === 'stairs') {
    const steps = recipe.parameters?.steps ?? ASSEMBLY_DEFAULTS.stairs.steps;
    for (let i = 0; i < steps; i++) {
      const rise = h * (i + 1) / steps;
      box(`step-${i + 1}`, 0, rise / 2, -d / 2 + d * (i + 0.5) / steps, w, rise, d / steps);
    }
  } else {
    const surfaceY = recipe.template === 'chair' ? h / 2 : h;
    box(recipe.template === 'chair' ? 'seat' : 'top', 0, surfaceY - th / 2, 0, w, th, d);
    for (const [n, x, z] of [['front-left', -1, 1], ['front-right', 1, 1], ['back-left', -1, -1], ['back-right', 1, -1]] as const) {
      box(`leg-${n}`, x * (w - th) / 2, (surfaceY - th) / 2, z * (d - th) / 2, th, surfaceY - th, th);
    }
    if (recipe.template === 'chair') box('back', 0, (h + surfaceY) / 2, -(d - th) / 2, w, h - surfaceY, th);
  }
  return parts;
}
