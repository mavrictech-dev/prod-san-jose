import type {INestApplicationContext} from '@nestjs/common';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {B2bIdentityHttp,B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {b2bOwnerRuntimeCapabilities} from '@factuez/service-access/dist/b2b-runtime-status';
import {PrismaService} from '../infrastructure/prisma.service';
import {ArtifactStore} from '../infrastructure/artifact-store';
import {CurrentPdfService} from '../application/current-pdf.service';
import {SecretVault} from '../infrastructure/crypto/secret-vault';
import {CertificateInspectionService} from '../infrastructure/crypto/certificate-inspection.service';
import {CertificateTrustService} from '../infrastructure/crypto/certificate-trust.service';
import {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {BetaOwnerXmlTrust,PinnedBetaIssuerPublicCertificates} from '../infrastructure/crypto/beta-owner-xml-trust';
import {XsdValidationService} from '../infrastructure/sunat/xsd-validation.service';
import {createB2bSunatRuntime,type B2bSunatOwnerRuntime} from './runtime';
import {sunatRuntimeConfig} from './runtime-config';
import type {B2bSunatRuntimeConfig,B2bSunatRuntimeDependencies,SunatRuntimeTls} from './runtime-types';

type TlsFiles={ca:string;cert:string;key:string};
export interface SunatMountedRuntimeMetadata {
 schemaVersion:'factuez.b2b.sunat-mounted-runtime.v1';config:B2bSunatRuntimeConfig;
 origins:{identity:string;billing:string};
 files:{apiTls:TlsFiles;controlTls:TlsFiles;identityTls:TlsFiles;billingTls:TlsFiles};
 allowedRucs:{guide:string[];batch:string[]};
 /** Deployment-owned PUBLIC pins only. P12/credentials never come from runtime.json. */
 issuerPublicPins:ConstructorParameters<typeof PinnedBetaIssuerPublicCertificates>[0];
}
/** The deployment must supply REAL owner/Identity authorities and actual shutdown
 * resources. No mock authority, approved Boolean or fallback implementation here. */
export interface SunatHostPorts {
 drain:B2bSunatRuntimeDependencies['drain'];lifecycle:B2bSunatRuntimeDependencies['lifecycle'];
 guideKeys:NonNullable<B2bSunatRuntimeDependencies['guide']>['keys'];
 batchKeys:NonNullable<B2bSunatRuntimeDependencies['batch']>['keys'];
 privileged:Pick<NonNullable<B2bSunatRuntimeDependencies['privileged']>,'authority'|'liveIdentity'|'bindingOwner'>;
 batchCdrSource?:NonNullable<B2bSunatRuntimeDependencies['batch']>['cdrSource'];
}
export type SunatHostContext=Pick<INestApplicationContext,'get'>;
function exact(v:any,keys:string[]){return !!v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function completePorts(context:SunatHostContext|undefined,ports:SunatHostPorts|undefined):asserts ports is SunatHostPorts {
 if(!context||typeof context.get!=='function'||!ports||typeof ports.guideKeys?.withKey!=='function'||typeof ports.batchKeys?.acquire!=='function'||
  typeof ports.privileged?.authority?.authorize!=='function'||typeof ports.privileged.liveIdentity?.current!=='function'||typeof ports.privileged.bindingOwner?.revalidate!=='function'||
  !['install','pauseCommands','closeAdmission','drain','snapshot'].every(k=>typeof (ports.drain as any)?.[k]==='function')||
  !['stopProducers','stopWorkers','closeOtherOwnerListeners'].every(k=>typeof (ports.lifecycle as any)?.[k]==='function'))throw Error('B2B_SUNAT_COMPLETE_HOST_BINDINGS_REQUIRED');
}
export function requireCompleteSunatCapabilities(capabilities:readonly string[]){
 const expected=b2bOwnerRuntimeCapabilities.fiscal;
 if(!Array.isArray(capabilities)||capabilities.length!==expected.length||new Set(capabilities).size!==expected.length||expected.some(c=>!capabilities.includes(c)))throw Error('B2B_SUNAT_COMPLETE_CAPABILITIES_REQUIRED');
}
export function sunatMountedRuntimeMetadata(input:unknown):SunatMountedRuntimeMetadata {
 const m=input as SunatMountedRuntimeMetadata;
 if(!exact(m,['schemaVersion','config','origins','files','allowedRucs','issuerPublicPins'])||m.schemaVersion!=='factuez.b2b.sunat-mounted-runtime.v1'||
  !exact(m.origins,['identity','billing'])||!exact(m.files,['apiTls','controlTls','identityTls','billingTls'])||!exact(m.allowedRucs,['guide','batch']))throw Error('B2B_SUNAT_MOUNTED_CONFIG_INVALID');
 for(const origin of Object.values(m.origins)){
  const url=new URL(origin);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('B2B_SUNAT_MOUNTED_ORIGIN_INVALID');
 }
 for(const group of Object.values(m.files))if(!exact(group,['ca','cert','key'])||Object.values(group).some(n=>typeof n!=='string'||!/^[a-z][a-z0-9-]{0,63}\.(pem|key|crt|bin)$/.test(n)))throw Error('B2B_SUNAT_MOUNTED_TLS_INVALID');
 for(const rucs of Object.values(m.allowedRucs))if(!Array.isArray(rucs)||!rucs.length||rucs.length>100||new Set(rucs).size!==rucs.length||rucs.some(r=>!/^\d{11}$/.test(r)))throw Error('B2B_SUNAT_MOUNTED_RUCS_REQUIRED');
 return {...m,config:sunatRuntimeConfig(m.config)};
}
/** Explicit mounted factory over an EXISTING owner DI context. Does not create
 * AppModule, Prisma, workers, publishers or network listeners. All five capabilities
 * are mandatory here; the lower-level runtime factory may be used for partial tests. */
export async function createB2bSunatRuntimeFromFiles(files:B2bRuntimeFiles,context:SunatHostContext,ports:SunatHostPorts,options:{enabled?:boolean;carrierReference?:B2bSunatRuntimeDependencies['carrierReference'];batchMemberEvidence?:B2bSunatRuntimeDependencies['batchMemberEvidence']}={}):Promise<B2bSunatOwnerRuntime|null>{
 if(options.enabled!==true)return null;
 completePorts(context,ports);
 let stage:'METADATA'|'DI'|'FACTORY'|'CAPABILITIES'='METADATA';
 try{
  const m=sunatMountedRuntimeMetadata(files.metadata('sunat-runtime.json'));
  // Validate public pin policy BEFORE touching TLS key files or constructing transports.
  const issuerCertificates=new PinnedBetaIssuerPublicCertificates(m.issuerPublicPins);
  const tls=(refs:TlsFiles):SunatRuntimeTls=>({ca:files.publicPem(refs.ca),cert:files.publicPem(refs.cert),key:files.privatePem(refs.key)});
  const credentials={apiTls:tls(m.files.apiTls),controlTls:tls(m.files.controlTls)},identityHttp=new B2bPrivateHttp(m.origins.identity,tls(m.files.identityTls)),billingHttp=new B2bPrivateHttp(m.origins.billing,tls(m.files.billingTls));
  stage='DI';const db=context.get(PrismaService,{strict:false}),artifacts=context.get(ArtifactStore,{strict:false}),pdf=context.get(CurrentPdfService,{strict:false}),
   trust=context.get(CertificateTrustService,{strict:false}),cdr=context.get(CdrSignatureTrustService,{strict:false}),xsd=context.get(XsdValidationService,{strict:false}),
   vault=context.get(SecretVault,{strict:false}),certificates=context.get(CertificateInspectionService,{strict:false});
  if(!(trust instanceof CertificateTrustService)||!(cdr instanceof CdrSignatureTrustService)||!(xsd instanceof XsdValidationService)||!(vault instanceof SecretVault)||!(certificates instanceof CertificateInspectionService))throw Error('CONCRETE_CRYPTO_DI_REQUIRED');
  stage='FACTORY';const runtime=await createB2bSunatRuntime(m.config,{prisma:db,artifacts,pdf,identity:new B2bIdentityHttp(identityHttp),identityHttp,billingHttp,credentials,
   drain:ports.drain,lifecycle:ports.lifecycle,carrierReference:options.carrierReference,batchMemberEvidence:options.batchMemberEvidence,guide:{keys:ports.guideKeys,allowedRucs:m.allowedRucs.guide,cdr,xsd},
   batch:{keys:ports.batchKeys,allowedRucs:m.allowedRucs.batch,cdr,xsd,cdrSource:ports.batchCdrSource},
   corrections:{signatures:new BetaOwnerXmlTrust(issuerCertificates,trust),cdr,xsd},privileged:{...ports.privileged,vault,certificates}});
  stage='CAPABILITIES';if(!runtime)throw Error();requireCompleteSunatCapabilities(runtime.statusMetadata.capabilities);return runtime;
 }catch(error){
  const ownCodes=['CONCRETE_CRYPTO_DI_REQUIRED','B2B_SUNAT_RUNTIME_DEPENDENCIES_REQUIRED','B2B_SUNAT_RUNTIME_STORAGE_NOT_READY','B2B_SUNAT_COMPLETE_CAPABILITIES_REQUIRED'];
  const code=error instanceof Error&&ownCodes.includes(error.message)?error.message:stage;
  throw Error('B2B_SUNAT_MOUNTED_RUNTIME_NOT_READY_'+code);
 }
}
/** No env auto-load. Missing actual host bindings fails BEFORE mounted files,
 * Prisma construction, AppModule lifecycle or sockets. Never fall back to legacy. */
export async function bootstrapB2bSunatHost(input:{enabled?:boolean;configRoot?:string},context?:SunatHostContext,ports?:SunatHostPorts){
 if(input.enabled!==true)return null;
 if(!context&&!ports){const {bootstrapStandaloneSunatHost}=await import('./host-standalone');return bootstrapStandaloneSunatHost(input);}
 completePorts(context,ports);
 if(typeof input.configRoot!=='string')throw Error('B2B_SUNAT_PRIVATE_CONFIG_ROOT_REQUIRED');
 const runtime=await createB2bSunatRuntimeFromFiles(new B2bRuntimeFiles(input.configRoot),context!,ports,{enabled:true});
 if(!runtime)throw Error('B2B_SUNAT_COMPLETE_HOST_BINDINGS_REQUIRED');
 try{await runtime.start();return runtime;}catch{await runtime.close().catch(()=>{});throw Error('B2B_SUNAT_HOST_START_FAILED');}
}
if(require.main===module){
 void bootstrapB2bSunatHost({enabled:process.env.B2B_SUNAT_RUNTIME_ENABLED==='true',configRoot:process.env.B2B_SUNAT_CONFIG_ROOT})
  .catch(()=>{process.stderr.write('B2B_SUNAT_COMPLETE_HOST_NOT_READY\n');process.exitCode=1;});
}
