import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {BetaCorrectionEvidence,isBetaCorrectionEvidence} from '../services/sunat-service/src/application/beta-correction-evidence';
import {buildFiscalSupplementCommand} from '../packages/sunat-core/src/fiscal-supplement-command';
import {buildFiscalNoteSnapshot,buildFiscalNoteUbl,fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {documentEvidenceFixture,AS_OF} from './helpers/beta-document-evidence.fixture';
import {supplementCommandFixture,supplementUuid as id} from './helpers/fiscal-supplement.fixture';

// Actual owner-composition seals, structural XML fixtures, fake crypto policy.
// These tests do not assert official PKI, issue documents or transmit anything.
async function fixture(history:'ACCEPTED'|'RESERVED'|null=null){
  const original=documentEvidenceFixture(),credit=documentEvidenceFixture('07');
  original.record.completedAt='2026-10-02T16:30:00.000Z';
  original.setCdr(Buffer.from(original.cdr.toString().replace('<cbc:IssueDate>2026-10-03</cbc:IssueDate>','<cbc:IssueDate>2026-10-02</cbc:IssueDate>')));
  const proof=await original.run();
  const data=supplementCommandFixture(),baseContext={...data.context,original:structuredClone(original.doc) as typeof data.doc,acceptance:proof.evidence,asOf:AS_OF,creditHistory:{complete:true as const,entries:[]}};
  const historical=buildFiscalNoteSnapshot(baseContext,{documentTypeCode:'07',reasonCode:'07',reasonDescription:'SYNTHETIC HISTORY',lines:[{originalLineNumber:1,quantity:'1'}]},
    {documentId:credit.doc.documentId,series:'FC01',number:'1',issueDate:data.note.issueDate});
  Object.assign(credit.doc,historical);credit.record.document=structuredClone(historical);credit.record.noteContext=structuredClone(baseContext);
  credit.setXml(Buffer.from(buildFiscalNoteUbl(historical,baseContext)));
  const context={...data.context,original:structuredClone(original.doc) as typeof data.doc,
    acceptance:proof.evidence,asOf:AS_OF,creditHistory:{complete:true as const,entries:history?[{state:history,note:structuredClone(credit.doc) as typeof data.note}]:[]}};
  const note=buildFiscalNoteSnapshot(context,{documentTypeCode:'07',reasonCode:'07',reasonDescription:'SYNTHETIC ONLY',lines:[{originalLineNumber:1,quantity:'1'}]},
    {documentId:id(99),series:'FC01',number:'2',issueDate:data.note.issueDate});
  const command=buildFiscalSupplementCommand({kind:'NOTE',note,context},{eventId:id(98),correlationId:id(97),occurredAt:AS_OF});
  const resolver={verify:vi.fn(async(snapshot:any)=>snapshot.documentId===original.doc.documentId?original.run():credit.run())};
  const core=new BetaCorrectionEvidence(resolver as never);
  return {core,resolver,command,original,credit,run:()=>core.verify(command,AS_OF)};
}
describe('Owner correction evidence bundle, not public trust flags',()=>{
  it('binds command and immutable original proof, with a non-serializable capability',async()=>{
    const f=await fixture(),proof=await f.run();expect(proof.commandSha256).toBe(fiscalSnapshotSha256(f.command));
    expect(proof.proofs).toHaveLength(1);expect(isBetaCorrectionEvidence(proof)).toBe(true);
    expect(isBetaCorrectionEvidence(structuredClone(proof))).toBe(false);expect(proof.transmissionAuthorized).toBe(false);
    expect(Object.isFrozen(proof.proofs[0])).toBe(true);expect(Object.isFrozen((proof.proofs[0] as any).fence)).toBe(true);
  });
  it.each(['ACCEPTED','RESERVED'] as const)('verifies accepted history only; %s is never mistaken for acceptance',async state=>{
    const f=await fixture(state),proof=await f.run();expect(proof.proofs).toHaveLength(state==='ACCEPTED'?2:1);
    expect(f.resolver.verify).toHaveBeenCalledTimes(state==='ACCEPTED'?2:1);
  });
  it('rejects a cloned owner receipt even when every JSON field matches',async()=>{
    const f=await fixture(),proof=await f.original.run();f.resolver.verify.mockResolvedValueOnce(structuredClone(proof) as never);
    await expect(f.run()).rejects.toThrow('OWNER_EVIDENCE_REQUIRED');
  });
  it('rejects a genuine sealed proof for the wrong history member',async()=>{
    const f=await fixture('ACCEPTED'),original=await f.original.run();f.resolver.verify.mockResolvedValue(original as never);
    await expect(f.run()).rejects.toThrow('OWNER_EVIDENCE_BINDING_REQUIRED');
  });
  it('rejects stale acceptance hashes instead of trusting the command context',async()=>{
    const f=await fixture();f.original.setCdr(Buffer.from(f.original.cdr.toString().replace('SIMULADO NO OFICIAL','OTRA DESCRIPCION SINTETICA')));
    await expect(f.run()).rejects.toThrow('ACCEPTANCE_CHANGED');
  });
  it('propagates owner signature/trust rejection without sealing a bundle',async()=>{
    const f=await fixture('ACCEPTED');f.credit.ports.verifyCdr.mockResolvedValueOnce(false);
    await expect(f.run()).rejects.toMatchObject({code:'CDR_SIGNATURE_UNTRUSTED'});
  });
  it('pins the original owner version for subsequent transaction rechecks',async()=>{
    const f=await fixture(),first=await f.run();f.original.record.version='e'.repeat(64);const next=await f.run();
    expect(first.commandSha256).toBe(next.commandSha256);expect(first.evidenceSha256).not.toBe(next.evidenceSha256);
  });
  it('rejects mutation by a resolver across awaits; caller input stays detached',async()=>{
    const f=await fixture();f.resolver.verify.mockImplementationOnce(async(snapshot:any)=>{snapshot.customer.legalName='MUTATED';return f.original.run();});
    await expect(f.run()).rejects.toThrow();expect(f.command.payload.envelope.kind==='NOTE'&&f.command.payload.envelope.context.original.customer.legalName).not.toBe('MUTATED');
  });
});
