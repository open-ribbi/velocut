import type {Stage} from './stage.ts';
import type {SceneSpec,SceneTransform} from './types.ts';
import {bindingOrder,type SceneBinding,type BindingStatus} from './bindings.ts';
import {createSpatialContext} from './spatial.ts';
import {sampleObjectTransform} from './animation.ts';
import {objectIsVisible} from './visual.ts';

class SuspendedBinding extends Error {}

/** Export/shot capture must not silently deliver visible fallback geometry. */
export function assertRenderableBindings(stage:Stage, included?:Set<object>) {
  const failed=stage.bindingStatuses?.filter(s=>s.status==='invalid'||s.status==='suspended')??[];
  if(!failed.length)return;
  const objects=new Map([...stage.groups,...stage.props,...stage.lights].map(e=>[e.spec.id!,e.root]));
  for(const status of failed){
    const root=objects.get(status.targetId);if(!root||included&&!included.has(root))continue;
    let visible=false;
    root.traverse(node=>{if(('isMesh' in node||'isLight' in node)&&objectIsVisible(node))visible=true;});
    if(visible)throw new Error(`binding '${status.id}' is ${status.status}: ${status.message}; repair or disable it before rendering/export`);
  }
}

/** A deterministic one-way pass. It owns derived root transforms only; the
 * authored scene, curves and manual offsets are never rewritten by playback. */
