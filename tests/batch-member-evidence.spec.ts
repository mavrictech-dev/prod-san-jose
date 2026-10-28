import 'reflect-metadata';
import {beforeAll,describe,it,expect,vi} from 'vitest';
import {fiscalSnapshotSha256,buildFiscalNoteSnapshot,buildFiscalNoteUbl} from '../packages/sunat-core/src/fiscal-note';
import {BatchMemberEvidence,BatchMemberEvidenceError} from '../services/sunat-service/src/application/batch-member-evidence';
import {BetaOwnerAcceptanceResolver} from '../services/sunat-service/src/application/beta-owner-acceptance-resolver';
import {batchMemberTestPki,batchMemberEvidenceFixture as fixture,id,hash} from './helpers/batch-member-evidence.fixture';
import {cdrXml} from './helpers/beta-document-evidence.fixture';

let pki:ReturnType<typeof batchMemberTestPki>;
beforeAll(()=>{pki=batchMemberTestPki();},30000);
describe('SUNAT batch member evidence: actual ephemeral XMLDSig, test offline CRL policy only',()=>{
  it.each(['01','03','07','08'] as const)('composes real branded acceptance and full signed %s XML',async type=>{
    const f=await fixture(pki,type),r=await f.run();
    expect(r).toMatchObject({binding:f.record.binding,snapshot:f.record.snapshot,original:f.record.ownerOriginalVersion,
      acceptance:{documentId:f.record.member.documentId,snapshotSha256:f.record.member.snapshotSha256,responseCode:'0'},
      provenance:{verifiedAt:f.asOf,signedXmlSha256:f.record.signedXml.sha256,catalogueSha256:fiscalSnapshotSha256([])}});
    expect(r.provenance.cdrSha256).toBe(r.acceptance?.cdrSha256);
    expect(f.owner.load).toHaveBeenCalledTimes(3);
    const assembled=await f.assemble().verifySignedVersion('opaque-member-version-1',f.asOf);
    expect(assembled).toEqual(r);
  });
  it.each(['07','08'] as const)('verifies B-series %s member signature and exact signed RC membership',async type=>{
    const f=await fixture(pki,type,{boleta:true});
    await expect(f.run()).resolves.toMatchObject({acceptance:{source:{kind:'CDR_SUMMARY',conditionCode:'1',lineNumber:1}}});
  });
  it('verifies an unreported 03 for RC1, returning acceptance:null without consulting acceptance',async()=>{
    const f=await fixture(pki,'03',{unreported:true}),spy=vi.spyOn(f.resolver,'verify');
    await expect(f.run()).resolves.toMatchObject({acceptance:null,provenance:{cdrSha256:null}});
    expect(spy).not.toHaveBeenCalled();expect(f.trust.evaluate).toHaveBeenCalled();
    // The old individual sendBill gate must continue rejecting boletas.
    await expect(f.signatures.verifyIssuer({document:f.record.snapshot} as any,f.blobs.get(f.record.signedXml.id)!,f.unsigned,f.asOf)).rejects.toThrow('INDIVIDUAL_BETA_REQUIRED');
  });
  it('accepts exact RC2 and historical private record without replacing its snapshot',async()=>{
    const f=await fixture(pki,'03',{condition:'2'});
    f.record.member.version=2;
    await expect(f.run()).resolves.toMatchObject({snapshot:f.record.snapshot,acceptance:{source:{conditionCode:'2'}}});
    expect(f.owner.load.mock.calls.every(([handle])=>handle==='opaque-member-version-1')).toBe(true);
  });
  it.each(['body','digest','KeyInfo','wrapping','different-signed-body'] as const)('rejects actual XML signature attacks even with refreshed descriptors: %s',async mode=>{
    const f=await fixture(pki,'03',{unreported:true});let xml=f.blobs.get(f.record.signedXml.id)!.toString();
    if(mode==='body')xml=xml.replace('BIEN FICTICIO','ALTERADO');
    if(mode==='digest')xml=xml.replace(/(<(?:\w+:)?DigestValue>)([A-Za-z0-9+/])/u,(_m,p,l)=>p+(l==='A'?'B':'A'));
    if(mode==='KeyInfo')xml=xml.replace(/<(?:\w+:)?X509Certificate>[\s\S]*?<\/(?:\w+:)?X509Certificate>/,
      '<X509Certificate xmlns="http://www.w3.org/2000/09/xmldsig#">AAAA</X509Certificate>');
    if(mode==='wrapping')xml=xml.replace('</Invoice>','<cbc:ID Id="wrap">WRAPPED</cbc:ID></Invoice>');
    if(mode==='different-signed-body'){
      const signed=f.sign(f.unsigned.replace('BIEN FICTICIO','OTRO BIEN'),'Invoice');xml=signed.xml;f.record.digestValue=signed.digestValue;
    }
    f.replaceXml(Buffer.from(xml));await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_SIGNATURE_INVALID'});
  });
  it.each(['chain','revocation','blockers','pin'] as const)('requires explicit pinned issuer/CRL policy: %s',async mode=>{
    const f=await fixture(pki,'03',{unreported:true});
    if(mode==='pin')f.certificates.load.mockResolvedValueOnce({certificatePem:pki.otherIssuer.certificatePem,chainPems:pki.otherIssuer.chainPems});
    else{const original=f.trust.evaluate.getMockImplementation()!;
      f.trust.evaluate.mockImplementationOnce(async(...args)=>{const proof=await original(...args);
        if(mode==='chain')proof.chainValid=false;if(mode==='revocation')(proof as any).revocation='PENDING';if(mode==='blockers')proof.blockers.push('REVOKED');return proof;});}
    await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_SIGNATURE_INVALID'});
  });
  it.each(['binding','hash','document','version','cdr','package'] as const)('rejects wrong owner identity or acceptance fence: %s',async mode=>{
    const f=await fixture(pki);
    if(mode==='binding')f.record.binding.issuerRuc='20131312955';
    if(mode==='hash')f.record.member.snapshotSha256='0'.repeat(64);
    if(mode==='document')f.record.member.documentId=id(555);
    if(mode==='version')f.record.acceptance!.fence.ownerVersion='0'.repeat(64);
    if(mode==='cdr')f.record.acceptance!.fence.cdrZipSha256='0'.repeat(64);
    if(mode==='package')f.blobs.set(f.record.requestZip.id,Buffer.from('wrong package'));
    await expect(f.run()).rejects.toThrow(/^BATCH_EVIDENCE_/);
  });
  it('rejects an intact-looking CDR with broken signature even when descriptors are refreshed',async()=>{
    const f=await fixture(pki),accepted=[...f.individuals.values()][0],xml=f.blobs.get(accepted.cdrZip.id)!;
    // ZIP is replaced by a freshly packed, altered signed response; the owner proof cannot be minted.
    const bad=pki.signCdr(cdrXml(f.record.snapshot.fullNumber,'01',f.record.binding.issuerRuc)
      .replace('2026-10-03','2026-10-02')).replace('SIMULADO NO OFICIAL','TAMPERED');
    const bytes=f.pack(`R-${f.record.binding.issuerRuc}-01-${f.record.snapshot.fullNumber}.xml`,Buffer.from(bad));
    f.blobs.set(accepted.cdrZip.id,bytes);Object.assign(accepted.cdrZip,{sha256:hash(bytes),sizeBytes:bytes.length});
    expect(xml.equals(bytes)).toBe(false);await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_ACCEPTANCE_INVALID'});
  });
  it('rejects copied and public accepted flags instead of trusting serialized proofs',async()=>{
    const f=await fixture(pki),proof=await f.resolver.verify(f.record.snapshot,f.asOf);
    const fake=new BetaOwnerAcceptanceResolver({verify:async()=>structuredClone(proof)} as any,{verify:async()=>proof} as any);
    await expect(new BatchMemberEvidence(f.owner,f.artifacts,f.signatures,fake).verifySignedVersion('opaque',f.asOf))
      .rejects.toMatchObject({code:'BATCH_EVIDENCE_ACCEPTANCE_INVALID'});
    (f.record as any).accepted=true;await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_OWNER_INVALID'});
  });
  it('rejects the wrong signed RC member even when the member signature remains valid',async()=>{
    const f=await fixture(pki,'03'),summary=[...f.summaries.values()][0];
    summary.batch.input.entries[0].document.snapshot.documentId=id(599);
    await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_ACCEPTANCE_INVALID'});
  });
  it('fences owner changes after genuine branded acceptance has completed',async()=>{
    const f=await fixture(pki),verify=f.resolver.verify.bind(f.resolver);
    vi.spyOn(f.resolver,'verify').mockImplementation(async(...args)=>{
      const proof=await verify(...args);f.record.creditCatalogue.revision++;return proof;
    });
    await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_OWNER_CHANGED'});
  });
  it.each(['row','catalogue','xml-bytes','zip-bytes','last-row'] as const)('fences mutation across asynchronous verification: %s',async mode=>{
    const f=await fixture(pki,'03',{unreported:true}),original=f.trust.evaluate.getMockImplementation()!;
    if(mode==='last-row'){
      const read=f.artifacts.read.getMockImplementation()!;let calls=0;
      f.artifacts.read.mockImplementation(async(...args)=>{const bytes=await read(...args);if(++calls===4)f.record.ownerVersion='e'.repeat(64);return bytes;});
    }else f.trust.evaluate.mockImplementationOnce(async(...args)=>{const result=await original(...args);
      if(mode==='row')f.record.ownerVersion='e'.repeat(64);if(mode==='catalogue')f.record.creditCatalogue.revision++;
      if(mode==='xml-bytes')f.blobs.get(f.record.signedXml.id)![0]^=1;if(mode==='zip-bytes')f.blobs.get(f.record.requestZip.id)![0]^=1;return result;});
    await expect(f.run()).rejects.toThrow(/^BATCH_EVIDENCE_/);
  });
  it.each(['RESERVED','ACCEPTED'] as const)('hashes the full catalogue member/state array and verifies %s history',async state=>{
    const f=await fixture(pki,'07',{unreported:true}),context=f.record.noteContext!;
    const prior=buildFiscalNoteSnapshot(context,{documentTypeCode:'07',reasonCode:'09',reasonDescription:'CREDITO RESERVADO',
      lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'1'}]},
      {documentId:id(9),series:'FC01',number:'9',issueDate:'2026-10-02T16:30:00Z'});
    if(state==='ACCEPTED')await f.add(prior,structuredClone(context),true,4);
    context.creditHistory.entries=[{state,note:prior}];
    const current=buildFiscalNoteSnapshot(context,{documentTypeCode:'07',reasonCode:'09',reasonDescription:'AJUSTE FICTICIO',
      lines:[{originalLineNumber:1,unitPriceAdjustmentWithTax:'1'}]},
      {documentId:f.record.member.documentId,series:'FC01',number:'1',issueDate:'2026-10-02T17:00:00Z'});
    f.record.snapshot=current;f.record.member.snapshotSha256=fiscalSnapshotSha256(current);
    f.record.creditCatalogue.entries=[{member:{documentId:prior.documentId,version:4,snapshotSha256:fiscalSnapshotSha256(prior)},state}];
    const signed=f.sign(buildFiscalNoteUbl(current,context),'CreditNote');f.record.digestValue=signed.digestValue;f.replaceXml(Buffer.from(signed.xml));
    await expect(f.run()).resolves.toMatchObject({provenance:{catalogueSha256:fiscalSnapshotSha256(f.record.creditCatalogue.entries)}});
    f.record.creditCatalogue.entries[0].member.snapshotSha256='0'.repeat(64);
    await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_CATALOGUE_INVALID'});
  });
  it.each(['incomplete','wrong-source','omitted','false-state'] as const)('rejects false owner catalogue declarations: %s',async mode=>{
    const f=await fixture(pki,'07',{unreported:true});
    if(mode==='incomplete')(f.record.creditCatalogue as any).complete=false;
    if(mode==='wrong-source')(f.record.creditCatalogue as any).source='PUBLIC_REQUEST';
    if(mode==='omitted')delete (f.record as any).creditCatalogue;
    if(mode==='false-state')f.record.creditCatalogue.entries.push({member:{documentId:id(9),version:1,snapshotSha256:'a'.repeat(64)},state:'ACCEPTED'});
    await expect(f.run()).rejects.toMatchObject({code:mode==='omitted'?'BATCH_EVIDENCE_OWNER_INVALID':'BATCH_EVIDENCE_CATALOGUE_INVALID'});
  });
  it('validates exact not-delivered identity and time',async()=>{
    const f=await fixture(pki);f.record.notDelivered={status:'NOT_DELIVERED',documentId:f.record.member.documentId,
      documentTypeCode:'01',fullNumber:f.record.snapshot.fullNumber,issuerRuc:f.record.binding.issuerRuc,
      snapshotSha256:f.record.member.snapshotSha256,evidenceId:id(88),assertedAt:'2026-10-03T18:00:00Z'};
    await expect(f.run()).resolves.toMatchObject({notDelivered:f.record.notDelivered});
    f.record.notDelivered.snapshotSha256='0'.repeat(64);await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_OWNER_INVALID'});
  });
  it('requires verified owner acceptance for the original of a signed note',async()=>{
    const f=await fixture(pki,'07',{unreported:true});
    f.individuals.clear();await expect(f.run()).rejects.toMatchObject({code:'BATCH_EVIDENCE_ACCEPTANCE_INVALID'});
  });
  it.each(['../owner','D:\\owner','https://host/owner','file:owner','', 'x'.repeat(201)])('rejects path/URL handles before loading: %s',async handle=>{
    const f=await fixture(pki,'03',{unreported:true});
    await expect(f.adapter.verifySignedVersion(handle,f.asOf)).rejects.toMatchObject({code:'BATCH_EVIDENCE_INPUT_INVALID'});expect(f.owner.load).not.toHaveBeenCalled();
  });
  it('sanitizes private owner failures and rejects invalid asOf before IO',async()=>{
    const f=await fixture(pki,'03',{unreported:true});f.owner.load.mockRejectedValue(new Error('private path and secret diagnostic'));
    await expect(f.run()).rejects.toMatchObject({message:'BATCH_EVIDENCE_UNAVAILABLE'});
    f.owner.load.mockClear();await expect(f.adapter.verifySignedVersion('opaque','2026-10-04')).rejects.toMatchObject({code:'BATCH_EVIDENCE_INPUT_INVALID'});
    expect(f.owner.load).not.toHaveBeenCalled();
  });
  it('does not forward forged error codes or private diagnostic properties from owner ports',async()=>{
    const f=await fixture(pki,'03',{unreported:true});
    f.owner.load.mockRejectedValue(new BatchMemberEvidenceError('PRIVATE_SECRET' as any));
    await expect(f.run()).rejects.toMatchObject({message:'BATCH_EVIDENCE_UNAVAILABLE',code:'BATCH_EVIDENCE_UNAVAILABLE'});
    const error=Object.assign(new BatchMemberEvidenceError('BATCH_EVIDENCE_OWNER_INVALID'),{path:'PRIVATE_PATH'});
    error.message='PRIVATE_MESSAGE';f.owner.load.mockRejectedValue(error);
    await f.run().catch(e=>{expect(e.message).toBe('BATCH_EVIDENCE_OWNER_INVALID');expect(e.path).toBeUndefined();});
  });
});
