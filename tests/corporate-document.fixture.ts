import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { PRODUCTION_NOTES_PROFILE } from '../packages/contracts/src/production-notes';
import { CorporateDocumentSource } from '../services/mailer-worker/src/corporate-document-source';
const { zipSync } = createRequire(new URL('../services/mailer-worker/package.json', import.meta.url))('fflate');
export const documentIssuer = { companyId: 1, ruc: '00000000001' };
export const documentActor = '084a10ac-df2d-49f5-aa8a-9a784212e320';
export const documentAuthorization = 'Bearer synthetic.document.token';
export const documentConfig = { host: 'smtp.corporativo.pe', port: 587 as const, tlsMode: 'STARTTLS' as const, fromName: 'Synthetic',
  fromAddress: 'sender@example.invalid', replyTo: null, username: 'PRIVATE-USER', password: 'PRIVATE-PASSWORD' };
export function documentSourceFixture(type: '01' | '03' | '07' | '08' = '01') {
  const id = randomUUID(), series = type === '03' ? 'B001' : type === '07' ? 'FC01' : type === '08' ? 'FD01' : 'F001', fullNumber = series + '-1';
  const doc = { id, companyId: 1, fullNumber, sunatStatus: 'ACCEPTED', immutableSnapshot: {
    documentId: id, companyId: 1, environment: 'PRODUCTION', documentTypeCode: type, series, number: '1', fullNumber,
    issuer: { identityNumber: documentIssuer.ruc }, lines: [], totals: { payableAmount: '10.00' },
  } };
  const originalId = randomUUID(), reasonCode = type === '07' ? '01' : '02';
  const note = {
    profile: PRODUCTION_NOTES_PROFILE, reasonCode, reasonDescription: 'SYNTHETIC NOTE',
    adjustment: { documentTypeCode: type, reasonCode, reasonDescription: 'SYNTHETIC NOTE',
      ...(type === '08' ? { lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.00' }] } : {}) },
    reference: { documentId: originalId, documentTypeCode: '01', fullNumber: 'F001-1', snapshotSha256: 'a'.repeat(64), issueDate: '2026-10-27T12:00:00.000Z' },
    originalAcceptance: { profile: 'PRODUCTION-01-ARCHIVE-v1', documentId: originalId, snapshotSha256: 'a'.repeat(64),
      signedXmlSha256: 'b'.repeat(64), cdrXmlSha256: 'c'.repeat(64), cdrZipSha256: 'd'.repeat(64),
      acceptedAt: '2026-10-27T12:01:00.000Z', checkedAt: '2026-10-28T12:00:00.000Z' }, creditHistoryIds: [],
  };
  if (type === '07' || type === '08') Object.assign(doc.immutableSnapshot, note);
  const base = documentIssuer.ruc + '-' + type + '-' + fullNumber;
  const submitted = type === '03' ? documentIssuer.ruc + '-RC-20261028-1' : base;
  const root = type === '07' ? 'CreditNote' : type === '08' ? 'DebitNote' : 'Invoice';
  const xml = Buffer.from('<?xml version="1.0"?><' + root + '>SYNTHETIC ORIGINAL ' + fullNumber + '</' + root + '>');
  const summary = Buffer.from('<?xml version="1.0"?><SummaryDocuments>SYNTHETIC RC ' + fullNumber + '</SummaryDocuments>');
  const cdr = Buffer.from('<?xml version="1.0"?><ApplicationResponse>SYNTHETIC CDR ' + fullNumber + '</ApplicationResponse>');
  const files = new Map<string, { bytes: Buffer; type: string; name: string }>([
    ['a4', { bytes: Buffer.from('%PDF-1.7 synthetic current A4'), type: 'application/pdf', name: base + '-a4-PRODUCCION.pdf' }],
    ['ticket', { bytes: Buffer.from('%PDF-1.7 synthetic current ticket'), type: 'application/pdf', name: base + '-ticket-PRODUCCION.pdf' }],
    ['xml', { bytes: xml, type: 'application/xml', name: base + '.xml' }],
    ['submission-zip', { bytes: Buffer.from(zipSync({ [submitted + '.xml']: type === '03' ? summary : xml })), type: 'application/zip', name: submitted + '.zip' }],
    ['cdr-xml', { bytes: cdr, type: 'application/xml', name: 'R-' + submitted + '.xml' }],
    ['cdr-zip', { bytes: Buffer.from(zipSync({ ['R-' + submitted + '.xml']: cdr })), type: 'application/zip', name: 'R-' + submitted + '.zip' }],
  ]);
  const json = vi.fn(async () => structuredClone(doc));
  const identity = vi.fn(async () => ({ sub: documentActor, roles: ['ADMIN'], scope: { kind: 'GLOBAL' } }));
  const fetch = vi.fn(async (url: any, _options: any) => {
    const file = files.get(String(url).split('/').at(-1)!);
    if (!file) return new Response('', { status: 404 });
    return new Response(file.bytes, { headers: { 'content-type': file.type, 'content-disposition': 'attachment; filename="' + file.name + '"', 'content-length': String(file.bytes.length) } });
  });
  const source = new CorporateDocumentSource({ identity, json, fetch } as never);
  return { source, doc, id, base, submitted, xml, cdr, summary, files, json, identity, fetch, zipSync };
}
