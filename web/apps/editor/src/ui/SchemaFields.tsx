import {useEffect,useState} from 'react';
import type {JsonObject,JsonValue} from '@velocut/provider-sdk';
export function JsonField({label,value,onChange}:{label:string;value:JsonValue|undefined;onChange:(v:JsonValue|undefined)=>void}){
 const [text,setText]=useState(value===undefined?'':JSON.stringify(value,null,2)),[error,setError]=useState('');
 useEffect(()=>setText(value===undefined?'':JSON.stringify(value,null,2)),[value]);
 return <label>{label}<textarea aria-label={label} rows={4} value={text} onChange={e=>{setText(e.target.value);try{onChange(e.target.value.trim()?JSON.parse(e.target.value):undefined);setError('');e.target.setCustomValidity('');}catch{setError('Enter valid JSON');e.target.setCustomValidity('Enter valid JSON');}}}/>{error&&<small role="alert">{error}</small>}</label>;
}
/** All controls come from data, including nested objects and media references. */
export function SchemaFields({schema,value,onChange,prefix='Input',references=[]}:{schema:JsonObject;value:JsonObject;onChange:(v:JsonObject)=>void;prefix?:string;references?:{id:string;name:string;kind?:string}[]}){
 const properties=(schema.properties??{}) as Record<string,JsonObject>,required=(schema.required??[]) as string[];
 const set=(key:string,v:JsonValue|undefined)=>{const next={...value};if(v===undefined)delete next[key];else next[key]=v;onChange(next);};
 if(!Object.keys(properties).length||schema.oneOf||schema.anyOf||schema.$ref)return <JsonField label={prefix} value={value} onChange={v=>{if(v&&typeof v==='object'&&!Array.isArray(v))onChange(v as JsonObject);}}/>;
 return <div className="schema-fields">{Object.entries(properties).map(([key,s])=>{
   if(!s||typeof s!=='object')return null;const label=String(s.title??key),name=prefix+' '+label,v=value[key]??s.default,kind=s['x-media-kind'];
   if(typeof kind==='string')return <label key={key}>{label}<select aria-label={name} value={v&&typeof v==='object'&&!Array.isArray(v)?String(v.$mediaRef??''):''} onChange={e=>set(key,e.target.value?{$mediaRef:e.target.value,kind}:undefined)}><option value="">Choose saved reference</option>{references.filter(r=>(r.kind??'image')===kind).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>;
   if(s.type==='object'&&!s.oneOf&&!s.anyOf&&!s.$ref)return <fieldset key={key}><legend>{label}</legend><SchemaFields schema={s} value={v&&typeof v==='object'&&!Array.isArray(v)?v:{}} onChange={x=>set(key,x)} prefix={name} references={references}/>{!required.includes(key)&&<button type="button" onClick={()=>set(key,undefined)}>Clear {label}</button>}</fieldset>;
   if(s.type==='array'||s.oneOf||s.anyOf||s.$ref)return <JsonField key={key} label={name} value={v} onChange={x=>set(key,x)}/>;
   const options=Array.isArray(s.enum)?s.enum:s.type==='boolean'?[true,false]:null;
   return <label key={key}>{label}{required.includes(key)?' *':''}{options?<select aria-label={name} value={v===undefined?'':JSON.stringify(v)} onChange={e=>set(key,e.target.value?JSON.parse(e.target.value):undefined)}><option value="">Default / unset</option>{options.map(x=><option key={JSON.stringify(x)} value={JSON.stringify(x)}>{String(x)}</option>)}</select>:<input aria-label={name} type={s.type==='number'||s.type==='integer'?'number':'text'} min={typeof s.minimum==='number'?s.minimum:undefined} max={typeof s.maximum==='number'?s.maximum:undefined} step={s.type==='integer'?1:'any'} value={v===undefined?'':String(v)} onChange={e=>set(key,e.target.value===''?undefined:s.type==='number'||s.type==='integer'?Number(e.target.value):e.target.value)}/>} {typeof s.description==='string'&&<small>{s.description}</small>}</label>;
 })}</div>;
}
