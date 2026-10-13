import {test}from'node:test';import assert from'node:assert/strict';
import{summarize,compareReports}from'./media-benchmark-stats.mjs';
const report=values=>({status:'complete',comparability:{browser:'fixed',recipe:'fixed'},scenarios:[{id:'seek',metrics:{latencyMs:summarize(values)}}]});
test('nearest-rank percentiles retain raw observations and reject invalid samples',()=>{
 const s=summarize([8,1,2,3,4]);assert.deepEqual([s.p50,s.p95,s.max],[3,8,8]);assert.deepEqual(s.samples,[8,1,2,3,4]);
 for(const values of [[],[NaN],[Infinity],[-1]])assert.throws(()=>summarize(values));
});
test('comparison detects material p95 regressions without failing on sub-millisecond noise',()=>{
 assert.equal(compareReports(report([100,130,160]),report([100,100,100])).regressions.length,1);
 assert.equal(compareReports(report([1,2,3]),report([1,1,1])).regressions.length,0);
});
test('incompatible machines, missing metrics and partial runs cannot produce a green comparison',()=>{
 const a=report([1]),b=report([1]);b.comparability.browser='other';assert.throws(()=>compareReports(a,b),/environments/);
 b.comparability=a.comparability;b.status='partial';assert.throws(()=>compareReports(a,b),/incomplete/);
 b.status='complete';a.scenarios=[];assert.throws(()=>compareReports(a,b),/missing/);
});
test('single setup observations stay diagnostic and serialized key order is immaterial',()=>{
 const a=report([900]),b=report([100]);a.comparability={recipe:'fixed',browser:'fixed'};
 const result=compareReports(a,b);assert.equal(result.regressions.length,0);assert.equal(result.changes[0].compared,false);
});
