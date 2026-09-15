import { sampleAnimatable, type Animatable, type MotionKeyframe } from '@velocut/render-sdk/motionspec';
import type { SceneSpec, SceneTransform } from './types.ts';

export const ANIMATION_CHANNELS = ['position.x','position.y','position.z','rotationX','rotationY','rotationZ','scale.x','scale.y','scale.z','visible','opacity'] as const;
export type AnimationChannel = typeof ANIMATION_CHANNELS[number];
export interface SceneCurve { name?: string; mode?: 'continuous' | 'step'; keys: MotionKeyframe[] }
export interface CurveBinding { curveId: string; timeOffset?: number; timeScale?: number; valueScale?: number; valueOffset?: number }
export type ChannelValue = Animatable | CurveBinding;
export interface SceneAnimation { timeOffset?: number; channels?: Partial<Record<AnimationChannel, ChannelValue>> }
export type AnimatedVisibility = boolean | Array<{t:number;v:boolean}>;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
export const isCurveBinding = (v: unknown): v is CurveBinding => !!v && typeof v === 'object' && !Array.isArray(v) && 'curveId' in v;

export function validateKeys(value: unknown, boolean = false): string | null {
  if (!Array.isArray(value) || !value.length) return 'keyframes must be a nonempty array';
  let previous = -Infinity;
  for (const k of value) {
    if (!k || typeof k !== 'object' || Object.keys(k).some(key => !['t','v',...(boolean ? [] : ['ease'])].includes(key)) || !finite(k.t) || k.t < 0 || k.t <= previous ||
      (boolean ? typeof k.v !== 'boolean' : !finite(k.v)) || (k.ease != null && typeof k.ease !== 'string')) return 'keyframes need finite values and strictly increasing nonnegative times';
    previous = k.t;
  }
  return null;
}
export function validateCurve(curve: SceneCurve): string | null {
  if (!curve || typeof curve !== 'object' || Array.isArray(curve) || Object.keys(curve).some(k => !['name','mode','keys'].includes(k))) return 'invalid curve fields';
  if (curve.name != null && typeof curve.name !== 'string' || curve.mode != null && !['continuous','step'].includes(curve.mode)) return 'invalid curve name or mode';
  return validateKeys(curve.keys);
}
export function validateObjectAnimation(object: SceneTransform, spec: SceneSpec): string | null {
  const animation = object.animation;
  if (object.visible != null && typeof object.visible !== 'boolean') { const error = validateKeys(object.visible,true); if (error) return error; }
  if (object.opacity != null) {
    const error = typeof object.opacity === 'number' ? (!finite(object.opacity) ? 'invalid opacity' : null) : validateKeys(object.opacity);
    if (error) return error;
    const values = typeof object.opacity === 'number' ? [object.opacity] : object.opacity.map(k => k.v);
    if (values.some(v => v < 0 || v > 1)) return 'opacity values must be 0..1';
  }
  if (animation == null) return null;
  if (typeof animation !== 'object' || Array.isArray(animation) || Object.keys(animation).some(k => !['timeOffset','channels'].includes(k)) || animation.timeOffset != null && !finite(animation.timeOffset)) return 'invalid animation fields/timeOffset';
  if (animation.channels != null && (typeof animation.channels !== 'object' || Array.isArray(animation.channels))) return 'animation channels must be an object';
  for (const [channel, value] of Object.entries(animation.channels ?? {})) {
    if (!(ANIMATION_CHANNELS as readonly string[]).includes(channel)) return `unknown animation channel '${channel}'`;
    let values: number[];
    if (isCurveBinding(value)) {
      if (Object.keys(value).some(k => !['curveId','timeOffset','timeScale','valueScale','valueOffset'].includes(k)) || typeof value.curveId !== 'string' || !Object.hasOwn(spec.curves ?? {},value.curveId)) return 'invalid or missing curve reference';
      if ([value.timeOffset,value.timeScale,value.valueScale,value.valueOffset].some(n => n != null && !finite(n)) || (value.timeScale ?? 1) <= 0) return 'invalid curve binding transform';
      const curve = spec.curves![value.curveId];
      if (channel === 'visible' && (curve.mode !== 'step' || value.valueScale != null || value.valueOffset != null)) return 'visibility references require a step curve without value transforms';
      values = curve.keys.map(k => k.v*(value.valueScale ?? 1)+(value.valueOffset ?? 0));
    } else {
      const error = typeof value === 'number' ? (!finite(value) ? 'invalid animation number' : null) : validateKeys(value);
      if (error) return error;
      values = typeof value === 'number' ? [value] : (value as MotionKeyframe[]).map(k => k.v);
      if (channel === 'visible' && Array.isArray(value) && value.some(k => k.ease != null)) return 'visibility keys use step changes, without easing';
    }
    if (values.some(v => !finite(v))) return 'curve binding produces non-finite values';
    if (channel === 'visible' && values.some(v => v !== 0 && v !== 1)) return 'visibility channel values must be 0 or 1';
    if (channel === 'opacity' && values.some(v => v < 0 || v > 1)) return 'opacity values must be 0..1';
    if (channel.startsWith('scale.') && values.some(v => v < 0)) return 'animated scale values must be nonnegative';
  }
  return null;
}
function stepValue<T>(keys: Array<{t:number;v:T}>, t:number): T {
  let value=keys[0].v;for(const key of keys){if(key.t>t)break;value=key.v;}return value;
}
export function channelBase(object: SceneTransform, channel: AnimationChannel): Animatable | undefined {
  if (channel.startsWith('position.')) return object.position?.[channel.slice(-1) as 'x'|'y'|'z'];
  if (channel.startsWith('scale.')) return typeof object.scale === 'number' ? object.scale : object.scale?.[channel.slice(-1) as 'x'|'y'|'z'];
  if (channel === 'opacity') return object.opacity;
  if (channel === 'visible') return undefined;
  return object[channel as 'rotationX'|'rotationY'|'rotationZ'];
}
export function sampleChannel(object: SceneTransform, channel: AnimationChannel, timeS: number, spec: Pick<SceneSpec,'curves'>, fallback: number): number {
  const value=object.animation?.channels?.[channel];
  const t=timeS-(object.animation?.timeOffset ?? 0);
  let result: number;
  if (isCurveBinding(value)) {
    const curve=spec.curves?.[value.curveId];if(!curve)throw new Error(`unknown curve '${value.curveId}'`);
    const local=(t-(value.timeOffset ?? 0))*(value.timeScale ?? 1);
    result=(curve.mode==='step'?stepValue(curve.keys,local):sampleAnimatable(curve.keys,local,fallback))*(value.valueScale ?? 1)+(value.valueOffset ?? 0);
  } else if(channel==='visible') {
    if(value!=null)result=typeof value==='number'?value:stepValue(value,t);
    else result=typeof object.visible==='boolean' ? Number(object.visible) : object.visible ? Number(stepValue(object.visible,t)) : 1;
  } else result=sampleAnimatable(value ?? channelBase(object,channel),t,fallback);
  if(!Number.isFinite(result))throw new Error(`animation '${channel}' produced a non-finite value`);
  return channel==='opacity'?Math.max(0,Math.min(1,result)):channel.startsWith('scale.')?Math.max(0,result):result;
}
export function sampleObjectTransform(object: SceneTransform,timeS:number,spec:Pick<SceneSpec,'curves'>,defaultY=0) {
  const s=(channel:AnimationChannel,fallback:number)=>sampleChannel(object,channel,timeS,spec,fallback);
  return {position:[s('position.x',0),s('position.y',defaultY),s('position.z',0)] as [number,number,number],
    rotation:[s('rotationX',0),s('rotationY',0),s('rotationZ',0)] as [number,number,number],
    scale:[s('scale.x',1),s('scale.y',1),s('scale.z',1)] as [number,number,number],
    visible:s('visible',1)===1,opacity:s('opacity',1)};
}
