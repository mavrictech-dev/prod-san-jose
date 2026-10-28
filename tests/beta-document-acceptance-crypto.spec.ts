import 'reflect-metadata';
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {X509Certificate} from 'node:crypto';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {BetaOwnerXmlTrust,PinnedBetaIssuerPublicCertificates} from '../services/sunat-service/src/infrastructure/crypto/beta-owner-xml-trust';
import {XmlSignerService,parseSafeInvoice,verifyLocalSignedInvoice} from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import {documentEvidenceFixture,AS_OF} from './helpers/beta-document-evidence.fixture';
import {supplementCommandFixture} from './helpers/fiscal-supplement.fixture';
import {buildFiscalBatchUbl} from '../packages/sunat-core/src/fiscal-batch';
import {buildFiscalNoteUbl} from '../packages/sunat-core/src/fiscal-note';
const forge=createRequire(new URL('../services/sunat-service/package.json',import.meta.url))('node-forge') as typeof import('node-forge');
function certificate(serial:string,ruc:string,issuer?:{cert:import('node-forge').pki.Certificate;key:import('node-forge').pki.rsa.PrivateKey}){
  const keys=forge.pki.rsa.generateKeyPair(2048),cert=forge.pki.createCertificate();cert.publicKey=keys.publicKey;cert.serialNumber=serial;
  cert.validity.notBefore=new Date('2025-01-01T00:00:00Z');cert.validity.notAfter=new Date('2030-01-01T00:00:00Z');
  cert.setSubject([{name:'commonName',value:'SYNTHETIC ONLY '+serial},{type:'2.5.4.97',value:'NTRPE-'+ruc}]);cert.setIssuer(issuer?.cert.subject.attributes??cert.subject.attributes);
  cert.setExtensions([{name:'basicConstraints',critical:true,cA:!issuer},{name:'keyUsage',critical:true,digitalSignature:!!issuer,keyCertSign:!issuer,cRLSign:!issuer}]);cert.sign(issuer?.key??keys.privateKey,forge.md.sha256.create());
  return {cert,key:keys.privateKey,pem:forge.pki.certificateToPem(cert)};
}
function makeRoot(){return certificate('01','00000000001');}
let leaf:ReturnType<typeof certificate>,cdrLeaf:ReturnType<typeof certificate>,root:ReturnType<typeof makeRoot>;
beforeAll(()=>{root=makeRoot();leaf=certificate('02','20100070970',root);cdrLeaf=certificate('03','20131312955',root);},30000);
function sign(xml:string,c:typeof leaf,kind:'Invoice'|'CreditNote'|'DebitNote'|'ApplicationResponse'|'SummaryDocuments'|'VoidedDocuments'){
  const p12=Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(c.key,[c.cert,root.cert],'SYNTHETIC-PASSWORD',{algorithm:'aes256'})).getBytes(),'binary');
  return new XmlSignerService().sign(xml,p12,'SYNTHETIC-PASSWORD',kind);
}
function fixture(type:'01'|'07'|'08'='01'){
  const f=documentEvidenceFixture(type),signed=sign(f.unsigned,leaf,type==='01'?'Invoice':type==='07'?'CreditNote':'DebitNote');f.setXml(Buffer.from(signed.xml));
  f.record.signerFingerprint=signed.certificateFingerprintSha256;f.record.digestValue=signed.digestValue;
  const cdrUnsigned=f.cdr.toString();f.setCdr(Buffer.from(sign(cdrUnsigned,cdrLeaf,'ApplicationResponse').xml));
  // Test policy port only: this is not an official CRL or a deployment trust store.
  const trust={evaluate:vi.fn(async(metadata:any,ruc:string,now:Date)=>({profile:'OFFLINE-PINNED-ROOTS-CRL-v1' as const,
    chainValid:new X509Certificate(metadata.certificatePem).verify(new X509Certificate(root.pem).publicKey),identityMatched:metadata.subjectRucCandidates[0]===ruc,
    revocation:'VERIFIED_OFFLINE_CRL' as const,trustStoreSha256:'c'.repeat(64),certificateFingerprint:metadata.fingerprint,checkedAt:now.toISOString(),blockers:[]}))};
  const certificates={load:vi.fn(async()=>({certificatePem:leaf.pem,chainPems:[root.pem]}))},adapter=new BetaOwnerXmlTrust(certificates,trust);
  f.ports.verifyIssuer.mockImplementation((...args:any[])=>adapter.verifyIssuer(args[0],args[1],args[2],args[3]));
  f.ports.verifyCdr.mockImplementation(async(bytes:Buffer)=>{try{verifyLocalSignedInvoice(bytes.toString(),cdrLeaf.pem,cdrUnsigned,'ApplicationResponse');return true;}catch{return false;}});
  return {...f,adapter,certificates,trust};
}
describe('Owner document evidence with actual ephemeral XMLDSig, no official PKI claim',()=>{
  it.each(['RC','RA','NOTE'] as const)('verifies the complete %s envelope with an ephemeral issuer signature',async kind=>{
    const f=fixture(),data=supplementCommandFixture(kind),envelope=data.command.payload.envelope;
    const unsigned=envelope.kind==='NOTE'?buildFiscalNoteUbl(envelope.note,envelope.context):buildFiscalBatchUbl(envelope.batch,envelope.asOf);
    const signed=sign(unsigned,leaf,kind==='NOTE'?'CreditNote':kind==='RC'?'SummaryDocuments':'VoidedDocuments');
    await expect(f.adapter.verifyEnvelope(envelope,signed.certificateFingerprintSha256,Buffer.from(signed.xml),AS_OF)).resolves.toMatchObject({digestValue:signed.digestValue});
    await expect(f.adapter.verifyEnvelope(envelope,signed.certificateFingerprintSha256,Buffer.from(signed.xml.replace('2026-10-02','2026-10-01')),AS_OF)).rejects.toThrow();
  });
  it.each(['01','07','08'] as const)('verifies real full-body signatures for %s and its CDR',async type=>{
    const f=fixture(type);await expect(f.run()).resolves.toMatchObject({evidence:{documentTypeCode:type},fiscalExecutionEnabled:false});
    expect(f.certificates.load).toHaveBeenCalledWith(f.doc.issuer.identityNumber,f.record.signerFingerprint);
  });
  it.each(['body','digest','KeyInfo','wrapping'])('rejects tampered issuer XML: %s',async mode=>{
    const f=fixture();let xml=f.xml.toString();
    if(mode==='body')xml=xml.replace('BIEN FICTICIO','ALTERADO');
    if(mode==='digest')xml=xml.replace(/(<(?:\w+:)?DigestValue>)([A-Za-z0-9+/])/u,(_match,prefix,letter)=>prefix+(letter==='A'?'B':'A'));
    if(mode==='KeyInfo')xml=xml.replace(/<(?:\w+:)?X509Certificate>[\s\S]*?<\/(?:\w+:)?X509Certificate>/,`<X509Certificate xmlns="http://www.w3.org/2000/09/xmldsig#">${new X509Certificate(cdrLeaf.pem).raw.toString('base64')}</X509Certificate>`);
    if(mode==='wrapping')xml=xml.replace('</Invoice>','<cac:AdditionalDocumentReference><cbc:ID Id="wrap">WRAP</cbc:ID></cac:AdditionalDocumentReference></Invoice>');
    f.setXml(Buffer.from(xml));await expect(f.run()).rejects.toMatchObject({code:'ISSUER_SIGNATURE_UNTRUSTED'});
  });
  it('rejects a valid signature over a different full snapshot body',async()=>{
    const f=fixture();f.setXml(Buffer.from(sign(f.unsigned.replace('BIEN FICTICIO','OTRO BIEN'),leaf,'Invoice').xml));
    await expect(f.run()).rejects.toMatchObject({code:'ISSUER_SIGNATURE_UNTRUSTED'});
  });
  it('does not accept an intact CDR with a broken signature even after hashes are updated',async()=>{
    const f=fixture();f.setCdr(Buffer.from(f.cdr.toString().replace('SIMULADO NO OFICIAL','OTRO TEXTO')));
    await expect(f.run()).rejects.toMatchObject({code:'CDR_SIGNATURE_UNTRUSTED'});
  });
  it.each(['chain','identity','revocation','blockers','store'])('requires all owner trust checks: %s',async mode=>{
    const f=fixture(),proof=await f.trust.evaluate({certificatePem:leaf.pem,subjectRucCandidates:[f.doc.issuer.identityNumber],fingerprint:f.record.signerFingerprint},f.doc.issuer.identityNumber,new Date(AS_OF));
    if(mode==='chain')proof.chainValid=false;if(mode==='identity')proof.identityMatched=false;if(mode==='revocation')(proof as any).revocation='PENDING';if(mode==='blockers')(proof.blockers as string[]).push('EXPIRED');if(mode==='store')(proof as any).trustStoreSha256=null;
    f.trust.evaluate.mockResolvedValueOnce(proof);await expect(f.run()).rejects.toMatchObject({code:'ISSUER_SIGNATURE_UNTRUSTED'});
  });
  it('uses an external certificate pin, not embedded KeyInfo as authority',async()=>{
    const f=fixture();f.certificates.load.mockResolvedValueOnce({certificatePem:cdrLeaf.pem,chainPems:[root.pem]});await expect(f.run()).rejects.toMatchObject({code:'ISSUER_SIGNATURE_UNTRUSTED'});
  });
  it('requires explicit public pin metadata without probing arbitrary files',async()=>{
    expect(()=>new PinnedBetaIssuerPublicCertificates([])).toThrow();
    expect(()=>new PinnedBetaIssuerPublicCertificates([{issuerRuc:'20100070970',fingerprint:'a'.repeat(64),sha256:'b'.repeat(64),path:'relative.pem'}])).toThrow();
    const loader=new PinnedBetaIssuerPublicCertificates([{issuerRuc:'20100070970',fingerprint:'a'.repeat(64),sha256:'b'.repeat(64),path:resolve('synthetic-not-opened/issuer.pem')}]);
    await expect(loader.load('00000000001','a'.repeat(64))).rejects.toThrow('NOT_PINNED');
  });
});
