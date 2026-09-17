import {spawn} from 'node:child_process';
import {createConnection} from 'node:net';
import {mkdir,open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';

async function health(url,signal){
  try{const response=await fetch(url+'/__velocut/health',{signal:AbortSignal.any([AbortSignal.timeout(1000),...(signal?[signal]:[])]),redirect:'error'});if(!response.ok||!response.headers.get('content-type')?.includes('application/json'))return null;return await response.json();}catch{return null;}
}
const listening=(port,host)=>new Promise(resolve=>{const socket=createConnection({port,host});const done=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>done(true));socket.once('error',()=>done(false));socket.setTimeout(500,()=>done(false));});

/** No npm subprocess or source checkout: npm resolves the exact CLI dependency once.
 * The detached Studio outlives MCP chats and exits after its pages stop heartbeating. */
export function createStudioLauncher({version,loadStudio=()=>import('@velocut/cli'),logDirectory=process.env.VELOCUT_STUDIO_LOG_DIR??resolve(homedir(),'.velocut','studio'),startupTimeoutMs=15_000}={}){
  const pending=new Map();
  const compatible=(info)=>{
    if(info?.app!=='velocut')return false;
    if(info.version!==version||info.bridgeProtocol!==2)throw Error(`Studio ${info.version??'unknown'} is already running; this plugin needs ${version}. Close the old Studio or explicitly connect to its editorUrl. The project origin was not changed.`);
    return true;
  };
  const ensure=async(port=5173,signal)=>{
    if(!Number.isInteger(port)||port<1||port>65535)throw Error('Studio port must be 1–65535');
    const url=`http://localhost:${port}`;signal?.throwIfAborted();
    const existing=await health(url,signal);
    if(compatible(existing))return {url,version,status:existing.mode==='development'?'reused-development':'reused',managed:existing.managed===true};
    signal?.throwIfAborted();
    if((await Promise.all([listening(port,'127.0.0.1'),listening(port,'::1')])).some(Boolean))throw Error(`Port ${port} is occupied by a service that is not a compatible Velocut Studio. Supply editorUrl to connect to an existing editor, or explicitly choose another port; browser projects belong to their original origin.`);
    const cli=await loadStudio();signal?.throwIfAborted();
    if(cli.VERSION!==version||typeof cli.managedWorkerPath!=='string')throw Error(`Install @velocut/mcp@${version} with its matching @velocut/cli dependency; no source build is required.`);
    await mkdir(logDirectory,{recursive:true,mode:0o700});const logPath=resolve(logDirectory,`studio-${port}.log`),log=await open(logPath,'a',0o600);
    let child,spawnError,exited=false,ready=false;
    try{
      child=spawn(process.execPath,[cli.managedWorkerPath,'--port',String(port)],{cwd:homedir(),detached:true,stdio:['ignore',log.fd,log.fd],windowsHide:true});
      child.once('error',error=>{spawnError=error;});child.once('exit',()=>{exited=true;});child.unref();
    }finally{await log.close();}
    try{
      const started=Date.now();
      while(Date.now()-started<startupTimeoutMs){
        signal?.throwIfAborted();const current=await health(url,signal);
        if(compatible(current)){ready=true;return {url,version,status:'started',managed:current.managed===true};}
        if(spawnError)throw spawnError;
        if(exited&&Date.now()-started>1000)throw Error(`Studio did not start. See ${logPath}`);
        await delay(100,undefined,{signal});
      }
      throw Error(`Studio startup timed out. See ${logPath}`);
    }finally{if(!ready&&!exited)child.kill();}
  };
  return {ensure(port=5173,signal){
    // Repeated calls in one MCP process share startup; other processes coordinate via the port.
    if(pending.has(port))return pending.get(port);
    const task=ensure(port,signal).finally(()=>pending.delete(port));pending.set(port,task);return task;
  }};
}
