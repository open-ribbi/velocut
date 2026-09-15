import type * as THREE from 'three';
import type {Stage} from './stage.ts';
import {spatialVector, anchorIdValid, type LocalAnchor, type SurfaceAnchor, type SpatialVector} from './anchors.ts';
import {objectIsVisible} from './visual.ts';
import {surfaceReference, surfaceReferenceError, surfaceReferenceScopeError} from './surface-references.ts';

export type SpatialPoint = {position: SpatialVector; objectId?: string} | {objectId: string; anchorId: string};
export type SceneSpatialQuery =
  | {type:'anchorRepair';objectId:string;anchorId:string;method:'face';ray?:never}
  | {type:'anchorRepair';objectId:string;anchorId:string;method:'raycast';ray:{origin:SpatialVector;direction:SpatialVector;maxDistance?:number;includeHidden?:boolean}}
  | {type:'bindings'; ids?:string[]}
  | {type:'anchors'; objectId:string; anchorIds?:string[];status?:'valid'|'invalid'}
  | {type:'raycast'; origin:SpatialVector; direction:SpatialVector; objectIds?:string[]; maxDistance?:number; includeHidden?:boolean}
  | {type:'surface'; objectId:string; meshPath?:number[]; triangleIndex:number; barycentric:SpatialVector}
  | {type:'distance'; from:SpatialPoint; to:SpatialPoint}
  | {type:'angle'; a:SpatialPoint; vertex:SpatialPoint; b:SpatialPoint};

const vectorSchema={type:'array',items:{type:'number'},minItems:3,maxItems:3};
const idSchema={type:'string',minLength:1};
const idsSchema={type:'array',items:idSchema,minItems:1,uniqueItems:true};
const objectSchema=(required:string[],properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required,properties});
const pointSchema={oneOf:[objectSchema(['position'],{position:vectorSchema,objectId:idSchema}),objectSchema(['objectId','anchorId'],{objectId:idSchema,anchorId:idSchema})]};
export const SCENE_SPATIAL_SCHEMA=objectSchema(['assetId','queries'],{
  assetId:idSchema,timeS:{type:'number',minimum:0},expectedRevision:{type:'integer',minimum:0},
  queries:{type:'array',minItems:1,items:{oneOf:[
    objectSchema(['type','objectId','anchorId','method'],{type:{const:'anchorRepair'},objectId:idSchema,anchorId:idSchema,method:{const:'face'}}),
    objectSchema(['type','objectId','anchorId','method','ray'],{type:{const:'anchorRepair'},objectId:idSchema,anchorId:idSchema,method:{const:'raycast'},ray:objectSchema(['origin','direction'],{origin:vectorSchema,direction:vectorSchema,maxDistance:{type:'number',minimum:0},includeHidden:{type:'boolean'}})}),
    objectSchema(['type'],{type:{const:'bindings'},ids:idsSchema}),
    objectSchema(['type','objectId'],{type:{const:'anchors'},objectId:idSchema,anchorIds:idsSchema,status:{enum:['valid','invalid']}}),
    objectSchema(['type','origin','direction'],{type:{const:'raycast'},origin:vectorSchema,direction:vectorSchema,objectIds:idsSchema,maxDistance:{type:'number',minimum:0},includeHidden:{type:'boolean'}}),
    objectSchema(['type','objectId','triangleIndex','barycentric'],{type:{const:'surface'},objectId:idSchema,meshPath:{type:'array',items:{type:'integer',minimum:0}},triangleIndex:{type:'integer',minimum:0},barycentric:{...vectorSchema,items:{type:'number',minimum:0,maximum:1},description:'Weights sum to 1.'}}),
    objectSchema(['type','from','to'],{type:{const:'distance'},from:pointSchema,to:pointSchema}),
    objectSchema(['type','a','vertex','b'],{type:{const:'angle'},a:pointSchema,vertex:pointSchema,b:pointSchema}),
  ]}},
});

