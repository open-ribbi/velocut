import { useState } from 'react';
import type { SceneLight, SceneProp } from '@velocut/scene-sdk';
import { AnimatableField, NumberField } from './SceneFields';

function JsonField({ label, value, onChange }: { label: string; value: unknown; onChange: (v: unknown) => void }) {
  const [error, setError] = useState<string | null>(null);
  const text = JSON.stringify(value);
  return <div>
    <div className="prop-label">{label}</div>
    <textarea aria-label={label} key={text} className="scene-json" defaultValue={text} onBlur={(e) => {
      try { const parsed = JSON.parse(e.target.value); setError(null); if (JSON.stringify(parsed) !== text) onChange(parsed); }
      catch { setError('Enter a valid JSON array.'); }
    }} />
    {error && <div className="scene-error">{error}</div>}
  </div>;
}

export function MeshFields({ value, onChange }: { value: SceneProp; onChange: (patch: Partial<SceneProp>) => void }) {
  return <div>
    <JsonField label="Vertices [x,y,z]" value={value.vertices ?? []} onChange={(vertices) => onChange({ vertices: vertices as SceneProp['vertices'] })} />
    <JsonField label="Triangles [a,b,c]" value={value.faces ?? []} onChange={(faces) => onChange({ faces: faces as SceneProp['faces'] })} />
    <JsonField label="UV coordinates" value={value.uvs ?? []} onChange={(uvs) => onChange({ uvs: Array.isArray(uvs) && !uvs.length ? undefined : uvs as SceneProp['uvs'] })} />
    <div className="empty-hint">Triangle indices start at 0; front faces wind counter-clockwise. Duplicate vertices for hard edges.</div>
  </div>;
}

export function LightFields({ value, onChange }: { value: SceneLight; onChange: (patch: Partial<SceneLight>) => void }) {
  return <>
    <div className="prop-row"><span className="prop-label">Light type</span>
      <select value={value.type} onChange={(e) => onChange({ type: e.target.value as SceneLight['type'], distance: undefined, decay: undefined, angle: undefined, penumbra: undefined })}>
        {['point', 'spot', 'directional', 'ambient'].map((type) => <option key={type} value={type}>{type}</option>)}
      </select>
    </div>
    <div className="prop-row"><span className="prop-label">Intensity</span>
      <AnimatableField value={value.intensity} fallback={value.type === 'ambient' ? 0.5 : value.type === 'directional' ? 3 : 100} step={0.1} onChange={(intensity) => onChange({ intensity })} />
    </div>
    {(value.type === 'spot' || value.type === 'point') && <>
      <div className="prop-row"><span className="prop-label">Range</span><NumberField value={value.distance ?? 0} min={0} max={10000} onCommit={(distance) => onChange({ distance })} /></div>
      <div className="prop-row"><span className="prop-label">Decay</span><NumberField value={value.decay ?? 2} min={0} max={5} onCommit={(decay) => onChange({ decay })} /></div>
    </>}
    {value.type === 'spot' && <>
      <div className="prop-row"><span className="prop-label">Half angle</span><NumberField value={value.angle ?? 45} min={0.1} max={89.9} step={1} onCommit={(angle) => onChange({ angle })} /></div>
      <div className="prop-row"><span className="prop-label">Penumbra</span><NumberField value={value.penumbra ?? 0.2} min={0} max={1} onCommit={(penumbra) => onChange({ penumbra })} /></div>
    </>}
    {value.type !== 'ambient' && <label><input type="checkbox" checked={value.shadow ?? false} onChange={(e) => onChange({ shadow: e.target.checked })} /> Cast shadows</label>}
    {(value.type === 'spot' || value.type === 'directional') && <div className="empty-hint">Points down local −Z. Rotate the light to aim it.</div>}
  </>;
}
