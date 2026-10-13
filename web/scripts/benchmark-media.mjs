import {chromium} from '@playwright/test';
import {createServer} from 'node:http';
import {createReadStream} from 'node:fs';
import {readFile,writeFile,mkdir,stat,open} from 'node:fs/promises';
import {resolve,dirname,extname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import os from 'node:os';
import {browserOptions} from './browser-options.mjs';
import {runScenario} from './media-benchmark-browser.mjs';
import {summarize,compareReports} from './media-benchmark-stats.mjs';

const {values:args}=parseArgs({options:{
  profile:{type:'string',default:'standard'},samples:{type:'string',default:'5'},out:{type:'string'},
  baseline:{type:'string'},gpu:{type:'string',default:'native'},browser:{type:'string',default:'chromium'},
  ratio:{type:'string',default:'1.3'},'floor-ms':{type:'string',default:'5'},
}});
const samples=Number(args.samples);
if(!['quick','standard'].includes(args.profile)||!Number.isInteger(samples)||samples<3||samples>30)throw Error('Use --profile quick|standard and --samples 3..30');
if(!['native','software'].includes(args.gpu)||!['chromium','chrome'].includes(args.browser))throw Error('Use --gpu native|software and --browser chromium|chrome');
const web=resolve(dirname(fileURLToPath(import.meta.url)),'..'),repo=resolve(web,'..'),root=resolve(web,'apps/editor/dist');
const out=resolve(args.out??resolve(repo,'artifacts/media-benchmark/latest.json'));
const fixtures=resolve(repo,'artifacts/media-benchmark/fixtures-v1');
await mkdir(dirname(out),{recursive:true});await mkdir(fixtures,{recursive:true});
const index=await readFile(resolve(root,'index.html'),'utf8').catch(()=>{throw Error('Build the editor first: npm run build');});
const digest=async file=>{const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');};
const exists=async file=>!!(await stat(file).catch(()=>null));
const audioSeconds=args.profile==='quick'?60:600,audioPath=resolve(fixtures,`tone-${audioSeconds}s.wav`);
if(!await exists(audioPath)){
  const rate=48000,size=audioSeconds*rate*2,header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(size+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(rate,24);header.writeUInt32LE(rate*2,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(size,40);
  const second=Buffer.alloc(rate*2);for(let i=0;i<rate;i++)second.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/rate)*4096),i*2);
  const file=await open(audioPath,'w');try{await file.write(header);for(let i=0;i<audioSeconds;i++)await file.write(second);}finally{await file.close();}
}
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.glb':'model/gltf-binary','.png':'image/png','.svg':'image/svg+xml','.jpg':'image/jpeg','.mp4':'video/mp4','.wav':'audio/wav'};
const server=createServer(async(req,res)=>{
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  try {
    const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    if(path==='/__velocut/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data:{models:[],connections:[]}}));return;}
    const fixtureRoutes={'/fixtures/audio.wav':audioPath,'/fixtures/video4k.mp4':resolve(fixtures,'video4k.mp4'),'/fixtures/video1080.mp4':resolve(fixtures,'video1080.mp4')};
    const file=fixtureRoutes[path]??resolve(root,path==='/'?'index.html':'.'+path);
    if(!fixtureRoutes[path]&&!file.startsWith(root+sep)){res.writeHead(403);res.end();return;}
    const info=await stat(file);if(!info.isFile())throw Error('Not a file');
    res.setHeader('Content-Type',mime[extname(file)]??'application/octet-stream');res.setHeader('Content-Length',info.size);createReadStream(file).pipe(res);
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
let browser;
const git=command=>execFileSync('git',command,{cwd:repo,encoding:'utf8'}).trim();
const report={schemaVersion:1,status:'partial',createdAt:new Date().toISOString(),revision:git(['rev-parse','HEAD']),trackedChanges:!!git(['status','--porcelain','--untracked-files=no']),
  buildIndexSha256:createHash('sha256').update(index).digest('hex'),profile:args.profile,samples,scenarios:[],warnings:[],
  limitations:['Main-thread JS heap excludes worker heaps, native codec surfaces and total GPU memory.','Timer gaps measure event-loop responsiveness. Seek-to-worker-ack includes scheduling/decoding/render submission, not OS presentation latency; dropped counts mean renderer admission drops, not missing display frames.','Scene frame timing covers pose and render submission/VideoFrame creation, not isolated GPU execution.','Single setup/import/build timings are diagnostics, not statistically stable percentiles.','This establishes a baseline for this build; it does not claim an improvement over an unmeasured older build.']};
const recipeFile=fileURLToPath(new URL('./media-benchmark-browser.mjs',import.meta.url));
const recipeSha256=await digest(recipeFile);
const save=()=>writeFile(out,JSON.stringify(report,null,2)+'\n');
const bounded=async(promise,ms)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(`Benchmark operation exceeded ${ms} ms`)),ms))]);}finally{clearTimeout(timer);}};
try {
  browser=await chromium.launch(args.gpu==='software'?{...browserOptions,headless:true,...(args.browser==='chrome'?{channel:'chrome'}:{})}:
    {headless:true,channel:args.browser,args:['--enable-unsafe-webgpu']});
  const browserSession=await browser.newBrowserCDPSession(),gpu=(await browserSession.send('SystemInfo.getInfo')).gpu;
  const environment={platform:process.platform,release:os.release(),cpu:os.cpus()[0]?.model,logicalCpus:os.cpus().length,totalMemoryBytes:os.totalmem(),browser:browser.version(),browserChannel:args.browser,gpuMode:args.gpu,
    glRenderer:gpu.auxAttributes?.glRenderer??null,gpuDevices:gpu.devices.map(device=>({vendorId:device.vendorId,deviceId:device.deviceId,deviceString:device.deviceString,driverVersion:device.driverVersion}))};
  const newPage=async()=>{
    const context=await browser.newContext({viewport:{width:1280,height:800}});await context.route('https://**',route=>route.abort());
    const page=await context.newPage();page.on('console',message=>{if(['warning','error'].includes(message.type())&&message.text().includes('[velocut]')&&report.warnings.length<30)report.warnings.push(message.text());});page.on('pageerror',error=>{if(report.warnings.length<30)report.warnings.push(String(error));});
    await page.goto(url);await page.waitForFunction(()=>window.velocut?.exportFilm,{timeout:30000});
    const adapter=await page.evaluate(async()=>{const gpu=await navigator.gpu?.requestAdapter();return gpu?{vendor:gpu.info?.vendor,architecture:gpu.info?.architecture,description:gpu.info?.description}:null;});
    if(!adapter)throw Error('WebGPU is unavailable; select a supported browser or explicitly use --gpu software');
    if(args.gpu==='native' && /swiftshader|llvmpipe|software/i.test((environment.glRenderer??'')+' '+(adapter.architecture??'')))throw Error('Native GPU requested but a software renderer was selected; explicitly use --gpu software or change browser');
    if(environment.webgpu && JSON.stringify(environment.webgpu)!==JSON.stringify(adapter))throw Error('GPU adapter changed during the benchmark');
    environment.webgpu=adapter;
    return {context,page,adapter};
  };
  // Generate deterministic recipe inputs once; later runs reuse the exact bytes.
  for(const [name,width,height]of[['video4k',3840,2160],['video1080',1920,1080]]){
    const file=resolve(fixtures,name+'.mp4');if(await exists(file))continue;
    console.log(`Generating ${name} fixture (outside timed samples)`);const {context,page}=await newPage();
    try {
      const base64=await bounded(page.evaluate(async({width,height})=>{
        const v=window.velocut,doc=structuredClone(v.doc());Object.assign(doc,{width,height,fpsNum:12,fpsDen:1});v.store.loadDocument(doc);
        const made=await v.motionClip({spec:{version:1,durationUs:2000000,width,height,background:'#26334a',layers:[{type:'rect',x:[{t:0,v:width*.2},{t:2,v:width*.8}],y:height*.5,w:width*.2,h:height*.4,fill:'#e6b774'}]}});if(!made.ok)throw Error(made.message);
        const job=v.exportFilm({videoCodec:'avc'});try{const output=await job.result,bytes=new Uint8Array(await output.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);}finally{await job.releaseOutput();}
      },{width,height}),120000);await writeFile(file,Buffer.from(base64,'base64'));
    }finally{await context.close();}
  }
  const fixtureHashes={video4k:await digest(resolve(fixtures,'video4k.mp4')),video1080:await digest(resolve(fixtures,'video1080.mp4')),audio:await digest(audioPath)};
  report.comparability={environment,profile:args.profile,samples,recipeSha256,fixtureHashes};
  await save();
  for(const id of ['video4k','multitrack','audio','scene']){
    console.log(`Benchmark ${id} (${samples} measured samples + warmup)`);
    const {context,page,adapter}=await newPage(),cdp=await context.newCDPSession(page);
    try {
      await cdp.send('HeapProfiler.collectGarbage');const before=await cdp.send('Runtime.getHeapUsage');
      const scenario=await bounded(page.evaluate(runScenario,{id,profile:args.profile,samples}),args.profile==='standard'?180000:90000);
      await cdp.send('HeapProfiler.collectGarbage');const after=await cdp.send('Runtime.getHeapUsage');
      scenario.metrics=Object.fromEntries(Object.entries(scenario.metrics).map(([name,values])=>[name,summarize(values)]));
      scenario.webgpu=adapter;scenario.mainIsolateHeap={before,after};
      report.scenarios.push(scenario);await save();
      console.log(JSON.stringify({id,p95Ms:Object.fromEntries(Object.entries(scenario.metrics).map(([name,value])=>[name,Math.round(value.p95*100)/100])),maxTimerGapMs:scenario.responsiveness.maxTimerGapMs}));
    }finally{await context.close();}
  }
  if(await digest(recipeFile)!==recipeSha256 || createHash('sha256').update(await readFile(resolve(root,'index.html'))).digest('hex')!==report.buildIndexSha256)throw Error('Build or benchmark recipe changed during the run');
  report.status='complete';
  if(args.baseline){report.comparison=compareReports(report,JSON.parse(await readFile(resolve(args.baseline),'utf8')),{ratio:Number(args.ratio),floorMs:Number(args['floor-ms'])});if(report.comparison.regressions.length)process.exitCode=1;}
  await save();console.log(`Report: ${out}`);
}catch(error){report.error=String(error);await save();console.error(error);process.exitCode=2;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
