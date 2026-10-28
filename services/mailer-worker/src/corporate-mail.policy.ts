import { AccessError, UUID } from '@factuez/service-access';
import { createHash } from 'node:crypto';
import { smtpMailbox } from './smtp-configuration.policy';
import type { StoredSmtpConfiguration } from './smtp-configuration.store';
export const corporateSmtpEnabled = () => process.env.SERVER_SMTP_ENABLED === 'true';
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export const configurationDigest = (row: StoredSmtpConfiguration) => digest(row.configurationCipher);
export const corporateDisabled = () => new AccessError(423, 'Envío corporativo deshabilitado en este servidor');
export function revision(value: unknown, zero = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < (zero ? 0 : 1) || Number(value) > 2147483646)
    throw new AccessError(400, 'Revisión de correo inválida');
  return Number(value);
}
function object(body: unknown, keys: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== keys.sort().join(','))
    throw new AccessError(400, 'Campos de correo no permitidos');
  return body as Record<string, unknown>;
}
export function activationInput(body: unknown) {
  const b = object(body, ['expectedRevision', 'expectedActivationRevision', 'enabled', 'confirmed']);
  if (typeof b.enabled !== 'boolean' || b.confirmed !== true) throw new AccessError(400, 'Confirme expresamente la autorización por RUC');
  return { expectedRevision: revision(b.expectedRevision), expectedActivationRevision: revision(b.expectedActivationRevision, true), enabled: b.enabled };
}
export function testInput(body: unknown, key: unknown) {
  const b = object(body, ['expectedRevision', 'expectedActivationRevision', 'recipient', 'confirmed']);
  if (b.confirmed !== true || !smtpMailbox(b.recipient) || b.recipient !== b.recipient.trim() || typeof key !== 'string' || !UUID.test(key))
    throw new AccessError(400, 'Confirme un único destinatario válido e Idempotency-Key UUID');
  return { expectedRevision: revision(b.expectedRevision), expectedActivationRevision: revision(b.expectedActivationRevision),
    recipient: b.recipient, key: key.toLowerCase() };
}
export type CorporateMailState = 'QUEUED' | 'PREPARING' | 'SENDING' | 'HANDED_OFF' | 'UNKNOWN' | 'FAILED' | 'CANCELLED';
export type Activation = { companyId: number; issuerRuc: string; revision: number; configurationRevision: number;
  configurationDigest: string; enabled: boolean; updatedBy: string; updatedAt: Date };
export type CorporateMailJob = { id: string; companyId: number; issuerRuc: string; actorId: string; configurationRevision: number;
  configurationDigest: string; activationRevision: number; idempotencyHash: string; requestHash: string; payloadCipher: string | null;
  state: CorporateMailState; createdAt: Date; expiresAt: Date; claimedAt: Date | null; finishedAt: Date | null };
export const jobView = (j: CorporateMailJob) => ({ id: j.id, companyId: j.companyId, ruc: j.issuerRuc,
  configurationRevision: j.configurationRevision, activationRevision: j.activationRevision, state: j.state,
  createdAt: j.createdAt, finishedAt: j.finishedAt, handedOffToSmtp: j.state === 'HANDED_OFF', deliveredToClient: false,
  attachments: false, scope: 'TEST_ONLY' as const });
export function activeGrant(grant: Activation | null, row: StoredSmtpConfiguration): boolean {
  return Boolean(grant?.enabled && grant.companyId === row.companyId && grant.issuerRuc === row.ruc &&
    grant.configurationRevision === row.revision && grant.configurationDigest === configurationDigest(row));
}
