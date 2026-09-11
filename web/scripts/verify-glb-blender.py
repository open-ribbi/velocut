# Optional independent GLB round-trip check. Run Blender with --background
# --factory-startup --python-exit-code 1 --python this-file -- web/test-results.
import bpy,sys,json,os
from mathutils import Vector
root=sys.argv[sys.argv.index('--')+1]
results=[]
for folder,_,names in os.walk(root):
 for name in names:
  if not name.endswith('.glb'):continue
  path=os.path.join(folder,name)
  bpy.ops.wm.read_factory_settings(use_empty=True)
  bpy.ops.import_scene.gltf(filepath=path)
  bpy.context.view_layer.update()
  bpy.context.scene.frame_set(1)
  objects=list(bpy.context.scene.objects)
  mesh_objects=[o for o in objects if o.type=='MESH']
  assert mesh_objects,path
  graph=bpy.context.evaluated_depsgraph_get();points=[]
  for obj in mesh_objects:
   evaluated=obj.evaluated_get(graph);mesh=evaluated.to_mesh()
   points.extend(evaluated.matrix_world@v.co for v in mesh.vertices)
   evaluated.to_mesh_clear()
  bounds={'min':[min(v[i] for v in points) for i in range(3)],'max':[max(v[i] for v in points) for i in range(3)]}
  expected_path=os.path.join(folder,name[:-4]+'-bounds.json')
  if os.path.exists(expected_path):
   original=json.load(open(expected_path));expected={'min':[original['min'][0],-original['max'][2],original['min'][1]],'max':[original['max'][0],-original['min'][2],original['max'][1]]}
   for key in ('min','max'):
    assert all(abs(a-b)<0.002 for a,b in zip(bounds[key],expected[key])),(name,bounds,expected)
  results.append({'file':name,'meshes':len(mesh_objects),'armatures':sum(o.type=='ARMATURE' for o in objects),'cameras':sum(o.type=='CAMERA' for o in objects),'lights':sum(o.type=='LIGHT' for o in objects),'bounds':bounds})
assert len(results)>=4,results
print('VELOCUT_BLENDER_EXPORT_VERIFIED='+json.dumps(results))
