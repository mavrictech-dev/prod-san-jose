import {describe,it,expect,vi} from 'vitest';
import {PrismaBetaDocumentAcceptanceRepository} from '../services/sunat-service/src/application/beta-document-acceptance.repository';
import {BetaOwnerDocumentAcceptance} from '../services/sunat-service/src/application/beta-owner-document-acceptance';
import {ownerDocumentFixture} from './helpers/beta-document-owner.fixture';
import {AS_OF} from './helpers/beta-document-evidence.fixture';
function fixture(type:'01'|'07'|'08'='01'){
  const f=ownerDocumentFixture(type),findFirst=vi.fn(async()=>structuredClone(f.row));
  const repository=new PrismaBetaDocumentAcceptanceRepository({fiscalDocument:{findFirst}} as any);
  return {...f,findFirst,repository,load:()=>repository.load(f.doc.issuer.identityNumber,'BETA',f.doc.documentId)};
}
describe('Owner document acceptance repository, metadata only and read-only',()=>{
  it.each(['01','07','08'] as const)('loads complete %s owner metadata with no credentials/writes',async type=>{
    const f=fixture(type),r=await f.load();expect(r).toMatchObject({document:f.doc,signerFingerprint:f.record.signerFingerprint,status:'ACCEPTED'});
    expect(f.findFirst.mock.calls[0][0]).toMatchObject({where:{issuerRuc:f.doc.issuer.identityNumber,environment:'BETA',documentId:f.doc.documentId},select:{submissions:{take:2},artifacts:{where:{kind:{in:['SIGNED_XML','CDR_ZIP','SUBMISSION_ZIP']}}}}});
    expect(JSON.stringify(f.findFirst.mock.calls)).not.toMatch(/SunatCredentials|certificateCipher|solPassword|certificatePassword/);
  });
  it('rejects production and invalid IDs before storage',async()=>{
    const f=fixture();await expect(f.repository.load(f.doc.issuer.identityNumber,'PRODUCTION' as any,f.doc.documentId)).rejects.toThrow();expect(f.findFirst).not.toHaveBeenCalled();
  });
  it.each(['missing-time','unknown','ambiguous','batch','other-submission','log-hash','log-code','manifest','origin','snapshot','digest','envelope'])('rejects incomplete or ambiguous owner data: %s',async mode=>{
    const f=fixture(mode==='envelope'?'07':'01'),r=f.row,s=r.submissions[0];
    if(mode==='missing-time')(r as any).acceptedAt=null;if(mode==='unknown')s.result='UNKNOWN';if(mode==='ambiguous')r.submissions.push(structuredClone(s));if(mode==='batch')(s as any).batchId=f.doc.documentId;
    if(mode==='other-submission')s.documentId='00000000-0000-4000-8000-000000000001';if(mode==='log-hash')s.cdrLogs[0].cdrSha256='f'.repeat(64);if(mode==='log-code')s.cdrLogs[0].responseCode='99';
    if(mode==='manifest')s.errorMessage=JSON.stringify({...f.metadata,prepared:{...f.metadata.prepared,documentXml:{storageKey:'different'}}});
    if(mode==='origin')s.idempotencyKey='synthetic-unknown';if(mode==='snapshot')r.immutablePayload.environment='PRODUCTION';if(mode==='digest')r.digestValue='x';
    if(mode==='envelope')s.errorMessage=JSON.stringify({...f.metadata,envelopeSha256:'f'.repeat(64)});
    await expect(f.load()).rejects.toThrow('OWNER_DOCUMENT_EVIDENCE_INCOMPLETE');
  });
  it('does not fall back to a historical success when another attempt is present',async()=>{
    const f=fixture(),unknown=structuredClone(f.row.submissions[0]);unknown.result='UNKNOWN';unknown.errorCode='UNKNOWN';f.row.submissions.unshift(unknown);
    await expect(f.load()).rejects.toThrow();
  });
  it('assembles the candidate read-only owner path without network or activation',async()=>{
    const f=fixture(),core=new BetaOwnerDocumentAcceptance(f.repository,{read:f.ports.read},{verifyIssuer:f.ports.verifyIssuer},{verify:f.ports.verifyCdr});
    const proof=await core.verify(f.doc,AS_OF);expect(proof.evidence.documentId).toBe(f.doc.documentId);expect(proof.transmissionAuthorized).toBe(false);
    expect(f.findFirst).toHaveBeenCalledTimes(2);expect(f.ports.read).toHaveBeenCalledTimes(6);
  });
});
