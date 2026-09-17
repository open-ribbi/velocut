import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {ProviderRegistry} from '@velocut/provider-sdk';
import {parseModelSpec,serializeModelSpec,modelInput,previewModelRequest,declarativeProvider} from '@velocut/provider-sdk/declarative';

const revisionOf=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const failure=message=>{throw Error(message);};
/** Shared by the published Studio and Vite. No source checkout or package registration. */
export function createModelHost({directory=process.env.VELOCUT_MODEL_HOME??resolve(homedir(),'.velocut','models'),fetch:fetcher=globalThis.fetch}={}){
  const file=resolve(directory,'config.json');let pending=Promise.resolve();
  const fresh=()=>({version:1,models:{},connections:{}});
  const read=async()=>{try{const value=JSON.parse(await readFile(file,'utf8'));if(value.version!==1)throw Error('Unsupported model configuration version');return value;}catch(e){if(e.code==='ENOENT')return fresh();throw e;}};
  const mutate=work=>{const next=pending.then(async()=>{const state=await read(),result=await work(state);await mkdir(directory,{recursive:true,mode:0o700});const tmp=resolve(directory,randomUUID()+'.tmp');await writeFile(tmp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await rename(tmp,file);return result;});pending=next.catch(()=>{});return next;};
  const identifier=value=>typeof value==='string'&&!['constructor','prototype','__proto__'].includes(value)&&/^[a-zA-Z0-9][a-zA-Z0-9_.:/-]*$/.test(value)?value:failure('Invalid identifier');
  const describeConnection=c=>({id:c.id,label:c.label,baseUrl:c.baseUrl,remoteModel:c.remoteModel,modelId:c.modelId,credentialConfigured:!!c.apiKey});
  const getSpec=(state,id,revision)=>{const entry=state.models[identifier(id)];if(!entry)throw Error('Unknown model');const value=entry.versions[revision??entry.current];if(!value)throw Error('Unknown model revision');return parseModelSpec(value);};
  const getConnection=(state,id)=>state.connections[identifier(id)]??failure('Unknown connection');
  const resolveRequest=(state,p)=>{const c=getConnection(state,p.connectionId),s=getSpec(state,c.modelId,p.revision);return {connection:c,spec:s};};
  const provider=(spec,c)=>new ProviderRegistry().register(declarativeProvider(spec)).create({id:c.id,provider:'declarative:'+spec.id,config:{baseUrl:c.baseUrl,...(c.remoteModel?{remoteModel:c.remoteModel}:{})},...(spec.execution.auth?.type==='none'?{}:{credentials:{apiKey:{store:'local',key:c.id}}})},{fetch:fetcher,resolveCredential:async()=>c.apiKey});
  const allowed={list:[],get:['id','revision'],validate:['definition'],upsert:['definition','expectedRevision'],remove:['id','expectedRevision'],connections:['connection','id','expectedRevision'],setCredential:['id','token'],preview:['connectionId','revision','input','requestId'],binding:['connectionId','revision'],submit:['connectionId','revision','input','requestId','resources'],execute:['connectionId','revision','input','requestId','resources'],poll:['connectionId','revision','receipt'],collect:['connectionId','revision','receipt']};
  const execute=async(p,{signal}={})=>{
    if(!p||typeof p!=='object'||!allowed[p.action]||Object.keys(p).some(k=>k!=='action'&&!allowed[p.action].includes(k)))throw Error('Unknown model configuration action or fields');
    if(p.action==='validate'){const spec=parseModelSpec(p.definition);return {spec,yaml:serializeModelSpec(spec)};}
    if(p.action==='upsert')return mutate(state=>{const spec=parseModelSpec(p.definition),prior=state.models[spec.id];if(prior&&p.expectedRevision!==prior.current)throw Error('Model definition changed; get its revision before updating');const revision=revisionOf(spec);state.models[spec.id]={current:revision,enabled:true,versions:{...prior?.versions,[revision]:spec}};return {id:spec.id,revision,spec};});
    if(p.action==='remove')return mutate(state=>{const item=state.models[identifier(p.id)];if(!item||item.current!==p.expectedRevision)throw Error('Model definition changed');if(Object.values(state.connections).some(c=>c.modelId===p.id))throw Error('Remove connections before removing a model');item.enabled=false;return {removed:p.id};});
    if(p.action==='setCredential')return mutate(state=>{const c=getConnection(state,p.id);if(typeof p.token!=='string')throw Error('Token must be a string');c.apiKey=p.token;return describeConnection(c);});
    if(p.action==='connections'&&(p.connection||p.id))return mutate(state=>{
      if(p.id){delete state.connections[identifier(p.id)];return {removed:p.id};}
      const c=p.connection;if(!c||Object.keys(c).some(k=>!['id','label','baseUrl','remoteModel','modelId'].includes(k)))throw Error('Unsupported connection fields; tokens use the credential control');identifier(c.id);getSpec(state,c.modelId);
      const url=new URL(c.baseUrl);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Invalid connection Base URL');
      if(c.label!==undefined&&typeof c.label!=='string'||c.remoteModel!==undefined&&typeof c.remoteModel!=='string')throw Error('Invalid connection fields');
      const prior=state.connections[c.id];if(prior&&p.expectedRevision!==revisionOf(describeConnection(prior)))throw Error('Connection changed; reload before updating');
      // A credential is bound to its endpoint; changing that endpoint never forwards an existing token.
      state.connections[c.id]={...c,apiKey:prior?.baseUrl===c.baseUrl?prior.apiKey:undefined};return {...describeConnection(state.connections[c.id]),revision:revisionOf(describeConnection(state.connections[c.id]))};
    });
    const state=await read();
    if(p.action==='list')return {models:Object.entries(state.models).filter(([,m])=>m.enabled).map(([id,m])=>({id,revision:m.current,spec:m.versions[m.current]})),connections:Object.values(state.connections).map(c=>({...describeConnection(c),revision:revisionOf(describeConnection(c))}))};
    if(p.action==='connections')return {connections:Object.values(state.connections).map(c=>({...describeConnection(c),revision:revisionOf(describeConnection(c))}))};
    if(p.action==='get'){const spec=getSpec(state,p.id,p.revision);return {spec,revision:p.revision??state.models[p.id].current,yaml:serializeModelSpec(spec)};}
    const {spec,connection}=resolveRequest(state,p);
    if(p.action==='preview')return previewModelRequest(spec,connection,p.input??{},p.requestId);
    if(p.action==='binding')return {binding:revisionOf([spec,connection.id,connection.modelId,connection.baseUrl,connection.remoteModel,connection.apiKey])};
    const client=provider(spec,connection),call={signal,requestId:p.requestId,resources:{urlFor:async(id,kind)=>{const ref=p.resources?.[id];if(!ref||ref.kind!==kind||typeof ref.url!=='string')throw Error('Missing or mismatched media reference');const u=new URL(ref.url);if(!['https:','http:'].includes(u.protocol))throw Error('Invalid media URL');return ref.url;}}};
    try{
      const value=p.action==='submit'||p.action==='execute'?await client[p.action]({model:spec.id,capability:spec.capability,input:modelInput(spec,p.input??{})},call):await client[p.action](p.receipt,call);
      const result=value?.outputs?value:value?.result;
      if(result?.outputs?.some(o=>o.source.kind==='url'))await mutate(state=>{
        state.downloads??={};
        for(const output of result.outputs)if(output.source.kind==='url'){
          const id=revisionOf(output.source.url);state.downloads[id]=output.source.url;
          output.metadata={...output.metadata,localDownloadId:id};
        }
      });
      return value;
    }catch(e){if(connection.apiKey&&e instanceof Error)e.message=e.message.split(connection.apiKey).join('[redacted]');throw e;}
  };
  return {execute,async handle(req,res){
    const download=/^\/__velocut\/models\/download\/([a-f0-9]{64})$/.exec(req.url??'');
    if(!download&&req.url?.split('?')[0]!=='/__velocut/models')return false;
    const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value,(_key,value)=>value instanceof Uint8Array?{$bytes:Buffer.from(value).toString('base64')}:value));};
    // Same-origin application API; neither GET forms nor cross-origin JSON can mutate configuration.
    const origin=req.headers.origin;
    if(download){
      if(req.method!=='GET'||(origin?origin!==`http://${req.headers.host}`:req.headers['sec-fetch-site']!=='same-origin')){json(403,{ok:false,error:'Same-origin download required'});return true;}
      const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      try{
        const url=(await read()).downloads?.[download[1]];if(!url)throw Error('Saved model output is unavailable');
        // Only recorded provider results can be downloaded; caller cannot choose a URL or headers.
        const response=await fetcher(url,{signal:controller.signal});if(!response.ok||!response.body)throw Error(`Model output HTTP ${response.status}`);
        res.writeHead(200,{'Content-Type':response.headers.get('content-type')??'application/octet-stream','Cache-Control':'no-store','Cross-Origin-Resource-Policy':'same-origin'});
        await pipeline(Readable.fromWeb(response.body),res,{signal:controller.signal});
      }catch(e){if(!res.headersSent)json(400,{ok:false,error:'Model output download failed; resume its task to refresh the result'});else res.destroy();}
      return true;
    }
    if(req.method!=='POST'||req.headers['content-type']?.split(';')[0]!=='application/json'||origin!==`http://${req.headers.host}`){json(403,{ok:false,error:'Same-origin JSON request required'});return true;}
    const controller=new AbortController();res.once('close',()=>{if(!res.writableEnded)controller.abort();});
    try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const p=JSON.parse(Buffer.concat(chunks).toString('utf8'));const data=await execute(p,{signal:controller.signal});json(200,{ok:true,data});}
    catch(e){json(400,{ok:false,error:e.message,outcome:e.outcome??'unknown',retryable:e.retryable??false});}
    return true;
  }};
}
