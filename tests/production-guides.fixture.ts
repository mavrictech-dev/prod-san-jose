import { generateKeyPairSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { guidePreparationBody } from './helpers/guide-preparation.fixture';
import { createProductionGuidesSigner,createProductionGuidesVerifier,productionGuidesHash as hash } from '../packages/sunat-core/src/production-guides';
import type { ProductionGuidesSnapshot as Snapshot,ProductionGuidesReference09 as Reference } from '../packages/contracts/src/production-guides';
export const uuid=(n:number)=>`00000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
export const now='2026-10-23T16:00:00.000Z';
export function snapshot09():Snapshot{
 const body=guidePreparationBody();body.issueDate='2026-10-23T15:00:00.000Z';body.transferDate='2026-10-24';
 return {schemaVersion:'factuez.production-guides.v1',documentId:uuid(1),operationId:uuid(2),actorId:uuid(3),scope:{companyId:1,issuerRuc:body.sender.ruc,branchId:uuid(4),pointId:uuid(5),seriesCounterId:uuid(6),establishmentCode:'0001'},issuer:body.sender,documentType:'09',profile:'GRE09_PRIVATE04_V1',series:'T991',number:'1',body,grantVersion:1,createdAt:now,environment:'PRODUCTION'};
}
export function snapshotPublic09():Snapshot{
 const s=snapshot09(),b=s.body as any;s.profile='GRE09_PUBLIC01_V1';s.body={issueDate:'2026-10-23T12:00:00.000Z',transferDate:b.transferDate,sender:b.sender,recipient:{ruc:'20000000036',legalName:'DESTINATARIO FICTICIO'},origin:{ubigeo:b.origin.ubigeo,address:b.origin.address},destination:{ubigeo:b.destination.ubigeo,address:b.destination.address},carrier:{ruc:'20000000028',legalName:'TRANSPORTISTA FICTICIO'},grossWeight:b.grossWeight,weightUnit:b.weightUnit,items:b.items,transportMode:'01',regulatedGoods:false,reasonCode:'01',mtcRegistration:'MTC00031'};return s;
}
export function snapshot31(){
 const source=snapshotPublic09(),p=source.body as any,projection={schemaVersion:'factuez.carrier-reference09-owner.v1',documentId:source.documentId,documentType:'09',issuer:source.issuer,series:source.series,number:source.number,...Object.fromEntries(['issueDate','transferDate','sender','recipient','origin','destination','carrier','grossWeight','weightUnit','items','transportMode','regulatedGoods'].map(k=>[k,p[k]]))};
 const ref:Reference={snapshot:source,projection,projectionSha256:hash(projection),cdrZipSha256:'a'.repeat(64),source:'SUNAT_OFFICIAL',signatureTrusted:true,state:'ACCEPTED',acceptedAt:'2026-10-23T14:00:00.000Z'};
 const s=snapshot09();s.documentId=uuid(31);s.operationId=uuid(32);s.documentType='31';s.profile='GRE31_PUBLIC_SINGLE09_V1';s.issuer=p.carrier;s.scope.issuerRuc=p.carrier.ruc;s.series='V991';s.body={issueDate:'2026-10-23T15:00:00.000Z',transferDate:p.transferDate,sender:p.sender,recipient:p.recipient,origin:p.origin,destination:p.destination,grossWeight:p.grossWeight,weightUnit:p.weightUnit,items:p.items,transport:{mode:'01',carrier:{...p.carrier,mtcRegistration:p.mtcRegistration},vehicle:{plate:'ABC931',tuc:'TUC00031'},driver:{identityType:'1',identityNumber:'00000001',firstName:'CONDUCTOR',lastName:'FICTICIO',license:'A000000031'}},reference09:{documentId:source.documentId,issuerRuc:source.issuer.ruc,series:source.series,number:source.number,snapshotSha256:hash(projection)},totalTransfer:true,freightPayer:'SENDER',subcontracted:false,regulatedGoods:false};return {s,ref};
}
export function seals(){const owner=generateKeyPairSync('ed25519'),sunat=generateKeyPairSync('ed25519'),keys=new Map([['billing',owner.publicKey],['sunat',sunat.publicKey]]);return {ownerSigner:createProductionGuidesSigner('billing',owner.privateKey),statusSigner:createProductionGuidesSigner('sunat',sunat.privateKey),verifier:createProductionGuidesVerifier(keys),keys,owner,sunat};}
/** Fresh CA and leaf keys in memory; loopback-only server/client certificate. */
export function tlsFixture(){
 const local=createRequire(new URL('../services/sunat-service/package.json',import.meta.url));const forge:typeof import('node-forge')=local('node-forge');
 const caKeys=forge.pki.rsa.generateKeyPair(2048),leafKeys=forge.pki.rsa.generateKeyPair(2048);
 const ca=forge.pki.createCertificate();ca.publicKey=caKeys.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+86400000);ca.setSubject([{name:'commonName',value:'SYNTHETIC GRE TEST ROOT'}]);ca.setIssuer(ca.subject.attributes);ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(caKeys.privateKey,forge.md.sha256.create());
 const leaf=forge.pki.createCertificate();leaf.publicKey=leafKeys.publicKey;leaf.serialNumber='02';leaf.validity.notBefore=ca.validity.notBefore;leaf.validity.notAfter=ca.validity.notAfter;leaf.setSubject([{name:'commonName',value:'localhost'}]);leaf.setIssuer(ca.subject.attributes);leaf.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true,clientAuth:true},{name:'subjectAltName',altNames:[{type:7,ip:'127.0.0.1'},{type:2,value:'localhost'}]}]);leaf.sign(caKeys.privateKey,forge.md.sha256.create());
 return {ca:Buffer.from(forge.pki.certificateToPem(ca)),cert:Buffer.from(forge.pki.certificateToPem(leaf)),key:Buffer.from(forge.pki.privateKeyToPem(leafKeys.privateKey))};
}
