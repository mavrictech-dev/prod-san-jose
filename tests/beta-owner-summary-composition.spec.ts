import {describe,it,expect,vi} from 'vitest';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {isBetaOwnerSummaryAcceptance} from '../services/sunat-service/src/application/beta-owner-summary-acceptance';
import {PrismaBetaSummaryOwner} from '../services/sunat-service/src/application/beta-owner-summary.repository';
import {summaryCompositionFixture as fixture,summaryOwnerRow,AS_OF,hash,zipSync,id} from './helpers/beta-owner-summary.fixture';

describe('owner RC composition: synthetic signature ports, never official acceptance',()=>{
  it.each(['03','07','08'] as const)('binds exact B-series %s snapshot, archived request, signature ports and CDR',async type=>{
    const f=fixture(type),before=fiscalSnapshotSha256(f.record),result=await f.run();
    expect(result).toMatchObject({schemaVersion:'factuez.beta.owner-summary-acceptance.v1',candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false,
      evidence:{documentId:f.document.documentId,documentTypeCode:type,fullNumber:f.document.fullNumber,snapshotSha256:fiscalSnapshotSha256(f.document),responseCode:'0',status:'ACCEPTED',
        source:{kind:'CDR_SUMMARY',identifier:f.record.batch.identifier,lineNumber:1,conditionCode:'1'}},
      fence:{submissionId:f.record.submissionId,ownerVersion:f.record.version,ownerRecordSha256:before,signedXmlSha256:hash(f.xml),requestZipSha256:hash(f.request),cdrZipSha256:hash(f.response),cdrXmlSha256:hash(f.cdr)}});
    expect(f.signatures.verifyBatch).toHaveBeenCalledOnce();
    expect(f.signatures.verifyBatch.mock.calls[0]).toEqual([f.record.batch,f.record.signerFingerprint,f.xml,expect.any(String),AS_OF]);
    expect(f.cdrTrust.verify).toHaveBeenCalledExactlyOnceWith(f.cdr);
    expect(f.repository.current).toHaveBeenCalledTimes(4);expect(f.artifacts.read).toHaveBeenCalledTimes(6);
    expect(f.artifacts.read.mock.calls.every(([owner])=>owner===f.record.batch.documentId)).toBe(true);
    expect(fiscalSnapshotSha256(f.record)).toBe(before);
    expect(isBetaOwnerSummaryAcceptance(result)).toBe(true);
    for(const copy of [structuredClone(result),JSON.parse(JSON.stringify(result)),{...result}])expect(isBetaOwnerSummaryAcceptance(copy)).toBe(false);
    for(const value of [null,{},true,'ACCEPTED'])expect(isBetaOwnerSummaryAcceptance(value)).toBe(false);
    for(const value of [result,result.evidence,result.evidence.source,result.fence,result.proof])expect(Object.isFrozen(value)).toBe(true);
  });
  it('accepts the current condition-2 version rather than treating RC2 as an unconditional denial',async()=>{
    const f=fixture('03','2');expect((await f.run()).evidence.source).toMatchObject({conditionCode:'2',lineNumber:1});
  });
  it('refuses the previous version of a condition-2 member',async()=>{
    const f=fixture('03','2'),entry=f.record.batch.input.entries[0];
    if(!('previous'in entry))throw new Error('Fixture requires RC2');
    entry.document.snapshot.customer.legalName='CURRENT CHANGED VERSION';
    await expect(f.run()).rejects.toThrow('CURRENT_RC_VERSION_REQUIRED');expect(f.artifacts.read).not.toHaveBeenCalled();
  });
  it('RC3 cannot supply acceptance even if the batch and stored flags are accepted',async()=>{
    const f=fixture('03','3');await expect(f.run()).rejects.toThrow('CURRENT_RC_VERSION_REQUIRED');expect(f.signatures.verifyBatch).not.toHaveBeenCalled();
  });
  it.each(['PRODUCTION','01','09','31','F-SERIES'] as const)('rejects unsupported input %s before owner access',async mode=>{
    const f=fixture();if(mode==='PRODUCTION')f.document.environment='PRODUCTION';else if(mode==='F-SERIES')f.document.series='F001';else(f.document as any).documentTypeCode=mode;
    await expect(f.run()).rejects.toThrow('SUMMARY_BETA_MEMBER_REQUIRED');expect(f.repository.current).not.toHaveBeenCalled();
  });
  it.each(['missing','unavailable','wrong-member','different-customer','other-condition'] as const)('requires authoritative current membership: %s',async mode=>{
    const f=fixture();
    if(mode==='missing')f.repository.current.mockResolvedValueOnce(null as never);
    if(mode==='unavailable')f.repository.current.mockRejectedValueOnce(new Error('Owner unavailable'));
    if(mode==='wrong-member')f.record.batch.input.entries[0].document.snapshot.documentId=id(999);
    if(mode==='different-customer')f.record.batch.input.entries[0].document.snapshot.customer.legalName='CHANGED';
    if(mode==='other-condition')(f.record.batch.input.entries[0] as any).conditionCode='3';
    await expect(f.run()).rejects.toThrow();expect(f.artifacts.read).not.toHaveBeenCalled();
  });
  it.each(['signedXml','requestZip','cdrZip'] as const)('rejects actual byte/hash mismatch for %s',async kind=>{
    const f=fixture();f.record[kind].sha256='f'.repeat(64);await expect(f.run()).rejects.toThrow('RC_ARTIFACT_MISMATCH');expect(f.cdrTrust.verify).not.toHaveBeenCalled();
  });
  it.each([0,-1,4*1024*1024+1,1.5])('rejects invalid archived size %s',async size=>{
    const f=fixture();f.record.signedXml.sizeBytes=size;await expect(f.run()).rejects.toThrow('RC_ARTIFACT_INVALID');expect(f.artifacts.read).not.toHaveBeenCalled();
  });
  it.each(['wrong-xml','wrong-name','extra-file','path','trailing','crc'] as const)('binds request ZIP to the exact signed XML: %s',async mode=>{
    const f=fixture(),name=`${f.document.issuer.identityNumber}-${f.record.batch.identifier}.xml`;
    let bytes=Buffer.from(f.request);
    if(mode==='wrong-xml')bytes=Buffer.from(zipSync({[name]:Buffer.concat([f.xml,Buffer.from('\n<!-- OTHER ARCHIVE VERSION -->')])}));
    if(mode==='wrong-name')bytes=Buffer.from(zipSync({'wrong.xml':f.xml}));
    if(mode==='extra-file')bytes=Buffer.from(zipSync({[name]:f.xml,'extra.xml':f.xml}));
    if(mode==='path')bytes=Buffer.from(zipSync({['../'+name]:f.xml}));
    if(mode==='trailing')bytes=Buffer.concat([bytes,Buffer.from('x')]);
    if(mode==='crc'){const central=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(0,14);bytes.writeUInt32LE(0,central+16);}
    f.setRequest(bytes);await expect(f.run()).rejects.toThrow();expect(f.signatures.verifyBatch).not.toHaveBeenCalled();
  });
  it.each(['digest','fingerprint','time','trust-store','throw'] as const)('rejects issuer-signature proof %s',async mode=>{
    const f=fixture(),proof=await f.signatures.verifyBatch();f.signatures.verifyBatch.mockClear();
    if(mode==='digest')proof.digestValue=Buffer.alloc(32,2).toString('base64');if(mode==='fingerprint')proof.certificateFingerprint='d'.repeat(64);
    if(mode==='time')proof.checkedAt='2026-10-03T00:00:00Z';if(mode==='trust-store')proof.trustStoreSha256='';
    if(mode==='throw')f.signatures.verifyBatch.mockRejectedValueOnce(new Error('SYNTHETIC trust unavailable'));else f.signatures.verifyBatch.mockResolvedValueOnce(proof);
    await expect(f.run()).rejects.toThrow();expect(f.cdrTrust.verify).not.toHaveBeenCalled();
  });
  it.each(['rejected','receiver','reference','sender','future','false-signature','nonboolean-signature','signature-error'] as const)('refuses rejected/untrusted or unbound CDR: %s',async mode=>{
    const f=fixture();let xml=f.cdr.toString();
    if(mode==='rejected')xml=xml.replace('<cbc:ResponseCode>0','<cbc:ResponseCode>99');
    if(mode==='receiver')xml=xml.replace(f.document.issuer.identityNumber,'00000000001');
    if(mode==='sender')xml=xml.replace('20131312955','00000000001');
    if(mode==='reference')xml=xml.replaceAll(f.record.batch.identifier,'RC-20261003-999');
    if(mode==='future')xml=xml.replace('2026-10-03','2027-01-01');
    if(mode==='false-signature')f.cdrTrust.verify.mockResolvedValueOnce(false);
    if(mode==='nonboolean-signature')f.cdrTrust.verify.mockResolvedValueOnce('true' as never);
    if(mode==='signature-error')f.cdrTrust.verify.mockRejectedValueOnce(new Error('CRL unavailable'));
    f.setCdr(Buffer.from(xml));await expect(f.run()).rejects.toThrow();
  });
  it.each(['version','submission','status','artifact-key','input','reread-missing','artifact-bytes'] as const)('fails closed when evidence changes during awaits: %s',async mode=>{
    const f=fixture();f.cdrTrust.verify.mockImplementationOnce(async()=>{
      if(mode==='version')f.record.version='d'.repeat(64);if(mode==='submission')f.record.submissionId=id(888);
      if(mode==='status')f.record.status='ACCEPTED_WITH_OBSERVATIONS';if(mode==='artifact-key')f.record.cdrZip.storageKey='synthetic/replaced';
      if(mode==='input')f.document.customer.legalName='MUTATED INPUT';if(mode==='reread-missing')f.repository.current.mockResolvedValueOnce(null as never);
      if(mode==='artifact-bytes')f.artifacts.read.mockResolvedValueOnce(Buffer.alloc(f.xml.length));return true;
    });await expect(f.run()).rejects.toThrow();
  });
});

