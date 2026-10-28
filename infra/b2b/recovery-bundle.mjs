/** B2B-09 bounded SYNTHETIC rehearsal envelope only. Pure memory operations:
 * no env, files, destination, SQL, credentials, network or restore side effects. */
import {createHash,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {types} from 'node:util';
const MAGIC=Buffer.from('FZB2B9R1'),VERSION='factuez.b2b.synthetic-recovery.v1';
const RAW_MAX=32*1024**2,CIPHER_MAX=48*1024**2,DUMP_MAX=16*1024**2,FILE_MAX=10*1024**2;
const PROFILES={BILLING:'B2B_REPORTS_V1',RECEIVED:'B2B_RECEPTION_COMMANDS_V1',MAILER:'B2B_CORPORATE_EMAIL_V1'};
const SHA=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAME=/^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const invalid=()=>{throw new Error('B2B_SYNTHETIC_RECOVERY_INVALID');};
function record(v,keys){
 if(!v||typeof v!=='object'||types.isProxy(v)||Object.getPrototypeOf(v)!==Object.prototype||Reflect.ownKeys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k))||Object.values(Object.getOwnPropertyDescriptors(v)).some(d=>!d.enumerable||!('value'in d)))invalid();
}
function list(v,max,min=0){
 if(!Array.isArray(v)||types.isProxy(v)||Object.getPrototypeOf(v)!==Array.prototype||v.length<min||v.length>max||Reflect.ownKeys(v).length!==v.length+1)invalid();
 for(let n=0;n<v.length;n++){const d=Object.getOwnPropertyDescriptor(v,String(n));if(!d||!d.enumerable||!('value'in d))invalid();}
}
const integer=(v,min=0,max=10000)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
function bytes(v,max){if(!Buffer.isBuffer(v)||types.isProxy(v)||v.length<1||v.length>max)invalid();return Buffer.from(v);}
function context(v){
 record(v,['runId','backupId','keyVersion','owners']);list(v.owners,3,1);
 if(typeof v.runId!=='string'||typeof v.backupId!=='string'||!UUID.test(v.runId)||!UUID.test(v.backupId)||!integer(v.keyVersion,1,2147483647)||v.owners.some(o=>typeof o!=='string'||!Object.hasOwn(PROFILES,o))||new Set(v.owners).size!==v.owners.length)invalid();
 return {runId:v.runId,backupId:v.backupId,keyVersion:v.keyVersion,owners:[...v.owners].sort()};
}
function fileMetadata(f){
 if(typeof f.name!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}\.(xml|zip|pdf)$/.test(f.name))invalid();
 const extension=f.name.split('.').at(-1),media={xml:'application/xml',zip:'application/zip',pdf:'application/pdf'}[extension];
 if(f.mediaType!==media)invalid();return {name:f.name,mediaType:f.mediaType};
}
function inventory(o){
 if(typeof o.owner!=='string'||!Object.hasOwn(PROFILES,o.owner)||o.profile!==PROFILES[o.owner]||typeof o.schemaSha256!=='string'||!SHA.test(o.schemaSha256))invalid();
 list(o.tables,100,1);list(o.sequences,100);
 const names=new Set();
 const tables=o.tables.map(t=>{record(t,['name','count','sha256']);if(typeof t.name!=='string'||!NAME.test(t.name)||names.has(t.name)||!integer(t.count)||typeof t.sha256!=='string'||!SHA.test(t.sha256))invalid();names.add(t.name);return {...t};}).sort((a,b)=>a.name.localeCompare(b.name,'en'));
 const seqs=new Set();
 const sequences=o.sequences.map(s=>{record(s,['name','lastValue','isCalled']);if(typeof s.name!=='string'||!NAME.test(s.name)||seqs.has(s.name)||typeof s.lastValue!=='string'||!/^(0|[1-9][0-9]{0,18})$/.test(s.lastValue)||BigInt(s.lastValue)>9223372036854775807n||typeof s.isCalled!=='boolean')invalid();seqs.add(s.name);return {...s};}).sort((a,b)=>a.name.localeCompare(b.name,'en'));
 return {owner:o.owner,profile:o.profile,schemaSha256:o.schemaSha256,tables,sequences};
}
function normalize(input){
 record(input,['runId','backupId','keyVersion','environment','datasetClass','capturedAt','consistency','owners']);list(input.owners,3,1);
 if(input.environment!=='BETA'||input.datasetClass!=='SYNTHETIC'||input.consistency!=='QUIESCED_ISOLATED_REHEARSAL'||typeof input.capturedAt!=='string'||!Number.isFinite(Date.parse(input.capturedAt))||new Date(input.capturedAt).toISOString()!==input.capturedAt)invalid();
 const expected=context({runId:input.runId,backupId:input.backupId,keyVersion:input.keyVersion,owners:input.owners.map(o=>{if(!o||types.isProxy(o))invalid();return Object.getOwnPropertyDescriptor(o,'owner')?.value;})});
 let total=0;
 const owners=input.owners.map(o=>{
  record(o,['owner','profile','schemaSha256','tables','sequences','databaseDump','originals']);const meta=inventory(o),dump=bytes(o.databaseDump,DUMP_MAX);
  if(dump.subarray(0,5).toString('ascii')!=='PGDMP')invalid();total+=dump.length;list(o.originals,32);
  const names=new Set(),originals=o.originals.map(f=>{record(f,['name','mediaType','bytes']);const m=fileMetadata(f),b=bytes(f.bytes,FILE_MAX);if(names.has(m.name))invalid();names.add(m.name);total+=b.length;return {...m,bytes:b};});
  return {...meta,databaseDump:dump,originals:originals.sort((a,b)=>a.name.localeCompare(b.name,'en'))};
 }).sort((a,b)=>a.owner.localeCompare(b.owner,'en'));
 if(total>RAW_MAX)invalid();return {...expected,environment:'BETA',datasetClass:'SYNTHETIC',capturedAt:input.capturedAt,consistency:input.consistency,owners};
}
function wire(value){return {...value,schemaVersion:VERSION,owners:value.owners.map(o=>{
 const {databaseDump,originals,...m}=o;
 return {...m,databaseDumpBase64:databaseDump.toString('base64'),databaseSha256:hash(databaseDump),originals:originals.map(({bytes,...f})=>({...f,contentBase64:bytes.toString('base64'),sha256:hash(bytes)}))};})};}
