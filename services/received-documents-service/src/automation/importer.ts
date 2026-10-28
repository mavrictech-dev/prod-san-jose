import { createHash } from 'node:crypto';
import { parseReceivedXml, unpackReceivedFiles, validateReceivedCdr, type ReceivedFile } from '@factuez/received-core';
import type { ReceivedDocumentProjectionV1, ReceivedSyncCounters } from '@factuez/contracts';
import type { Prisma } from '../generated/prisma/client';
import { safeArtifactName } from '../validation';
import type { MailAttachment } from './mailbox';
const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
export type PreparedMail = { documents: { file: ReceivedFile; projection: ReceivedDocumentProjectionV1 }[]; artifacts: ReceivedFile[]; rejected: number };
export function prepareMailDocuments(attachments: MailAttachment[], ruc: string): PreparedMail {
  const files = unpackReceivedFiles(attachments.filter(a => /\.(xml|zip)$/i.test(a.fileName)));
  for (const a of attachments.filter(a => /\.pdf$/i.test(a.fileName))) {
    safeArtifactName(a.fileName);
    if (a.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('MAIL_PDF_INVALID');
    files.push({ ...a, kind: 'PROVIDER_PDF' });
  }
  const documents: PreparedMail['documents'] = []; let rejected = 0;
  for (const file of files.filter(f => f.kind === 'XML')) {
    try {
      safeArtifactName(file.fileName); const projection = parseReceivedXml(file.bytes);
      if (projection.recipient.identityNumber !== ruc || projection.recipient.identityType !== '6' ||
        projection.supplier.identityType !== '6' || !/^\d{11}$/.test(projection.supplier.identityNumber ?? '') ||
        !/^[A-Z0-9]{4}$/.test(projection.series) || !/^\d{1,8}$/.test(projection.number)) throw new Error();
      documents.push({ file, projection });
    } catch { rejected++; }
  }
  if (!documents.length && !rejected) rejected = 1; // PDF-only/missing XML is never treated as full reception.
  return { documents, artifacts: files.filter(f => f.kind !== 'XML'), rejected };
}
/** Called only inside a worker transaction already locked to an enabled RUC/revision.
 * No manufactured user scope, external Billing write, Outbox, counter or fiscal status. */
export async function importPreparedMail(tx: Prisma.TransactionClient,
  binding: { companyId: number; recipientRuc: string; configuredBy: string }, prepared: PreparedMail, runId: string) {
  const counts: Partial<ReceivedSyncCounters> = { imported: 0, duplicate: 0, rejected: prepared.rejected }, changed: string[] = [];
  const owners: { id: string; p: ReceivedDocumentProjectionV1 }[] = [];
  for (const { file, projection: p } of prepared.documents) {
    if (p.recipient.identityNumber !== binding.recipientRuc) throw new Error('MAIL_RECIPIENT_MISMATCH');
    const key = { recipientRuc: binding.recipientRuc, supplierRuc: p.supplier.identityNumber!, documentType: p.documentType, series: p.series, number: BigInt(p.number).toString() };
    const existing = await tx.receivedDocument.findUnique({ where: { recipientRuc_supplierRuc_documentType_series_number: key } });
    if (existing) {
      if (existing.companyId !== binding.companyId || existing.xmlSha256 !== p.xmlSha256) {
        counts.rejected!++;
        if (existing.companyId === binding.companyId) await tx.receivedAudit.create({ data: { documentId: existing.id, actorId: binding.configuredBy, action: 'AUTOMATIC_CONFLICT', detail: { source: 'MAIL_WORKER', runId, candidateXmlSha256: p.xmlSha256 } } });
        continue;
      }
      counts.duplicate!++; owners.push({ id: existing.id, p }); continue;
    }
    const doc = await tx.receivedDocument.create({ data: { companyId: binding.companyId, ...key, branchId: null,
      supplierName: p.supplier.legalName, fullNumber: p.fullNumber, issueDate: new Date(p.issueDate + 'T00:00:00Z'), currencyCode: p.currencyCode, payableAmount: p.totals.payableAmount,
      projection: json(p), xmlSha256: p.xmlSha256,
      items: { create: p.items.map((item, ordinal) => ({ ordinal, supplierCode: item.supplierCode, sunatCode: item.sunatCode, description: item.description, quantity: item.quantity, unitCode: item.unitCode, unitValue: item.unitValue, unitPrice: item.unitPrice, amount: item.lineExtensionAmount, detail: json(item) })) },
      artifacts: { create: { kind: 'XML', fileName: file.fileName, sha256: p.xmlSha256, byteLength: file.bytes.length, bytes: new Uint8Array(file.bytes) } },
      audits: { create: { actorId: binding.configuredBy, action: 'AUTOMATIC_IMPORTED', detail: { source: 'MAIL_WORKER', runId, configuredBy: binding.configuredBy, xmlSha256: p.xmlSha256, branchAssignment: 'PENDING' } } },
    } }); counts.imported!++; owners.push({ id: doc.id, p }); changed.push(doc.id);
  }
  for (const file of prepared.artifacts) {
    const candidates = owners.filter(({ p }) => {
      const stem = `${p.supplier.identityNumber}-${p.documentType}-${p.series}-${p.number}`.toLowerCase();
      return [stem + '.pdf', 'r-' + stem + '.xml'].includes(file.fileName.toLowerCase());
    });
    if (candidates.length !== 1) { counts.rejected!++; continue; }
    const owner = candidates[0];
    try { safeArtifactName(file.fileName); if (file.kind === 'CDR') validateReceivedCdr(file.bytes, owner.p); }
    catch { counts.rejected!++; continue; }
    await tx.$queryRaw`SELECT id FROM "ReceivedDocument" WHERE id = ${owner.id}::uuid FOR UPDATE`;
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    if (await tx.receivedArtifact.findUnique({ where: { documentId_kind_sha256: { documentId: owner.id, kind: file.kind, sha256 } } })) continue;
    if (await tx.receivedArtifact.count({ where: { documentId: owner.id } }) >= 20) { counts.rejected!++; continue; }
    await tx.receivedArtifact.create({ data: { documentId: owner.id, kind: file.kind, fileName: file.fileName, sha256, byteLength: file.bytes.length, bytes: new Uint8Array(file.bytes) } });
    await tx.receivedAudit.create({ data: { documentId: owner.id, actorId: binding.configuredBy, action: 'AUTOMATIC_ARTIFACT', detail: { source: 'MAIL_WORKER', runId, kind: file.kind, sha256 } } });
    changed.push(owner.id);
  }
  return { counts, changed: [...new Set(changed)] };
}
