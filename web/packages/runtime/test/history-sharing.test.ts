import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryTree, TsEngineAdapter } from '../dist/index.js';
const actor = {kind:'user' as const,peerId:'test',name:'Tester'};
function document(spec: string) {
  const engine = new TsEngineAdapter('History',320,180,30,1);
  engine.apply({type:'addAsset',kind:'image',name:'Scene',src:'scene://test',width:320,height:180,durationUs:1_000_000,spec});
  return engine.document();
}
const one=JSON.stringify({version:1,durationUs:1_000_000,label:'黄鹤楼'.repeat(1000)}),two=JSON.stringify({version:1,durationUs:1_000_000,label:'屋面'.repeat(1000)});

test('compact history round-trips every branch, command and document, and reads legacy data',()=>{
  const tree=new HistoryTree(document(one),actor),assetId=tree.head.snapshot.assets[0].id;
  tree.record({type:'setAssetSpec',assetId,spec:two},document(two),actor,'Second');
  const branch=tree.head.id;tree.undo();
  tree.record({type:'batch',commands:[{type:'setAssetSpec',assetId,spec:one}]},document(one),actor,'Other branch');
  const legacy=tree.serialize(),packed=tree.serializeCompact();
  assert.equal(packed.specs.length,2);assert.ok(JSON.stringify(packed).length<JSON.stringify(legacy).length/2);
  for(const input of [legacy,packed]){
    const restored=HistoryTree.deserialize(JSON.parse(JSON.stringify(input)));
    assert.deepEqual(JSON.parse(JSON.stringify(restored.serialize())),JSON.parse(JSON.stringify(legacy)));
    assert.deepEqual(restored.jumpTo(branch),document(two));
    assert.deepEqual(restored.undo(),document(one));
    assert.deepEqual(restored.redo(),document(one)); // newest branch
  }
  assert.deepEqual(tree.serialize(),legacy); // packing never changes public snapshots
});
test('history rejects broken references and future encodings; mutations of caller commands stay outside history',()=>{
  const tree=new HistoryTree(document(one),actor),assetId=tree.head.snapshot.assets[0].id;
  const command={type:'setAssetSpec' as const,assetId,spec:two};
  tree.record(command,document(two),actor,'Change');command.spec='{}';
  assert.equal((tree.head.command as any).spec,two);
  const packed=tree.serializeCompact();
  const bad:any=structuredClone(packed);bad.nodes[0].snapshot.assets[0].spec={specRef:500};
  assert.throws(()=>HistoryTree.deserialize(bad),/spec reference/);
  assert.throws(()=>HistoryTree.deserialize({...packed,historyEncoding:'future'} as any),/unsupported/);
  assert.throws(()=>HistoryTree.deserialize({...packed,specs:[42]} as any),/spec table/);
  assert.throws(()=>HistoryTree.deserialize({...packed,rootId:'absent'}),/root/);
  const input=JSON.parse(JSON.stringify(packed)),restored=HistoryTree.deserialize(input);
  input.nodes[1].actor.name='Modified caller';input.nodes[1].command.assetId='changed';
  assert.equal(restored.head.actor.name,'Tester');assert.equal((restored.head.command as any).assetId,assetId);
});
test('pruning and rebasing release unused interned specs while preserving the retained branch',()=>{
  const tree=new HistoryTree(document(one),actor);
  for(let i=0;i<410;i++)tree.record(null,document(JSON.stringify({step:i})),actor,'Step');
  assert.equal(tree.all().length,400);
  // Memory ownership invariant: the pool must not retain pruned documents.
  assert.equal((tree as any).specPool.size,tree.serializeCompact().specs.length);
  tree.rebaseHead(document(two));
  assert.equal((tree as any).specPool.size,tree.serializeCompact().specs.length);
  const restored=HistoryTree.deserialize(JSON.parse(JSON.stringify(tree.serializeCompact())));
  assert.deepEqual(restored.head.snapshot,document(two));assert.equal(restored.all().length,400);
});
