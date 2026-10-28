import { B2bBatchMemberAuthority, type BatchMemberPlan, type BatchSubject } from './batch-member-authority';
import { PostgresBatchMemberOwner } from './batch-member-postgres';

/** Explicit local assembly: SERVICE has subjectId:null; RC1/RC2/RC3/RA all use the new
 * versioned aggregate. No legacy repository, decorated route, runtime wiring or transport.
 * Commands retain the real core envelope, but only a dedicated disabled local outbox is written. */
export function createDurableBatchMemberProducer(owner: PostgresBatchMemberOwner, now = () => new Date().toISOString()) {
  const authority = new B2bBatchMemberAuthority(owner, now);
  return {
    plan(value: unknown, subject: BatchSubject) { return authority.plan(value, subject); },
    coordinate(plan: BatchMemberPlan, mode: 'CREATE' | 'REUSE_JOURNAL') {
      return authority.coordinate(plan, mode, mode === 'CREATE' ? async (tx, prepared, checkpoint) => {
        await checkpoint();
        const result = await tx.persist(prepared);
        await checkpoint();
        return result;
      } : undefined);
    },
  };
}
