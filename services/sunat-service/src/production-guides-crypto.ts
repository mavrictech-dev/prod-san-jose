import type { ProductionGuidesGrant as Grant,ProductionGuidesSnapshot as Snapshot } from '@factuez/contracts/production-guides';
import { productionGuidesHash as hash,productionGuidesBytesHash,validateProductionGuidesSnapshot,PRODUCTION_GUIDES_XSD_SHA256 } from '@factuez/sunat-core/dist/production-guides';
import { signLocalGuideXml } from './infrastructure/crypto/guide-artifact-crypto';
import { inspectCertificate } from './infrastructure/crypto/certificate-inspector';
import type { SecretVault } from './infrastructure/crypto/secret-vault';
import type { CertificateTrustService } from './infrastructure/crypto/certificate-trust.service';
import type { XsdValidationService } from './infrastructure/sunat/xsd-validation.service';
import type { ProductionGuidesGreCredentials } from './production-guides-transport';
export type ProductionGuidesCredentialBinding=Pick<Grant,'issuerRuc'|'credentialRevision'|'certificateFingerprint'>;
export interface ProductionGuidesSecrets extends ProductionGuidesGreCredentials {
 inspect(grant:Grant):Promise<void>;
 withCertificate<T>(grant:Grant,work:(p12:Buffer,password:string)=>Promise<T>):Promise<T>;
}
export interface ProductionGuidesCrypto {
 ready(snapshot:Snapshot,grant:Grant):Promise<void>;
 sign(snapshot:Snapshot,grant:Grant,unsignedXml:string):Promise<{xml:Buffer;zip:Buffer;xmlSha256:string;zipSha256:string;fingerprint:string;digest:string}>;
}
/** Vault fields and AAD contexts distinguish GRE, SOL, and the signing key. No fallback between purposes. */
export class ProductionGuidesVaultSecrets implements ProductionGuidesSecrets {
 constructor(private readonly database:{$queryRawUnsafe<T>(sql:string,...args:any[]):Promise<T>},private readonly vault:Pick<SecretVault,'open'>){}
 async configuration(ruc:string,revision:number){
  const row=(await this.database.$queryRawUnsafe<any[]>('SELECT "revision","certificateFingerprint","certificateExpiresAt" FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND "environment"=\'PRODUCTION\'',ruc))[0];
  if(!row||row.revision!==revision||!/^[a-f0-9]{64}$/.test(row.certificateFingerprint??''))throw Error('GRE_CONFIG_CHANGED');
  const binding={issuerRuc:ruc,credentialRevision:revision,certificateFingerprint:row.certificateFingerprint};await this.row(binding);return binding;
 }
 private async row(g:ProductionGuidesCredentialBinding){
  const r=(await this.database.$queryRawUnsafe<any[]>('SELECT * FROM "SunatCredentials" WHERE "issuerRuc"=$1 AND "environment"=\'PRODUCTION\'',g.issuerRuc))[0];
  if(!r||r.revision!==g.credentialRevision||r.certificateFingerprint!==g.certificateFingerprint||r.certificateSelfSigned!==false||!r.certificateExpiresAt||new Date(r.certificateExpiresAt).getTime()<=Date.now()||!['certificateCipher','certificatePasswordCipher','greClientIdCipher','greClientSecretCipher','solUsernameCipher','solPasswordCipher'].every(k=>typeof r[k]==='string'&&r[k]))throw Error('GRE_CREDENTIAL_REVISION_OR_FIELDS_INVALID');return r;
 }
 async inspect(g:Grant){await this.row(g);}
 async withCertificate<T>(g:ProductionGuidesCredentialBinding,work:(p12:Buffer,password:string)=>Promise<T>){const r=await this.row(g);const p12=this.vault.open(r.certificateCipher,{ruc:g.issuerRuc,environment:'PRODUCTION',field:'certificate'});let pass:Buffer|undefined;try{pass=this.vault.open(r.certificatePasswordCipher,{ruc:g.issuerRuc,environment:'PRODUCTION',field:'certificatePassword'});return await work(p12,pass.toString('utf8'));}finally{p12.fill(0);pass?.fill(0);}}
 async withGre<T>(g:Grant,work:(gre:{clientId:string;clientSecret:string},sol:{username:string;password:string})=>Promise<T>){
  const r=await this.row(g),buffers:Buffer[]=[];const open=(field:string,column:string)=>{const b=this.vault.open(r[column],{ruc:g.issuerRuc,environment:'PRODUCTION',field});buffers.push(b);return b.toString('utf8');};
  try{return await work({clientId:open('greClientId','greClientIdCipher'),clientSecret:open('greClientSecret','greClientSecretCipher')},{username:open('solUsername','solUsernameCipher'),password:open('solPassword','solPasswordCipher')});}finally{buffers.forEach(b=>b.fill(0));}
 }
}
export type ProductionGuidesCatalogue={version:'factuez.production-guides.catalogue.v1';companyId:number;issuerRuc:string;
 sourceUrl:string;sourceSha256:string;units:string[];ubigeos:string[];
 goods:{code:string;description:string;unitCode:string;classification:'NON_REGULATED'}[];
 routes:{origin:unknown;destination:unknown}[];vehicles:unknown[];drivers:unknown[]};
