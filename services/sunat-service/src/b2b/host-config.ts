import {lstatSync,realpathSync} from 'node:fs';
import {basename,isAbsolute,join,parse,resolve} from 'node:path';
import {createHash,X509Certificate} from 'node:crypto';
import type {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {mountedB2bPostgres} from '@factuez/service-access/dist/b2b-postgres-options';
import {sunatMountedRuntimeMetadata} from './main';
import type {SunatHostKey} from './host-keys';
import type {SunatHostPki} from './host-crypto';
import type {CarrierReferenceSignerPins} from '../application/carrier-reference-verifier';
import {syntheticSunatHostRuc} from './host-synthetic-profile';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex');
const name=(v:unknown)=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,63}\.(bin|pem|key|crt|json)$/.test(v);
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function exact(v:any,keys:string[]){return v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');}
export function loadSunatStandaloneMount(files:B2bRuntimeFiles,root:string){
 try{
  const m=sunatMountedRuntimeMetadata(files.metadata('sunat-runtime.json')),h=files.metadata('sunat-host.json');
  if(!exact(h,['schemaVersion','environment','profile','postgres','artifactsRoot','vaultKeyFile','keys','pki','carrierPinsFile','authorityTls',...(h&&Object.hasOwn(h,'batchEvidenceProfile')?['batchEvidenceProfile']:[])])||h.schemaVersion!=='factuez.b2b.sunat-standalone-host.v1'||h.environment!=='BETA'||h.profile!=='SYNTHETIC'||
   !name(h.vaultKeyFile)||!name(h.carrierPinsFile)||typeof h.artifactsRoot!=='string'||!isAbsolute(h.artifactsRoot)||resolve(h.artifactsRoot)===parse(resolve(h.artifactsRoot)).root||
   !exact(h.postgres,['host','port','user','name','passwordFile'])||!/^sunat_synthetic_[a-z0-9_]+_beta$/.test(h.postgres.name)||
   !Array.isArray(h.keys)||h.keys.length<1||h.keys.length>100||!exact(h.pki,['roots','crl','cdrSigner','opensslPath'])||typeof h.pki.opensslPath!=='string'||!isAbsolute(h.pki.opensslPath))throw Error();
  if(h.batchEvidenceProfile!==undefined&&h.batchEvidenceProfile!=='OWNED_ORIGINALS_01_03')throw Error();
  if(!exact(h.authorityTls,['ca','cert','key'])||Object.values(h.authorityTls).some(v=>!name(v)))throw Error();
  if(new X509Certificate(files.publicPem(h.authorityTls.cert)).fingerprint256===new X509Certificate(files.publicPem(m.files.identityTls.cert)).fingerprint256)throw Error();
  const artifactRoot=resolve(h.artifactsRoot),stat=lstatSync(artifactRoot);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(artifactRoot)!==artifactRoot||process.platform!=='win32'&&(stat.mode&0o077)!==0)throw Error();
  const pki={} as SunatHostPki;
  for(const key of ['roots','crl','cdrSigner'] as const){const ref=h.pki[key];if(!exact(ref,['file','sha256'])||!name(ref.file)||!hash(ref.sha256))throw Error();
   const bytes=files.publicPem(ref.file);if(sha(bytes)!==ref.sha256||bytes.includes('PRIVATE KEY'))throw Error();pki[key]={path:join(root,ref.file),sha256:ref.sha256};}
  const signer=new X509Certificate(files.publicPem(h.pki.cdrSigner.file));if(signer.ca)throw Error();
  pki.opensslPath=h.pki.opensslPath;
  const keys=h.keys as SunatHostKey[];
  for(const key of keys)if(!exact(key,['issuerRuc','purpose','pkcs12File','passwordFile','certificateFile','pkcs12Sha256','certificateSha256'])||!syntheticSunatHostRuc(key.issuerRuc)||
   !['LOCAL_GUIDE_ARTIFACT','LOCAL_SYNTHETIC_BATCH'].includes(key.purpose)||![key.pkcs12File,key.passwordFile,key.certificateFile].every(name)||!hash(key.pkcs12Sha256)||!hash(key.certificateSha256))throw Error();
  if(new Set(keys.map(k=>k.issuerRuc+':'+k.purpose)).size!==keys.length)throw Error();
  for(const group of ['guide','batch'] as const){const purpose=group==='guide'?'LOCAL_GUIDE_ARTIFACT':'LOCAL_SYNTHETIC_BATCH';
   if(m.allowedRucs[group].some(r=>!syntheticSunatHostRuc(r)||!keys.some(k=>k.issuerRuc===r&&k.purpose===purpose))||keys.some(k=>k.purpose===purpose&&!m.allowedRucs[group].includes(k.issuerRuc)))throw Error();}
  for(const pin of m.issuerPublicPins){if(!syntheticSunatHostRuc(pin.issuerRuc)||!name(basename(pin.path))||resolve(pin.path)!==join(root,basename(pin.path)))throw Error();
   const bytes=files.publicPem(basename(pin.path));if(sha(bytes)!==pin.sha256||new X509Certificate(bytes).fingerprint256.replace(/:/g,'').toLowerCase()!==pin.fingerprint)throw Error();}
  const postgres=mountedB2bPostgres(files,h.postgres);
  return {runtime:m,postgres,artifactsRoot:artifactRoot,vaultKeyFile:h.vaultKeyFile as string,keys:structuredClone(keys),pki,carrierPinsFile:h.carrierPinsFile as string,
   batchEvidenceProfile:h.batchEvidenceProfile as 'OWNED_ORIGINALS_01_03'|undefined,
   authorityTls:structuredClone(h.authorityTls) as {ca:string;cert:string;key:string}};
 }catch{throw Error('SUNAT_STANDALONE_MOUNT_INVALID');}
}
/** A deployment-owned, reread-on-every-use pin catalogue. Explicit ACTIVE status
 * is a revocable key selection, never proof of cryptography, CDR or official trust. */
