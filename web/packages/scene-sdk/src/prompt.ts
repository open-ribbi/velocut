// prompt.ts — render the asset manifest into the agent-facing vocabulary.
//
// This is what grounds the agent: it can only name models, clips and
// environments that actually exist, and locomotion clips advertise their
// natural gait speed so position keyframes can be paced to match (no
// skating). Served to programs via the sceneAssets() script RPC, so the
// vocabulary always reflects the shipped manifest — no prompt edits when
// assets are added.

import { MANNEQUIN_JOINTS, POSE_PRESETS } from './mannequin.ts';
import type { SceneAssetManifest } from './types.ts';
import { SCENE_LIMITS } from './geometry.ts';

export function scenePromptDoc(manifest: SceneAssetManifest): string {
  const lines: string[] = [];
  lines.push('Characters (model id → animation clips):');
  for (const [id, c] of Object.entries(manifest.characters)) {
    const clips = Object.entries(c.clips)
      .map(([name, m]) => name + (m.speedMps ? `(${m.speedMps}m/s)` : '') + (m.loop === false ? '(once)' : ''))
      .join(', ');
    const slots = Object.keys(c.bones ?? {});
    const isMannequin = c.file.startsWith('builtin:mannequin');
    lines.push(
      `• ${id}${c.heightM ? ` — height ${c.heightM}m` : ''}: ${isMannequin ? 'POSEABLE (pose field, no clips)' : clips}` +
        (slots.length ? ` | attach slots: ${slots.join(', ')}` : '') +
        (c.morphs?.length ? ` | expressions: ${c.morphs.join(', ')}` : ''),
    );
  }
  lines.push(
    `Mannequin pose presets: ${Object.keys(POSE_PRESETS).join(', ')}. ` +
      `Joints (for pose overrides, degrees [pitch, yaw, roll]): ${MANNEQUIN_JOINTS.join(', ')}.`,
  );
  lines.push('Environments: ' + Object.keys(manifest.environments).join(', '));
  lines.push('Lighting: ' + Object.keys(manifest.lighting).join(', '));
  lines.push('Modeling: objects support rotationX/Y/Z (degrees, XYZ Euler, animatable), per-axis scale, parentId for nested groups. Prop material: roughness/metalness/opacity 0..1, emissive #RRGGBB, emissiveIntensity 0..100. prop/tube: path [[x,y,z],…] (2..64 points), radius meters (default .05), closed boolean; use for cables, rails, handles. prop/extrude additionally supports holes: arrays of closed XY outlines and bevel 0..1 meters (keep smaller than the outline features). Profiles, paths and material values remain editable.');
  lines.push('Assemblies via sceneEdit type:assembly: table/chair/stairs with width/depth/height/thickness (meters), steps for stairs. Parts are ordinary editable props under a group. sceneArrange provides bounding-box ground/on/align/distribute placement.');
  lines.push('Batch authoring through sceneEdit({assetId,expectedRevision?,edits,dryRun?}): duplicateMany {type:"duplicateMany",ids,copies:[{prefix,transform?,relative?}],timeS?} clones each selected subtree into prefix/oldId, remaps internal references, returns copies:[{prefix,rootIds,idMap}] and createdIds. Optional transform applies to each copied root; relative:true preserves separation with offsets. Originals remain. transform {type:"transform",ids,transform:{position?:{x?,y?,z?},rotation?:{x?,y?,z?},scale?:number|{x?,y?,z?}},relative?,timeS?} sets supplied local components at timeS (default 0), retaining omitted axes and shifting animation keys; relative adds position/Euler degrees, multiplies positive scales about individual origins. Physics props require timeS:0. Reject parent/descendant overlap.');
  lines.push('layout {type:"layout",ids,timeS?,layout:...} places object origins in ID order in a shared parent/bone frame. Layout options: {mode:"line",origin:{x?,y?,z?},step:{x?,y?,z?}}; {mode:"grid",origin:{x?,y?,z?},columns,spacing:{x,z}} (row-major X/Z); {mode:"radial",center:{x?,y?,z?},radius,startAngle?,sweepAngle?,facing?:"keep"|"inward"|"outward"|"tangent",rotationOffset?}. Omitted origin/center axes are zero. Radial: angle 0=+Z, positive toward +X; default sweep 360 omits repeated endpoint, shorter arcs include endpoints; facing controls local +Z yaw plus rotationOffset. Combine duplicateMany + layout + transform in ONE sceneEdit for one atomic undo step.');
  lines.push('sceneArrange mode:"distribute" packs world bounds in ids order along axis (default x), with gap meters between edges and optional start for first lower bound; default start keeps first lower edge, other world coordinates remain. Different parents supported. No referenceId. sceneEdit/sceneArrange dryRun:true compiles a candidate without changing document/history: {ok:true,preview:true,ready:false,revision,spec,...}; commit same options without dryRun using returned revision. Preview returns no image. Separate script calls are separate transactions. Limits: 200 ordinary props (assembly parts count), no fixed shared-instance count limit, 100 groups, 8 characters, 16 lights, 256 KiB spec, 100 copy requests/500 generated objects per duplicateMany.');
  lines.push('Explicit meshes: prop/mesh has vertices [[x,y,z],…] (3..4096), faces [[a,b,c],…] (1..8192 counter-clockwise index triples), optional uvs [[u,v],…] per vertex. All geometry is editable data; the document spec still has a 256 KiB budget.');
  lines.push('Shared geometry: SceneSpec.geometries accepts inline geometry in a scene-local registry {geometryId:{name?,vertices,faces,uvs?}}. sceneEdit operations: {type:"geometry.create",id,geometry}, {type:"geometry.update",id,geometry} (replace the whole definition, updates all linked instances), {type:"geometry.remove",id} (reject while referenced). Add instances with {type:"add",kind:"prop",object:{id,model:"prop/instance",geometryId,position?,rotationX/Y/Z?,scale?,parentId?,color?,material?}}. Ordinary update/transform/layout/duplicate/remove work on each instance; duplicate keeps the shared reference. {type:"geometry.clone",id,newId} clones a geometry definition, reusing immutable file bytes until changed. {type:"makeUnique",id,geometryId?} creates a new geometry definition and converts one instance into a resource-backed prop/mesh, preserving object ID/transform/material and counting against the 200 ordinary-prop limit; no vertices are put back into the manifest. geometryId is the optional new registry key (otherwise unique_N). It does not delete the shared resource. First version: opaque materials only; physics/bone attachment require makeUnique. Instances render in batches but remain independently pickable/editable.');
  lines.push('Budget and bulk editing: query({kind:"sceneBudget",assetId}) returns current counts/limits; query kind:sceneGeometries returns paginated geometry summaries (opt into fields:["id","geometry"] only for legacy inline vertices; sceneGeometry reads resource-backed arrays); query kind:sceneObjects includes model, geometryId and materialId. sceneEdit({assetId,edits,expectedRevision,preflight:true}) checks structure and budgets without compiling/rendering, writing files or committing; patches may read their source resource; ready:false,compiled:false. A valid preflight is not proof of rendered quality. dryRun:true additionally compiles. includeSpec:false suppresses full specs in edit replies. Send at most 500 edits per batch; each committed batch is one undo step. Limits: ' + JSON.stringify(SCENE_LIMITS) + '. A null limit means no configured ceiling for that metric. Exceeding a limit is a failed edit, never silently merge/simplify user-requested parts. The runtime persists inline geometry as immutable project files in spec.geometryResources; scene references/history contain metadata only. The 256 KiB limit applies to the compact manifest; geometryBytes has a separate budget. used.specBytes is the projected compact size, documentBytes is the current JSON size. Instance/group transform-only edits return updateMode:transforms and retain renderers; other edits return rebuild. Old inline specs remain readable.');
  lines.push('Geometry editing: sceneGeometry({assetId,geometryId,attribute?:vertices|faces|uvs,offset?,limit?:1..1024}) reads a page with revision/resource/total/items/nextOffset. MCP tool: velocut_scene_geometry. query sceneGeometries includes storage:inline|resource; opt into resource for source metadata, geometry only exists for legacy inline entries. sceneEdit {type:"geometry.patch",id,attribute:"vertices"|"faces"|"uvs",updates:[{index,value}]} replaces 1..1024 existing unique indices, preserving other data. Topology insertions/removals still use full geometry.update. Every edit creates an immutable geometry version as needed; undo restores old references. dryRun saves no geometry files: commit the original edits, not the returned temporary spec.');
  lines.push('Shared materials: spec.materials is a registry (max 128) with definitions {name?,color?:#RRGGBB,roughness?,metalness?,opacity?,emissive?,emissiveIntensity?,side?}. sceneEdit {type:"material.create"|"material.update",id,material} creates/replaces a definition; {type:"material.remove",id} refuses live references. Props bind materialId; prop.color and supplied prop.material fields override shared values. Clear local color/material to inherit again. Query sceneMaterials for id/name/objectCount, request field material for the definition. Resource-backed prop/mesh supports geometryId and can use transparency/physics/bone attachment through existing APIs; instances still require opaque resolved materials. geometry.clone + update binding + geometry.patch can compose in one sceneEdit. Material/geometry IDs are returned separately in materialIds/geometryIds.');
  lines.push('Independent lights: add kind:light objects with id, type point/spot/directional/ambient, color, intensity (constant or keyframed), transform/parentId. Point/spot: distance (0=infinite), decay. Spot: angle (half-angle degrees <90), penumbra 0..1. shadow boolean. Directional/spot aim down local -Z; rotate to aim. lighting:none disables preset rigs. Imported self-contained GLBs are registered by sceneImportModel; sceneInspect.spec.models contains their exact animation names.');
  lines.push('Props: ' + Object.keys(manifest.props).join(', '));
  lines.push(
    'Pace walks so position keyframes match the gait: distance = speedMps × seconds ' +
      '(e.g. Walking at 1.4m/s covers 4.2m in 3s). World units are meters, ground is y=0, camera looks -Z by default.',
  );
  lines.push(
    'Physics (per-prop opt-in, baked deterministically): physics: "dynamic" | "fixed" | "kinematic" | ' +
      '{type, mass?, restitution?, friction?, velocity?, angularVelocity?, startAt?}. ' +
      'Reach for it when motion should EMERGE (falls, collapses, impacts, rolling, scattering); ' +
      'keep keyframes for choreographed moves. Characters are not simulated.',
  );
  return lines.join('\n');
}
