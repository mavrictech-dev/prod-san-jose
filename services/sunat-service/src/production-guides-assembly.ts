import type { KeyObject } from 'node:crypto';
import type { ProductionGuidesGrant as Grant } from '@factuez/contracts/production-guides';
import { createProductionGuidesSigner,createProductionGuidesVerifier,productionGuidesHash as hash,productionGuidesExact,PRODUCTION_GUIDES_XSD_SHA256 } from '@factuez/sunat-core/dist/production-guides';
import { ProductionGuidesPrivateHttp,type ProductionGuidesPrivateTls } from '@factuez/sunat-core/dist/production-guides-private';
import { SecretVault } from './infrastructure/crypto/secret-vault';
import { CertificateTrustService } from './infrastructure/crypto/certificate-trust.service';
import { CdrSignatureTrustService } from './infrastructure/crypto/cdr-signature-trust.service';
import { XsdValidationService } from './infrastructure/sunat/xsd-validation.service';
import { ProductionGuidesVaultSecrets,ProductionGuidesNativeCrypto,ProductionGuidesCatalogueRules,type ProductionGuidesCatalogue } from './production-guides-crypto';
import { ProductionGuidesHttps,ProductionGuidesRest } from './production-guides-transport';
import { ProductionGuidesStore,type ProductionGuidesDatabase } from './production-guides-store';
import { ProductionGuidesService } from './production-guides-service';
import { ProductionGuidesBillingPrivateClient,type ProductionGuidesGrantEvidence } from './production-guides-private';
import { ProductionGuidesSunatRuntime } from './production-guides-runtime';
import { renderProductionGuidesPdf } from './production-guides-pdf';
export type ProductionGuidesSunatAssemblyInput={database:ProductionGuidesDatabase;enabled?:()=>boolean;runWorkers?:boolean;
 vaultKey:Buffer;statusSigning:{keyId:string;key:KeyObject};ownerPublicKeys:ReadonlyMap<string,KeyObject>;
 billing:{origin:string;tls:ProductionGuidesPrivateTls;allowedPeerFingerprints:readonly string[]};
 catalogues:readonly ProductionGuidesCatalogue[];now?:()=>string;
};
/** Fully native production composition. Construction performs no secret read, OAuth, signing, scheduling or migration. */
export function createProductionGuidesSunat(input:ProductionGuidesSunatAssemblyInput){
 const enabled=input.enabled??(()=>false),privateHttp=new ProductionGuidesPrivateHttp(input.billing.origin,input.billing.tls),billing=new ProductionGuidesBillingPrivateClient(privateHttp);
 const vault=new SecretVault(input.vaultKey),secrets=new ProductionGuidesVaultSecrets(input.database,vault),trust=new CertificateTrustService(),cdr=new CdrSignatureTrustService(trust),xsd=new XsdValidationService();
 const catalogue=new Map(input.catalogues.map(c=>[c.issuerRuc,structuredClone(c)]));if(catalogue.size!==input.catalogues.length)throw Error('GRE_DUPLICATE_CATALOGUE');
 const readCatalogue=async(ruc:string)=>{const schema=(await input.database.$queryRawUnsafe<any[]>(`SELECT to_regclass('"ProductionGuidesCatalogue"') IS NOT NULL AS ready`))[0]?.ready;if(schema){const row=(await input.database.$queryRawUnsafe<any[]>('SELECT payload FROM "ProductionGuidesCatalogue" WHERE "issuerRuc"=$1 ORDER BY revision DESC LIMIT 1',ruc))[0];if(row)return row.payload as ProductionGuidesCatalogue;}return catalogue.get(ruc);};
 const rules={validate:async(s:Parameters<ProductionGuidesCatalogueRules['validate']>[0],g:Grant)=>{const c=await readCatalogue(s.issuer.ruc);if(!c)throw Error('GRE_CATALOGUE_MISSING');await new ProductionGuidesCatalogueRules(c).validate(s,g);}};
 const crypto=new ProductionGuidesNativeCrypto(secrets,trust,xsd,rules,input.now?()=>new Date(input.now!()):undefined);
 const transport=new ProductionGuidesRest({http:new ProductionGuidesHttps(),credentials:secrets,authorize:async(action,g)=>{
  if(!enabled()||!['OAUTH_GRE','SUBMIT_GRE','QUERY_TICKET'].includes(action))throw Error('GRE_ACTION_DISABLED');await billing.currentGrant(g);await secrets.inspect(g);
 }});
 const store=new ProductionGuidesStore(input.database,createProductionGuidesSigner(input.statusSigning.keyId,input.statusSigning.key),transport.source);
 let service:ProductionGuidesService;
 service=new ProductionGuidesService(store,{enabled,owner:{current:e=>billing.current(e),reference09:s=>service.reference09(s)},referenceOwner:s=>billing.referenceOwner(s),ownerVerifier:createProductionGuidesVerifier(input.ownerPublicKeys),crypto,transport,cdr,pdf:renderProductionGuidesPdf,now:input.now});
 const grantEvidence:ProductionGuidesGrantEvidence=async(scope,profiles,revision)=>{
  if(!enabled())throw Error('GRE_DISABLED');productionGuidesExact(scope,['companyId','issuerRuc','branchId','pointId','seriesCounterId','establishmentCode']);
  const c=await readCatalogue(scope.issuerRuc);if(!c||c.companyId!==scope.companyId||!profiles.length||profiles.some(p=>!['GRE09_PRIVATE04_V1','GRE09_PUBLIC01_V1','GRE31_PUBLIC_SINGLE09_V1'].includes(p)))throw Error('GRE_PROFILE_OR_OWNER_UNCONFIGURED');
  const binding=await secrets.configuration(scope.issuerRuc,revision);await crypto.readyGrant(binding);
  if(!await cdr.configured())throw Error('GRE_CDR_TRUST_UNAVAILABLE');
  return {...binding,rulesSha256:hash(c),xsdSha256:PRODUCTION_GUIDES_XSD_SHA256};
 };
 const runtime=new ProductionGuidesSunatRuntime(service,store,e=>billing.receive(e),enabled).enableLifecycle(input.runWorkers===true);
 const readiness=async(scope:{companyId:number;issuerRuc:string})=>{
  const blockers:string[]=[];const c=await readCatalogue(scope.issuerRuc);
  if(!enabled())blockers.push('Activación explícita y workers GRE pendientes');
  if(!c||c.companyId!==scope.companyId)blockers.push('Catálogo de bienes, rutas y transportes revisado pendiente');
  const schema=(await input.database.$queryRawUnsafe<any[]>(`SELECT to_regclass('"ProductionGuidesJob"') IS NOT NULL AS ready`))[0]?.ready;if(!schema)blockers.push('Migración GRE SUNAT pendiente');
  const row=(await input.database.$queryRawUnsafe<any[]>('SELECT "revision" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND "environment"=\'PRODUCTION\'',scope.issuerRuc))[0];
  if(!row)blockers.push('Credenciales GRE/SOL y certificado de producción pendientes');
  else {try{const b=await secrets.configuration(scope.issuerRuc,row.revision);await crypto.readyGrant(b);}catch{blockers.push('Credenciales, certificado, confianza PKI/CRL o XSD no válidos');}}
  if(!await cdr.configured())blockers.push('Confianza de firmas CDR pendiente');
  return {ready:blockers.length===0,blockers,credentialRevision:row?.revision??null,rulesSha256:c?hash(c):null,catalogue:c&&c.companyId===scope.companyId?{goods:c.goods,units:c.units,routes:c.routes,vehicles:c.vehicles,drivers:c.drivers}:null};
 };
 return {service,store,runtime,grantEvidence,readiness,catalogueSource:(scope:{companyId:number;issuerRuc:string})=>billing.catalogueSource(scope),privatePeers:Object.freeze([...input.billing.allowedPeerFingerprints]),close:()=>{transport.clear();privateHttp.close();vault.onModuleDestroy();}};
}
