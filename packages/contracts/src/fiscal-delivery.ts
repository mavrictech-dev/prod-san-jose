import { EventNames, type FiscalDocumentSnapshot, type SunatStatusChangedEventV1 } from './events';
export type BetaStatusEvidence = { transport: 'SUNAT_BETA'; environment: 'BETA'; issuerRuc: string;
  submissionId: string; officialCdr: boolean; cdrSignatureVerified: boolean };
export type BetaStatusEvent = SunatStatusChangedEventV1 & { payload: SunatStatusChangedEventV1['payload'] & { evidence?: BetaStatusEvidence } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Una aceptación QA o un CDR de firma no acreditada nunca actualizan el estado fiscal de Billing. */
export function assertBetaStatusProjection(event: BetaStatusEvent, snapshot: FiscalDocumentSnapshot) {
  if (event.eventName !== EventNames.sunatStatusChanged || event.producer !== 'sunat-service' || !uuid.test(event.eventId) ||
    !uuid.test(event.payload?.documentId ?? '') || event.payload.documentId !== snapshot.documentId ||
    !['QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR'].includes(event.payload.status))
    throw new Error('Contrato de proyección fiscal inválido');
  const proof = event.payload.evidence;
  if (proof && (proof.transport !== 'SUNAT_BETA' || proof.environment !== 'BETA' || snapshot.environment !== 'BETA' ||
    proof.issuerRuc !== snapshot.issuer.identityNumber || !uuid.test(proof.submissionId))) throw new Error('Contexto de evidencia fiscal inválido');
  if (['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(event.payload.status) &&
    (!proof || proof.officialCdr !== true || proof.cdrSignatureVerified !== true)) throw new Error('CDR oficial verificado requerido');
}
