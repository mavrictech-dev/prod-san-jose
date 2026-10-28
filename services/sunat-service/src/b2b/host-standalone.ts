import 'reflect-metadata';
import {Module,type DynamicModule,type INestApplicationContext} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {PrismaService} from '../infrastructure/prisma.service';
import {ArtifactStore} from '../infrastructure/artifact-store';
import {SecretVault} from '../infrastructure/crypto/secret-vault';
import {CertificateTrustService} from '../infrastructure/crypto/certificate-trust.service';
import {CdrSignatureTrustService} from '../infrastructure/crypto/cdr-signature-trust.service';
import {CertificateInspectionService} from '../infrastructure/crypto/certificate-inspection.service';
import {PinnedBetaIssuerPublicCertificates} from '../infrastructure/crypto/beta-owner-xml-trust';
import {CurrentPdfService} from '../application/current-pdf.service';
import {XsdValidationService} from '../infrastructure/sunat/xsd-validation.service';
import {CarrierReferenceValidation,PrismaCarrierReferenceOwnerBinding} from './carrier-reference-validation';
import {createB2bSunatRuntimeFromFiles} from './main';
import {loadSunatStandaloneMount,MountedCarrierReferencePins} from './host-config';
import {SunatHostCrypto,type SunatHostCryptoModules} from './host-crypto';
import {SunatHostKeys} from './host-keys';
import {createPrismaBatchMemberLedgerReader} from './batch-member-evidence-assembly';
import {createSunatHostAdministration} from './host-administration';
import type {B2bSunatOwnerRuntime} from './runtime';
type Mount=ReturnType<typeof loadSunatStandaloneMount>;
/** Trusted composition options, never read from JSON/HTTP/env. Tests can supply a
 * fictitious DB or an actual platform XSD implementation; the CLI supplies none. */
export interface SunatStandaloneOptions {
 prismaFactory?:(options:Mount['postgres'])=>PrismaService;
 cryptoModules?:SunatHostCryptoModules;xsd?:XsdValidationService;signals?:boolean;
}
@Module({})
export class SunatStandaloneContextModule {
 static owned(providers:DynamicModule['providers']):DynamicModule{return {module:SunatStandaloneContextModule,providers};}
}
/** This context has an enumerated provider list. No AppModule, legacy consumer,
 * producer, Redis, scheduler, migrations or automatic .env loader can be reached. */
export async function createSunatStandaloneContext(files:B2bRuntimeFiles,mount:Mount,crypto:SunatHostCrypto,options:SunatStandaloneOptions={}){
 const master=files.secretBytes(mount.vaultKeyFile);let db:PrismaService|undefined,vault:SecretVault|undefined,pdf:CurrentPdfService|undefined;
 try{
  if(master.length!==32)throw Error('SUNAT_VAULT_KEY_REQUIRED');
  vault=new SecretVault(master);db=options.prismaFactory?options.prismaFactory(mount.postgres):new PrismaService(mount.postgres);
  pdf=new CurrentPdfService();const artifacts=new ArtifactStore(mount.artifactsRoot),xsd=options.xsd??new XsdValidationService();
  if(!(xsd instanceof XsdValidationService))throw Error('SUNAT_XSD_IMPLEMENTATION_REQUIRED');
  const context=await NestFactory.createApplicationContext(SunatStandaloneContextModule.owned([
   {provide:PrismaService,useValue:db},{provide:ArtifactStore,useValue:artifacts},{provide:SecretVault,useValue:vault},
   {provide:CurrentPdfService,useValue:pdf},{provide:CertificateTrustService,useValue:crypto.trust},
   {provide:CdrSignatureTrustService,useValue:crypto.cdr},{provide:CertificateInspectionService,useValue:crypto.inspector},
   {provide:XsdValidationService,useValue:xsd},
  ]),{logger:false,abortOnError:false});
  return context;
 }catch{await db?.$disconnect().catch(()=>{});vault?.onModuleDestroy();pdf?.onModuleDestroy();throw Error('SUNAT_STANDALONE_CONTEXT_NOT_READY');}
 finally{master.fill(0);}
}
/** The standalone host owns ZERO producers/workers: none occur in the explicit
 * Nest provider list. Lifecycle closes actual custody, application context (DB,
 * PDF cache, vault) and PKI workers. It does not receipt any other process. */
