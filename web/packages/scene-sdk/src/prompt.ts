// prompt.ts — render the asset manifest into the agent-facing vocabulary.
//
// This is what grounds the agent: it can only name models, clips and
// environments that actually exist, and locomotion clips advertise their
// natural gait speed so position keyframes can be paced to match (no
// skating). Served to programs via the sceneAssets() script RPC, so the
// vocabulary always reflects the shipped manifest — no prompt edits when
// assets are added.

import type { SceneAssetManifest } from './types.ts';

export function scenePromptDoc(manifest: SceneAssetManifest): string {
  const lines: string[] = [];
  lines.push('Characters (model id → animation clips):');
  for (const [id, c] of Object.entries(manifest.characters)) {
    const clips = Object.entries(c.clips)
      .map(([name, m]) => name + (m.speedMps ? `(${m.speedMps}m/s)` : '') + (m.loop === false ? '(once)' : ''))
      .join(', ');
    lines.push(`• ${id}${c.heightM ? ` — height ${c.heightM}m` : ''}: ${clips}`);
  }
  lines.push('Environments: ' + Object.keys(manifest.environments).join(', '));
  lines.push('Lighting: ' + Object.keys(manifest.lighting).join(', '));
  lines.push('Props: ' + Object.keys(manifest.props).join(', '));
  lines.push(
    'Pace walks so position keyframes match the gait: distance = speedMps × seconds ' +
      '(e.g. Walking at 1.4m/s covers 4.2m in 3s). World units are meters, ground is y=0, camera looks -Z by default.',
  );
  return lines.join('\n');
}
