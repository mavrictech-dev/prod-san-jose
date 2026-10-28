import { EventNames, type FiscalDocumentSnapshot, type SunatStatusChangedEventV1 } from './events';

export type ProductionStatusEvidence = {
  transport: 'SUNAT_PRODUCTION';
  environment: 'PRODUCTION';
  issuerRuc: string;
  submissionId: string;
  officialCdr: boolean;
  cdrSignatureVerified: boolean;
  /** Present on 03 final outcomes: the CDR belongs to this exact RC, not an individual Invoice. */
  cdrScope?: 'RECEIPT_SUMMARY';
  summaryIdentifier?: string;
  summaryXmlSha256?: string;
  summaryZipSha256?: string;
  documentSnapshotSha256?: string;
};
/** Separate from Beta, including progress events. 03 final outcomes require exact RC and member snapshot evidence. */
export type ProductionStatusEvent = SunatStatusChangedEventV1 & {
  payload: SunatStatusChangedEventV1['payload'] & {
    environment: 'PRODUCTION';
    provenance: 'SUNAT_PRODUCTION';
    documentTypeCode: '01' | '03';
    evidence?: ProductionStatusEvidence;
  };
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = ['QUEUED', 'BUILDING', 'SIGNED', 'SUBMITTED', 'ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED', 'RETRYABLE_ERROR', 'PERMANENT_ERROR'];
/** Validates a trusted private producer's projection claims; this is not a CDR signature verifier.
 * No legacy/Beta fallback: production context is required even for progress without evidence. */
export function assertProductionStatusProjection(event: ProductionStatusEvent, snapshot: FiscalDocumentSnapshot): void {
  if (!event || !snapshot || event.eventName !== EventNames.sunatStatusChanged || event.producer !== 'sunat-service' ||
      typeof event.eventId !== 'string' || !uuid.test(event.eventId) ||
      typeof event.payload?.documentId !== 'string' || !uuid.test(event.payload.documentId) ||
      event.payload.documentId !== snapshot.documentId || !statuses.includes(event.payload.status))
    throw new Error('Contrato de proyección fiscal de producción inválido');
  const payload = event.payload;
  if (payload.environment !== 'PRODUCTION' || payload.provenance !== 'SUNAT_PRODUCTION' || !['01', '03'].includes(payload.documentTypeCode) ||
      snapshot.environment !== 'PRODUCTION' || snapshot.documentTypeCode !== payload.documentTypeCode)
    throw new Error('Contexto de proyección fiscal de producción inválido');
  const proof = payload.evidence;
  if (proof !== undefined && (!proof || proof.transport !== 'SUNAT_PRODUCTION' || proof.environment !== 'PRODUCTION' ||
      typeof proof.issuerRuc !== 'string' || proof.issuerRuc !== snapshot.issuer?.identityNumber ||
      typeof proof.submissionId !== 'string' || !uuid.test(proof.submissionId)))
    throw new Error('Contexto de evidencia fiscal de producción inválido');
  if (snapshot.documentTypeCode === '03') {
    if (snapshot.currencyCode !== 'PEN' || snapshot.operationTypeCode !== '0101') throw new Error('Contexto 03 fuera de PEN/0101');
    // BUILDING may precede RC reservation. Final claims always bind the RC and Billing's frozen snapshot.
    const final = ['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(payload.status);
    const sha = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    if (final && (!proof || proof.cdrScope !== 'RECEIPT_SUMMARY' || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(proof.summaryIdentifier ?? '') ||
        !sha(proof.summaryXmlSha256) || !sha(proof.summaryZipSha256) || !sha(proof.documentSnapshotSha256)))
      throw new Error('CDR RC con identificador y hashes exactos requerido para boleta 03');
    if (proof?.documentSnapshotSha256 !== undefined && proof.documentSnapshotSha256 !== productionDocumentSnapshotSha256(snapshot))
      throw new Error('Snapshot de evidencia RC no corresponde al snapshot inmutable de Billing');
  }
  if (['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS', 'REJECTED'].includes(payload.status) &&
      (!proof || proof.officialCdr !== true || proof.cdrSignatureVerified !== true))
    throw new Error('CDR oficial verificado requerido para producción');
}

/** Private server assertion helper. Lazy builtin access keeps the shared contracts import browser-safe.
 * Node >=22 is the service runtime. Canonicalization is identical to sunat-core fiscalSnapshotSha256. */
export function productionDocumentSnapshotSha256(snapshot: FiscalDocumentSnapshot): string {
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => JSON.stringify(key) + ':' + canonical(v)).join(',') + '}';
    return JSON.stringify(value);
  };
  return process.getBuiltinModule('node:crypto').createHash('sha256').update(canonical(snapshot)).digest('hex');
}
