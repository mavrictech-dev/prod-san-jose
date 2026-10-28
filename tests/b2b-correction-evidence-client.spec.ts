import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {HttpBetaCorrectionEvidence} from '../services/billing-service/src/b2b/correction-evidence-client';
import {correctionEvidenceResponse} from '../packages/service-access/src/b2b-correction-evidence-wire';
import {outcomeFixture,AS_OF,id} from './helpers/beta-owner-summary.fixture';
import {documentEvidenceFixture} from './helpers/beta-document-evidence.fixture';

async function fixture(){
  const outcome=outcomeFixture(),original=documentEvidenceFixture(),acceptance=await original.run(),result=await outcome.run();
  const r={issuerId:original.doc.companyId!,issuerRuc:original.doc.issuer.identityNumber,branchId:original.doc.branchId!,pointId:id(200),seriesId:id(201),environment:'BETA' as const,documentType:'01' as const},
    binding={reference:r,noteType:'07' as const,noteSeriesId:id(202)};
  const dto:any={ORIGINAL:{evidence:acceptance.evidence,fence:acceptance.fence},
    PREREQUISITES:{commandSha256:result.commandSha256,evidenceSha256:'a'.repeat(64)},
    OUTCOME:{commandSha256:result.commandSha256,operationId:result.operationId,evidence:result.evidence,fence:result.fence}};
  let authority='b'.repeat(64),now=AS_OF;
  const http={post:vi.fn(async(_path:string,request:any,_token?:string)=>correctionEvidenceResponse(request,authority,dto[request.action],now))};
  const token=vi.fn(async()=> 'synthetic-token'),commands={load:vi.fn(async()=>outcome.command)},core=new HttpBetaCorrectionEvidence(http,token,'SERVICE',binding,commands,()=>now);
  return{outcome,original,acceptance,result,binding,dto,http,token,commands,core,setAuthority(v:string){authority=v;},setNow(v:string){now=v;}};
}
describe('Billing private evidence consumer; structural crypto fixtures, no official traffic',()=>{
  it('mints separate immutable local capabilities, not a serialized owner WeakSet',async()=>{
    const f=await fixture(),a=await f.core.original(f.original.doc,AS_OF),p=await f.core.prerequisites(f.outcome.command,AS_OF),o=await f.core.verify(f.outcome.command,AS_OF);
    expect(f.core.ownsOriginal(a)).toBe(true);expect(f.core.ownsPrerequisites(p)).toBe(true);expect(f.core.owns(o)).toBe(true);
    for(const x of [structuredClone(a),f.acceptance,f.result,o])expect(f.core.ownsOriginal(x)).toBe(false);
    expect(f.core.ownsPrerequisites(structuredClone(p))).toBe(false);expect(f.core.owns(structuredClone(o))).toBe(false);
    expect(Object.isFrozen(o.fence)).toBe(true);expect(f.token).toHaveBeenCalledTimes(3);
    expect(f.http.post.mock.calls.every(([path])=>path==='/internal/b2b/correction-evidence')).toBe(true);
    expect(new Set(f.http.post.mock.calls.map(([,req])=>req.requestId)).size).toBe(3);
  });
  it('authority revisions participate in fences without treating fresh request nonces as data changes',async()=>{
    const f=await fixture(),first=await f.core.prerequisites(f.outcome.command,AS_OF),same=await f.core.prerequisites(f.outcome.command,AS_OF);
    expect(first.evidenceSha256).toBe(same.evidenceSha256);f.setAuthority('c'.repeat(64));expect((await f.core.prerequisites(f.outcome.command,AS_OF)).evidenceSha256).not.toBe(first.evidenceSha256);
  });
  it.each(['nonce','request-hash','asOf','authority','production','extra','future'] as const)('refuses mismatched or unauthorized owner envelope: %s',async mode=>{
    const f=await fixture(),normal=f.http.post.getMockImplementation()!;
    f.http.post.mockImplementationOnce(async(...args)=>{const r:any=structuredClone(await normal(...args));
      if(mode==='nonce')r.requestId=id(999);if(mode==='request-hash')r.requestSha256='f'.repeat(64);if(mode==='asOf')r.checkedAt='2026-10-03T18:00:00Z';
      if(mode==='authority')r.authoritySha256='not-hash';if(mode==='production')r.fiscalExecutionEnabled=true;if(mode==='extra')r.role='ADMIN';if(mode==='future')r.verifiedAt='2027-01-01T00:00:00Z';return r;});
    await expect(f.core.original(f.original.doc,AS_OF)).rejects.toThrow();
  });
  it.each(['documentId','snapshotSha256','issuerRuc','environment','source'] as const)('refuses valid-shaped original evidence for wrong %s',async field=>{
    const f=await fixture(),e:any=structuredClone(f.dto.ORIGINAL.evidence);e[field]=field==='source'?{kind:'CDR_SUMMARY'}:'WRONG';f.dto.ORIGINAL.evidence=e;
    await expect(f.core.original(f.original.doc,AS_OF)).rejects.toMatchObject({code:'INVALID_OWNER_EVIDENCE_RESPONSE'});
  });
  it.each(['commandSha256','operationId','flag','hash','code','date','fence','extra'] as const)('rejects malformed or unrelated outcome: %s',async mode=>{
    const f=await fixture();f.dto.OUTCOME=structuredClone(f.dto.OUTCOME);const d=f.dto.OUTCOME;
    if(mode==='commandSha256')d.commandSha256='f'.repeat(64);if(mode==='operationId')d.operationId=id(999);if(mode==='flag')d.evidence.officialCdr=false;
    if(mode==='hash')d.evidence.cdrSha256='x';if(mode==='code')d.evidence.responseCode='2335';if(mode==='date')d.evidence.acceptedAt='2027-01-01';if(mode==='fence')d.fence={};if(mode==='extra')d.xml='not-returned';
    await expect(f.core.verify(f.outcome.command,AS_OF)).rejects.toMatchObject({code:'INVALID_OWNER_EVIDENCE_RESPONSE'});
  });
  it('keeps trusted rejection separate from acceptance',async()=>{
    const f=await fixture(),r=await outcomeFixture('07','2335').run();f.dto.OUTCOME={commandSha256:r.commandSha256,operationId:r.operationId,evidence:r.evidence,fence:r.fence};
    expect((await f.core.verify(f.outcome.command,AS_OF)).evidence.status).toBe('REJECTED');
  });
  it('only uses the supplied Billing-owned operation reader and checks the operation identity',async()=>{
    const f=await fixture(),port=f.core.financialEvidence();expect((await port.command(f.outcome.command.payload.operationId)).payload.operationId).toBe(f.outcome.command.payload.operationId);
    await expect(port.command(id(888))).rejects.toMatchObject({code:'INVALID_OWNER_EVIDENCE_RESPONSE'});
    const noReader=new HttpBetaCorrectionEvidence(f.http,f.token,'SERVICE',f.binding);expect(()=>noReader.financialEvidence()).toThrow('Billing-owned command reader required');
  });
  it('provides a prerequisite-only adapter, never outcome flags as reservation proof',async()=>{
    const f=await fixture(),port=f.core.correctionEvidence(),proof=await port.verify(f.outcome.command,AS_OF);expect(port.owns(proof)).toBe(true);expect(port.owns(await f.core.verify(f.outcome.command,AS_OF))).toBe(false);
  });
  it('owner errors propagate without fabricating a proof or falling back to cached acceptance',async()=>{
    const f=await fixture();await f.core.original(f.original.doc,AS_OF);f.http.post.mockRejectedValueOnce(new Error('PRIVATE_OWNER_UNAVAILABLE'));
    await expect(f.core.original(f.original.doc,AS_OF)).rejects.toThrow('PRIVATE_OWNER_UNAVAILABLE');expect(f.http.post).toHaveBeenCalledTimes(2);
  });
});
