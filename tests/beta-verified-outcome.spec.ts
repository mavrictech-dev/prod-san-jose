import {describe,it,expect,vi} from 'vitest';
import {isBetaVerifiedSupplementOutcome} from '../services/sunat-service/src/application/beta-verified-supplement-outcome';
import {PrismaBetaSupplementOutcomeOwner} from '../services/sunat-service/src/application/beta-supplement-outcome.repository';
import {outcomeFixture as fixture,outcomeOwnerRow,AS_OF,hash,zipSync,id} from './helpers/beta-owner-summary.fixture';

describe('sealed supplement outcome: synthetic ports, no official fiscal execution',()=>{
  it.each(['07','08','RC','RA'] as const)('verifies %s request/archive/CDR and seals immutable proof',async kind=>{
    const f=fixture(kind),result=await f.run();
    expect(result).toMatchObject({schemaVersion:'factuez.beta.verified-supplement-outcome.v1',commandSha256:f.record.commandSha256,operationId:f.command.payload.operationId,submissionId:f.record.submissionId,
      evidence:{status:'ACCEPTED',cdrSignatureVerified:true,responseCode:'0',cdrSha256:hash(f.response),requestSha256:hash(f.request),acceptedAt:f.record.completedAt},
      fence:{version:f.record.version,xmlSha256:hash(f.xml),requestSha256:hash(f.request),cdrSha256:hash(f.response)},candidateOnly:true,fiscalExecutionEnabled:false,transmissionAuthorized:false});
    expect(f.owner.load).toHaveBeenCalledTimes(2);expect(f.owner.read).toHaveBeenCalledTimes(6);
    expect(f.owner.read.mock.calls.every(([owner])=>owner===f.identity.documentId)).toBe(true);
    expect(f.signatures.verifyEnvelope).toHaveBeenCalledExactlyOnceWith(f.command.payload.envelope,f.record.fingerprint,f.xml,AS_OF);
    expect(f.cdrTrust.verify).toHaveBeenCalledExactlyOnceWith(f.cdr);
    expect(isBetaVerifiedSupplementOutcome(result)).toBe(true);
    for(const value of [JSON.parse(JSON.stringify(result)),structuredClone(result),{...result},{},null,true])expect(isBetaVerifiedSupplementOutcome(value)).toBe(false);
    for(const value of [result,result.evidence,result.fence])expect(Object.isFrozen(value)).toBe(true);
  });
  it.each(['07','08','RC','RA'] as const)('returns a trusted rejection separately for %s, never acceptance',async kind=>{
    const f=fixture(kind,'2335'),r=await f.run();expect(r.evidence).toMatchObject({status:'REJECTED',responseCode:'2335'});expect(isBetaVerifiedSupplementOutcome(r)).toBe(true);
    expect(r).toMatchObject({fiscalExecutionEnabled:false,transmissionAuthorized:false});expect(r).not.toHaveProperty('financialEffect');
  });
  it('preserves acceptance with observations',async()=>{expect((await fixture('07','0',true).run()).evidence.status).toBe('ACCEPTED_WITH_OBSERVATIONS');});
  it.each(['07','08','RC','RA'] as const)('does not replace stored rejection with an accepted CDR for %s',async kind=>{
    const f=fixture(kind,'2335');f.setCdr(Buffer.from(f.cdr.toString().replace('<cbc:ResponseCode>2335','<cbc:ResponseCode>0')));
    await expect(f.run()).rejects.toThrow();
  });
  it.each(['different-code','different-result'] as const)('compares actual CDR with final owner %s',async mode=>{
    const f=fixture('07','2335');if(mode==='different-code')f.setCdr(Buffer.from(f.cdr.toString().replace('<cbc:ResponseCode>2335','<cbc:ResponseCode>2336')));else f.record.result='SUCCESS';
    await expect(f.run()).rejects.toThrow();
  });
  it.each(['missing','hash','version','future','before-command'] as const)('fails closed before file reads for owner evidence %s',async mode=>{
    const f=fixture();if(mode==='missing')f.owner.load.mockResolvedValueOnce(null as never);if(mode==='hash')f.record.commandSha256='f'.repeat(64);if(mode==='version')f.record.version='not-a-hash';
    if(mode==='future')f.record.completedAt='2027-01-01T00:00:00Z';if(mode==='before-command')f.record.completedAt='2026-10-02T00:00:00Z';
    await expect(f.run()).rejects.toThrow();expect(f.owner.read).not.toHaveBeenCalled();
  });
  it('does not allow caller-supplied acceptance flags or malformed command',async()=>{
    const f=fixture();(f.command as any).officialCdr=true;await expect(f.run()).rejects.toThrow();expect(f.owner.load).not.toHaveBeenCalled();
  });
  it.each(['signedXml','requestZip','cdrZip'] as const)('hashes actual archived %s bytes',async kind=>{
    const f=fixture();f.record[kind].sha256='f'.repeat(64);await expect(f.run()).rejects.toThrow('OUTCOME_ARTIFACT_MISMATCH');expect(f.cdrTrust.verify).not.toHaveBeenCalled();
  });
  it.each([0,-1,1.5,4*1024*1024+1])('bounds stored artifact size %s',async size=>{
    const f=fixture();f.record.signedXml.sizeBytes=size;await expect(f.run()).rejects.toThrow('OUTCOME_ARTIFACT_INVALID');expect(f.owner.read).not.toHaveBeenCalled();
  });
  it.each(['changed-xml','wrong-name','extra-file','path','trailing','crc'] as const)('requires archived request binding: %s',async mode=>{
    const f=fixture(),name=f.identity.fileName.replace(/\.zip$/,'.xml');let request=Buffer.from(f.request);
    if(mode==='changed-xml')request=Buffer.from(zipSync({[name]:Buffer.from(f.xml.toString().replace('BIEN FICTICIO','TAMPERED GOODS'))}));
    if(mode==='wrong-name')request=Buffer.from(zipSync({'wrong.xml':f.xml}));
    if(mode==='extra-file')request=Buffer.from(zipSync({[name]:f.xml,'extra.xml':f.xml}));
    if(mode==='path')request=Buffer.from(zipSync({['../'+name]:f.xml}));
    if(mode==='trailing')request=Buffer.concat([request,Buffer.from('x')]);
    if(mode==='crc'){const central=request.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));request.writeUInt32LE(0,14);request.writeUInt32LE(0,central+16);}
    f.setRequest(request);await expect(f.run()).rejects.toThrow();expect(f.signatures.verifyEnvelope).not.toHaveBeenCalled();
  });
  it.each(['digest','fingerprint','time','exception'] as const)('rejects wrong issuer signature proof %s',async mode=>{
    const f=fixture(),proof=await f.signatures.verifyEnvelope();f.signatures.verifyEnvelope.mockClear();
    if(mode==='digest')proof.digestValue='WRONG';if(mode==='fingerprint')proof.certificateFingerprint='f'.repeat(64);if(mode==='time')proof.checkedAt='2026-10-03T00:00:00Z';
    if(mode==='exception')f.signatures.verifyEnvelope.mockRejectedValueOnce(new Error('Untrusted issuer'));else f.signatures.verifyEnvelope.mockResolvedValueOnce(proof);
    await expect(f.run()).rejects.toThrow();expect(f.cdrTrust.verify).not.toHaveBeenCalled();
  });
  it.each(['sender','receiver','reference','type','missing-type','duplicate-code','false-signature','nonboolean-signature','signature-error'] as const)('refuses unrelated/untrusted CDR %s',async mode=>{
    const f=fixture(),type=f.command.payload.envelope.kind==='NOTE'?f.command.payload.envelope.note.documentTypeCode:'07';let xml=f.cdr.toString();
    if(mode==='sender')xml=xml.replace('20131312955','00000000001');if(mode==='receiver')xml=xml.replace(f.identity.ruc,'00000000001');
    if(mode==='reference')xml=xml.replaceAll(f.identity.reference,'FC01-999');
    if(mode==='type')xml=xml.replace(`<cbc:DocumentTypeCode>${type}`,`<cbc:DocumentTypeCode>08`);
    if(mode==='missing-type')xml=xml.replace(`<cbc:DocumentTypeCode>${type}</cbc:DocumentTypeCode>`,'');
    if(mode==='duplicate-code')xml=xml.replace('<cbc:ResponseCode>0</cbc:ResponseCode>','<cbc:ResponseCode>0</cbc:ResponseCode>'.repeat(2));
    if(mode==='false-signature')f.cdrTrust.verify.mockResolvedValueOnce(false);if(mode==='nonboolean-signature')f.cdrTrust.verify.mockResolvedValueOnce('true' as never);
    if(mode==='signature-error')f.cdrTrust.verify.mockRejectedValueOnce(new Error('CRL unavailable'));
    f.setCdr(Buffer.from(xml));await expect(f.run()).rejects.toThrow();
  });
  it.each(['07','RC','RA'] as const)('rejects CDR dates in the future rather than crediting stored completion for %s',async kind=>{
    const f=fixture(kind);f.setCdr(Buffer.from(f.cdr.toString().replace('<cbc:IssueDate>2026-10-03','<cbc:IssueDate>2027-01-01')));
    await expect(f.run()).rejects.toThrow();
  });
  it.each(['id','storage-key'] as const)('rejects aliased archives before reading storage: %s',async mode=>{
    const f=fixture();if(mode==='id')f.record.requestZip.id=f.record.signedXml.id;else f.record.cdrZip.storageKey=f.record.signedXml.storageKey;
    await expect(f.run()).rejects.toThrow();expect(f.owner.read).not.toHaveBeenCalled();
  });
  it.each(['version','submission','request-key','completed-at','reread-missing','file'] as const)('requires unchanged owner metadata/files after asynchronous trust checks: %s',async mode=>{
    const f=fixture();f.cdrTrust.verify.mockImplementationOnce(async()=>{
      if(mode==='version')f.record.version='d'.repeat(64);if(mode==='submission')f.record.submissionId=id(999);if(mode==='request-key')f.record.requestZip.storageKey='synthetic/replaced';
      if(mode==='completed-at')f.record.completedAt='2026-10-03T18:01:00Z';if(mode==='reread-missing')f.owner.load.mockResolvedValueOnce(null as never);
      if(mode==='file')f.owner.read.mockResolvedValueOnce(Buffer.alloc(f.xml.length));return true;
    });await expect(f.run()).rejects.toThrow();
  });
});

