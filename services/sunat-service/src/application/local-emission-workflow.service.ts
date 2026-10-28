import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { LocalDocumentPendingError, LocalXmlValidationService } from './local-xml-validation.service';
import { FiscalCircuitQaService } from './fiscal-circuit-qa.service';
import { isRetryableLocalPreparationError } from './local-preparation-policy';

/** Una venta YA registrada, sin volver a emitir ni almacenar su JWT.
 * Sólo laboratorio ficticio/self-signed. No activa el adaptador Beta oficial. */
@Injectable()
export class LocalEmissionWorkflowService {
  constructor(private readonly local: LocalXmlValidationService, private readonly circuit: FiscalCircuitQaService) {}

  async run(documentId: string, actorId: string, authorization?: string) {
    if (process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true' || process.env.LOCAL_XML_VALIDATION_ENABLED !== 'true' ||
      process.env.SUNAT_BETA_TRANSMISSION_ENABLED === 'true') throw new ServiceUnavailableException('El flujo local requiere QA aislada y transmisión externa deshabilitada');
    const base = { documentId, localOnly: true, official: false, fiscalTransmission: false, transport: 'LOCAL_SIMULATION' as const };
    try {
      // Billing revalida acceso; contexto exige 00…/BETA/autofirmado vigente.
      await this.local.context(documentId, authorization);
      const circuit = await this.circuit.start(documentId, actorId, 'ACCEPTED', authorization);
      return { ...base, phase: 'CIRCUIT_STARTED' as const, circuit };
    } catch (error) {
      if (error instanceof LocalDocumentPendingError) return { ...base, phase: 'WAITING_LOCAL_COPY' as const, retryAfterMs: 2000 };
      if (isRetryableLocalPreparationError(error)) return { ...base, phase: 'WAITING_LOCAL_VALIDATOR' as const, retryAfterMs: 2000 };
      // No reintentar autorización, configuración, XSD inválido ni corrupción.
      throw error;
    }
  }
}
