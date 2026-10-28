import { isProxy } from 'node:util/types';
import { EventNames, type EventEnvelope } from '@factuez/contracts';
import { fiscalSnapshotSha256, fiscalTimestamp, type FiscalNoteContext, type FiscalNoteSnapshot, validateFiscalNoteSnapshot } from './fiscal-note';
import { type FiscalBatchSnapshot, validateFiscalBatchSnapshot } from './fiscal-batch';

/** Server-only contract. Planning does not allocate numbers, verify PKI or authorize transmission. */
export type FiscalSupplementEnvelope = { kind: 'NOTE'; note: FiscalNoteSnapshot; context: FiscalNoteContext }
  | { kind: 'BATCH'; batch: FiscalBatchSnapshot; asOf: string };
export type FiscalSupplementCommand = EventEnvelope<typeof EventNames.betaSupplementRequested, {
  environment: 'BETA'; issuerRuc: string; companyId: number; branchId: string;
  operationId: string; operationKind: 'NOTE' | 'RC' | 'RA'; envelopeSha256: string; envelope: FiscalSupplementEnvelope;
}>;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
function fail(): never { throw new Error('Comando de suplemento BETA inválido'); }

/** Reject executable/accessor/proxy inputs before cloning, hashing or traversing domain validators. */
export function boundedSupplementJson(value: unknown): unknown {
  let nodes = 0, bytes = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 50000 || depth > 64) fail();
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return item; }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item); if (item.length > 16384 || bytes > 512 * 1024) fail(); return item;
    }
    if (!item || typeof item !== 'object' || isProxy(item)) fail();
    const array = Array.isArray(item), prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(item), keys = Reflect.ownKeys(item);
    if (array) {
      if ((item as unknown[]).length > 1000 || keys.length !== (item as unknown[]).length + 1 ||
          keys.some(k => typeof k !== 'string' || k !== 'length' && (!/^(0|[1-9]\d*)$/.test(k) || Number(k) >= (item as unknown[]).length))) fail();
      return Array.from({ length: (item as unknown[]).length }, (_, i) => {
        const descriptor = descriptors[String(i)];
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        return visit(descriptor.value, depth + 1);
      });
    }
    if (keys.length > 100) fail();
    const output: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string' || key.length > 120 || ['__proto__', 'prototype', 'constructor'].includes(key)) fail();
      const descriptor = descriptors[key];
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
      bytes += Buffer.byteLength(key); if (bytes > 512 * 1024) fail();
      output[key] = visit(descriptor.value, depth + 1);
    }
    return output;
  };
  // Return ordinary JSON objects for Prisma/domain comparisons; traversal above is the trust boundary.
  const normalized = visit(value, 0), encoded = JSON.stringify(normalized);
  if (Buffer.byteLength(encoded) > 512 * 1024) fail();
  return JSON.parse(encoded);
}
function exact(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail();
}

export function fiscalSupplementIdentity(envelope: FiscalSupplementEnvelope) {
  let snapshot: FiscalNoteSnapshot | FiscalBatchSnapshot;
  let rootName: 'CreditNote' | 'DebitNote' | 'SummaryDocuments' | 'VoidedDocuments';
  let method: 'sendBill' | 'sendSummary';
  if (envelope.kind === 'NOTE') {
    exact(envelope, ['kind', 'note', 'context']);
    validateFiscalNoteSnapshot(envelope.note, envelope.context);
    if (!envelope.note.series.startsWith('F')) throw new Error('Notas B requieren lote RC explícito');
    snapshot = envelope.note; rootName = snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote'; method = 'sendBill';
  } else if (envelope.kind === 'BATCH') {
    exact(envelope, ['kind', 'batch', 'asOf']);
    validateFiscalBatchSnapshot(envelope.batch, envelope.asOf);
    snapshot = envelope.batch; rootName = snapshot.kind === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments'; method = 'sendSummary';
  } else fail();
  if (snapshot.environment !== 'BETA' || !Number.isSafeInteger(snapshot.companyId) || (snapshot.companyId ?? 0) < 1 || !UUID.test(snapshot.branchId ?? '')) fail();
  const reference = envelope.kind === 'NOTE' ? envelope.note.fullNumber : envelope.batch.identifier;
  return { documentId: snapshot.documentId, ruc: snapshot.issuer.identityNumber, reference, rootName, method,
    companyId: snapshot.companyId!, branchId: snapshot.branchId!,
    operationKind: envelope.kind === 'NOTE' ? 'NOTE' as const : envelope.batch.kind,
    fileName: `${snapshot.issuer.identityNumber}-${envelope.kind === 'NOTE' ? `${envelope.note.documentTypeCode}-` : ''}${reference}.zip` };
}

export function buildFiscalSupplementCommand(envelope: FiscalSupplementEnvelope,
  context: { eventId: string; correlationId: string; occurredAt: string }): FiscalSupplementCommand {
  context = boundedSupplementJson(context) as typeof context;
  exact(context, ['eventId', 'correlationId', 'occurredAt']);
  const clone = boundedSupplementJson(envelope) as FiscalSupplementEnvelope, identity = fiscalSupplementIdentity(clone);
  if (!UUID.test(context.eventId) || !UUID.test(context.correlationId)) fail();
  fiscalTimestamp(context.occurredAt, 'occurredAt');
  const asOf = clone.kind === 'NOTE' ? clone.context.asOf : clone.asOf;
  if (context.occurredAt !== asOf) fail();
  return { ...context, eventName: EventNames.betaSupplementRequested, producer: 'billing-service', payload: {
    environment: 'BETA', issuerRuc: identity.ruc, companyId: identity.companyId, branchId: identity.branchId,
    operationId: identity.documentId, operationKind: identity.operationKind, envelopeSha256: fiscalSnapshotSha256(clone), envelope: clone,
  } };
}

export function validateFiscalSupplementCommand(value: unknown): FiscalSupplementCommand {
  try {
    const event = boundedSupplementJson(value);
    exact(event, ['eventId', 'eventName', 'occurredAt', 'correlationId', 'producer', 'payload']);
    exact(event.payload, ['environment', 'issuerRuc', 'companyId', 'branchId', 'operationId', 'operationKind', 'envelopeSha256', 'envelope']);
    const expected = buildFiscalSupplementCommand(event.payload.envelope as FiscalSupplementEnvelope,
      { eventId: event.eventId as string, correlationId: event.correlationId as string, occurredAt: event.occurredAt as string });
    if (event.eventName !== expected.eventName || event.producer !== expected.producer ||
        typeof event.payload.envelopeSha256 !== 'string' || !HASH.test(event.payload.envelopeSha256) ||
        fiscalSnapshotSha256(event) !== fiscalSnapshotSha256(expected)) fail();
    return expected;
  } catch { return fail(); }
}
