import type {SceneSpec,SceneProp} from './types.ts';
import {anchorIdValid,spatialVector,type SpatialVector} from './anchors.ts';

export type JointEndpoint={objectId:string;position:SpatialVector;anchorId?:never}|{objectId:string;anchorId:string;position?:never};
export const JOINT_AXES=['x','y','z','rotationX','rotationY','rotationZ'] as const;
export type JointAxis=typeof JOINT_AXES[number];
export type JointMotor=
  | {mode:'velocity';targetVelocity:number;damping:number;model?:'force'|'acceleration'}
  | {mode:'position';targetPosition:number;stiffness:number;damping:number;model?:'force'|'acceleration'};
interface JointBase {name?:string;enabled?:boolean;a:JointEndpoint;b:JointEndpoint;contactsEnabled?:boolean}
export type SceneJoint=
  | (JointBase&{type:'fixed';rotationA?:SpatialVector;rotationB?:SpatialVector})
  | (JointBase&{type:'spherical'})
  | (JointBase&{type:'revolute'|'prismatic';axis:SpatialVector;limits?:[number,number];motor?:JointMotor})
  | (JointBase&{type:'spring';length:number;stiffness:number;damping:number})
  | (JointBase&{type:'rope';length:number})
  | (JointBase&{type:'generic';axis:SpatialVector;lockedAxes:JointAxis[]});
export type JointQuaternion=[number,number,number,number];
/** Compact immutable setup metadata. No solver worlds or per-joint frame tracks. */
export interface JointRuntime {
  id:string;definition:SceneJoint;anchorA:SpatialVector;anchorB:SpatialVector;
  frameA:JointQuaternion|null;frameB:JointQuaternion|null;
}

const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
export function jointLocalPosition(p:SceneProp,e:JointEndpoint):SpatialVector {
  const anchor=e.anchorId===undefined?undefined:p.anchors?.[e.anchorId];
  if(e.anchorId!==undefined&&(!anchor||anchor.kind==='surface'))throw Error(`joint endpoint '${e.objectId}:${e.anchorId}' requires a local anchor`);
  const position=e.position??(anchor as {position:SpatialVector}).position;
  const scale=typeof p.scale==='number'?[p.scale,p.scale,p.scale]:[p.scale?.x??1,p.scale?.y??1,p.scale?.z??1];
  return position.map((v,i)=>v*scale[i]) as SpatialVector;
}
export function validateJoints(spec:SceneSpec):string|null {
  if(spec.joints===undefined)return null;
  if(!object(spec.joints))return 'joints must be a registry';
  const props=new Map((spec.props??[]).map(p=>[p.id,p]));
  const endpoint=(e:unknown)=>{
    if(!object(e)||Object.keys(e).some(k=>!['objectId','position','anchorId'].includes(k))||typeof e.objectId!=='string')return false;
    const p=props.get(e.objectId);if(!p?.physics)return false;
    if(e.anchorId!==undefined){const a=Object.hasOwn(p.anchors??{},e.anchorId as string)?p.anchors![e.anchorId as string]:undefined;return anchorIdValid(e.anchorId)&&e.position===undefined&&!!a&&a.kind!=='surface';}
    return spatialVector(e.position);
  };
  for(const [id,j]of Object.entries(spec.joints)){
    const fail=(s:string)=>`joint '${id}': ${s}`;
    if(!anchorIdValid(id)||!object(j)||!['fixed','spherical','revolute','prismatic','spring','rope','generic'].includes(j.type))return fail('invalid id or type');
    const extra=j.type==='fixed'?['rotationA','rotationB']:['revolute','prismatic'].includes(j.type)?['axis','limits','motor']:j.type==='spring'?['length','stiffness','damping']:j.type==='rope'?['length']:j.type==='generic'?['axis','lockedAxes']:[];
    if(Object.keys(j).some(k=>!['type','a','b','enabled','name','contactsEnabled',...extra].includes(k))||j.name!==undefined&&typeof j.name!=='string')return fail('invalid fields');
    for(const k of ['enabled','contactsEnabled'] as const)if(j[k]!==undefined&&typeof j[k]!=='boolean')return fail(`${k} must be boolean`);
    if(!endpoint(j.a)||!endpoint(j.b))return fail('endpoints need physics objectId and either position:[x,y,z] or a local anchorId');
    if(j.a.objectId===j.b.objectId)return fail('endpoints must belong to different bodies');
    if(j.enabled!==false&&![j.a,j.b].some(e=>{const p=props.get(e.objectId)!.physics!;return (typeof p==='string'?p:p.type)==='dynamic';}))return fail('an enabled joint needs at least one dynamic body');
    for(const e of [j.a,j.b])if(!jointLocalPosition(props.get(e.objectId)!,e).every(v=>Number.isFinite(Math.fround(v))))return fail('scaled anchors exceed physics numeric range');
    if(j.type==='fixed')for(const k of ['rotationA','rotationB'] as const)if(j[k]!==undefined&&!spatialVector(j[k]))return fail(`${k} must be XYZ degrees`);
    if('axis' in j&&(!spatialVector(j.axis)||!Number.isFinite(Math.hypot(...j.axis))||Math.hypot(...j.axis)===0))return fail('axis must be a finite nonzero local direction');
    if(j.type==='rope'||j.type==='spring')if(!finite(j.length)||j.length<0)return fail('length must be nonnegative meters');
    if(j.type==='spring'&&(!finite(j.stiffness)||j.stiffness<=0||!finite(j.damping)||j.damping<0))return fail('spring requires stiffness > 0 and damping >= 0');
    if(j.type==='generic'&&(!Array.isArray(j.lockedAxes)||new Set(j.lockedAxes).size!==j.lockedAxes.length||j.lockedAxes.some(a=>!JOINT_AXES.includes(a))))return fail('lockedAxes must contain unique x/y/z/rotationX/rotationY/rotationZ entries');
    if(j.type==='revolute'||j.type==='prismatic'){
      if(j.limits!==undefined&&(!Array.isArray(j.limits)||j.limits.length!==2||!j.limits.every(finite)||j.limits[0]>j.limits[1]))return fail('limits must be ordered [min,max]');
      if(j.type==='revolute'&&j.limits&&(j.limits[0]<-180||j.limits[1]>180))return fail('revolute limits use the signed angle range -180..180 degrees');
      const m=j.motor;
      if(m!==undefined){
        if(!object(m)||!['position','velocity'].includes(m.mode))return fail('invalid motor mode');
        const fields=m.mode==='position'?['targetPosition','stiffness']:['targetVelocity'];
        if(Object.keys(m).some(k=>!['mode','damping','model',...fields].includes(k))||m.model!==undefined&&!['force','acceleration'].includes(m.model))return fail('invalid motor fields');
        if(!finite(m.damping)||m.damping<0)return fail('motor damping must be >= 0');
        if(m.mode==='position'&&(!finite(m.targetPosition)||!finite(m.stiffness)||m.stiffness<=0)||m.mode==='velocity'&&!finite(m.targetVelocity))return fail('motor targets must be finite and stiffness > 0');
        if(m.mode==='position'&&j.limits&&(m.targetPosition<j.limits[0]||m.targetPosition>j.limits[1]))return fail('motor targetPosition is outside the limits');
        if(m.mode==='position'&&j.type==='revolute'&&(m.targetPosition<-180||m.targetPosition>180))return fail('revolute targetPosition uses -180..180 degrees; use a velocity motor for continuous turns');
      }
    }
  }
  return null;
}
