import { AccessError, UUID } from '@factuez/service-access';
import { createHash } from 'node:crypto';
import type { StoredSmtpConfiguration } from './smtp-configuration.store';
import { activeGrant, configurationDigest, activationInput, corporateSmtpEnabled, testInput, type Activation, type CorporateMailJob } from './corporate-mail.policy';
export const documentSmtpEnabled = () => corporateSmtpEnabled() && process.env.SERVER_SMTP_DOCUMENTS_ENABLED === 'true';
export function documentGate() { if (!documentSmtpEnabled()) throw new AccessError(423, 'Envío DOCUMENT deshabilitado en este servidor'); }
export const documentActivationInput = activationInput;
export function documentSendInput(body: unknown, key: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'confirmed,documentId,expectedActivationRevision,expectedRevision,format,recipient')
    throw new AccessError(400, 'Campos de envío documental no permitidos');
  const { documentId, format, ...rest } = body as Record<string, unknown>;
  if (typeof documentId !== 'string' || !UUID.test(documentId) || !['a4', 'ticket'].includes(String(format)))
    throw new AccessError(400, 'Comprobante o formato inválido');
  return { ...testInput(rest, key), documentId: documentId.toLowerCase(), format: format as 'a4' | 'ticket' };
}
export type DocumentActivation = Activation;
export type DocumentMailJob = CorporateMailJob & { documentId: string; format: 'a4' | 'ticket'; documentProof: string };
export const documentJobView = (j: DocumentMailJob) => ({ id: j.id, documentId: j.documentId, format: j.format,
  companyId: j.companyId, ruc: j.issuerRuc, configurationRevision: j.configurationRevision, activationRevision: j.activationRevision,
  state: j.state, createdAt: j.createdAt, finishedAt: j.finishedAt, handedOffToSmtp: j.state === 'HANDED_OFF',
  deliveredToClient: false, scope: 'DOCUMENT' as const });
export const bytesDigest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Canonical snapshots ignore JSON property order, never fiscal values or original bytes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical((value as Record<string, unknown>)[k])).join(',') + '}';
}

/** Explicit scope version: a v1 01/03 activation cannot silently authorize 07/08.
 * Existing jobs/activations become stale and need a new confirmed DOCUMENT activation. */
export const DOCUMENT_AUTHORIZATION_PROFILE = 'factuez.mail.document.01-03-07-08.v2';
const documentScopeRow = (row: StoredSmtpConfiguration): StoredSmtpConfiguration => ({...row, configurationCipher: DOCUMENT_AUTHORIZATION_PROFILE + '|' + row.configurationCipher});
export const documentConfigurationDigest = (row: StoredSmtpConfiguration) => configurationDigest(documentScopeRow(row));
export const activeDocumentGrant = (grant: Activation | null, row: StoredSmtpConfiguration) => activeGrant(grant, documentScopeRow(row));
