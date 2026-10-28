import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { BetaSupplementCommandRepository } from '../application/beta-supplement-command.repository';
import type { SupplementActor } from '../application/supplement-actor';
import {
  B2bBatchMemberAuthority, type BatchMemberOwnerPort, type BatchMemberPlan, type BatchSubject,
} from './batch-member-authority';

/** Explicit local candidate bridge to the existing producer's SAME owner transaction.
 * The supplied owner must implement transaction-local member/grant/history locks and
 * journal persistence. This factory does not supply a PostgreSQL authority adapter,
 * install schema, activate routes, or authorize transport. Repository restrictions
 * remain intact: USER only, one point, RC1/RC3/RA; RC2 has no materialized versions.
 * Never call repository.reserve(): it opens/retries a separate transaction. */
export function createBillingBatchMemberProducer(
  owner: BatchMemberOwnerPort<Prisma.TransactionClient>, db: Pick<PrismaClient, '$transaction'>,
  now = () => new Date().toISOString(),
) {
  const authority = new B2bBatchMemberAuthority(owner, now);
  const repository = new BetaSupplementCommandRepository(db);
  const profile = (plan: BatchMemberPlan) => {
    const roots = plan.request.entries.map(e => plan.members.find(m =>
      m.record.member.documentId === e.member.documentId && m.record.member.version === e.member.version)!.record);
    if (plan.subject.kind !== 'USER' || new Set(roots.map(r => r.binding.pointId)).size !== 1 ||
      plan.request.kind === 'RC' && plan.request.entries.some(e => e.conditionCode === '2'))
      throw new B2bSecurityError(409, 'BATCH_PRODUCER_UNSUPPORTED');
  };
  return {
    async plan(value: unknown, subject: BatchSubject) {
      const plan = await authority.plan(value, subject); profile(plan); return plan;
    },
    coordinate(plan: BatchMemberPlan, mode: 'CREATE' | 'REUSE_JOURNAL') {
      return authority.coordinate(plan, mode, mode === 'CREATE' ? async (tx, prepared, checkpoint) => {
        profile(plan);
        const actor: SupplementActor = {
          userId: plan.subject.subjectId,
          scope: { kind: 'ASSIGNED', branchIds: [plan.request.scope.branchId],
            emissionPointIds: [...new Set(plan.members.map(m => m.record.binding.pointId))],
            series: [...new Set(plan.members.map(m => m.record.binding.seriesId))] },
          b2b: { ...plan.subject, revision: plan.members[0].grant.clientRevision,
            userAuthRevision: plan.members[0].grant.userAuthRevision },
        };
        await checkpoint();
        const result = await repository.reserveWithinTransaction(tx, prepared.command, actor);
        await checkpoint();
        return result;
      } : undefined);
    },
  };
}
