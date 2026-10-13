import {isDeepStrictEqual} from 'node:util';
export function summarize(values) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) throw Error('Benchmark samples must be finite, nonnegative and nonempty');
  const sorted=[...values].sort((a,b)=>a-b),percentile=p=>sorted[Math.max(0,Math.ceil(p*sorted.length)-1)];
  return {samples:values,count:values.length,min:sorted[0],p50:percentile(.5),p95:percentile(.95),max:sorted.at(-1)};
}
export function compareReports(current, baseline, {ratio=1.3,floorMs=5}={}) {
  if(!(ratio>1)||!Number.isFinite(ratio)||!(floorMs>=0)||!Number.isFinite(floorMs))throw Error('Invalid regression threshold');
  if(current.status!=='complete'||baseline.status!=='complete')throw Error('Cannot compare incomplete benchmark reports');
  if(!isDeepStrictEqual(current.comparability,baseline.comparability))throw Error('Benchmark environments, recipes or input fixtures differ; collect a matching baseline');
  const changes=[];
  const seen=new Set();
  for(const scenario of current.scenarios)for(const [metric,summary]of Object.entries(scenario.metrics)){
    const key=scenario.id+'.'+metric;seen.add(key);
    const previous=baseline.scenarios.find(item=>item.id===scenario.id)?.metrics[metric];
    if(!previous)throw Error('Baseline metric missing: '+key);
    const before=summarize(previous.samples).p95,after=summarize(summary.samples).p95;
    if(!Number.isFinite(before)||!Number.isFinite(after))throw Error('Invalid benchmark percentile');
    const compared=summary.samples.length>=3&&previous.samples.length>=3;
    changes.push({metric:key,beforeP95:before,afterP95:after,ratio:before?after/before:null,compared,regressed:compared&&after>Math.max(before*ratio,before+floorMs)});
  }
  for(const scenario of baseline.scenarios)for(const metric of Object.keys(scenario.metrics))if(!seen.has(scenario.id+'.'+metric))throw Error('Current metric missing: '+scenario.id+'.'+metric);
  return {ratioThreshold:ratio,absoluteFloorMs:floorMs,regressions:changes.filter(change=>change.regressed),changes};
}