describe('persisted outcome owner: bounded metadata projections, no real database',()=>{
  function setup(kind:'07'|'08'|'RC'|'RA'='07',code='0'){
    const f=fixture(kind,code),data=outcomeOwnerRow(f,code),db={sunatSubmission:{findUnique:vi.fn(async()=>structuredClone(data.row))},documentArtifact:{findMany:vi.fn(async()=>structuredClone(data.files))},batchArtifact:{findMany:vi.fn(async()=>structuredClone(data.files))}},
      storage={read:vi.fn(async()=>Buffer.from('SYNTHETIC'))},owner=new PrismaBetaSupplementOutcomeOwner(db as never,storage);
    return {f,...data,db,storage,owner,run:()=>owner.load(f.command)};
  }
  it.each(['07','08','RC','RA'] as const)('loads exact immutable owner and three archived artifacts for %s',async kind=>{
    const f=setup(kind),r=await f.run();expect(r).toMatchObject({commandSha256:f.f.record.commandSha256,submissionId:f.row.id,signedXml:f.f.record.signedXml,requestZip:f.f.record.requestZip,cdrZip:f.f.record.cdrZip});
    expect(f.db.sunatSubmission.findUnique).toHaveBeenCalledWith(expect.objectContaining({where:{idempotencyKey:`beta-supplement:${f.f.identity.documentId}:v1`}}));
    expect(f.db.documentArtifact.findMany).toHaveBeenCalledTimes(['07','08'].includes(kind)?1:0);expect(f.db.batchArtifact.findMany).toHaveBeenCalledTimes(['RC','RA'].includes(kind)?1:0);
    expect(JSON.stringify(f.db.sunatSubmission.findUnique.mock.calls)).not.toMatch(/secret|password|p12|certificate/i);expect(f.storage.read).not.toHaveBeenCalled();
  });
  it.each(['07','RC','RA'] as const)('can load a final BUSINESS_ERROR only with matching nonzero CDR for %s',async kind=>{expect(await setup(kind,'2335').run()).not.toBeNull();});
  it('returns null for missing authoritative operation',async()=>{const f=setup();f.db.sunatSubmission.findUnique.mockResolvedValueOnce(null as never);expect(await f.run()).toBeNull();});
  it.each(['issuer','environment','owner-id','channel','result','not-done','completed-at','cdr-count','metadata-missing','metadata-json','event','correlation','envelope-hash','file-name','reference','owner-snapshot','log-owner','log-submission','log-key','success-code','business-code','xml-missing','extra-file','manifest-xml','manifest-zip','request-key','cdr-hash'] as const)('rejects incomplete or conflicting persisted field: %s',async mode=>{
    const f=setup(),r=f.row,own=r.document!,log=r.cdrLogs[0],meta=f.metadata;
    if(mode==='issuer')own.issuerRuc='00000000001';if(mode==='environment')own.environment='PRODUCTION';if(mode==='owner-id')(own as any).documentId=id(999);
    if(mode==='channel')r.channel='SOAP_SEND_SUMMARY';if(mode==='result')r.result='NETWORK_ERROR';if(mode==='not-done')r.errorCode='WAITING';if(mode==='completed-at')r.completedAt=null as never;
    if(mode==='cdr-count')r.cdrLogs.push(structuredClone(log));if(mode==='metadata-missing')r.errorMessage='';if(mode==='metadata-json')r.errorMessage='not-json';
    if(mode==='event')meta.eventId=id(999);if(mode==='correlation')meta.correlationId=id(999);if(mode==='envelope-hash')meta.envelopeSha256='f'.repeat(64);
    if(mode==='file-name')meta.prepared.fileName='wrong.zip';if(mode==='reference')meta.prepared.reference='FC01-999';
    if(mode==='owner-snapshot')(own.immutablePayload as any).currencyCode='USD';
    if(mode==='log-owner')log.documentId=id(999);if(mode==='log-submission')log.submissionId=id(999);if(mode==='log-key')log.cdrStorageKey='elsewhere';
    if(mode==='success-code')log.responseCode='2335';if(mode==='business-code')r.result='BUSINESS_ERROR';
    if(mode==='xml-missing')f.files.splice(f.files.findIndex(a=>a.kind==='SIGNED_XML'),1);if(mode==='extra-file')f.files.push(structuredClone(f.files[0]));
    if(mode==='manifest-xml')meta.prepared.xml.sha256='f'.repeat(64);if(mode==='manifest-zip')meta.prepared.zip.storageKey='elsewhere';
    if(mode==='request-key')r.requestArtifactKey='elsewhere';if(mode==='cdr-hash')log.cdrSha256='f'.repeat(64);
    if(['event','correlation','envelope-hash','file-name','reference','manifest-xml','manifest-zip'].includes(mode))r.errorMessage=JSON.stringify(meta);
    await expect(f.run()).rejects.toThrow();expect(f.storage.read).not.toHaveBeenCalled();
  });
  it('delegates artifact reads using the exact owner id and bounded metadata',async()=>{
    const f=setup();await f.owner.read(f.f.identity.documentId,f.f.record.signedXml);expect(f.storage.read).toHaveBeenCalledExactlyOnceWith(f.f.identity.documentId,f.f.record.signedXml);
  });
  it.each(['xml','zip'] as const)('does not ignore prepared manifest size mismatch for %s',async kind=>{
    const f=setup();f.metadata.prepared[kind].sizeBytes++;f.row.errorMessage=JSON.stringify(f.metadata);
    await expect(f.run()).rejects.toThrow();
  });
});
