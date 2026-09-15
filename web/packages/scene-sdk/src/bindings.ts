import type {SceneSpec, SceneTransform} from './types.ts';
import {anchorIdValid, spatialVector, type SpatialVector} from './anchors.ts';
import {isCurveBinding} from './animation.ts';

export interface AnchorRef {objectId:string;anchorId:string}
interface BindingBase {
  name?:string;
  source:AnchorRef;
  target:AnchorRef;
  enabled?:boolean;
  /** Preserve authored motion as a delta from this scene-local time. */
  motion?:{referenceTimeS:number};
}
export type SceneBinding =
  | (BindingBase & {type:'position';offset?:SpatialVector;offsetSpace?:'world'|'source'})
  | (BindingBase & {type:'orientation';twist?:number});
export interface BindingStatus {id:string;targetId:string;status:'valid'|'disabled'|'invalid'|'suspended';message?:string}

export function bindingObjects(spec:SceneSpec) {
  return [...(spec.groups??[]).map(object=>({kind:'group',object})),...(spec.props??[]).map(object=>({kind:'prop',object})),
    ...(spec.characters??[]).map(object=>({kind:'character',object})),...(spec.lights??[]).map(object=>({kind:'light',object}))];
}
export function activeBinding(spec:Pick<SceneSpec,'bindings'>,objectId:string,type:SceneBinding['type']) {
  return Object.entries(spec.bindings??{}).find(([,b])=>b.enabled!==false&&b.target.objectId===objectId&&b.type===type);
}
export function assertBindingWrite(spec:SceneSpec,objectId:string,fields:string[]) {
  for(const type of ['position','orientation'] as const){
    const binding=activeBinding(spec,objectId,type);
    if(binding && fields.some(f=>type==='position'?f==='position':['rotationX','rotationY','rotationZ'].includes(f)))
      throw new Error(`binding '${binding[0]}' owns ${type} of '${objectId}'; edit its offset/twist or disable it before transforming the object`);
  }
}

/** One-way object dependencies, including hierarchy, in evaluation order. */
export function bindingOrder(spec:SceneSpec):string[] {
  const entries=bindingObjects(spec),byId=new Map(entries.map(e=>[e.object.id!,e]));
  const parents=new Map<string,Set<string>>(),children=new Map<string,Set<string>>();
  for(const id of byId.keys()){parents.set(id,new Set());children.set(id,new Set());}
  const edge=(source:string,target:string)=>{
    if(!byId.has(source)||!byId.has(target))throw new Error('binding dependency references a missing object');
    parents.get(target)!.add(source);children.get(source)!.add(target);
  };
  for(const {object:o} of entries){
    if(o.parentId)edge(o.parentId,o.id!);
    if('attachTo' in o&&o.attachTo)edge(o.attachTo.character,o.id!);
  }
  for(const b of Object.values(spec.bindings??{}))if(b.enabled!==false)edge(b.source.objectId,b.target.objectId);
  const queue=[...byId.keys()].filter(id=>!parents.get(id)!.size),order:string[]=[];
  for(let i=0;i<queue.length;i++){
    const id=queue[i];order.push(id);
    for(const child of children.get(id)!){parents.get(child)!.delete(id);if(!parents.get(child)!.size)queue.push(child);}
  }
  if(order.length!==byId.size)throw new Error('binding dependencies contain a cycle (including object parenting)');
  return order;
}

export function validateBindings(spec:SceneSpec):string|null {
  if(spec.bindings===undefined)return null;
  if(!spec.bindings||typeof spec.bindings!=='object'||Array.isArray(spec.bindings))return 'bindings must be a registry';
  const entries=bindingObjects(spec),byId=new Map(entries.map(e=>[e.object.id,e])),owners=new Set<string>();
  const ref=(value:unknown)=>{
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['objectId','anchorId'].includes(k)))return false;
    const r=value as AnchorRef;
    return typeof r.objectId==='string'&&anchorIdValid(r.anchorId)&&Object.hasOwn(byId.get(r.objectId)?.object.anchors??{},r.anchorId);
  };
  for(const [id,b] of Object.entries(spec.bindings)){
    if(!anchorIdValid(id))return 'invalid binding id';
    if(!b||typeof b!=='object'||Array.isArray(b)||!['position','orientation'].includes(b.type))return `binding '${id}': invalid type`;
    const fields=['type','name','source','target','enabled','motion',...(b.type==='position'?['offset','offsetSpace']:['twist'])];
    if(Object.keys(b).some(k=>!fields.includes(k))||b.name!==undefined&&typeof b.name!=='string'||b.enabled!==undefined&&typeof b.enabled!=='boolean')return `binding '${id}': invalid fields`;
    if(!ref(b.source)||!ref(b.target))return `binding '${id}': missing object or anchor reference`;
    const target=byId.get(b.target.objectId)!;
    if(target.object.anchors![b.target.anchorId].kind==='surface')return `binding '${id}': target must be a local anchor`;
    if(target.kind==='character'||'physics' in target.object&&target.object.physics)return `binding '${id}': target must be a rigid non-physics object`;
    if(b.type==='position'&&(b.offset!==undefined&&!spatialVector(b.offset)||b.offsetSpace!==undefined&&!['world','source'].includes(b.offsetSpace)))return `binding '${id}': invalid position offset`;
    if(b.type==='orientation'&&b.twist!==undefined&&(!Number.isFinite(b.twist)||typeof b.twist!=='number'))return `binding '${id}': twist must be finite degrees`;
    if(b.motion!==undefined&&(!b.motion||typeof b.motion!=='object'||Array.isArray(b.motion)||Object.keys(b.motion).some(k=>k!=='referenceTimeS')||!Number.isFinite(b.motion.referenceTimeS)||b.motion.referenceTimeS<0||b.motion.referenceTimeS>spec.durationUs/1e6))return `binding '${id}': invalid motion referenceTimeS`;
    if(b.enabled===false)continue;
    // A rigid binding pass runs after character mixers/gaze. Do not move a rig
    // afterward and silently give attached surface anchors the wrong pose.
    for(const character of spec.characters??[]){
      let parent=character.parentId;
      while(parent){if(parent===b.target.objectId)return `binding '${id}': a target group cannot contain characters`;parent=byId.get(parent)?.object.parentId;}
    }
    const owner=`${b.target.objectId}:${b.type}`;
    if(owners.has(owner))return `binding '${id}': multiple writers for ${b.type} of '${b.target.objectId}'`;
    owners.add(owner);
    const o=target.object as SceneTransform;
    const values=b.type==='position'?[o.position?.x,o.position?.y,o.position?.z,...['x','y','z'].map(a=>o.animation?.channels?.[`position.${a}` as 'position.x'])]:
      [o.rotationX,o.rotationY,o.rotationZ,...['rotationX','rotationY','rotationZ'].map(a=>o.animation?.channels?.[a as 'rotationX'])];
    if(!b.motion&&values.some(v=>Array.isArray(v)||isCurveBinding(v)))return `binding '${id}': authored animation requires explicit motion.referenceTimeS`;
  }
  try {bindingOrder(spec);}catch(e){return (e as Error).message;}
  return null;
}
