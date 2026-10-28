import 'reflect-metadata';
import {describe, expect, it, vi} from 'vitest';
import {VerifiedFinancialCommit} from '../services/billing-service/src/application/verified-financial-commit';
import {VerifiedCorrectionTransaction} from '../services/billing-service/src/application/verified-correction-transaction';
import {FinancialLedgerCandidateRepository} from '../services/billing-service/src/application/financial-ledger-candidate.repository';
import {assertFinancialLedgerCandidateActivation} from '../services/billing-service/src/application/financial-ledger-candidate.service';
import {assertBillingSupplementActivation} from '../services/billing-service/src/application/beta-supplement-command.service';
import {projectFiscalFinancialLedger} from '../packages/sunat-core/src/fiscal-financial-ledger';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {supplementCommandFixture, supplementUuid as id} from './helpers/fiscal-supplement.fixture';

// Transactional test doubles, invented snapshots and sealed fixture proofs ONLY.
// owns() establishes provenance within this fixture, NOT XML/CDR/PKI trust.
const copy = <T>(value:T):T => structuredClone(value);
function fixture() {
  const f=supplementCommandFixture(), scope={issuerRuc:f.doc.issuer.identityNumber, companyId:f.doc.companyId,
    branchId:f.doc.branchId!, environment:'BETA' as const};
  const actor={userId:null, scope:{kind:'ASSIGNED' as const, branchIds:[scope.branchId], emissionPointIds:[id(20)], series:[id(21),id(22)]},
    b2b:{kind:'SERVICE' as const, clientId:id(70), revision:1, subjectId:null, userAuthRevision:null}};
  const base={scope, documents:[copy(f.doc)], entries:[]};
  const projected=projectFiscalFinancialLedger(base); if(!projected.ok) throw new Error('BAD_FIXTURE');
  const evidence={status:'ACCEPTED' as const, cdrSignatureVerified:true, officialCdr:true, responseCode:'0',
    cdrSha256:'b'.repeat(64), requestSha256:'c'.repeat(64), acceptedAt:'2026-10-03T18:10:00Z'};
  const plan={planId:id(71), input:{...base, entries:[{...scope, documentId:f.doc.documentId, eventId:id(72),
    operationId:f.note.documentId, sequence:1, expectedPreviousSha256:projected.documents[0].currentVersion.sha256,
    kind:'NOTE_CREDIT' as const, nextSnapshot:copy(f.note), noteContext:{...copy(f.context),asOf:'2026-10-04T18:00:00Z'}, evidence:copy(evidence)}]},
    expectedHeads:[{documentId:f.doc.documentId, revision:0, sequence:0, versionSha256:null}]};
  const writes:string[]=[], options:unknown[]=[], sealed=new WeakSet<object>(), prerequisiteSeals=new WeakSet<object>(), originalSeals=new WeakSet<object>();
  const faults={conflicts:0, commit:false};
  const tx={$executeRaw:vi.fn(async()=>1), marker:'OWNER_TX'};
  const db={$transaction:vi.fn(async(work:(value:typeof tx)=>Promise<unknown>, option:unknown)=>{
    options.push(option); const before=[...writes];
    try {
      if(faults.conflicts-->0) throw Object.assign(new Error('FIXTURE_SERIALIZATION'),{code:'P2034'});
      const value=await work(tx); if(faults.commit) throw new Error('FIXTURE_COMMIT_FAILURE'); return value;
    } catch(error) {writes.splice(0,writes.length,...before); throw error;}
  })};
  const authority={current:vi.fn(async()=>copy(actor))};
  const outcomes={command:vi.fn(async()=>copy(f.command)),
    prerequisites:vi.fn(async(command:unknown,_asOf:string)=>{
      const proof={commandSha256:fiscalSnapshotSha256(command),evidenceSha256:fiscalSnapshotSha256(f.context)};
      prerequisiteSeals.add(proof);return proof;
    }),
    ownsPrerequisites:vi.fn((p:unknown)=>!!p&&typeof p==='object'&&prerequisiteSeals.has(p as object)),
    original:vi.fn(async(snapshot:unknown,_asOf:string)=>{
      const d=snapshot as typeof f.doc;
      const proof={evidence:{documentId:d.documentId,snapshotSha256:fiscalSnapshotSha256(snapshot),issuerRuc:d.issuer.identityNumber,environment:d.environment!},fence:{snapshotSha256:fiscalSnapshotSha256(snapshot),revision:1}};originalSeals.add(proof);return proof;
    }),
    ownsOriginal:vi.fn((p:unknown)=>!!p&&typeof p==='object'&&originalSeals.has(p as object)),
    verify:vi.fn(async()=>{
    const proof={commandSha256:fiscalSnapshotSha256(f.command), operationId:f.note.documentId,
      evidence:copy(evidence), fence:{revision:1, requestSha256:'d'.repeat(64)}};
    sealed.add(proof); return proof;
  }), owns:vi.fn((proof:unknown)=>!!proof&&typeof proof==='object'&&sealed.has(proof as object))};
  const repository={commitWithinTransaction:vi.fn(async(ownerTx:unknown, _plan:unknown, _actor:unknown)=>{
    expect(ownerTx).toBe(tx); writes.push('CANDIDATE_COMMIT'); return {candidateOnly:true, deduplicated:false};
  })};
  const core=new VerifiedFinancialCommit(db as never, repository as never, outcomes, authority,()=> '2026-10-04T18:00:00Z');
  return {f,scope,actor,evidence,plan,tx,db,options,faults,authority,outcomes,repository,writes,core,sealed,prerequisiteSeals,originalSeals};
}

