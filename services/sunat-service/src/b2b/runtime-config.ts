import type {B2bSunatRuntimeConfig,SunatRuntimeTls} from './runtime-types';
import {types} from 'node:util';
const uuid=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s);
function exact(v:any,keys:string[]){return v&&typeof v==='object'&&!types.isProxy(v)&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k))&&Object.values(Object.getOwnPropertyDescriptors(v)).every(d=>d.enumerable&&'value'in d);}
export function sunatRuntimeConfig(input:B2bSunatRuntimeConfig):B2bSunatRuntimeConfig {
 const v=input,fail=()=>{throw Error('B2B_SUNAT_RUNTIME_CONFIG_INVALID');};
 if(!exact(v,['enabled','environment','deploymentId','instanceId','api','control','peers'])||v.enabled!==true||v.environment!=='BETA'||!uuid(v.deploymentId)||!uuid(v.instanceId))return fail();
 for(const l of [v.api,v.control])if(!exact(l,['host','port'])||!['127.0.0.1','0.0.0.0'].includes(l.host)||!Number.isInteger(l.port)||l.port<0||l.port>65535)return fail();
 if(v.api.port&&v.api.port===v.control.port||!exact(v.peers,['resource','billing','operator']))return fail();
 for(const p of Object.values(v.peers))if(!Array.isArray(p)||!p.length||p.length>32||new Set(p).size!==p.length||p.some(x=>typeof x!=='string'||!/^[a-f0-9]{64}$/.test(x)))return fail();
 if(v.peers.operator.some(p=>[...v.peers.resource,...v.peers.billing].includes(p)))return fail();
 return structuredClone(v);
}
export function sunatRuntimeTls(value:SunatRuntimeTls):SunatRuntimeTls {
 if(!exact(value,['ca','cert','key'])||[value.ca,value.cert,value.key].some(v=>!Buffer.isBuffer(v)||types.isProxy(v)||!v.length||v.length>128*1024))throw Error('B2B_SUNAT_RUNTIME_TLS_REQUIRED');
 return {ca:Buffer.from(value.ca),cert:Buffer.from(value.cert),key:Buffer.from(value.key)};
}
