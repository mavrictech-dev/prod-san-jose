import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BetaSupplementCommandRepository, type BetaSupplementActor, type BetaSupplementReservation } from './beta-supplement-command.repository';

/** No environment flag or caller claim can enable this producer. Opening it
 * requires a separately reviewed evidence resolver and financial persistence.
 * Keep the check before validation, DB, reservations, counters and Outbox.
 */
export function assertBillingSupplementActivation(): never {
  throw new ServiceUnavailableException('Productor fiscal BETA bloqueado: evidencia confiable y conciliación persistida pendientes');
}

/** Internal port only. No controller, scheduled task or demo calls reserve(). */
@Injectable()
export class BetaSupplementCommandService {
  constructor(private readonly repository: BetaSupplementCommandRepository) {}
  async reserve(command: unknown, actor: BetaSupplementActor): Promise<BetaSupplementReservation> {
    assertBillingSupplementActivation();
    return this.repository.reserve(command, actor);
  }
}
