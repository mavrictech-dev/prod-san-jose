import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AccessError, UUID } from '@factuez/service-access';
import { parseReceivedXml, unpackReceivedFiles, validateReceivedCdr, ReceivedCoreError, type ReceivedFile } from '@factuez/received-core';
import type { ReceivedDocumentDetail, ReceivedDocumentProjectionV1, ReceivedDocumentRow, ReceivedUploadResult } from '@factuez/contracts';
import type { Prisma, ReceivedDocument } from './generated/prisma/client';
import { ReceptionPrisma } from './prisma.service';
import { receptionCompany, receptionVisible, type ReceptionAccess } from './access';
import { decodeUpload, receptionFilters, safeArtifactName, uploadCommand } from './validation';
import { automationAdmin } from './automation/service';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const projected = (row: ReceivedDocument) => row.projection as unknown as ReceivedDocumentProjectionV1;
function rowDto(row: ReceivedDocument): ReceivedDocumentRow {
  const p = projected(row);
  return { id: row.id, companyId: row.companyId, recipientRuc: row.recipientRuc, branchId: row.branchId, supplierRuc: row.supplierRuc,
    supplierName: row.supplierName, documentType: row.documentType, fullNumber: row.fullNumber, issueDate: row.issueDate.toISOString().slice(0, 10),
    currencyCode: row.currencyCode, payableAmount: row.payableAmount, receivedAt: row.receivedAt.toISOString(), itemCount: p.items.length,
    sunatStatus: 'NOT_CHECKED', lastVerifiedAt: null, registeredAt: row.registeredAt?.toISOString() ?? null, erpReference: row.erpReference, warnings: p.warnings };
}
@Injectable()
export class ReceptionService {
  constructor(private readonly db: ReceptionPrisma) {}
  private where(access: ReceptionAccess, query: Record<string, unknown>): Prisma.ReceivedDocumentWhereInput {
    const f = receptionFilters(query);
    const selected = query.companyId ? receptionCompany(access, query.companyId, query.branchId) : undefined;
    if (query.branchId && !selected) throw new AccessError(400, 'Seleccione la empresa de la sede');
    const companies = access.catalog.companies.filter(c => c.environment === 'BETA' && (!selected || c.id === selected.id) &&
      (f.dataSource === 'ALL' || (f.dataSource === 'SYNTHETIC') === c.ruc.startsWith('00')));
    return { AND: [
      // Prisma can normalize nested empty OR into an omitted predicate. Use an
      // explicit impossible ID set when no current company is authorized.
      companies.length ? { OR: companies.map(c => ({ companyId: c.id, recipientRuc: c.ruc })) } : { id: { in: [] } },
      ...(access.user.scope.kind === 'ASSIGNED' ? [{ branchId: { in: access.catalog.branches.filter(b => access.user.scope.kind === 'ASSIGNED' && access.user.scope.branchIds.includes(b.id)).map(b => b.id) } }] : []),
      ...(query.branchId ? [{ branchId: String(query.branchId) }] : []),
      ...(f.type ? [{ documentType: f.type }] : []),
      ...(f.from || f.to ? [{ issueDate: { ...(f.from ? { gte: new Date(f.from + 'T00:00:00Z') } : {}), ...(f.to ? { lte: new Date(f.to + 'T00:00:00Z') } : {}) } }] : []),
      ...(f.q ? [{ OR: [{ fullNumber: { contains: f.q, mode: 'insensitive' as const } }, { supplierName: { contains: f.q, mode: 'insensitive' as const } }, { supplierRuc: { contains: f.q } }] }] : []),
    ] };
  }
  async list(access: ReceptionAccess, query: Record<string, unknown>) {
    const { page } = receptionFilters(query), where = this.where(access, query), pageSize = 25;
    const [rows, total] = await this.db.$transaction([this.db.receivedDocument.findMany({ where, orderBy: [{ issueDate: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }), this.db.receivedDocument.count({ where })]);
    return { items: rows.map(rowDto), page, pageSize, total };
  }
  async exportRows(access: ReceptionAccess, query: Record<string, unknown>) {
    const where = this.where(access, query), count = await this.db.receivedDocument.count({ where });
    if (count > 1000) throw new AccessError(400, 'Acote las fechas: máximo 1.000 documentos por exportación');
    const rows = await this.db.receivedDocument.findMany({ where, orderBy: [{ issueDate: 'desc' }, { id: 'desc' }], take: 1001 });
    if (rows.length > 1000) throw new AccessError(400, 'Acote las fechas de la exportación');
    if (rows.reduce((sum, r) => sum + projected(r).items.length, 0) > 10000) throw new AccessError(400, 'Acote las fechas: máximo 10.000 ítems por exportación');
    return rows.map(r => ({ ...rowDto(r), projection: projected(r) }));
  }
  private async visible(access: ReceptionAccess, id: string) {
    if (!UUID.test(id)) throw new AccessError(400, 'Identificador de documento inválido');
    const row = await this.db.receivedDocument.findUnique({ where: { id } });
    if (!row || !receptionVisible(access, row)) throw new AccessError(404, 'Documento no disponible en su alcance');
    return row;
  }
  async detail(access: ReceptionAccess, id: string): Promise<ReceivedDocumentDetail> {
    const row = await this.visible(access, id);
    const artifacts = await this.db.receivedArtifact.findMany({ where: { documentId: id }, select: { id: true, kind: true, fileName: true, sha256: true, byteLength: true }, orderBy: { createdAt: 'asc' } });
    return { ...rowDto(row), projection: projected(row), artifacts: artifacts as ReceivedDocumentDetail['artifacts'] };
  }
  async import(access: ReceptionAccess, input: unknown): Promise<ReceivedUploadResult> {
    const command = uploadCommand(input), company = receptionCompany(access, command.companyId, command.branchId);
    if (access.user.scope.kind === 'ASSIGNED' && !command.branchId) throw new AccessError(403, 'Seleccione una sede asignada');
    let files: ReceivedFile[];
    try { files = unpackReceivedFiles(command.files.map(f => ({ fileName: safeArtifactName(f.fileName), bytes: decodeUpload(f.contentBase64) }))); }
    catch (e) { if (e instanceof AccessError) throw e; throw new AccessError(400, e instanceof ReceivedCoreError ? e.message : 'Carga de archivos inválida'); }
    const results: ReceivedUploadResult['results'] = [], imports: { file: ReceivedFile; p: ReceivedDocumentProjectionV1 }[] = [];
    for (const file of files.filter(f => f.kind === 'XML')) {
      try {
        safeArtifactName(file.fileName);
        const p = parseReceivedXml(file.bytes);
        if (p.recipient.identityNumber !== company.ruc || p.recipient.identityType !== '6') throw new AccessError(400, 'El RUC destinatario del XML no corresponde a la empresa seleccionada');
        if (p.supplier.identityType !== '6' || !/^\d{11}$/.test(p.supplier.identityNumber ?? '')) throw new AccessError(400, 'El XML no identifica el RUC del proveedor');
        if (p.series.length > 4 || p.number.length > 8) throw new AccessError(400, 'Serie o correlativo fuera del perfil de recepción');
        imports.push({ file, p });
      } catch (e) { results.push({ fileName: file.fileName, outcome: 'REJECTED', message: e instanceof AccessError || e instanceof ReceivedCoreError ? e.message : 'No se pudo leer el XML' }); }
    }
    for (const { file, p } of imports) {
      const number = BigInt(p.number).toString(), key = { recipientRuc: company.ruc, supplierRuc: p.supplier.identityNumber!, documentType: p.documentType, series: p.series, number };
      try {
        const id = await this.db.$transaction(async tx => {
          const doc = await tx.receivedDocument.create({ data: { companyId: company.id, recipientRuc: company.ruc, branchId: command.branchId ?? null,
            supplierRuc: key.supplierRuc, supplierName: p.supplier.legalName, documentType: p.documentType, fullNumber: p.fullNumber, series: p.series, number,
            issueDate: new Date(p.issueDate + 'T00:00:00Z'), currencyCode: p.currencyCode, payableAmount: p.totals.payableAmount, projection: json(p), xmlSha256: p.xmlSha256,
            items: { create: p.items.map((item, ordinal) => ({ ordinal, supplierCode: item.supplierCode, sunatCode: item.sunatCode, description: item.description,
              quantity: item.quantity, unitCode: item.unitCode, unitValue: item.unitValue, unitPrice: item.unitPrice, amount: item.lineExtensionAmount, detail: json(item) })) },
            artifacts: { create: { kind: 'XML', fileName: file.fileName, sha256: p.xmlSha256, byteLength: file.bytes.length, bytes: new Uint8Array(file.bytes) } },
            audits: { create: { actorId: access.user.sub, action: 'IMPORTED', detail: { source: 'MANUAL', xmlSha256: p.xmlSha256 } } },
          } }); return doc.id;
        });
        results.push({ fileName: file.fileName, outcome: 'IMPORTED', id, message: 'Original e ítems guardados; estado SUNAT no consultado' });
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw new AccessError(503, 'No se pudo guardar la recepción. Reintente; los originales no se sobrescriben');
        const existing = await this.db.receivedDocument.findUnique({ where: { recipientRuc_supplierRuc_documentType_series_number: key } });
        if (!existing || !receptionVisible(access, existing)) { results.push({ fileName: file.fileName, outcome: 'REJECTED', message: 'Clave fiscal ya registrada fuera del alcance de esta carga' }); continue; }
        if (existing.xmlSha256 !== p.xmlSha256 || existing.branchId !== (command.branchId ?? null)) {
          await this.db.receivedAudit.create({ data: { documentId: existing.id, actorId: access.user.sub, action: 'CONFLICT_REJECTED', detail: { candidateXmlSha256: p.xmlSha256 } } });
          results.push({ fileName: file.fileName, outcome: 'REJECTED', message: 'Misma clave fiscal con distinto XML o sede. Requiere conciliación; no se sobrescribió' });
        } else results.push({ fileName: file.fileName, outcome: 'DUPLICATE', id: existing.id, message: 'Este XML original ya fue recibido' });
      }
    }
    // Associate attachments only by exact fiscal file identity, never by upload order.
    for (const file of files.filter(f => f.kind !== 'XML')) {
      const candidate = imports.find(({ p }) => new RegExp(`^(?:R-)?${p.supplier.identityNumber}-${p.documentType}-${p.series}-${p.number}\\.(?:xml|pdf)$`, 'i').test(file.fileName));
      const owner = candidate && results.find(r => r.fileName === candidate.file.fileName && r.id && r.outcome !== 'REJECTED');
      if (!owner?.id) { results.push({ fileName: file.fileName, outcome: 'REJECTED', message: 'Adjunto sin XML asociado inequívoco. Adjunte desde el detalle del documento' }); continue; }
      try { await this.attach(access, owner.id, { kind: file.kind, fileName: file.fileName, contentBase64: file.bytes.toString('base64') }); }
      catch (e) { results.push({ fileName: file.fileName, outcome: 'REJECTED', message: e instanceof AccessError ? e.message : 'Adjunto no válido' }); }
    }
    if (!results.length) throw new AccessError(400, 'La carga no contiene un documento XML de proveedor');
    return { results };
  }
  async artifact(access: ReceptionAccess, id: string, artifactId: string) {
    await this.visible(access, id);
    if (!UUID.test(artifactId)) throw new AccessError(400, 'Adjunto inválido');
    const artifact = await this.db.receivedArtifact.findFirst({ where: { id: artifactId, documentId: id } });
    if (!artifact) throw new AccessError(404, 'Adjunto no encontrado');
    if (hash(artifact.bytes) !== artifact.sha256 || artifact.bytes.byteLength !== artifact.byteLength) throw new AccessError(409, 'Integridad del original no coincide');
    return artifact;
  }
  async attach(access: ReceptionAccess, id: string, body: unknown) {
    const doc = await this.visible(access, id);
    const b = body as { kind?: unknown; fileName?: unknown; contentBase64?: unknown };
    if (!b || !['PROVIDER_PDF', 'CDR'].includes(String(b.kind))) throw new AccessError(400, 'Tipo de adjunto no permitido');
    const fileName = safeArtifactName(b.fileName), bytes = decodeUpload(b.contentBase64);
    if (b.kind === 'PROVIDER_PDF') { if (!/\.pdf$/i.test(fileName) || bytes.subarray(0, 5).toString() !== '%PDF-') throw new AccessError(400, 'PDF original inválido'); }
    else {
      if (!/\.(xml|zip)$/i.test(fileName)) throw new AccessError(400, 'Adjunte el CDR XML o ZIP');
      try {
        let cdr = bytes;
        if (/\.zip$/i.test(fileName)) {
          const entries = unpackReceivedFiles([{ fileName, bytes }]);
          if (entries.length !== 1 || entries[0].kind !== 'CDR') throw new AccessError(400, 'El ZIP debe contener solamente un CDR XML');
          cdr = entries[0].bytes;
        }
        validateReceivedCdr(cdr, projected(doc));
      } catch (e) { throw new AccessError(400, e instanceof AccessError || e instanceof ReceivedCoreError ? e.message : 'CDR no corresponde al documento'); }
    }
    const sha256 = hash(bytes);
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ReceivedDocument" WHERE id = ${id}::uuid FOR UPDATE`;
      const existing = await tx.receivedArtifact.findUnique({ where: { documentId_kind_sha256: { documentId: id, kind: String(b.kind), sha256 } } });
      if (existing) return { id: existing.id, duplicate: true };
      if (await tx.receivedArtifact.count({ where: { documentId: id } }) >= 20) throw new AccessError(400, 'Máximo 20 originales por documento');
      const artifact = await tx.receivedArtifact.create({ data: { documentId: id, kind: String(b.kind), fileName, sha256, byteLength: bytes.length, bytes: new Uint8Array(bytes) } });
      await tx.receivedAudit.create({ data: { documentId: id, actorId: access.user.sub, action: 'ARTIFACT_ATTACHED', detail: { kind: String(b.kind), sha256 } } });
      return { id: artifact.id, duplicate: false };
    });
  }
  async registration(access: ReceptionAccess, id: string, body: unknown) {
    await this.visible(access, id);
    const b = body as { registered?: unknown; erpReference?: unknown };
    if (!b || typeof b.registered !== 'boolean' || b.erpReference !== undefined && (typeof b.erpReference !== 'string' || b.erpReference.length > 150)) throw new AccessError(400, 'Referencia de registro inválida');
    if (b.registered && (typeof b.erpReference !== 'string' || !b.erpReference.trim())) throw new AccessError(400, 'Indique la referencia contable o del ERP');
    const registered = b.registered;
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ReceivedDocument" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivedDocument.findUniqueOrThrow({ where: { id } });
      const reference = b.registered ? String(b.erpReference).trim() : null;
      if (Boolean(current.registeredAt) !== registered || current.erpReference !== reference) {
        await tx.receivedDocument.update({ where: { id }, data: { registeredAt: b.registered ? new Date() : null, erpReference: reference } });
        await tx.receivedAudit.create({ data: { documentId: id, actorId: access.user.sub, action: 'REGISTRATION_CHANGED', detail: { registered, erpReference: reference } } });
      }
      return { registered: b.registered, erpReference: reference };
    });
  }
  async assignment(access: ReceptionAccess, id: string, body: unknown) {
    automationAdmin(access);
    const doc = await this.visible(access, id);
    const b = body as { branchId?: unknown; expectedBranchId?: unknown };
    if (!b || Object.keys(b).some(k => !['branchId', 'expectedBranchId'].includes(k)) ||
      b.branchId !== null && (typeof b.branchId !== 'string' || !UUID.test(b.branchId)) ||
      b.expectedBranchId !== null && (typeof b.expectedBranchId !== 'string' || !UUID.test(b.expectedBranchId))) throw new AccessError(400, 'Asignación de sede inválida');
    receptionCompany(access, doc.companyId, b.branchId ?? undefined);
    const branchId = b.branchId as string | null;
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "ReceivedDocument" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.receivedDocument.findUniqueOrThrow({ where: { id } });
      if (!receptionVisible(access, current) || current.companyId !== doc.companyId || current.recipientRuc !== doc.recipientRuc) throw new AccessError(404, 'Documento no disponible en su alcance');
      if (current.branchId !== b.expectedBranchId) throw new AccessError(409, 'La sede asignada cambió; vuelva a cargar el documento');
      if (current.branchId !== branchId) {
        await tx.receivedDocument.update({ where: { id }, data: { branchId } });
        await tx.receivedAudit.create({ data: { documentId: id, actorId: access.user.sub, action: 'BRANCH_ASSIGNED', detail: { before: current.branchId, after: branchId } } });
      }
      return { branchId };
    });
  }
}