function decode(v,max){if(typeof v!=='string'||v.length>Math.ceil(max/3)*4||v.length%4!==0)invalid();const b=Buffer.from(v,'base64');if(b.toString('base64')!==v||!b.length||b.length>max)invalid();return b;}
function fromWire(v){
 record(v,['runId','backupId','keyVersion','environment','datasetClass','capturedAt','consistency','owners','schemaVersion']);if(v.schemaVersion!==VERSION)invalid();list(v.owners,3,1);
 const owners=v.owners.map(o=>{
  record(o,['owner','profile','schemaSha256','tables','sequences','databaseDumpBase64','databaseSha256','originals']);list(o.originals,32);
  const databaseDump=decode(o.databaseDumpBase64,DUMP_MAX);if(hash(databaseDump)!==o.databaseSha256)invalid();
  const originals=o.originals.map(f=>{record(f,['name','mediaType','contentBase64','sha256']);const bytes=decode(f.contentBase64,FILE_MAX);if(hash(bytes)!==f.sha256)invalid();return {name:f.name,mediaType:f.mediaType,bytes};});
  const {databaseDumpBase64,databaseSha256,...meta}=o;return {...meta,databaseDump,originals};
 });
 const {schemaVersion,...meta}=v;return normalize({...meta,owners});
}
function aad(c){return Buffer.from(JSON.stringify({schemaVersion:VERSION,...c}));}
export function sealB2bSyntheticRecovery(input,key){
 let plaintext;
 try{
  const value=normalize(input),c=context({runId:value.runId,backupId:value.backupId,keyVersion:value.keyVersion,owners:value.owners.map(o=>o.owner)});
  if(!Buffer.isBuffer(key)||types.isProxy(key)||key.length!==32)invalid();
  plaintext=Buffer.from(JSON.stringify(wire(value)));if(plaintext.length>CIPHER_MAX-36)invalid();
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(c));
  const encrypted=Buffer.concat([cipher.update(plaintext),cipher.final()]);return Buffer.concat([MAGIC,iv,cipher.getAuthTag(),encrypted]);
 }catch{invalid();}finally{plaintext?.fill(0);}
}
/** Authenticate and validate EVERY member before any caller opens a destination.
 * Key material is supplied separately, never stored in the archive or returned. */
export function openB2bSyntheticRecovery(encrypted,key,expected){
 let plaintext;
 try{
  const c=context(expected);
  if(!Buffer.isBuffer(key)||types.isProxy(key)||key.length!==32||!Buffer.isBuffer(encrypted)||types.isProxy(encrypted)||encrypted.length<37||encrypted.length>CIPHER_MAX||!encrypted.subarray(0,8).equals(MAGIC))invalid();
  const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(8,20));decipher.setAAD(aad(c));decipher.setAuthTag(encrypted.subarray(20,36));
  plaintext=Buffer.concat([decipher.update(encrypted.subarray(36)),decipher.final()]);
  const value=fromWire(JSON.parse(plaintext.toString('utf8')));
  const actual=context({runId:value.runId,backupId:value.backupId,keyVersion:value.keyVersion,owners:value.owners.map(o=>o.owner)});
  if(JSON.stringify(actual)!==JSON.stringify(c))invalid();return value;
 }catch{invalid();}finally{plaintext?.fill(0);}
}
export function b2bRecoveryInventorySha(inventoryValue){
 record(inventoryValue,['owner','profile','schemaSha256','tables','sequences']);return hash(Buffer.from(JSON.stringify(inventory(inventoryValue))));
}
