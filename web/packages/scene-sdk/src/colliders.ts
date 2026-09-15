import type * as THREE from 'three';
import type {SceneProp,SceneSpec} from './types.ts';
import {colliderDefinitions,type SceneCollider} from './collider-spec.ts';
type Rapier=typeof import('@dimforge/rapier3d-compat');

export interface ColliderInfo {
  objectId:string;colliderId:string;definition:SceneCollider;
  effectiveShape:'box'|'sphere'|'cylinder'|'cone'|'convexHull'|'mesh';
  vertexCount:number;triangleCount:number;warning?:string;mass:number;
}
export interface ColliderBodyInfo {
  objectId:string;bodyType:'dynamic'|'fixed'|'kinematic';automatic:boolean;mass:number;colliders:ColliderInfo[];
}
export interface ColliderInspector {
  bodies:ColliderBodyInfo[];
  /** Actual Rapier debug edges in body-local meters, with object scale baked in. */
  lines(objectId:string,colliderId:string):Float32Array;
}
export type ResolvedCollider=Omit<ColliderInfo,'mass'> & {desc:InstanceType<Rapier['ColliderDesc']>};

/** Shared by the bake, inspection and wireframe. Never approximates a requested
 * mesh with a hull. Child authored objects belong to their own collider owners. */
export function resolveColliders(R:Rapier,T:typeof THREE,spec:SceneSpec,p:SceneProp,root:THREE.Object3D,authoredRoots:ReadonlySet<THREE.Object3D>,onlyId?:string):ResolvedCollider[] {
  const scale=typeof p.scale==='number'?[p.scale,p.scale,p.scale]:[p.scale?.x??1,p.scale?.y??1,p.scale?.z??1];
  const [sx,sy,sz]=scale,uniform=sx===sy&&sy===sz;
  const physics=typeof p.physics==='string'?{type:p.physics}:p.physics!;
  root.updateWorldMatrix(true,true);
  const inverse=root.matrixWorld.clone().invert();
  function meshData(geometryId?:string) {
    const positions:number[]=[],indices:number[]=[];
    if(geometryId){
      const g=spec.geometries?.[geometryId];if(!g)throw Error(`collider geometry '${geometryId}' was not resolved`);
      for(const v of g.vertices)positions.push(...v);for(const f of g.faces)indices.push(...f);
    }else{
      const visit=(node:THREE.Object3D)=>{
        if(node!==root&&authoredRoots.has(node))return;
        const g=(node as THREE.Mesh).geometry,pos=g?.getAttribute('position');
        if(pos){
          const count=g.index?.count??pos.count,start=g.drawRange.start,end=Math.min(count,start+g.drawRange.count);
          if(start%3||end%3)throw Error('collider mesh draw range must contain complete triangles');
          const offset=positions.length/3,m=inverse.clone().multiply(node.matrixWorld),v=new T.Vector3();
          for(let i=0;i<pos.count;i++){v.fromBufferAttribute(pos,i).applyMatrix4(m);positions.push(v.x,v.y,v.z);}
          for(let i=start;i<end;i++)indices.push(offset+(g.index?.getX(i)??i));
        }
        node.children.forEach(visit);
      };visit(root);
    }
    return {positions,indices};
  }
  const definitions=colliderDefinitions(p),entries: Array<[string,SceneCollider]>=onlyId===undefined?Object.entries(definitions):Object.hasOwn(definitions,onlyId)?[[onlyId,definitions[onlyId]]]:[];
  return entries.map(([colliderId,definition])=>{
    let shape=definition.shape,geometryId='geometryId' in definition?definition.geometryId:undefined;
    let effectiveShape:ColliderInfo['effectiveShape'],desc:ResolvedCollider['desc']|null=null,vertexCount=0,triangleCount=0;
    let data:{positions:number[];indices:number[]}|undefined;
    const rotation='rotation' in definition?definition.rotation:undefined;
    const position='position' in definition?definition.position:undefined;
    const q=new T.Quaternion().setFromEuler(new T.Euler(...(rotation??[0,0,0]).map(v=>v*Math.PI/180) as [number,number,number],'XYZ'));
    const offset=new T.Vector3(...(position??[0,0,0]));
    if(shape==='auto'){
      if(p.model==='prop/cube'){effectiveShape='box';desc=R.ColliderDesc.cuboid(.5*sx,.5*sy,.5*sz);}
      else if(p.model==='prop/sphere'&&uniform){effectiveShape='sphere';desc=R.ColliderDesc.ball(.5*sx);}
      else if(p.model==='prop/pillar'&&sx===sz){effectiveShape='cylinder';desc=R.ColliderDesc.cylinder(sy,.3*sx);}
      else if(p.model==='prop/cone'&&sx===sz){effectiveShape='cone';desc=R.ColliderDesc.cone(.5*sy,.5*sx);}
      else shape=physics.type==='dynamic'?'convexHull':'mesh';
    }else if(shape==='sphere'){
      if(!uniform)throw Error('sphere collider requires uniform object scale');
      desc=R.ColliderDesc.ball((definition as Extract<SceneCollider,{shape:'sphere'}>).radius*sx);effectiveShape='sphere';
    }else if(shape==='box'){
      const h=(definition as Extract<SceneCollider,{shape:'box'}>).halfExtents;
      if(uniform||!rotation?.some(v=>v!==0)){desc=R.ColliderDesc.cuboid(h[0]*sx,h[1]*sy,h[2]*sz);effectiveShape='box';}
      else {
        // A rotated box under nonuniform scale is a parallelepiped. Its exact
        // convex hull preserves that shear instead of applying a wrong box.
        data={positions:[],indices:[]};for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1])data.positions.push(x*h[0],y*h[1],z*h[2]);
        shape='convexHull';
      }
    }
    if(!desc){
      data??=meshData(geometryId);
      const v=new T.Vector3(),points=new Float32Array(data.positions.length);
      for(let i=0;i<points.length;i+=3){v.fromArray(data.positions,i).applyQuaternion(q).add(offset);points[i]=v.x*sx;points[i+1]=v.y*sy;points[i+2]=v.z*sz;}
      if(!points.length||!points.every(Number.isFinite))throw Error(`collider '${p.id}:${colliderId}' has invalid collision vertices`);
      if(shape==='mesh'){
        if(physics.type==='dynamic')throw Error('dynamic triangle mesh colliders are not supported; use convex parts');
        if(!data.indices.length)throw Error('mesh collider requires triangles');
        desc=R.ColliderDesc.trimesh(points,new Uint32Array(data.indices));effectiveShape='mesh';
      }else {desc=R.ColliderDesc.convexHull(points);effectiveShape='convexHull';}
      if(!desc)throw Error(`collider '${p.id}:${colliderId}' has no non-degenerate collision geometry`);
      // Hull counts describe the actual convex hull, not the visual input mesh.
      const actual=desc.shape as import('@dimforge/rapier3d-compat').ConvexPolyhedron;
      vertexCount=actual.vertices.length/3;triangleCount=(actual.indices?.length??0)/3;
    }else desc.setTranslation(offset.x*sx,offset.y*sy,offset.z*sz).setRotation(q);
    return {objectId:p.id!,colliderId,definition:structuredClone(definition),desc,effectiveShape:effectiveShape!,vertexCount,triangleCount,
      warning:effectiveShape! ==='convexHull'&&definition.shape!=='box'?'Convex hull fills holes and concavities.':undefined};
  });
}

