import type {Stage} from './stage.ts';
import type {JointRuntime} from './joints.ts';
export interface JointQuery {ids?:string[];objectIds?:string[];offset?:number;limit?:number}

export function readStageJoints(stage:Stage,q:JointQuery={}) {
  const T=stage.three,all=stage.physicsJoints??[],props=new Map(stage.props.map(p=>[p.spec.id!,p.root]));
  for(const id of q.ids??[])if(!all.some(j=>j.id===id))throw Error(`unknown joint '${id}'`);
  for(const id of q.objectIds??[])if(!props.has(id))throw Error(`unknown physics object '${id}'`);
  const filtered=all.filter(j=>(!q.ids||q.ids.includes(j.id))&&(!q.objectIds||q.objectIds.includes(j.definition.a.objectId)||q.objectIds.includes(j.definition.b.objectId)));
  const offset=q.offset??0,limit=q.limit??256;
  const items=filtered.slice(offset,offset+limit).map(r=>{
    const j=r.definition,a=props.get(j.a.objectId)!,b=props.get(j.b.objectId)!;
    const pa=new T.Vector3(...r.anchorA).applyQuaternion(a.quaternion).add(a.position),pb=new T.Vector3(...r.anchorB).applyQuaternion(b.quaternion).add(b.position),distance=pa.distanceTo(pb);
    const qa=r.frameA?a.quaternion.clone().multiply(new T.Quaternion(...r.frameA)):null,qb=r.frameB?b.quaternion.clone().multiply(new T.Quaternion(...r.frameB)):null;
    const delta=qa?pb.clone().sub(pa).applyQuaternion(qa.clone().invert()):null;
    const relative=qa&&qb?qa.clone().invert().multiply(qb).normalize():null;
    const axisA=qa?new T.Vector3(1,0,0).applyQuaternion(qa):null,axisB=qb?new T.Vector3(1,0,0).applyQuaternion(qb):null;
    const angular=relative?2*Math.acos(Math.min(1,Math.abs(relative.w)))*180/Math.PI:null;
    const axisError=axisA&&axisB?Math.acos(Math.max(-1,Math.min(1,axisA.dot(axisB))))*180/Math.PI:null;
    let coordinate:number|null=null,unit:'meters'|'degrees'|null=null,linearErrorM:number|null=null,angularErrorDeg:number|null=null;
    if(j.enabled!==false){
      if(j.type==='fixed'||j.type==='spherical'||j.type==='revolute')linearErrorM=distance;
      if(j.type==='fixed'||j.type==='prismatic')angularErrorDeg=angular;
      if(j.type==='revolute'&&relative){coordinate=((2*Math.atan2(relative.x,relative.w)*180/Math.PI+180)%360+360)%360-180;unit='degrees';angularErrorDeg=axisError;}
      if(j.type==='prismatic'&&delta){coordinate=delta.x;unit='meters';linearErrorM=Math.hypot(delta.y,delta.z);}
      if(j.type==='spring'||j.type==='rope'){coordinate=distance;unit='meters';if(j.type==='rope')linearErrorM=Math.max(0,distance-j.length);}
      if(j.type==='generic'&&delta)linearErrorM=Math.hypot(...(['x','y','z'] as const).map(k=>j.lockedAxes.includes(k)?delta[k]:0));
    }
    const limitError=coordinate!==null&&'limits' in j&&j.limits?Math.max(0,j.limits[0]-coordinate,coordinate-j.limits[1]):null;
    return {id:r.id,type:j.type,name:j.name,status:j.enabled===false?'disabled' as const:'enabled' as const,a:structuredClone(j.a),b:structuredClone(j.b),
      positionA:pa.toArray(),positionB:pb.toArray(),frameA:qa?.toArray()??null,frameB:qb?.toArray()??null,axisA:'axis' in j?axisA?.toArray()??null:null,axisB:'axis' in j?axisB?.toArray()??null:null,
      anchorDistanceM:distance,relativeTranslation:delta?.toArray()??null,coordinate,unit,linearErrorM,angularErrorDeg,limitError,
      extensionM:j.type==='spring'?distance-j.length:null,contactsEnabled:j.contactsEnabled??false};
  });
  return {engine:stage.physicsVersion?{name:'rapier' as const,version:stage.physicsVersion,solver:'impulse' as const}:null,total:filtered.length,nextOffset:offset+limit<filtered.length?offset+limit:null,items};
}

export function createJointOverlay(stage:Stage,objectId?:string) {
  const T=stage.three,root=new T.Group(),material=new T.LineBasicMaterial({color:'#f8b55b',depthTest:false});root.name='__velocut_joints';
  const props=new Map(stage.props.map(p=>[p.spec.id!,p.root]));
  const entries:Array<{joint:JointRuntime;line:InstanceType<typeof T.LineSegments>}>=[];
  for(const joint of stage.physicsJoints??[]){
    const j=joint.definition;if(j.enabled===false||objectId&&j.a.objectId!==objectId&&j.b.objectId!==objectId)continue;
    const geometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(new Float32Array(18),3));
    const line=new T.LineSegments(geometry,material);line.frustumCulled=false;line.renderOrder=1001;root.add(line);entries.push({joint,line});
  }
  const p=new T.Vector3(),axis=new T.Vector3(),q=new T.Quaternion(),local=new T.Quaternion();
  return {root,update(){
    for(const {joint:r,line} of entries){
      const attr=line.geometry.getAttribute('position');
      for(const [i,id,anchor,frame]of [[0,r.definition.a.objectId,r.anchorA,r.frameA],[1,r.definition.b.objectId,r.anchorB,r.frameB]] as const){
        const body=props.get(id)!;p.fromArray(anchor).applyQuaternion(body.quaternion).add(body.position);
        attr.setXYZ(i,p.x,p.y,p.z);attr.setXYZ(2+i*2,p.x,p.y,p.z);
        q.copy(body.quaternion);if(frame)q.multiply(local.fromArray(frame));axis.set(1,0,0).applyQuaternion(q).multiplyScalar('axis' in r.definition||r.definition.type==='fixed'?.3:0).add(p);
        attr.setXYZ(3+i*2,axis.x,axis.y,axis.z);
      }attr.needsUpdate=true;
    }
  },dispose(){root.removeFromParent();entries.forEach(e=>e.line.geometry.dispose());material.dispose();root.clear();}};
}
