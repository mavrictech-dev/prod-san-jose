import 'reflect-metadata';
import {describe,it,expect,vi} from 'vitest';
import {createBetaCorrectionOwnerAssembly} from '../services/sunat-service/src/application/beta-correction-owner-assembly';
import {ownerDocumentFixture} from './helpers/beta-document-owner.fixture';
import {summaryCompositionFixture,summaryOwnerRow,outcomeFixture,outcomeOwnerRow,AS_OF} from './helpers/beta-owner-summary.fixture';

describe('Explicit SUNAT owner assembly; no runtime activation or production access',()=>{
  it.each(['01','07','08'] as const)('resolves individual %s through its own Prisma/archive ports',async type=>{
    const f=ownerDocumentFixture(type),db={fiscalDocument:{findFirst:vi.fn(async()=>structuredClone(f.row))}},
      artifacts={read:f.ports.read},signatures={verifyIssuer:f.ports.verifyIssuer,verifyBatch:vi.fn(),verifyEnvelope:vi.fn()};
    const core=createBetaCorrectionOwnerAssembly(db as never,artifacts,signatures,{verify:f.ports.verifyCdr});
    const proof=await core.acceptance.verify(f.doc,AS_OF);expect(proof.evidence.documentId).toBe(f.doc.documentId);
    expect(core.fiscalExecutionEnabled).toBe(false);expect(core.transmissionAuthorized).toBe(false);expect(signatures.verifyBatch).not.toHaveBeenCalled();
  });
  it('resolves a B-series original from its RC owner, not the individual endpoint',async()=>{
    const f=summaryCompositionFixture(),db={fiscalBatch:{findMany:vi.fn(async()=>[summaryOwnerRow(f)])},fiscalDocument:{findUnique:vi.fn()}},
      signatures={verifyIssuer:vi.fn(),verifyBatch:f.signatures.verifyBatch,verifyEnvelope:vi.fn()};
    const core=createBetaCorrectionOwnerAssembly(db as never,f.artifacts,signatures,f.cdrTrust);
    const proof=await core.acceptance.verify(f.document,AS_OF);expect(proof.evidence.source.kind).toBe('CDR_SUMMARY');expect(db.fiscalDocument.findUnique).not.toHaveBeenCalled();
  });
  it.each(['07','RC','RA'] as const)('builds a financial evidence port from owner archives for %s, never JSON flags',async kind=>{
    const f=outcomeFixture(kind),owner=outcomeOwnerRow(f),db={sunatSubmission:{findUnique:vi.fn(async()=>structuredClone(owner.row))},
      documentArtifact:{findMany:vi.fn(async()=>structuredClone(owner.files))},batchArtifact:{findMany:vi.fn(async()=>structuredClone(owner.files))}},
      signatures={verifyIssuer:vi.fn(),verifyBatch:vi.fn(),verifyEnvelope:f.signatures.verifyEnvelope};
    const core=createBetaCorrectionOwnerAssembly(db as never,{read:f.owner.read},signatures,f.cdrTrust),commands={load:vi.fn(async()=>f.command)},port=core.financialEvidence(commands);
    expect(await port.command(f.command.payload.operationId)).toBe(f.command);const proof=await port.verify(f.command,AS_OF);
    expect(port.owns(proof)).toBe(true);expect(port.owns(structuredClone(proof))).toBe(false);expect(proof.evidence.status).toBe('ACCEPTED');
    expect(port.ownsPrerequisites({commandSha256:proof.commandSha256,evidenceSha256:'a'.repeat(64)})).toBe(false);
    expect(port.ownsOriginal({fence:proof.fence})).toBe(false);
  });
});