/** Allocated only while a user enables inspection; never enters shot exports. */
export function createColliderOverlay(stage:import('./stage.ts').Stage,objectId?:string) {
  const T=stage.three,root=new T.Group();root.name='__velocut_colliders';
  const material=new T.LineBasicMaterial({color:'#43e6d1',depthTest:false,transparent:true,opacity:.85});
  const entries:Array<{owner:THREE.Object3D;lines:THREE.LineSegments}>=[];
  try{
    for(const body of stage.colliderInspector?.bodies??[]){
      if(objectId&&body.objectId!==objectId)continue;
      const owner=stage.props.find(p=>p.spec.id===body.objectId)!.root;
      for(const c of body.colliders){
        const points=stage.colliderInspector!.lines(body.objectId,c.colliderId);
        const geometry=new T.BufferGeometry().setAttribute('position',new T.BufferAttribute(points,3));
        const lines=new T.LineSegments(geometry,material);lines.renderOrder=1000;lines.frustumCulled=false;
        root.add(lines);entries.push({owner,lines});
      }
    }
  }catch(error){for(const e of entries)e.lines.geometry.dispose();material.dispose();throw error;}
  return {root,update(){for(const {owner,lines} of entries){lines.position.copy(owner.position);lines.quaternion.copy(owner.quaternion);}},
    dispose(){root.removeFromParent();for(const {lines} of entries)lines.geometry.dispose();material.dispose();root.clear();}};
}