describe('VerifiedFinancialCommit — isolated owner outcome boundary',()=>{
  it('uses one owner transaction and verifies sealed evidence before, inside and immediately before commit',async()=>{
    const h=fixture(); await expect(h.core.commit(h.plan,h.actor)).resolves.toMatchObject({candidateOnly:true});
    expect(h.db.$transaction).toHaveBeenCalledTimes(1); expect(h.repository.commitWithinTransaction).toHaveBeenCalledTimes(1);
    expect(h.options).toEqual([{isolationLevel:'Serializable',maxWait:3000,timeout:15000}]);
    expect(h.outcomes.verify).toHaveBeenCalledTimes(3); expect(h.outcomes.owns).toHaveBeenCalledTimes(3);
    expect(h.outcomes.original).toHaveBeenCalledTimes(3);expect(h.outcomes.ownsOriginal).toHaveBeenCalledTimes(3);
    expect(h.outcomes.prerequisites).toHaveBeenCalledTimes(3);expect(h.outcomes.ownsPrerequisites).toHaveBeenCalledTimes(3);
    expect(h.authority.current).toHaveBeenCalledTimes(3);
    for(const [command,asOf] of h.outcomes.verify.mock.calls as unknown as Array<[unknown,string]>) {
      expect(command).toEqual(h.f.command); expect(asOf).toBe('2026-10-04T18:00:00Z');
    }
    expect(h.writes).toEqual(['CANDIDATE_COMMIT']);
  });
  it('passes a typed SERVICE actor with null human IDs, not a fabricated human',async()=>{
    const h=fixture(); await h.core.commit(h.plan,h.actor);
    const actor=h.repository.commitWithinTransaction.mock.calls[0][2];
    expect(actor).toEqual(h.actor); expect(actor).toMatchObject({userId:null,b2b:{kind:'SERVICE',subjectId:null,userAuthRevision:null}});
    expect(actor).not.toBe(h.actor);
  });
  it('base-only plans still require original owner provenance, not Billing ACCEPTED projection alone',async()=>{
    const h=fixture();h.plan.input.entries=[];
    await h.core.commit(h.plan,h.actor);
    expect(h.outcomes.original).toHaveBeenCalledTimes(3);expect(h.outcomes.ownsOriginal).toHaveBeenCalledTimes(3);
    expect(h.outcomes.verify).not.toHaveBeenCalled();expect(h.outcomes.prerequisites).not.toHaveBeenCalled();
  });
  it('base-only copied original proof is rejected before persistence',async()=>{
    const h=fixture();h.plan.input.entries=[];const normal=h.outcomes.original.getMockImplementation()!;
    h.outcomes.original.mockImplementation(async(...args)=>copy(await normal(...args)));
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_ORIGINAL_REQUIRED');expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it('base-only original fence changing immediately precommit rolls back writes',async()=>{
    const h=fixture();h.plan.input.entries=[];const normal=h.outcomes.original.getMockImplementation()!;let calls=0;
    h.outcomes.original.mockImplementation(async(...args)=>{const p=await normal(...args);if(++calls===3)p.fence.revision++;return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FINANCIAL_EVIDENCE_CHANGED');expect(h.writes).toEqual([]);
    expect(h.repository.commitWithinTransaction).toHaveBeenCalledTimes(1);
  });
  it('outcome and original seals cannot substitute for the prerequisites owner seal',async()=>{
    const h=fixture(), normal=h.outcomes.prerequisites.getMockImplementation()!;
    h.outcomes.prerequisites.mockImplementation(async(...args)=>{const p=copy(await normal(...args));h.sealed.add(p);h.originalSeals.add(p);return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_PREREQUISITES_REQUIRED');expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.outcomes.verify).not.toHaveBeenCalled();
  });
  it.each(['commandSha256','evidenceSha256'] as const)('prerequisites proof with invalid %s is not accepted just because it is sealed',async field=>{
    const h=fixture(), normal=h.outcomes.prerequisites.getMockImplementation()!;
    h.outcomes.prerequisites.mockImplementation(async(...args)=>{const p=await normal(...args);p[field]=field==='commandSha256'?'0'.repeat(64):'NOT_A_SHA';return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_PREREQUISITES_REQUIRED');expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it('prerequisite acceptance/history evidence changing precommit rolls back the settlement',async()=>{
    const h=fixture(), normal=h.outcomes.prerequisites.getMockImplementation()!;let calls=0;
    h.outcomes.prerequisites.mockImplementation(async(...args)=>{const p=await normal(...args);if(++calls===3)p.evidenceSha256='0'.repeat(64);return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FINANCIAL_EVIDENCE_CHANGED');expect(h.writes).toEqual([]);
    expect(h.repository.commitWithinTransaction).toHaveBeenCalledTimes(1);
  });
  it('public signature/official booleans and a copied proof cannot impersonate the owner seal',async()=>{
    const h=fixture(), proof=await h.outcomes.verify();
    h.outcomes.verify.mockImplementation(async()=>copy(proof));
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_OWN_OUTCOME_REQUIRED');
    expect(h.outcomes.owns).toHaveBeenCalled(); expect(h.db.$transaction).not.toHaveBeenCalled();
    expect(h.repository.commitWithinTransaction).not.toHaveBeenCalled();
  });
  it.each(['cdrSha256','requestSha256','acceptedAt','responseCode','status','cdrSignatureVerified','officialCdr'] as const)(
    'requires exact owner outcome, including %s, even when a proof is sealed',async field=>{
      const h=fixture(), normal=h.outcomes.verify.getMockImplementation()!;
      h.outcomes.verify.mockImplementation(async()=>{
        const proof=await normal(); const e=proof.evidence as Record<string,unknown>;
        e[field]=typeof e[field]==='boolean'?!e[field]:field==='status'?'REJECTED':field==='responseCode'?'2335':field==='acceptedAt'?'2026-10-03T18:11:00Z':'e'.repeat(64);
        return proof;
      });
      await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_OWN_OUTCOME_REQUIRED');
      expect(h.db.$transaction).not.toHaveBeenCalled();
    });
  it.each(['commandSha256','operationId'] as const)('rejects owner proof with wrong %s',async field=>{
    const h=fixture(), normal=h.outcomes.verify.getMockImplementation()!;
    h.outcomes.verify.mockImplementation(async()=>({...await normal(),[field]:field==='operationId'?id(800):'0'.repeat(64)}));
    // Seal the changed object so this exercises binding rather than just owns().
    const changed=h.outcomes.verify.getMockImplementation()!;
    h.outcomes.verify.mockImplementation(async()=>{const p=await changed();h.sealed.add(p);return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_OWN_OUTCOME_REQUIRED');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects a different valid command returned for the requested operation',async()=>{
    const h=fixture(), foreign=copy(h.f.command); foreign.eventId=id(801);
    h.outcomes.command.mockResolvedValue(foreign);
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_OWN_OUTCOME_REQUIRED');
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['before-write','precommit'] as const)('revocation %s aborts and rolls back candidate writes',async when=>{
    const h=fixture(); let calls=0;
    h.authority.current.mockImplementation(async()=>{if(++calls===(when==='precommit'?3:2))throw new Error('FIXTURE_REVOKED');return copy(h.actor);});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FIXTURE_REVOKED');
    expect(h.writes).toEqual([]); expect(h.repository.commitWithinTransaction).toHaveBeenCalledTimes(when==='precommit'?1:0);
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);
  });
  it.each(['grant','scope'] as const)('changed %s immediately precommit cannot be persisted',async mode=>{
    const h=fixture(); let calls=0;
    h.authority.current.mockImplementation(async()=>{const a=copy(h.actor);if(++calls===3){if(mode==='grant')a.b2b.revision++;else a.scope.series=[];}return a;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FINANCIAL_AUTHORITY_CHANGED'); expect(h.writes).toEqual([]);
  });
  it('changed evidence fence immediately precommit rolls back the owner result',async()=>{
    const h=fixture(), normal=h.outcomes.verify.getMockImplementation()!; let calls=0;
    h.outcomes.verify.mockImplementation(async()=>{const p=await normal();if(++calls===3)p.fence.revision++;return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FINANCIAL_EVIDENCE_CHANGED');
    expect(h.repository.commitWithinTransaction).toHaveBeenCalledTimes(1); expect(h.writes).toEqual([]);
  });
  it('an unavailable proof owner fails closed and is not retried as a serialization conflict',async()=>{
    const h=fixture(); h.outcomes.verify.mockRejectedValue(new Error('FIXTURE_OWNER_UNAVAILABLE'));
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FIXTURE_OWNER_UNAVAILABLE'); expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it('commit failure rolls back without nesting repository transactions or retrying other errors',async()=>{
    const h=fixture(); h.faults.commit=true;
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FIXTURE_COMMIT_FAILURE');
    expect(h.writes).toEqual([]); expect(h.db.$transaction).toHaveBeenCalledTimes(1);
  });
  it('P2034 retries exactly the same detached plan at most three attempts',async()=>{
    const h=fixture(); let writes=0;
    h.repository.commitWithinTransaction.mockImplementation(async()=>{
      h.writes.push('PENDING'); if(++writes<3)throw Object.assign(new Error('FIXTURE_CONFLICT'),{code:'P2034'});
      return {candidateOnly:true,deduplicated:false};
    });
    await h.core.commit(h.plan,h.actor); expect(h.db.$transaction).toHaveBeenCalledTimes(3);expect(h.writes).toEqual(['PENDING']);
    const plans=h.repository.commitWithinTransaction.mock.calls.map(call=>call[1]);
    expect(plans.every(p=>p===plans[0]&&Object.isFrozen(p))).toBe(true);
    const bad=fixture(); bad.faults.conflicts=5;
    await expect(bad.core.commit(bad.plan,bad.actor)).rejects.toMatchObject({code:'P2034'});
    expect(bad.db.$transaction).toHaveBeenCalledTimes(3);expect(bad.writes).toEqual([]);
  });
  it('retries an exact plan receipt PK collision as a whole transaction, not a second effect',async()=>{
    const h=fixture();h.repository.commitWithinTransaction.mockRejectedValueOnce(Object.assign(new Error('CONCURRENT_RECEIPT'),{code:'P2002',meta:{modelName:'FinancialLedgerCommit'}}));
    await h.core.commit(h.plan,h.actor);expect(h.db.$transaction).toHaveBeenCalledTimes(2);expect(h.writes).toHaveLength(1);
  });
  it.each(['documentId','snapshotSha256','issuerRuc','environment'] as const)('rejects a sealed original proof with a different %s',async field=>{
    const h=fixture(),normal=h.outcomes.original.getMockImplementation()!;
    h.outcomes.original.mockImplementation(async(...args)=>{const p=await normal(...args);p.evidence[field]='WRONG';return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('VERIFIED_ORIGINAL_REQUIRED');expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it.each([{modelName:'Document'},{modelName:'FinancialLedgerCommit',target:['otherField']}])('does not retry an unrelated unique constraint %j',async meta=>{
    const h=fixture();h.repository.commitWithinTransaction.mockRejectedValue(Object.assign(new Error('UNRELATED_UNIQUE'),{code:'P2002',meta}));
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('UNRELATED_UNIQUE');expect(h.db.$transaction).toHaveBeenCalledTimes(1);expect(h.writes).toEqual([]);
  });
  it('retains original evidence fences across P2034 retry rather than adopting a newer proof',async()=>{
    const h=fixture();h.faults.conflicts=1;const normal=h.outcomes.verify.getMockImplementation()!;let calls=0;
    h.outcomes.verify.mockImplementation(async()=>{const p=await normal();if(++calls>1)p.fence.revision++;return p;});
    await expect(h.core.commit(h.plan,h.actor)).rejects.toThrow('FINANCIAL_EVIDENCE_CHANGED');
    expect(h.repository.commitWithinTransaction).not.toHaveBeenCalled();expect(h.db.$transaction).toHaveBeenCalledTimes(2);
  });
  it('malformed plans and untyped null-human actors fail before authority and DB',async()=>{
    for(const mode of ['plan','actor']){const h=fixture();await expect(h.core.commit(mode==='plan'?{}:h.plan,mode==='actor'?{userId:null,scope:h.actor.scope}:h.actor)).rejects.toThrow();
      expect(h.authority.current).not.toHaveBeenCalled();expect(h.db.$transaction).not.toHaveBeenCalled();}
  });
  it('repository owner port validates SERVICE without calling its transaction wrapper',async()=>{
    const h=fixture(), nested=vi.fn(()=>{throw new Error('NESTED_TRANSACTION_FORBIDDEN');});
    const repo=new FinancialLedgerCandidateRepository({$transaction:nested} as never);
    const company=vi.fn(async()=>{throw new Error('REACHED_OWNER_TX');});
    const tx={$executeRaw:vi.fn(async()=>1),companySettings:{findUnique:company}};
    await expect(repo.commitWithinTransaction(tx as never,h.plan,h.actor)).rejects.toThrow('REACHED_OWNER_TX');
    expect(company).toHaveBeenCalled();expect(nested).not.toHaveBeenCalled();
  });
});

describe('VerifiedCorrectionTransaction — isolated note owner boundary',()=>{
  function correction(){const h=fixture(), sealed=new WeakSet<object>();
    const evidence={verify:vi.fn(async()=>{const p={commandSha256:fiscalSnapshotSha256(h.f.command),evidenceSha256:'f'.repeat(64)};sealed.add(p);return p;}),
      owns:vi.fn((p:unknown)=>!!p&&typeof p==='object'&&sealed.has(p as object))};
    const core=new VerifiedCorrectionTransaction(h.db as never,h.authority,evidence,[h.scope.issuerRuc],()=> '2026-10-04T18:00:00Z');
    const work=vi.fn(async(tx:unknown,_command:unknown,a:unknown)=>{expect(tx).toBe(h.tx);expect(a).toEqual(h.actor);h.writes.push('NOTE_RESERVED');return 'DONE';});
    return {...h,evidence,sealed,core,work};}
  it('shares the exact transaction and typed actor with the reservation owner, taking its company/RUC lock',async()=>{
    const h=correction();await expect(h.core.execute(h.f.command,h.work)).resolves.toBe('DONE');
    expect(h.db.$transaction).toHaveBeenCalledTimes(1);expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.evidence.verify).toHaveBeenCalledTimes(3);expect(h.authority.current).toHaveBeenCalledTimes(3);
    expect(h.tx.$executeRaw.mock.calls[0]).toContain(`factuez:beta-supplement:company:${h.scope.companyId}:ruc:${h.scope.issuerRuc}`);
  });
  it('rejects a caller-created proof even when hash-shaped fields match',async()=>{
    const h=correction(), p=await h.evidence.verify();h.evidence.verify.mockResolvedValue(copy(p));
    await expect(h.core.execute(h.f.command,h.work)).rejects.toThrow('OWNER_EVIDENCE_REQUIRED');expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it.each(['command','evidence','authority'] as const)('precommit %s change rolls back reservation work',async mode=>{
    const h=correction(), normal=h.evidence.verify.getMockImplementation()!;let calls=0;
    if(mode==='authority')h.authority.current.mockImplementation(async()=>{const a=copy(h.actor);if(++calls===3)a.b2b.revision++;return a;});
    else h.evidence.verify.mockImplementation(async()=>{const p=await normal();if(++calls===3){if(mode==='command')p.commandSha256='0'.repeat(64);else p.evidenceSha256='0'.repeat(64);}return p;});
    await expect(h.core.execute(h.f.command,h.work)).rejects.toThrow(mode==='authority'?'AUTHORITY_CHANGED':'EVIDENCE_CHANGED');
    expect(h.work).toHaveBeenCalledTimes(1);expect(h.writes).toEqual([]);
  });
  it('retries only P2034 up to three times and never nests transactions',async()=>{
    const h=correction();h.faults.conflicts=2;await h.core.execute(h.f.command,h.work);
    expect(h.db.$transaction).toHaveBeenCalledTimes(3);expect(h.work).toHaveBeenCalledTimes(1);
    const bad=correction();bad.faults.conflicts=4;await expect(bad.core.execute(bad.f.command,bad.work)).rejects.toMatchObject({code:'P2034'});
    expect(bad.db.$transaction).toHaveBeenCalledTimes(3);expect(bad.writes).toEqual([]);
  });
  it('requires explicit Beta RUC profile and does not widen to a different issuer',async()=>{
    const h=correction();expect(()=>new VerifiedCorrectionTransaction(h.db as never,h.authority,h.evidence,[])).toThrow('EXPLICIT_BETA_PROFILE_REQUIRED');
    const core=new VerifiedCorrectionTransaction(h.db as never,h.authority,h.evidence,['20000000001']);
    await expect(core.execute(h.f.command,h.work)).rejects.toThrow('BETA_PROFILE_NOT_ENABLED');expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it('public activation gates remain closed regardless of a valid local fixture',()=>{
    expect(()=>assertBillingSupplementActivation()).toThrow('Productor fiscal BETA bloqueado');
    expect(()=>assertFinancialLedgerCandidateActivation()).toThrow('Persistencia candidata BETA bloqueada');
  });
});
