/** Compatibility exports. New providers use @velocut/provider-sdk directly. */
export * from '@velocut/provider-sdk/video';
export {TaskApiVideoGen} from '@velocut/provider-task-api';
import {TaskApiVideoGen} from '@velocut/provider-task-api';
import type {VideoGenProviderKind,VideoGenEndpointConfig,VideoGenerator} from '@velocut/provider-sdk/video';
const kinds=new Map<string,VideoGenProviderKind>();
export function registerVideoGenProvider(kind:VideoGenProviderKind){kinds.set(kind.id,kind);}
export function videoGenProviders():VideoGenProviderKind[]{return [...kinds.values()];}
export function createVideoGen(kindId:string,config:VideoGenEndpointConfig):VideoGenerator {
  const kind=kinds.get(kindId);if(!kind)throw Error(`unknown video-gen provider kind: ${kindId} (have: ${[...kinds.keys()].join(', ')})`);return kind.create(config);
}
registerVideoGenProvider({id:'task-api',label:'Async task API (submit → poll relays)',create:config=>new TaskApiVideoGen(config)});
