import {b2bRuntimeOwners,type B2bRuntimeOwner} from './runtime-assembly';
export interface B2bApiRuntimeConfig {
 schemaVersion:'factuez.b2b.api-runtime.v1';environment:'BETA';deploymentId:string;instanceId:string;approvedForPrivateBeta:true;
 listen:{host:'127.0.0.1'|'0.0.0.0';port:number;maintenancePort:number};
 edgePeers:string[];operatorPeers:string[];origins:Record<B2bRuntimeOwner,string>;
 localIssuanceEnabled:boolean;localConversionEnabled:boolean;automaticReceivedApprovals?:boolean;
}
const exact=(v:any,keys:string[])=>v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const fingerprints=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=32&&new Set(v).size===v.length&&v.every(x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x));
export function b2bApiRuntimeConfig(value:unknown):B2bApiRuntimeConfig {
 const v=value as B2bApiRuntimeConfig;
 if(!exact(v,['schemaVersion','environment','deploymentId','instanceId','approvedForPrivateBeta','listen','edgePeers','operatorPeers','origins','localIssuanceEnabled','localConversionEnabled',...(Object.hasOwn(v??{},'automaticReceivedApprovals')?['automaticReceivedApprovals']:[])])||
  v.schemaVersion!=='factuez.b2b.api-runtime.v1'||v.environment!=='BETA'||v.approvedForPrivateBeta!==true||!uuid(v.deploymentId)||!uuid(v.instanceId)||
  !exact(v.listen,['host','port','maintenancePort'])||!['127.0.0.1','0.0.0.0'].includes(v.listen.host)||
  [v.listen.port,v.listen.maintenancePort].some(p=>!Number.isInteger(p)||p<1024||p>65535)||v.listen.port===v.listen.maintenancePort||
  !fingerprints(v.edgePeers)||!fingerprints(v.operatorPeers)||v.operatorPeers.some(p=>v.edgePeers.includes(p))||!exact(v.origins,[...b2bRuntimeOwners])||
  typeof v.localIssuanceEnabled!=='boolean'||typeof v.localConversionEnabled!=='boolean'||v.automaticReceivedApprovals!==undefined&&typeof v.automaticReceivedApprovals!=='boolean')throw Error('B2B_API_RUNTIME_CONFIG_INVALID');
 for(const origin of Object.values(v.origins)){
  try{const u=new URL(origin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw Error();}catch{throw Error('B2B_FIXED_HTTPS_OWNERS_REQUIRED');}
 }
 return {...structuredClone(v),automaticReceivedApprovals:v.automaticReceivedApprovals??false};
}