export class MountedCarrierReferencePins implements CarrierReferenceSignerPins {
 constructor(private readonly files:Pick<B2bRuntimeFiles,'metadata'>,private readonly file:string,private readonly allowed:ReadonlyArray<{issuerRuc:string;fingerprint:string}>){if(!name(file))throw Error('SUNAT_CARRIER_PINS_INVALID');this.catalogue();}
 private catalogue(){
  try{const p=this.files.metadata(this.file);
   if(!exact(p,['schemaVersion','environment','entries'])||p.schemaVersion!=='factuez.b2b.carrier-reference-pins.v1'||p.environment!=='BETA'||!Array.isArray(p.entries)||p.entries.length>100)throw Error();
   const keys=new Set<string>();for(const e of p.entries){if(!exact(e,['issuerRuc','documentId','ownerSnapshotSha256','fingerprint','status'])||!syntheticSunatHostRuc(e.issuerRuc)||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(e.documentId)||!hash(e.ownerSnapshotSha256)||!hash(e.fingerprint)||!['ACTIVE','REVOKED'].includes(e.status)||
    !this.allowed.some(a=>a.issuerRuc===e.issuerRuc&&a.fingerprint===e.fingerprint))throw Error();
    const key=e.issuerRuc+':'+e.documentId+':'+e.ownerSnapshotSha256;if(keys.has(key))throw Error();keys.add(key);}
   return {entries:p.entries,revision:sha(JSON.stringify(p))};
  }catch{throw Error('SUNAT_CARRIER_PINS_INVALID');}
 }
 async current(ruc:string,documentId:string,ownerSnapshotSha256:string){const p=this.catalogue(),e=p.entries.find((e:any)=>e.issuerRuc===ruc&&e.documentId===documentId&&e.ownerSnapshotSha256===ownerSnapshotSha256);
  if(!e||e.status!=='ACTIVE')throw Error('SUNAT_CARRIER_PIN_UNAVAILABLE');return {fingerprint:e.fingerprint as string,revision:p.revision};}
}
