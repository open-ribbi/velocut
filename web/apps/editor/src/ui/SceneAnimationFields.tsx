import { useState } from 'react';
import { ANIMATION_CHANNELS, channelBase, isCurveBinding, sampleChannel, type AnimationChannel, type SceneSpec, type SceneTransform, type SceneEdit, type SceneObjectKind } from '@velocut/scene-sdk';
import { NumberField } from './SceneFields';
import { JsonField } from './SceneModelFields';

export function SceneAnimationFields({object,spec,timeS,kind,onChange,onEdit}:{object:SceneTransform;spec:SceneSpec;timeS:number;kind:SceneObjectKind;onChange:(animation:SceneTransform['animation'])=>void;onEdit:(edits:SceneEdit[])=>unknown}) {
  const [selectedChannel,setChannel]=useState<AnimationChannel>('scale.y');
  const channel=kind==='light'&&selectedChannel==='opacity'?'visible':selectedChannel;
  const bound=object.animation?.channels?.[channel];
  const fallback=channel.startsWith('scale.')||channel==='opacity'||channel==='visible'?1:channel==='position.y'&&kind==='prop'&&!('attachTo' in object && object.attachTo)?0.5:0;
  const raw=bound ?? (channel==='visible' ? typeof object.visible==='boolean'?Number(object.visible):object.visible?.map(k=>({t:k.t,v:Number(k.v)})) : channelBase(object,channel)) ?? fallback;
  const setValue=(value:unknown)=>onChange({...object.animation,channels:{...object.animation?.channels,[channel]:value as never}});
  const binding=isCurveBinding(bound)?bound:undefined;
  const curve=binding?spec.curves?.[binding.curveId]:undefined;
  const choices=ANIMATION_CHANNELS.filter(c=>kind!=='light'||c!=='opacity');
  return <details className="scene-actions">
    <summary>Animation</summary>
    <div className="prop-row"><span className="prop-label">Object delay (s)</span><NumberField value={object.animation?.timeOffset ?? 0} onCommit={timeOffset=>onChange({...object.animation,timeOffset})}/></div>
    <label className="prop-row"><span className="prop-label">Channel</span><select aria-label="Animation channel" value={channel} onChange={e=>setChannel(e.target.value as AnimationChannel)}>{choices.map(c=><option key={c}>{c}</option>)}</select></label>
    <div className="empty-hint">Sample: {sampleChannel(object,channel,timeS,spec,fallback).toFixed(3)} at {timeS.toFixed(2)}s. Channels override the base transform.</div>
    <label className="prop-row"><span className="prop-label">Curve</span><select aria-label="Animation curve" value={binding?.curveId ?? ''} onChange={e=>setValue(e.target.value?{curveId:e.target.value}:sampleChannel(object,channel,timeS,spec,fallback))}>
      <option value="">Inline / constant</option>{Object.entries(spec.curves ?? {}).filter(([,c])=>channel!=='visible'||c.mode==='step').map(([id,c])=><option key={id} value={id}>{c.name ?? id}</option>)}
    </select></label>
    <JsonField label="Channel value or binding" value={raw} onChange={setValue}/>
    <button className="fx-add" onClick={()=>{const channels={...object.animation?.channels};delete channels[channel];onChange({...object.animation,channels});}}>Use base value</button>
    <button className="fx-add" onClick={()=>{let n=1;while(Object.hasOwn(spec.curves ?? {},`curve_${n}`))n++;onEdit([{type:'curve.create',id:`curve_${n}`,curve:{mode:channel==='visible'?'step':'continuous',keys:[{t:0,v:0},{t:1,v:1}]}}]);}}>Create shared curve</button>
    {curve&&binding&&<>
      <div className="group-title">Shared curve · {binding.curveId}</div>
      <div className="empty-hint">Editing these keys changes every binding to this curve.</div>
      <JsonField label="Shared curve keys" value={curve.keys} onChange={keys=>onEdit([{type:'curve.update',id:binding.curveId,curve:{...curve,keys:keys as never}}])}/>
    </>}
    <div className="empty-hint">Keys use seconds and {'{t,v,ease?}'}. Visibility uses 0/1 step keys. Scale and opacity can start at zero. Binding timeOffset is added to the object delay.</div>
  </details>;
}