export async function bootstrapStandaloneSunatHost(input:{enabled?:boolean;configRoot?:string},options:SunatStandaloneOptions={}):Promise<B2bSunatOwnerRuntime|null>{
 if(input.enabled!==true)return null;
 if(typeof input.configRoot!=='string'||!input.configRoot)throw Error('B2B_SUNAT_PRIVATE_CONFIG_ROOT_REQUIRED');
 let context:INestApplicationContext|undefined,runtime:B2bSunatOwnerRuntime|undefined,crypto:SunatHostCrypto|undefined,keys:SunatHostKeys|undefined;
 let stage:'MOUNT'|'CRYPTO'|'AUTHORITY'|'CONTEXT'|'ASSEMBLY'|'LISTEN'='MOUNT';
 try{
  const files=new B2bRuntimeFiles(input.configRoot),mount=loadSunatStandaloneMount(files,input.configRoot),m=mount.runtime;
  const pins=new MountedCarrierReferencePins(files,mount.carrierPinsFile,m.issuerPublicPins);
  stage='CRYPTO';crypto=new SunatHostCrypto(mount.pki,options.cryptoModules);await crypto.assertInfrastructure();
  const tls=(refs:{ca:string;cert:string;key:string})=>({ca:files.publicPem(refs.ca),cert:files.publicPem(refs.cert),key:files.privatePem(refs.key)});
  const identityTls=tls(mount.authorityTls),billingTls=tls(m.files.billingTls);
  let administration:ReturnType<typeof createSunatHostAdministration>;
  try{administration=createSunatHostAdministration(new B2bPrivateHttp(m.origins.identity,identityTls),new B2bPrivateHttp(m.origins.billing,billingTls));}
  finally{identityTls.key.fill(0);billingTls.key.fill(0);}
  stage='AUTHORITY';try{await administration.assertInfrastructure();}catch{throw Error('SUNAT_STANDALONE_IDENTITY_OWNER_AUTHORITY_REQUIRED');}
  stage='CONTEXT';
  context=await createSunatStandaloneContext(files,mount,crypto,options);
  const db=context.get(PrismaService),xsd=context.get(XsdValidationService),certificates=new PinnedBetaIssuerPublicCertificates(m.issuerPublicPins);
  keys=new SunatHostKeys(files,mount.keys,crypto.inspector);
  const custody=keys,ownedContext=context,ownedCrypto=crypto;
  let storageClosing:Promise<void>|undefined;
  const closeStorage=()=>storageClosing??=(async()=>{try{await ownedContext.close();}finally{await ownedCrypto.close();}})();
  const core=new CarrierReferenceValidation({owner:new PrismaCarrierReferenceOwnerBinding(db),pins,certificates,trust:crypto.trust,cdr:crypto.cdr,xsd});
  const batchMemberEvidence=mount.batchEvidenceProfile?createPrismaBatchMemberLedgerReader(db,{artifacts:context.get(ArtifactStore),certificates,trust:crypto.trust,cdr:crypto.cdr}):undefined;
  stage='ASSEMBLY';runtime=(await createB2bSunatRuntimeFromFiles(files,context,{drain:new B2bOwnerDrain({enabled:true,maxConcurrent:32}),guideKeys:keys,batchKeys:keys,
   privileged:administration,lifecycle:{
    async stopProducers(){/* No producer providers are constructed by this host. */},
    async stopWorkers(){await custody.close();},
    async closeOtherOwnerListeners(){/* The runtime owns both listeners; no additional owner server exists. */},
    closeStorage,
   }},{enabled:true,carrierReference:core,batchMemberEvidence}))??undefined;
  if(!runtime)throw Error('SUNAT_STANDALONE_RUNTIME_REQUIRED');
  if(options.signals!==false){const ownedRuntime=runtime,close=runtime.close.bind(runtime);
   const signal=()=>{void ownedRuntime.close().catch(()=>{process.stderr.write('SUNAT_STANDALONE_SHUTDOWN_INCOMPLETE\n');process.exitCode=1;});};
   runtime.close=()=>{process.off('SIGTERM',signal);process.off('SIGINT',signal);return close();};
   process.once('SIGTERM',signal);process.once('SIGINT',signal);
  }
  stage='LISTEN';await runtime.start();return runtime;
 }catch(error){
  if(runtime){
   // A failed drain is not cancellation. Keep storage/custody alive behind work
   // that may still be completing its transaction or audit after disconnect.
   try{await runtime.close();}catch{throw Error('SUNAT_STANDALONE_STARTUP_WORK_STILL_ACTIVE');}
  }else{
   await keys?.close();await context?.close();await crypto?.close();
  }
  // Fixed boundary diagnostics identify our missing composition ports, never DB,
  // PEM/P12/password, worker errors or untrusted upstream response diagnostics.
  if(error instanceof Error&&['SUNAT_STANDALONE_IDENTITY_OWNER_AUTHORITY_REQUIRED','SUNAT_STANDALONE_MOUNT_INVALID','SUNAT_STANDALONE_CONTEXT_NOT_READY','SUNAT_HOST_CRYPTO_UNAVAILABLE'].includes(error.message))throw error;
  if(error instanceof Error&&/^B2B_SUNAT_MOUNTED_RUNTIME_NOT_READY_(METADATA|DI|FACTORY|CAPABILITIES|CONCRETE_CRYPTO_DI_REQUIRED|B2B_SUNAT_RUNTIME_DEPENDENCIES_REQUIRED|B2B_SUNAT_RUNTIME_STORAGE_NOT_READY|B2B_SUNAT_COMPLETE_CAPABILITIES_REQUIRED)$/.test(error.message))throw error;
  throw Error('SUNAT_STANDALONE_START_FAILED_'+stage);
 }
}