/** Pinned reviewed narrow catalogue, not a claim of running all SUNAT XSL rules. */
export class ProductionGuidesCatalogueRules {
 #catalogue:ProductionGuidesCatalogue;
 constructor(catalogue:ProductionGuidesCatalogue){this.#catalogue=structuredClone(catalogue);}
 async validate(snapshot:Snapshot,g:Grant){
  const s=validateProductionGuidesSnapshot(snapshot),b=s.body as any,c=this.#catalogue;
  if(c.version!=='factuez.production-guides.catalogue.v1'||c.companyId!==s.scope.companyId||c.issuerRuc!==s.issuer.ruc||hash(c)!==g.rulesSha256||!/^https:\/\/(?:cpe\.|www\.)?sunat\.gob\.pe\//.test(c.sourceUrl)||!/^[a-f0-9]{64}$/.test(c.sourceSha256))throw Error('GRE_CATALOGUE_PIN_INVALID');
  if(![b.origin.ubigeo,b.destination.ubigeo].every(x=>c.ubigeos.includes(x))||!c.routes.some(x=>hash(x.origin)===hash(b.origin)&&hash(x.destination)===hash(b.destination))||b.items.some((i:any)=>!c.units.includes(i.unitCode)||!c.goods.some(x=>x.classification==='NON_REGULATED'&&x.code===i.code&&x.description===i.description&&x.unitCode===i.unitCode)))throw Error('GRE_CATALOGUE_NOT_APPROVED');
  if(b.transport?.vehicle&&!c.vehicles.some(x=>hash(x)===hash(b.transport.vehicle))||b.transport?.driver&&!c.drivers.some(x=>hash(x)===hash(b.transport.driver)))throw Error('GRE_TRANSPORT_NOT_APPROVED');
 }
}
export class ProductionGuidesNativeCrypto implements ProductionGuidesCrypto {
 constructor(private readonly secrets:ProductionGuidesSecrets,private readonly trust:Pick<CertificateTrustService,'evaluate'>,private readonly xsd:Pick<XsdValidationService,'configured'|'validate'>,private readonly rules:Pick<ProductionGuidesCatalogueRules,'validate'>,private readonly now=()=>new Date()){}
 private async trusted(g:ProductionGuidesCredentialBinding,p12:Buffer,password:string){
  const metadata=inspectCertificate(p12,password,this.now());if(metadata.fingerprint!==g.certificateFingerprint)throw Error('GRE_CERTIFICATE_PIN_MISMATCH');
  const proof=await this.trust.evaluate(metadata,g.issuerRuc,this.now());
  if(proof.profile!=='OFFLINE-PINNED-ROOTS-CRL-v1'||!proof.chainValid||!proof.identityMatched||proof.revocation!=='VERIFIED_OFFLINE_CRL'||proof.blockers.length||proof.certificateFingerprint!==g.certificateFingerprint||!/^[a-f0-9]{64}$/.test(proof.trustStoreSha256??''))throw Error('GRE_CERTIFICATE_UNTRUSTED');
 }
 async readyGrant(binding:ProductionGuidesCredentialBinding){if(!await this.xsd.configured())throw Error('GRE_XSD_UNAVAILABLE');await this.secrets.withCertificate(binding as Grant,async(p12,pass)=>this.trusted(binding,p12,pass));}
 async ready(s:Snapshot,g:Grant){await this.rules.validate(s,g);await this.secrets.inspect(g);if(g.xsdSha256!==PRODUCTION_GUIDES_XSD_SHA256||!await this.xsd.configured())throw Error('GRE_XSD_UNAVAILABLE');await this.secrets.withCertificate(g,async(p12,pass)=>this.trusted(g,p12,pass));}
 async sign(s:Snapshot,g:Grant,unsignedXml:string){
  await this.ready(s,g);const result=await this.secrets.withCertificate(g,async(p12,pass)=>{await this.trusted(g,p12,pass);return signLocalGuideXml({issuerRuc:s.issuer.ruc,documentType:s.documentType,fullNumber:`${s.series}-${s.number}`,unsignedXml},p12,pass);});
  const xml=Buffer.from(result.xml),proof=await this.xsd.validate(xml,'DespatchAdvice');
  if(proof.archiveSha256!==g.xsdSha256||proof.xmlSha256!==productionGuidesBytesHash(xml))throw Error('GRE_XSD_PROOF_MISMATCH');
  return {xml,zip:Buffer.from(result.zip),xmlSha256:result.xmlSha256,zipSha256:result.zipSha256,fingerprint:result.certificateFingerprintSha256,digest:result.digestValue};
 }
}
