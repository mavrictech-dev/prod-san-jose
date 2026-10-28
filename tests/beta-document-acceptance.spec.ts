import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {isBetaOwnerDocumentAcceptance,verifyBetaDocumentAcceptance} from '../services/sunat-service/src/application/beta-document-acceptance';
import {documentEvidenceFixture,AS_OF,zipSync,hash} from './helpers/beta-document-evidence.fixture';
describe('B2B-06 individual owner XML/CDR evidence, no fiscal activation',()=>{
  it.each(['01','07','08'] as const)('binds %s to authoritative snapshot, XML, CDR and version fences',async type=>{
    const f=documentEvidenceFixture(type),r=await f.run();expect(r.evidence).toMatchObject({documentId:f.doc.documentId,snapshotSha256:f.snapshotHash(),cdrSha256:hash(f.zip),responseCode:'0'});
    expect(r).toMatchObject({candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false});expect(f.ports.load).toHaveBeenCalledTimes(2);expect(f.ports.read).toHaveBeenCalledTimes(6);
    expect(isBetaOwnerDocumentAcceptance(r)).toBe(true);expect(isBetaOwnerDocumentAcceptance(structuredClone(r))).toBe(false);expect(isBetaOwnerDocumentAcceptance(JSON.parse(JSON.stringify(r)))).toBe(false);
    expect(Object.isFrozen(r.evidence.source)).toBe(true);expect(Object.isFrozen(r.fence)).toBe(true);
  });
  it('keeps observed acceptance separate from plain acceptance',async()=>{const f=documentEvidenceFixture('01',true);expect((await f.run()).evidence.status).toBe('ACCEPTED_WITH_OBSERVATIONS');});
  it.each(['PRODUCTION','03','09','31'])('rejects unsupported environment/type before owner access: %s',async mode=>{
    const f=documentEvidenceFixture();if(mode==='PRODUCTION')f.doc.environment=mode;else(f.doc as any).documentTypeCode=mode;
    await expect(f.run()).rejects.toMatchObject({code:'INDIVIDUAL_BETA_REQUIRED'});expect(f.ports.load).not.toHaveBeenCalled();
  });
  it('does not trust missing/accepted-only/changed snapshots or acceptance times',async()=>{
    for(const mode of ['missing','changed','status','future','past']){
      const f=documentEvidenceFixture();
      if(mode==='missing')f.ports.load.mockResolvedValueOnce(null as any);
      if(mode==='changed')f.record.document.customer.legalName='ALTERADO';
      if(mode==='status')(f.record as any).status='REJECTED';
      if(mode==='future')f.record.completedAt='2027-01-01T00:00:00Z';
      if(mode==='past')f.record.completedAt='2026-10-01T00:00:00Z';
      await expect(f.run()).rejects.toThrow();expect(f.ports.verifyCdr).not.toHaveBeenCalled();
    }
  });
  it.each(['hash','size','empty','down'])('rejects stored artifact %s',async mode=>{
    const f=documentEvidenceFixture();if(mode==='hash')f.record.signedXml.sha256='f'.repeat(64);if(mode==='size')f.record.cdrZip.sizeBytes++;
    if(mode==='empty')f.ports.read.mockResolvedValueOnce(Buffer.alloc(0));if(mode==='down')f.ports.read.mockRejectedValueOnce(new Error('private path must not escape'));
    await expect(f.run()).rejects.toMatchObject({code:mode==='down'?'ARTIFACT_UNAVAILABLE':'ARTIFACT_MISMATCH'});
  });
  it.each(['issuer','digest','root','time','extra'])('does not accept an archived or mismatched trust proof: %s',async mode=>{
    const f=documentEvidenceFixture(),p=await f.ports.verifyIssuer();
    if(mode==='issuer')p.certificateFingerprint='f'.repeat(64);if(mode==='digest')p.digestValue=Buffer.alloc(32,9).toString('base64');if(mode==='root')p.trustStoreSha256='';if(mode==='time')p.checkedAt='2026-10-03T00:00:00Z';if(mode==='extra')(p as any).trusted=true;
    f.ports.verifyIssuer.mockResolvedValueOnce(p);await expect(f.run()).rejects.toMatchObject({code:'ISSUER_SIGNATURE_UNTRUSTED'});
  });
  it.each(['sender','receiver','reference','type','missing-type','duplicate','namespace','rejected','future','date'])('rejects CDR binding %s',async mode=>{
    const f=documentEvidenceFixture();let xml=f.cdr.toString();
    if(mode==='sender')xml=xml.replace('20131312955','00000000001');
    if(mode==='receiver')xml=xml.replace(f.doc.issuer.identityNumber,'00000000001');
    if(mode==='reference')xml=xml.replaceAll(f.doc.fullNumber,'FQ01-999');
    if(mode==='type')xml=xml.replace('<cbc:DocumentTypeCode>01','<cbc:DocumentTypeCode>07');
    if(mode==='missing-type')xml=xml.replace('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>','');
    if(mode==='duplicate')xml=xml.replace('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>','<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>'.repeat(2));
    if(mode==='namespace')xml=xml.replace('<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode>','<cbc:DocumentTypeCode>01</cbc:DocumentTypeCode><x:DocumentTypeCode xmlns:x="urn:forged">01</x:DocumentTypeCode>');
    if(mode==='rejected')xml=xml.replace('<cbc:ResponseCode>0','<cbc:ResponseCode>99');
    if(mode==='future')xml=xml.replace('2026-10-03','2027-01-01');
    if(mode==='date')xml=xml.replace('2026-10-03','2026-09-01');
    f.setCdr(Buffer.from(xml));await expect(f.run()).rejects.toThrow();
  });
  it.each(['name','duplicate-entry','crc','path','trailing'])('rejects malformed/ambiguous ZIP: %s',async mode=>{
    const f=documentEvidenceFixture(),name=`R-${f.doc.issuer.identityNumber}-01-${f.doc.fullNumber}.xml`;
    if(mode==='name')f.setZip(Buffer.from(zipSync({'wrong.xml':f.cdr})));
    if(mode==='duplicate-entry')f.setZip(Buffer.from(zipSync({[name]:f.cdr,'other.xml':f.cdr})));
    if(mode==='path')f.setZip(Buffer.from(zipSync({['../'+name]:f.cdr})));
    if(mode==='trailing')f.setZip(Buffer.concat([f.zip,Buffer.from('x')]));
    if(mode==='crc'){const bytes=Buffer.from(f.zip),central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(0,14);bytes.writeUInt32LE(0,central+16);f.setZip(bytes);}
    await expect(f.run()).rejects.toMatchObject({code:'CDR_INVALID'});
  });
  it.each(['false','throw'])('fails closed for untrusted CDR signature: %s',async mode=>{
    const f=documentEvidenceFixture();if(mode==='false')f.ports.verifyCdr.mockResolvedValueOnce(false);else f.ports.verifyCdr.mockRejectedValueOnce(new Error('trust unavailable'));
    await expect(f.run()).rejects.toMatchObject({code:'CDR_SIGNATURE_UNTRUSTED'});
  });
  it('detects owner version, file and caller mutation across verifier awaits',async()=>{
    for(const mode of ['record','file','input']){
      const f=documentEvidenceFixture();f.ports.verifyCdr.mockImplementationOnce(async()=>{
        if(mode==='record')f.record.version='f'.repeat(64);
        if(mode==='file')f.ports.read.mockResolvedValueOnce(Buffer.from('tampered'));
        if(mode==='input')f.doc.customer.legalName='MUTATED CALLER';return true;
      });await expect(f.run()).rejects.toMatchObject({code:mode==='record'?'OWNER_RECORD_CHANGED':mode==='file'?'ARTIFACT_MISMATCH':'INPUT_CHANGED'});
    }
  });
  it('accepts the bounded empty dummy directory but not new sources of trust',async()=>{
    const f=documentEvidenceFixture();f.setZip(Buffer.from(zipSync({[`R-${f.doc.issuer.identityNumber}-01-${f.doc.fullNumber}.xml`]:f.cdr,'dummy/':new Uint8Array()})));await expect(f.run()).resolves.toBeDefined();
  });
  it('keeps the runtime activation guards and synthetic protections intact',()=>{
    expect(readFileSync('services/billing-service/src/application/beta-supplement-command.service.ts','utf8')).toContain('never');
    expect(readFileSync('services/billing-service/src/application/synthetic-correction-reservations.ts','utf8')).toContain('SYNTHETIC_DATABASE_REQUIRED');
    for(const service of ['sunat-service','billing-service'])expect(readFileSync(`services/${service}/src/app.module.ts`,'utf8')).not.toContain('BetaOwnerDocumentAcceptance');
  });
});
