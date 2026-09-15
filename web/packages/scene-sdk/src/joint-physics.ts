import type * as THREE from 'three';
import type {SceneSpec} from './types.ts';
import {jointLocalPosition,JOINT_AXES,type JointRuntime,type JointQuaternion} from './joints.ts';
type Rapier=typeof import('@dimforge/rapier3d-compat');

export function createPhysicsJoints(R:Rapier,T:typeof THREE,world:InstanceType<Rapier['World']>,spec:SceneSpec,bodies:Map<string,InstanceType<Rapier['RigidBody']>>):JointRuntime[] {
  const props=new Map((spec.props??[]).map(p=>[p.id,p]));
  const vec=(v:number[])=>({x:v[0],y:v[1],z:v[2]});
  const rot=(r:number[]=[0,0,0])=>new T.Quaternion().setFromEuler(new T.Euler(r[0]*Math.PI/180,r[1]*Math.PI/180,r[2]*Math.PI/180,'XYZ'));
  const tuple=(q:{x:number;y:number;z:number;w:number}):JointQuaternion=>[q.x,q.y,q.z,q.w];
  return Object.entries(spec.joints??{}).map(([id,j])=>{
    const anchorA=jointLocalPosition(props.get(j.a.objectId)!,j.a),anchorB=jointLocalPosition(props.get(j.b.objectId)!,j.b);
    const result:JointRuntime={id,definition:structuredClone(j),anchorA,anchorB,frameA:null,frameB:null};
    if(j.enabled===false)return result;
    const a=vec(anchorA),b=vec(anchorB),axis='axis' in j?new T.Vector3(...j.axis.map(v=>v/Math.hypot(...j.axis)) as [number,number,number]):undefined;
    let data:import('@dimforge/rapier3d-compat').JointData;
    switch(j.type){
      case 'fixed':data=R.JointData.fixed(a,rot(j.rotationA),b,rot(j.rotationB));break;
      case 'spherical':data=R.JointData.spherical(a,b);break;
      case 'revolute':data=R.JointData.revolute(a,b,axis!);break;
      case 'prismatic':data=R.JointData.prismatic(a,b,axis!);break;
      case 'rope':data=R.JointData.rope(j.length,a,b);break;
      case 'spring':data=R.JointData.spring(j.length,j.stiffness,j.damping,a,b);break;
      case 'generic':data=R.JointData.generic(a,b,axis!,j.lockedAxes.reduce<number>((mask,name)=>mask|(1<<JOINT_AXES.indexOf(name)),0));break;
    }
    const joint=world.createImpulseJoint(data,bodies.get(j.a.objectId)!,bodies.get(j.b.objectId)!,true);
    joint.setContactsEnabled(j.contactsEnabled??false);
    result.frameA=tuple(joint.frameX1());result.frameB=tuple(joint.frameX2());
    if(j.type==='revolute'||j.type==='prismatic'){
      const unit=joint as import('@dimforge/rapier3d-compat').UnitImpulseJoint,factor=j.type==='revolute'?Math.PI/180:1;
      if(j.limits)unit.setLimits(j.limits[0]*factor,j.limits[1]*factor);
      const motor=j.motor;
      if(motor){
        unit.configureMotorModel(motor.model==='acceleration'?R.MotorModel.AccelerationBased:R.MotorModel.ForceBased);
        if(motor.mode==='position')unit.configureMotorPosition(motor.targetPosition*factor,motor.stiffness,motor.damping);
        else unit.configureMotorVelocity(motor.targetVelocity*factor,motor.damping);
      }
    }
    return result;
  });
}
