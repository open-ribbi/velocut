import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
const http=createServer((_,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body>Graphics probe</body></html>');});
await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${http.address().port}`;
const presets={
 default:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'],
 warp:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=d3d11-warp'],
 d3d11:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--use-webgpu-adapter=d3d11'],
 swiftshader:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--use-gl=angle','--use-angle=swiftshader','--use-webgpu-adapter=swiftshader'],
 vulkan:['--enable-unsafe-webgpu','--enable-unsafe-swiftshader','--ignore-gpu-blocklist','--use-gl=angle','--enable-features=Vulkan','--use-angle=vulkan','--use-vulkan=swiftshader','--use-webgpu-adapter=swiftshader','--disable-vulkan-surface'],
};
try { for(const [name,args] of Object.entries(presets)) {
 let server;
 try {
  server=await chromium.launchServer({headless:false,channel:'chromium',args});
  const browser=await chromium.connect(server.wsEndpoint());
  const page=await browser.newPage();await page.goto(url);
  const result=await page.evaluate(async()=>{
   const results={available:!!navigator.gpu,adapters:[]};
   for(const options of [{powerPreference:'high-performance'},{},{forceFallbackAdapter:true}]){
    try {const a=await Promise.race([navigator.gpu?.requestAdapter(options),new Promise((_,reject)=>setTimeout(()=>reject(Error('timeout')),5000))]);results.adapters.push({options,info:a?{vendor:a.info.vendor,architecture:a.info.architecture,description:a.info.description,isFallbackAdapter:a.info.isFallbackAdapter}:null});}
    catch(e){results.adapters.push({options,error:String(e)});}
   }
   return results;
  });
  const cdp=await browser.newBrowserCDPSession();const info=await cdp.send('SystemInfo.getInfo');
  console.log(JSON.stringify({name,result,gpu:info.gpu},null,2));
 }catch(error){console.log(JSON.stringify({name,error:String(error)}));}
 finally{await server?.kill();}
} }finally{await new Promise(resolve=>http.close(resolve));}