describe('Prisma RC owner metadata loader, fake query results only',()=>{
  function setup(){const f=fixture(),row=summaryOwnerRow(f),db={fiscalBatch:{findMany:vi.fn(async()=>[structuredClone(row)])}},owner=new PrismaBetaSummaryOwner(db as never);return{f,row,db,owner,run:()=>owner.current(f.document)};}
  it('selects bounded exact RUC/BETA history and links manifest, request, CDR and submission',async()=>{
    const f=setup(),record=await f.run();expect(record).toMatchObject({batch:f.f.record.batch,submissionId:f.row.submissions[0].id,signedXml:f.f.record.signedXml,cdrZip:f.f.record.cdrZip});
    expect(f.db.fiscalBatch.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{issuerRuc:f.f.document.issuer.identityNumber,environment:'BETA',identifier:{startsWith:'RC-'}},take:201}));
    expect(JSON.stringify(f.db.fiscalBatch.findMany.mock.calls)).not.toMatch(/password|secret|certificate|p12/i);
  });
  it('returns null for absent membership and ignored rejected batches',async()=>{
    const f=setup();f.row.status='REJECTED' as never;f.db.fiscalBatch.findMany.mockResolvedValueOnce([f.row]);expect(await f.run()).toBeNull();
    f.db.fiscalBatch.findMany.mockResolvedValueOnce([]);expect(await f.run()).toBeNull();
  });
  it.each(['history-limit','pending','two-submissions','wrong-channel','wrong-result','not-done','missing-completed','two-cdrs','wrong-log-id','wrong-batch-id','wrong-code','no-metadata','bad-json','wrong-event','wrong-envelope','wrong-manifest','request-key','response-key','cdr-hash','cdr-key','missing-xml','size','summary-id','idempotency-key','manifest-name','manifest-reference'] as const)('rejects malformed persisted owner field: %s',async mode=>{
    const f=setup(),r=f.row,s=r.submissions[0],log=s.cdrLogs[0],meta=JSON.parse(s.errorMessage);
    if(mode==='history-limit')f.db.fiscalBatch.findMany.mockResolvedValueOnce(Array.from({length:201},()=>structuredClone(r)));
    else{
      if(mode==='pending')r.status='QUEUED' as never;if(mode==='two-submissions')r.submissions.push(structuredClone(s));
      if(mode==='wrong-channel')s.channel='SOAP_SEND_BILL';if(mode==='wrong-result')s.result='BUSINESS_ERROR';if(mode==='not-done')s.errorCode='WAITING';
      if(mode==='missing-completed')s.completedAt=null as never;if(mode==='two-cdrs')s.cdrLogs.push(structuredClone(log));
      if(mode==='wrong-log-id')log.submissionId=id(999);if(mode==='wrong-batch-id')log.batchId=id(999);if(mode==='wrong-code')log.responseCode='99';
      if(mode==='no-metadata')s.errorMessage='';if(mode==='bad-json')s.errorMessage='not-json';
      if(mode==='wrong-event')meta.eventId=id(999);if(mode==='wrong-envelope')meta.envelopeSha256='f'.repeat(64);
      if(mode==='summary-id')r.summaryId=id(999);if(mode==='idempotency-key')s.idempotencyKey='beta-supplement:wrong:v1';
      if(mode==='manifest-name')meta.prepared.fileName='wrong.zip';if(mode==='manifest-reference')meta.prepared.reference='RC-20261003-999';
      if(mode==='wrong-manifest')meta.prepared.xml.sha256='f'.repeat(64);
      if(mode==='size')meta.prepared.xml.sizeBytes++;
      if(['wrong-event','wrong-envelope','wrong-manifest','size','manifest-name','manifest-reference'].includes(mode))s.errorMessage=JSON.stringify(meta);
      if(mode==='request-key')s.requestArtifactKey='elsewhere';if(mode==='response-key')s.responseArtifactKey='elsewhere';
      if(mode==='cdr-hash')log.cdrSha256='f'.repeat(64);if(mode==='cdr-key')log.cdrStorageKey='elsewhere';
      if(mode==='missing-xml')r.artifacts=r.artifacts.filter(a=>a.kind!=='SIGNED_XML');
      f.db.fiscalBatch.findMany.mockResolvedValueOnce([r]);
    }
    await expect(f.run()).rejects.toThrow();
  });
  it('selects the latest member version and rejects equal-time ambiguity',async()=>{
    const f=setup(),old=structuredClone(f.row);old.submissions[0].completedAt=new Date('2026-10-03T17:59:00Z');
    f.db.fiscalBatch.findMany.mockResolvedValueOnce([old,f.row]);expect((await f.run())?.completedAt).toBe(f.row.submissions[0].completedAt.toISOString());
    f.db.fiscalBatch.findMany.mockResolvedValueOnce([f.row,structuredClone(f.row)]);await expect(f.run()).rejects.toThrow('RC_ORDER_AMBIGUOUS');
  });
  it('does not silently select one artifact when duplicate archive kinds exist',async()=>{
    const f=setup();f.row.artifacts.push({...f.row.artifacts[0],id:id(998),storageKey:'synthetic/second-signed.xml'});
    f.db.fiscalBatch.findMany.mockResolvedValueOnce([f.row]);await expect(f.run()).rejects.toThrow();
  });
});
