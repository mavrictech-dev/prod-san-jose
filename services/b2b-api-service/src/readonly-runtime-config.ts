export const readonlyOwners=['identity','billing','fiscal','webhooks'] as const;
export type ReadonlyOwner=typeof readonlyOwners[number];
export const readonlyRequiredCapabilities:Record<ReadonlyOwner,readonly string[]>={
 identity:['IDENTITY','WEBHOOK_AUTHORITY'],billing:['READ'],fiscal:['READ'],webhooks:['SUBSCRIPTIONS','DELIVERIES','INGEST'],
};
export interface B2bReadonlyConfig {
 schemaVersion:'factuez.b2b.readonly-runtime.v1';profile:'READONLY_OAUTH_WEBHOOKS';environment:'BETA';
 approvedForPrivateBeta:true;deploymentId:string;instanceId:string;
 listen:{host:'127.0.0.1'|'0.0.0.0';port:number;maintenancePort:number};
 edgePeers:string[];operatorPeers:string[];origins:Record<ReadonlyOwner,string>;
}
const exact=(v:any,keys:string[])=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const peers=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=32&&new Set(v).size===v.length&&v.every(p=>typeof p==='string'&&/^[a-f0-9]{64}$/.test(p));
/** Separate opt-in metadata. Cannot silently select this profile from fullgraph configuration. */
export function b2bReadonlyConfig(value:unknown):B2bReadonlyConfig{
 const v=value as B2bReadonlyConfig;
 if(!exact(v,['schemaVersion','profile','environment','approvedForPrivateBeta','deploymentId','instanceId','listen','edgePeers','operatorPeers','origins'])||
  v.schemaVersion!=='factuez.b2b.readonly-runtime.v1'||v.profile!=='READONLY_OAUTH_WEBHOOKS'||v.environment!=='BETA'||v.approvedForPrivateBeta!==true||
  !uuid(v.deploymentId)||!uuid(v.instanceId)||!exact(v.listen,['host','port','maintenancePort'])||!['127.0.0.1','0.0.0.0'].includes(v.listen.host)||
  [v.listen.port,v.listen.maintenancePort].some(p=>!Number.isInteger(p)||p<9000||p>9099)||v.listen.port===v.listen.maintenancePort||
  !peers(v.edgePeers)||!peers(v.operatorPeers)||v.edgePeers.some(p=>v.operatorPeers.includes(p))||!exact(v.origins,[...readonlyOwners]))throw Error('B2B_READONLY_CONFIG_INVALID');
 const seen=new Set<string>();
 for(const origin of Object.values(v.origins)){
  try{const u=new URL(origin);if(u.protocol!=='https:'||u.username||u.password||u.pathname!=='/'||u.search||u.hash||!u.port||
   Number(u.port)<9000||Number(u.port)>9099||seen.has(u.origin))throw Error();seen.add(u.origin);}
  catch{throw Error('B2B_READONLY_DISTINCT_FIXED_HTTPS_OWNERS_REQUIRED');}
 }
 return structuredClone(v);
}
