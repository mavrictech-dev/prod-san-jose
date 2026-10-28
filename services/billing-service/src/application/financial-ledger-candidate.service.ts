import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { BetaSupplementActor } from './beta-supplement-command.repository';
import { FinancialLedgerCandidateRepository, type FinancialLedgerCandidateCommitResult } from './financial-ledger-candidate.repository';

export function assertFinancialLedgerCandidateActivation(): never {
  throw new ServiceUnavailableException('Persistencia candidata BETA bloqueada: blueprint no aplicado y resolvedor de evidencia confiable pendiente');
}
/** No controller or worker exposes candidate commits. No client evidence bypass. */
@Injectable()
export class FinancialLedgerCandidateService {
  constructor(private readonly repository: FinancialLedgerCandidateRepository) {}
  async commit(plan: unknown, actor: BetaSupplementActor): Promise<FinancialLedgerCandidateCommitResult> {
    assertFinancialLedgerCandidateActivation();
    return this.repository.commit(plan, actor);
  }
}