function record(value: unknown, keys: string[], label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw new Error(`invalid ${label} fields`);
}
function id(value:unknown, label:string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty ID`);
}
function vector(value:unknown, label:string): asserts value is SpatialVector {
  if (!spatialVector(value)) throw new Error(`${label} must be a finite triple`);
}
function ids(value:unknown, label:string): asserts value is string[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length) throw new Error(`${label} must contain unique IDs`);
  value.forEach(v => id(v,label));
}
function point(value:unknown) {
  record(value,['position','objectId','anchorId'],'point');
  if (value.objectId !== undefined) id(value.objectId,'objectId');
  if (value.anchorId !== undefined) {
    id(value.objectId,'objectId');
    if (!anchorIdValid(value.anchorId) || value.position !== undefined) throw new Error('anchor point needs objectId/anchorId only');
  } else vector(value.position,'position');
}

/** Validate before loading geometry or creating a stage. No scene/count cap. */
export function validateSpatialQueries(value:unknown): asserts value is SceneSpatialQuery[] {
  if (!Array.isArray(value) || !value.length) throw new Error('queries must be a nonempty array');
  for (const query of value) {
    if(query?.type==='anchorRepair'){
      record(query,['type','objectId','anchorId','method','ray'],'anchorRepair query');id(query.objectId,'objectId');
      if(!anchorIdValid(query.anchorId))throw new Error('invalid anchorId');
      if(query.method==='face'){if(query.ray!==undefined)throw new Error('face repair does not accept ray');}
      else if(query.method==='raycast'){record(query.ray,['origin','direction','maxDistance','includeHidden'],'repair ray');validateSpatialQueries([{type:'raycast',...query.ray}]);}
      else throw new Error('anchorRepair method must be face or raycast');
    } else if (query?.type === 'bindings') {
      record(query,['type','ids'],'bindings query');if(query.ids!==undefined)ids(query.ids,'ids');
    } else if (query?.type === 'anchors') {
      record(query,['type','objectId','anchorIds','status'],'anchors query');
      if(query.status!==undefined&&!['valid','invalid'].includes(query.status as string))throw new Error('anchor status must be valid or invalid');id(query.objectId,'objectId');
      if (query.anchorIds !== undefined) ids(query.anchorIds,'anchorIds');
    } else if (query?.type === 'raycast') {
      record(query,['type','origin','direction','objectIds','maxDistance','includeHidden'],'raycast query');
      vector(query.origin,'origin');vector(query.direction,'direction');
      const length = Math.hypot(...query.direction);
      if (!Number.isFinite(length) || !length) throw new Error('ray direction must be nonzero');
      if (query.objectIds !== undefined) ids(query.objectIds,'objectIds');
      if (query.maxDistance !== undefined && (typeof query.maxDistance !== 'number' || !Number.isFinite(query.maxDistance) || query.maxDistance < 0)) throw new Error('maxDistance must be nonnegative meters');
      if (query.includeHidden !== undefined && typeof query.includeHidden !== 'boolean') throw new Error('includeHidden must be boolean');
    } else if (query?.type === 'surface') {
      record(query,['type','objectId','meshPath','triangleIndex','barycentric'],'surface query');id(query.objectId,'objectId');
      if (query.meshPath !== undefined && (!Array.isArray(query.meshPath) || query.meshPath.some(i => !Number.isSafeInteger(i) || i < 0))) throw new Error('meshPath must contain nonnegative child indices');
      if (!Number.isSafeInteger(query.triangleIndex) || (query.triangleIndex as number) < 0) throw new Error('triangleIndex must be nonnegative');
      vector(query.barycentric,'barycentric');
      if (query.barycentric.some(v => v < 0 || v > 1) || Math.abs(query.barycentric.reduce((s,v) => s+v,0)-1) > 1e-6) throw new Error('barycentric weights must be 0..1 and sum to 1');
    } else if (query?.type === 'distance') {
      record(query,['type','from','to'],'distance query');point(query.from);point(query.to);
    } else if (query?.type === 'angle') {
      record(query,['type','a','vertex','b'],'angle query');point(query.a);point(query.vertex);point(query.b);
    } else throw new Error('unknown spatial query type');
  }
}

const tuple = (v:THREE.Vector3): SpatialVector => {
  const result = v.toArray() as SpatialVector;
  if (!result.every(Number.isFinite)) throw new Error('spatial result is not finite');
  return result;
};

/** Operates on one already-posed stage. All results use meters and world space,
 * except explicitly named local data and triangle barycentric coordinates. */
export function createSpatialContext(stage:Stage) {
  const T=stage.three;
  const entries=[...stage.groups,...stage.characters,...stage.props,...stage.lights];
  const byId=new Map(entries.map(e=>[e.spec.id!,e])), authoredRoots=new Set(entries.map(e=>e.root));
  const find=(objectId:string)=>{const e=byId.get(objectId);if(!e)throw new Error(`unknown object '${objectId}'`);return e;};
  stage.scene.updateMatrixWorld(true);
  stage.scene.traverse(node=>{const mesh=node as THREE.SkinnedMesh;if(mesh.isSkinnedMesh)mesh.skeleton.update();});
  const frame=(normal:THREE.Vector3,tangent:THREE.Vector3)=>{
    if (!normal.length() || !Number.isFinite(normal.length())) return {frameValid:false,normal:null,tangent:null,bitangent:null};
    normal.normalize();tangent.addScaledVector(normal,-tangent.dot(normal));
    if (!tangent.length() || !Number.isFinite(tangent.length())) return {frameValid:false,normal:null,tangent:null,bitangent:null};
    tangent.normalize();
    return {frameValid:true,normal:tuple(normal),tangent:tuple(tangent),bitangent:tuple(normal.clone().cross(tangent))};
  };
  const anchorCache=new Map<string,ReturnType<typeof evaluateAnchor>>();
  const reset=()=>{
    anchorCache.clear();stage.scene.updateMatrixWorld(true);
    stage.scene.traverse(node=>{const mesh=node as THREE.SkinnedMesh;if(mesh.isSkinnedMesh)mesh.skeleton.update();});
  };
  function evaluateAnchor(objectId:string,anchorId:string) {
    const e=find(objectId);
    if (!Object.hasOwn(e.spec.anchors??{},anchorId)) throw new Error(`unknown anchor '${objectId}:${anchorId}'`);
    const a=e.spec.anchors![anchorId],kind=a.kind??'local';
    const invalid=(message:string)=>({objectId,anchorId,kind,anchor:a,status:'invalid' as const,message,position:null,normal:null,tangent:null,bitangent:null,frameValid:false,visible:objectIsVisible(e.root)});
    if(stage.invalidBindingObjects?.has(objectId))return invalid('object has an invalid or suspended binding dependency');
    if(a.kind==='surface'){
      try{
        return {objectId,anchorId,kind,anchor:a,status:'valid' as const,message:undefined,...surfaceAnchorFrame(objectId,a)};
      }catch(e){return invalid(e instanceof Error?e.message:String(e));}
    }
    const position=new T.Vector3(...a.position).applyMatrix4(e.root.matrixWorld);
    const normal=new T.Vector3(...(a.normal??[0,1,0])).normalize();
    const tangent=new T.Vector3(...(a.tangent??(Math.abs(normal.x)>.9?[0,0,1]:[1,0,0])));
    tangent.addScaledVector(normal,-tangent.dot(normal)).normalize();
    const orientation=e.root.matrixWorld.determinant()===0 ? frame(new T.Vector3(),tangent) :
      frame(normal.applyMatrix3(new T.Matrix3().getNormalMatrix(e.root.matrixWorld)),tangent.transformDirection(e.root.matrixWorld));
    return {objectId,anchorId,kind,anchor:a,status:'valid' as const,message:undefined,position:tuple(position),...orientation,visible:objectIsVisible(e.root)};
  }
  const anchor=(objectId:string,anchorId:string)=>{
    const key=JSON.stringify([objectId,anchorId]);let value=anchorCache.get(key);
    if(!value){value=evaluateAnchor(objectId,anchorId);anchorCache.set(key,value);}return value;
  };
  const worldPoint=(p:SpatialPoint)=>{
    if ('anchorId' in p) {
      const value=anchor(p.objectId,p.anchorId);if(value.status==='invalid')throw new Error(`invalid anchor '${p.objectId}:${p.anchorId}': ${value.message}`);
      return new T.Vector3(...value.position!);
    }
    if(p.objectId&&stage.invalidBindingObjects?.has(p.objectId))throw new Error(`object '${p.objectId}' has an invalid binding dependency`);
    const v=new T.Vector3(...p.position);if(p.objectId)v.applyMatrix4(find(p.objectId).root.matrixWorld);tuple(v);return v;
  };
  const resolveMesh=(objectId:string,path:number[],own=false)=>{
    let node:THREE.Object3D=find(objectId).root;
    for (const i of path) {if(!node.children[i])throw new Error('meshPath no longer exists; resample the surface');node=node.children[i];if(own&&authoredRoots.has(node))throw new Error('surface attachment crosses an authored object; attach to the mesh owner instead');}
    if (!(node as THREE.Mesh).isMesh || (node as THREE.InstancedMesh).isInstancedMesh) throw new Error('meshPath must resolve to a logical mesh');
    return node as THREE.Mesh;
  };
  const range=(mesh:THREE.Mesh)=>{
    const geometry=mesh.geometry,position=geometry.getAttribute('position');
    if (!position) throw new Error('mesh has no positions');
    const count=geometry.index?.count??position.count;
    if(geometry.drawRange.start%3!==0)throw new Error('mesh drawRange is not aligned to triangles');
    return [geometry.drawRange.start/3,Math.floor(Math.min(count,geometry.drawRange.start+geometry.drawRange.count)/3)] as const;
  };
  const vertexIndices=(mesh:THREE.Mesh,index:number)=>[0,1,2].map(i=>mesh.geometry.index?.getX(index*3+i)??index*3+i);
  const vertices=(mesh:THREE.Mesh,index:number,a:THREE.Vector3,b:THREE.Vector3,c:THREE.Vector3)=>{
    // Reuse vectors in the ray loop; do not allocate arrays per triangle.
    const offset=index*3,attribute=mesh.geometry.index;
    mesh.getVertexPosition(attribute?.getX(offset)??offset,a).applyMatrix4(mesh.matrixWorld);
    mesh.getVertexPosition(attribute?.getX(offset+1)??offset+1,b).applyMatrix4(mesh.matrixWorld);
    mesh.getVertexPosition(attribute?.getX(offset+2)??offset+2,c).applyMatrix4(mesh.matrixWorld);
  };
  const sample=(objectId:string,meshPath:number[],triangleIndex:number,barycentric:SpatialVector,details=true)=>{
    const mesh=resolveMesh(objectId,meshPath),[start,end]=range(mesh);
    if(triangleIndex<start||triangleIndex>=end)throw new Error('triangleIndex is outside the mesh draw range');
    const a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3();
    vertices(mesh,triangleIndex,a,b,c);
    const indices=vertexIndices(mesh,triangleIndex),sum=barycentric.reduce((s,v)=>s+v,0);
    const weights=barycentric.map(v=>v/sum) as SpatialVector;
    const position=a.clone().multiplyScalar(weights[0]).addScaledVector(b,weights[1]).addScaledVector(c,weights[2]);
    const edge=b.clone().sub(a),normal=edge.clone().cross(c.clone().sub(a));
    const orientation=frame(normal,edge),root=find(objectId).root;
    let local:LocalAnchor|null=null;
    if(details&&root.matrixWorld.determinant()!==0){
      const inverse=root.matrixWorld.clone().invert();
      local={position:tuple(position.clone().applyMatrix4(inverse))};
      if(orientation.frameValid){
        const normalMatrix=new T.Matrix3().setFromMatrix4(root.matrixWorld).transpose();
        const localFrame=frame(new T.Vector3(...orientation.normal!).applyMatrix3(normalMatrix),new T.Vector3(...orientation.tangent!).transformDirection(inverse));
        if(localFrame.frameValid){local.normal=localFrame.normal!;local.tangent=localFrame.tangent!;}
      }
    }
    const uv=details?mesh.geometry.getAttribute('uv'):undefined;
    let reference=null;
    if(details){try{resolveMesh(objectId,meshPath,true);reference=surfaceReference(stage,objectId,mesh,meshPath,triangleIndex,weights);}catch{/* Cross-owner handles are read-only samples. */}}
    const coordinates=uv ? [indices.reduce((s,i,k)=>s+uv.getX(i)*weights[k],0),indices.reduce((s,i,k)=>s+uv.getY(i)*weights[k],0)] : null;
    if(coordinates?.some(v=>!Number.isFinite(v)))throw new Error('surface UVs are not finite');
    return {objectId,meshPath:[...meshPath],triangleIndex,vertexIndices:indices,barycentric:weights,position:tuple(position),...orientation,uv:coordinates,local,surfaceAnchor:reference?{kind:'surface' as const,surface:reference}:null,visible:objectIsVisible(mesh)};
  };
  const surfaceAnchorFrame=(objectId:string,a:SurfaceAnchor)=>{
    const mesh=resolveMesh(objectId,a.surface.meshPath,true),root=find(objectId).root;
    const error=surfaceReferenceError(stage,objectId,mesh,a.surface);if(error)throw new Error(error);
    const value=sample(objectId,a.surface.meshPath,a.surface.triangleIndex,a.surface.barycentric,false);
    const orientation=a.tangent&&value.normal ? frame(new T.Vector3(...value.normal),new T.Vector3(...a.tangent).transformDirection(root.matrixWorld)) : value;
    return {position:value.position,normal:orientation.normal,tangent:orientation.tangent,bitangent:orientation.bitangent,frameValid:orientation.frameValid,visible:value.visible};
  };
  const raycast=(q:Extract<SceneSpatialQuery,{type:'raycast'}>)=>{
    const selected=q.objectIds?.map(objectId=>find(objectId).root);
    const allowed=(root:THREE.Object3D)=>!selected||selected.some(target=>{for(let p:THREE.Object3D|null=root;p;p=p.parent)if(p===target)return true;return false;});
    const ray=new T.Ray(new T.Vector3(...q.origin),new T.Vector3(...q.direction).normalize());
    const box=new T.Box3(),a=new T.Vector3(),b=new T.Vector3(),c=new T.Vector3(),hit=new T.Vector3(),weights=new T.Vector3();
    let distance=q.maxDistance??Infinity;
    let nearest:{objectId:string;meshPath:number[];triangleIndex:number;barycentric:SpatialVector}|null=null;
    const visit=(node:THREE.Object3D,path:number[],objectId:string)=>{
      const mesh=node as THREE.Mesh;
      if(mesh.isMesh && !(mesh as THREE.InstancedMesh).isInstancedMesh && (q.includeHidden||objectIsVisible(mesh))){
        const [start,end]=range(mesh);
        // Shared static geometry gets one cached local box. Deformed meshes
        // bypass this coarse test so an animated skin cannot use stale bounds.
        const deformed=(mesh as THREE.SkinnedMesh).isSkinnedMesh||!!mesh.morphTargetInfluences?.length;
        if(!deformed){
          mesh.geometry.boundingBox??=new T.Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
          box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        }
        if(deformed||ray.intersectsBox(box)){
          for(let i=start;i<end;i++){
            vertices(mesh,i,a,b,c);
            if(!ray.intersectTriangle(a,b,c,false,hit))continue;
            const d=ray.origin.distanceTo(hit);
            if(d>distance||(nearest&&d===distance))continue;
            if(!T.Triangle.getBarycoord(hit,a,b,c,weights))continue;
            weights.set(Math.max(0,Math.min(1,weights.x)),Math.max(0,Math.min(1,weights.y)),Math.max(0,Math.min(1,weights.z)));
            distance=d;nearest={objectId,meshPath:[...path],triangleIndex:i,barycentric:tuple(weights)};
          }
        }
      }
      node.children.forEach((child,i)=>{if(!authoredRoots.has(child))visit(child,[...path,i],objectId);});
    };
    for(const e of entries)if(allowed(e.root))visit(e.root,[],e.spec.id!);
    const found=nearest as {objectId:string;meshPath:number[];triangleIndex:number;barycentric:SpatialVector}|null;
    return found ? {...sample(found.objectId,found.meshPath,found.triangleIndex,found.barycentric),distance} : null;
  };
  const repair=(q:Extract<SceneSpatialQuery,{type:'anchorRepair'}>)=>{
    const object=find(q.objectId).spec,current=object.anchors?.[q.anchorId];
    if(!current||current.kind!=='surface')throw new Error('anchorRepair requires an existing surface anchor');
    const currentStatus=anchor(q.objectId,q.anchorId);
    const unavailable=(message:string)=>({status:'unavailable' as const,currentStatus:currentStatus.status,message,candidate:null});
    try{
      if(stage.invalidBindingObjects?.has(q.objectId))return unavailable('repair upstream binding dependencies before sampling this object');
      let reference:SurfaceAnchor|null=null,windingReversed:boolean|null=null,orientationChanged:boolean|null=null;
      if(q.method==='raycast'){
        const hit=raycast({type:'raycast',...q.ray,objectIds:[q.objectId]});
        if(!hit?.surfaceAnchor)return unavailable('repair ray did not hit an attachable surface');
        if(hit.objectId!==q.objectId)return unavailable('repair ray hit a different mesh owner; choose another ray');
        reference=hit.surfaceAnchor;
      }else{
        const r=current.surface,mesh=resolveMesh(q.objectId,r.meshPath,true);
        const error=surfaceReferenceScopeError(stage,q.objectId,mesh,r);if(error)return unavailable(error+'; use an explicit raycast repair');
        const [start,end]=range(mesh);if(r.triangleIndex<start||r.triangleIndex>=end)return unavailable('referenced face no longer exists; use an explicit raycast repair');
        const indices=vertexIndices(mesh,r.triangleIndex),expected=r.vertexIndices??indices;
        if(indices.some(i=>!expected.includes(i)))return unavailable('referenced face no longer uses its original vertices; use an explicit raycast repair');
        const permutation=indices.map(i=>expected.indexOf(i));
        const barycentric=permutation.map(i=>r.barycentric[i]) as SpatialVector;
        let inversions=0;for(let i=0;i<3;i++)for(let j=i+1;j<3;j++)if(permutation[i]>permutation[j])inversions++;
        windingReversed=inversions%2===1;
        orientationChanged=windingReversed||(!current.tangent&&permutation.some((v,i)=>v!==i));
        reference=sample(q.objectId,r.meshPath,r.triangleIndex,barycentric).surfaceAnchor;
      }
      if(!reference)return unavailable('surface reference is unavailable');
      const next:SurfaceAnchor={...structuredClone(current),surface:reference.surface};
      const evaluated=surfaceAnchorFrame(q.objectId,next);
      if(!evaluated.frameValid)return unavailable('candidate frame is collapsed; choose another time, ray or tangent');
      return {status:'candidate' as const,currentStatus:currentStatus.status,message:windingReversed?'face winding reversed; inspect the new normal before committing':orientationChanged?'face order changes the tangent frame; inspect orientation before committing':undefined,
        candidate:{anchor:next,...evaluated,windingReversed,orientationChanged,edit:{type:'anchor.rebind' as const,id:q.objectId,anchorId:q.anchorId,expected:structuredClone(current.surface),surface:structuredClone(next.surface)}}};
    }catch(error){return unavailable(error instanceof Error?error.message:String(error));}
  };
  return {entries,find,anchor,worldPoint,resolveMesh,sample,raycast,repair,reset};
}

export function queryStageSpatial(stage:Stage,queries:SceneSpatialQuery[]){
  validateSpatialQueries(queries);
  const {find,anchor,worldPoint,sample,raycast,repair}=createSpatialContext(stage);
  return queries.map(q=>{
    if(q.type==='anchorRepair')return {type:q.type,objectId:q.objectId,anchorId:q.anchorId,...repair(q)};
    if(q.type==='bindings')return {type:q.type,items:structuredClone((stage.bindingStatuses??[]).filter(b=>!q.ids||q.ids.includes(b.id)))};
    if(q.type==='anchors'){
      const e=find(q.objectId),ids=q.anchorIds??Object.keys(e.spec.anchors??{});
      return {type:q.type,items:ids.map(id=>anchor(q.objectId,id)).filter(a=>!q.status||a.status===q.status).map(a=>structuredClone(a))};
    }
    if(q.type==='surface')return {type:q.type,surface:sample(q.objectId,q.meshPath??[],q.triangleIndex,q.barycentric)};
    if(q.type==='raycast')return {type:q.type,hit:raycast(q)};
    if(q.type==='distance'){
      const from=worldPoint(q.from),to=worldPoint(q.to),delta=to.clone().sub(from),distance=delta.length();
      if(!Number.isFinite(distance))throw new Error('distance is not finite');
      return {type:q.type,from:tuple(from),to:tuple(to),delta:tuple(delta),distance};
    }
    const a=worldPoint(q.a),vertex=worldPoint(q.vertex),b=worldPoint(q.b),u=a.clone().sub(vertex),v=b.clone().sub(vertex);
    if(!u.length()||!v.length()||!Number.isFinite(u.length())||!Number.isFinite(v.length()))throw new Error('angle needs two nonzero finite arms');
    return {type:q.type,a:tuple(a),vertex:tuple(vertex),b:tuple(b),degrees:Math.acos(Math.max(-1,Math.min(1,u.normalize().dot(v.normalize()))))*180/Math.PI};
  });
}