export function createBindingEvaluator(stage:Stage,spec:SceneSpec) {
  const T=stage.three,spatial=createSpatialContext(stage),order=bindingOrder(spec);
  const statuses:BindingStatus[]=Object.entries(spec.bindings??{}).map(([id,b])=>({id,targetId:b.target.objectId,status:b.enabled===false?'disabled':'valid'}));
  const byTarget=new Map<string,Array<{id:string;binding:SceneBinding;state:BindingStatus}>>();
  statuses.forEach(state=>{
    const binding=spec.bindings![state.id];if(binding.enabled===false)return;
    const entries=byTarget.get(binding.target.objectId)??[];entries.push({id:state.id,binding,state});byTarget.set(binding.target.objectId,entries);
  });
  for(const entries of byTarget.values())entries.sort((a,b)=>(a.binding.type==='orientation'?0:1)-(b.binding.type==='orientation'?0:1));
  const props=new Map(stage.props.map(p=>[p.spec.id!,p]));
  const invalidObjects=new Set<string>();
  const references=new Map<string,{spec:SceneTransform;position:InstanceType<typeof T.Vector3>;rotation:InstanceType<typeof T.Quaternion>}>();
  const refPose=(id:string,b:SceneBinding)=>{
    const o=spatial.find(b.target.objectId).spec,old=references.get(id);if(old?.spec===o)return old;
    const prop=props.get(b.target.objectId),sample=sampleObjectTransform(o,b.motion!.referenceTimeS,spec,prop?(prop.attachComp==null ? .5 : 0):0);
    const position=new T.Vector3(...sample.position).multiplyScalar(prop?.attachComp??1);
    const rotation=new T.Quaternion().setFromEuler(new T.Euler(...sample.rotation.map(v=>v*Math.PI/180) as [number,number,number],'XYZ'));
    const value={spec:o,position,rotation};references.set(id,value);return value;
  };
  const originalPosition=new T.Vector3(),originalRotation=new T.Quaternion();
  const inverse=new T.Matrix4(),linear=new T.Matrix3(),normalMatrix=new T.Matrix3();
  const n=new T.Vector3(),tangent=new T.Vector3(),bitangent=new T.Vector3(),targetN=new T.Vector3(),targetT=new T.Vector3();
  const desired=new T.Vector3(),delta=new T.Vector3(),localPoint=new T.Vector3();
  const basis=new T.Matrix4(),targetBasis=new T.Matrix4(),rotation=new T.Quaternion(),deltaRotation=new T.Quaternion();
  const finite=(v:{x:number;y:number;z:number})=>[v.x,v.y,v.z].every(Number.isFinite);
  const basisQuaternion=(normal:InstanceType<typeof T.Vector3>,direction:InstanceType<typeof T.Vector3>,matrix:InstanceType<typeof T.Matrix4>)=>{
    normal.normalize();direction.addScaledVector(normal,-direction.dot(normal)).normalize();
    if(!normal.lengthSq()||!direction.lengthSq()||!finite(normal)||!finite(direction))throw new SuspendedBinding('anchor frame is collapsed');
    bitangent.crossVectors(normal,direction);matrix.makeBasis(direction,bitangent,normal);
  };
  function evaluate(timeS:number) {
    invalidObjects.clear();spatial.reset();
    for(const objectId of order){
      const entry=spatial.find(objectId),object=entry.spec,root=entry.root,bindings=byTarget.get(objectId)??[];
      const parentId=object.parentId??('attachTo' in object?object.attachTo?.character:undefined);
      if(parentId&&invalidObjects.has(parentId)){
        invalidObjects.add(objectId);bindings.forEach(({state})=>{state.status='invalid';state.message='parent binding is invalid or suspended';});continue;
      }
      if(!bindings.length)continue;
      originalPosition.copy(root.position);originalRotation.copy(root.quaternion);
      try{
        root.parent!.updateWorldMatrix(true,false);
        const parent=root.parent!.matrixWorld,determinant=parent.determinant();
        if(!Number.isFinite(determinant)||determinant===0)throw new SuspendedBinding('target parent transform is singular');
        inverse.copy(parent).invert();linear.setFromMatrix4(inverse);normalMatrix.setFromMatrix4(parent).transpose();
        for(const {id,binding:b,state} of bindings){
          if(invalidObjects.has(b.source.objectId))throw new Error('source binding is invalid or suspended');
          const source=spatial.anchor(b.source.objectId,b.source.anchorId);
          if(source.status==='invalid')throw new Error(source.message);
          const anchor=object.anchors![b.target.anchorId];if(anchor.kind==='surface')throw new Error('target anchor must be local');
          if(b.type==='orientation'){
            if(!source.frameValid||!source.normal||!source.tangent)throw new SuspendedBinding('source anchor frame is collapsed');
            if([root.scale.x,root.scale.y,root.scale.z].some(v=>v===0))throw new SuspendedBinding('target scale is zero');
            n.set(...source.normal);tangent.set(...source.tangent);
            if(b.twist)tangent.applyAxisAngle(n,b.twist*Math.PI/180);
            n.applyMatrix3(normalMatrix);tangent.applyMatrix3(linear);basisQuaternion(n,tangent,basis);
            targetN.set(...(anchor.normal??[0,1,0])).normalize();
            targetT.set(...(anchor.tangent??(Math.abs(targetN.x)>.9?[0,0,1]:[1,0,0])));
            targetT.addScaledVector(targetN,-targetT.dot(targetN)).normalize();
            targetN.divide(root.scale);targetT.multiply(root.scale);basisQuaternion(targetN,targetT,targetBasis);
            rotation.setFromRotationMatrix(basis).multiply(deltaRotation.setFromRotationMatrix(targetBasis).invert());
            if(b.motion)rotation.multiply(deltaRotation.copy(refPose(id,b).rotation).invert().multiply(originalRotation));
            root.quaternion.copy(rotation);
          }else{
            desired.set(...source.position!);
            delta.set(...(b.offset??[0,0,0]));
            if(b.offsetSpace==='source'){
              if(!source.frameValid||!source.normal||!source.tangent||!source.bitangent)throw new SuspendedBinding('source offset frame is collapsed');
              desired.addScaledVector(tangent.set(...source.tangent),delta.x).addScaledVector(bitangent.set(...source.bitangent),delta.y).addScaledVector(n.set(...source.normal),delta.z);
            }else desired.add(delta);
            localPoint.set(...anchor.position).multiply(root.scale).applyQuaternion(root.quaternion);
            root.position.copy(desired.applyMatrix4(inverse)).sub(localPoint);
            if(b.motion)root.position.add(delta.copy(originalPosition).sub(refPose(id,b).position));
          }
          if(!finite(root.position)||![root.quaternion.x,root.quaternion.y,root.quaternion.z,root.quaternion.w].every(Number.isFinite))throw new Error('binding result is not finite');
          state.status='valid';delete state.message;
        }
      }catch(error){
        // No stale last-good matrix and no partially applied object solve.
        root.position.copy(originalPosition);root.quaternion.copy(originalRotation);invalidObjects.add(objectId);
        bindings.forEach(({state})=>{state.status=error instanceof SuspendedBinding?'suspended':'invalid';state.message=error instanceof Error?error.message:String(error);});
      }
      root.updateWorldMatrix(false,true);
    }
  }
  return {evaluate,statuses,invalidObjects};
}
