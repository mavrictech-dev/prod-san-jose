import { createHash, randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { PrintBrandingService } from './print-branding.service';
import {
  allowsResource,
  EventNames,
  type AccessScope,
  type DocumentIssuedEventV1,
  type FiscalDocumentTypeCode,
  type FiscalPaymentTermsSnapshot,
} from "@factuez/contracts";
import { assertFiscalSnapshot, fiscalSnapshotSha256, validateInvoicePaymentTerms } from '@factuez/sunat-core';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { calculateDocumentTotals } from "./totals";
import { PrismaService } from "../infrastructure/prisma.service";
import { B2bSecurityError, validB2bBinding, type B2bBinding, type B2bPrincipal } from '@factuez/contracts/b2b-security';

export interface IssueOwnerContext {
  idempotencyKey: string;
  userId: string | null;
  correlationId: string;
  scope: AccessScope;
  authorization?: string;
  b2b?: { binding: B2bBinding; draftId: string; actor: Pick<B2bPrincipal, 'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'> };
}

export interface IssueDocumentInput {
  emissionPointId: string;
  shiftId?: string;
  documentType: "INVOICE" | "SALES_RECEIPT";
  series: string;
  issueDate?: string;
  currencyCode?: "PEN" | "USD";
  paymentTerms?: FiscalPaymentTermsSnapshot;
  customer: {
    identityType: string;
    identityNumber: string;
    legalName: string;
    address?: string;
    email?: string;
  };
  lines: Array<{
    productId?: string;
    productCode?: string;
    description: string;
    unitCode: string;
    quantity: string;
    unitPriceWithTax: string;
    taxAffectationCode: string;
    igvRate: string;
  }>;
}

@Injectable()
export class IssueDocumentService {
  constructor(private readonly prisma: PrismaService, @Optional() private readonly printBranding?: PrintBrandingService) {}

  async execute(
    input: IssueDocumentInput,
    context: {
      idempotencyKey: string;
      userId: string;
      correlationId: string;
      scope: AccessScope;
  authorization?: string;
    },
  ) {
    this.validateInput(input, context);
    const work = (transaction: unknown) => this.executeWithinTransaction(input, context, transaction as PrismaService);
    // Admission may take up to 15s; Prisma's default interactive timeout is shorter.
    return process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true'
      ? this.prisma.$transaction(work, { timeout: 25_000 })
      : this.prisma.$transaction(work);
  }

  private validateInput(input: IssueDocumentInput, context: IssueOwnerContext) {
    if (context.b2b) {
      const { binding, actor } = context.b2b;
      if (!validB2bBinding(binding) || context.scope.kind !== 'ASSIGNED' ||
          (actor.kind === 'SERVICE' ? context.userId !== null || actor.subjectId !== null || actor.userAuthRevision !== null :
            actor.kind !== 'USER' || !actor.subjectId || context.userId !== actor.subjectId))
        throw new B2bSecurityError(403, 'INVALID_ISSUANCE_ACTOR');
    } else if (!context.userId) throw new ForbiddenException('Actor humano requerido');
    if (!context.idempotencyKey)
      throw new Error("Idempotency-Key es obligatorio");
    if (!input || typeof input !== 'object' || Object.keys(input).some(key => ![
      'emissionPointId', 'shiftId', 'documentType', 'series', 'issueDate', 'currencyCode', 'paymentTerms', 'customer', 'lines',
    ].includes(key))) throw new BadRequestException('Campos no soportados; descuentos/anticipos/impuestos especiales requieren otro perfil');
    if (
      !Array.isArray(input?.lines) ||
      !input.lines.length ||
      input.lines.length > 100
    )
      throw new BadRequestException("Se requieren entre 1 y 100 ítems");
    if (!["INVOICE", "SALES_RECEIPT"].includes(input.documentType))
      throw new BadRequestException("Tipo no habilitado en esta etapa");
    if (!input.customer || typeof input.customer !== 'object' || Array.isArray(input.customer) ||
      Object.keys(input.customer).some(key => !['identityType', 'identityNumber', 'legalName', 'address', 'email'].includes(key)))
      throw new BadRequestException('Campos de cliente no soportados');
    if (
      typeof input.customer?.legalName !== "string" ||
      !input.customer.legalName.trim() ||
      input.customer.legalName.length > 200
    )
      throw new BadRequestException("Falta el nombre del cliente");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.emissionPointId,
      ) ||
      !/^[FB][A-Z0-9]{3}$/.test(input.series)
    )
      throw new BadRequestException("Punto o serie inválidos");
    if (
      input.currencyCode !== undefined &&
      !["PEN", "USD"].includes(input.currencyCode)
    )
      throw new BadRequestException("Moneda inválida");
    if (
      input.issueDate !== undefined &&
      !Number.isFinite(Date.parse(input.issueDate))
    )
      throw new BadRequestException("Fecha inválida");
    for (const line of input.lines) {
      if (!line || typeof line !== 'object' || Array.isArray(line) || Object.keys(line).some(key => ![
        'productId', 'productCode', 'description', 'unitCode', 'quantity', 'unitPriceWithTax', 'taxAffectationCode', 'igvRate',
      ].includes(key))) throw new BadRequestException('Campos de ítem no soportados; no se omiten descuentos o impuestos especiales');
      if (line && (line.taxAffectationCode !== '10' || line.igvRate !== '18'))
        throw new BadRequestException('Perfil de desarrollo: venta gravada con IGV 18%; otras afectaciones aún no habilitadas');
      if (
        !line ||
        typeof line.description !== "string" ||
        !line.description.trim() ||
        line.description.length > 250 ||
        !/^[A-Z0-9]{2,3}$/.test(line.unitCode) ||
        ![line.quantity, line.unitPriceWithTax].every(
          (value) =>
            typeof value === "string" &&
            /^\d{1,12}(\.\d{1,6})?$/.test(value) &&
            Number(value) > 0,
        ) ||
        !["10", "20", "30"].includes(line.taxAffectationCode) ||
        line.igvRate !== (line.taxAffectationCode === "10" ? "18" : "0")
      )
        throw new BadRequestException(
          "Ítems inválidos: revise descripción, unidad, cantidades, precio y afectación",
        );
    }
    if (
      input.documentType === "INVOICE" &&
      !/^\d{11}$/.test(input.customer.identityNumber)
    )
      throw new BadRequestException("La factura requiere RUC de 11 dígitos");
    return createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
  }

  /** Owner-local reuse only: caller owns commit/rollback, never starts a nested transaction. */
  async executeWithinTransaction(input: IssueDocumentInput, context: IssueOwnerContext, tx: PrismaService) {
    const requestHash = this.validateInput(input, context);
      // Mismo orden de locks que el CRUD: RUC → sede → punto → serie.
      // SHARE permite emisiones concurrentes, pero bloquea renombrados/desactivación.
      if (context.b2b || process.env.STATION_MASTER_CRUD_ENABLED === 'true' || process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true') {
        const owners = await tx.$queryRawUnsafe<Array<{ companyId: number; branchId: string | null }>>(
          'SELECT "companyId", "branchId" FROM "EmissionPoint" WHERE "id" = $1::uuid', input.emissionPointId);
        if (!owners[0]?.branchId) throw new ForbiddenException('Sede, punto o serie no autorizados');
        await tx.$queryRawUnsafe('SELECT "id" FROM "CompanySettings" WHERE "id" = $1 FOR SHARE', owners[0].companyId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "Branch" WHERE "id" = $1::uuid FOR SHARE', owners[0].branchId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "EmissionPoint" WHERE "id" = $1::uuid FOR SHARE', input.emissionPointId);
      }
      const point = await tx.emissionPoint.findUnique({
        where: { id: input.emissionPointId },
        include: { branch: true },
      });
      if (
        !point?.active ||
        !point.branch?.active ||
        !point.branchId ||
        point.companyId !== point.branch.companyId ||
        !allowsResource(context.scope, point.branchId, point.id)
      ) {
        throw new ForbiddenException("Sede, punto o serie no autorizados");
      }
      if (context.b2b || process.env.STATION_MASTER_CRUD_ENABLED === 'true' || process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED === 'true') {
        await tx.$queryRawUnsafe('SELECT "id" FROM "SeriesCounter" WHERE "companyId" = $1 AND "documentType" = $2::"DocumentType" AND "series" = $3 FOR UPDATE',
          point.companyId, input.documentType, input.series);
      }
      const counter = await tx.seriesCounter.findUnique({
        where: {
          companyId_documentType_series: {
            companyId: point.companyId,
            documentType: input.documentType,
            series: input.series,
          },
        },
      });
      if (
        !counter?.active ||
        counter.emissionPointId !== point.id ||
        !allowsResource(context.scope, point.branchId, point.id, counter.id)
      )
        throw new ForbiddenException("Sede, punto o serie no autorizados");

      const prior = await tx.idempotencyRecord.findUnique({
        where: { key: context.idempotencyKey },
      });
      if (prior && prior.requestHash !== requestHash)
        throw new ConflictException(
          "Idempotency-Key reutilizada con otro contenido",
        );
      if (prior?.documentId)
        return tx.document.findUniqueOrThrow({
          where: { id: prior.documentId },
        });

      const company = await tx.companySettings.findUniqueOrThrow({
        where: { id: point.companyId },
      });
      const production = company.environment === 'PRODUCTION';
      if (company.environment !== 'BETA' && (!production || process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED !== 'true'))
        throw new BadRequestException('Emisión de producción bloqueada en este servidor');
      if (production && (context.b2b || !['INVOICE', 'SALES_RECEIPT'].includes(input.documentType) || (input.currencyCode ?? 'PEN') !== 'PEN'))
        throw new BadRequestException('Producción sólo admite factura 01 o boleta 03 en soles por el circuito humano, sin B2B');
      if (production && (typeof context.authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(context.authorization)))
        throw new ForbiddenException('Se requiere Authorization del usuario para la admisión fiscal');
      if (company.active === false) throw new ForbiddenException('Emisor inactivo: no se puede registrar una nueva emisión.');
      if (context.b2b) {
        const b = context.b2b.binding;
        if (company.id !== b.issuerId || company.ruc !== b.issuerRuc || point.branchId !== b.branchId || point.id !== b.pointId || counter.id !== b.seriesId ||
            b.documentType !== (input.documentType === 'INVOICE' ? '01' : '03'))
          throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
        if (counter.nextNumber < 1n || counter.nextNumber > 99999999n) throw new B2bSecurityError(409, 'SERIES_EXHAUSTED');
      }
      const calculated = calculateDocumentTotals(input.lines);
      const issueDate = input.issueDate ?? new Date().toISOString();
      const paymentIssues = validateInvoicePaymentTerms({ paymentTerms: input.paymentTerms,
        documentTypeCode: input.documentType === 'INVOICE' ? '01' : '03', issueDate,
        currencyCode: input.currencyCode ?? 'PEN', totals: calculated.totals },
        { mode: /^00\d{9}$/.test(company.ruc) ? 'LOCAL_DEVELOPMENT' : 'REAL_PREPARATION' });
      if (paymentIssues.length) throw new BadRequestException(paymentIssues.map(issue => issue.message).join('; '));
      // Production owns the locked counter, but does not increment before admission.
      // Beta preserves its existing allocation flow.
      const updated = production ? null : await tx.seriesCounter.update({
        where: { id: counter.id },
        data: { nextNumber: { increment: 1 } },
      });
      const number = updated ? updated.nextNumber - 1n : counter.nextNumber;
      const documentId = randomUUID();
      const eventId = randomUUID();
      const typeCode: FiscalDocumentTypeCode =
        input.documentType === "INVOICE" ? "01" : "03";
      const fullNumber = `${input.series}-${number}`;
      const printPresentation = await this.printBranding?.freezeIssued(company, point.branch);
      const snapshot = {
        companyId: company.id,
        branchId: point.branchId,
        environment: company.environment,
        documentId,
        documentTypeCode: typeCode,
        series: input.series,
        number: number.toString(),
        fullNumber,
        issueDate,
        currencyCode: input.currencyCode ?? "PEN",
        operationTypeCode: "0101",
        issuer: {
          identityType: "6",
          identityNumber: company.ruc,
          legalName: company.legalName,
          tradeName: company.tradeName ?? undefined,
          address: company.taxAddress,
          ubigeo: company.ubigeo,
          establishmentCode: production ? (() => {
            const value = point.branch.establishmentCode;
            if (typeof value !== 'string' || value.length !== 4 || !/^[0-9]{4}$/.test(value))
              throw new BadRequestException('Configure el establecimiento SUNAT de la sede con exactamente 4 dígitos antes de emitir en Producción');
            return value;
          })() : (point.branch.establishmentCode ?? point.code),
        },
        customer: { identityType: input.customer.identityType, identityNumber: input.customer.identityNumber,
          legalName: input.customer.legalName, ...(input.customer.address ? { address: input.customer.address } : {}) },
        ...(input.paymentTerms ? { paymentTerms: input.paymentTerms } : {}),
        ...(printPresentation ? { printPresentation } : {}),
        printOperation: { branchName: point.branch.name, ...(point.branch.address ? { branchAddress: point.branch.address } : {}), emissionPointName: point.name },
        lines: calculated.lines,
        totals: calculated.totals,
      } as const;
      const event: DocumentIssuedEventV1 = {
        eventId,
        eventName: EventNames.documentIssued,
        occurredAt: new Date().toISOString(),
        correlationId: context.correlationId,
        producer: "billing-service",
        payload: snapshot,
      };

      if (production) {
        try { assertFiscalSnapshot(snapshot, { mode: 'REAL_PREPARATION' }); }
        catch { throw new BadRequestException('Snapshot fuera del perfil fiscal REAL de factura/boleta en soles'); }
        await this.admitProduction(snapshot, context.authorization!);
        if (process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED !== 'true')
          throw new ServiceUnavailableException('Admisión de producción deshabilitada');
        const allocated = await tx.seriesCounter.update({ where: { id: counter.id }, data: { nextNumber: { increment: 1 } } });
        if (allocated.nextNumber - 1n !== number) throw new ConflictException('Cambió el correlativo durante la admisión');
      }
      const document = await tx.document.create({
        data: {
          id: documentId,
          companyId: company.id,
          seriesCounterId: counter.id,
          type: input.documentType,
          status: "ISSUED",
          sunatStatus: "QUEUED",
          series: input.series,
          number,
          fullNumber,
          issueDate,
          currencyCode: input.currencyCode ?? "PEN",
          operationTypeCode: "0101",
          emissionPointId: point.id,
          shiftId: input.shiftId,
          createdByUserId: context.userId,
          ...(context.b2b ? { createdByActor: JSON.parse(JSON.stringify(context.b2b.actor)) } : {}),
          ...(context.b2b ? { originSystem: 'b2b:'+context.b2b.actor.clientId, originId: context.b2b.draftId } : {}),
          customerIdentityType: input.customer.identityType,
          customerIdentityNumber: input.customer.identityNumber,
          customerLegalName: input.customer.legalName,
          customerAddress: input.customer.address,
          customerEmail: input.customer.email,
          taxableAmount: calculated.totals.taxableAmount,
          igvAmount: calculated.totals.igvAmount,
          payableAmount: calculated.totals.payableAmount,
          immutableSnapshot: JSON.parse(JSON.stringify(snapshot)),
          items: {
            create: calculated.lines.map((line, index) => ({
              lineNumber: line.lineNumber,
              productId: input.lines[index].productId,
              internalCode: line.productCode,
              description: line.description,
              unitCode: line.unitCode,
              quantity: line.quantity,
              unitValue: line.unitValue,
              unitPriceWithTax: line.unitPriceWithTax,
              discountAmount: 0,
              lineExtensionAmount: line.lineExtensionAmount,
              taxAffectationCode: line.taxAffectationCode,
              igvRate: line.igvRate,
              igvAmount: line.igvAmount,
              iscAmount: 0,
              totalAmount: line.totalAmount,
            })),
          },
        },
      });
      await tx.outboxEvent.create({
        data: {
          id: eventId,
          eventType: event.eventName,
          aggregateId: documentId,
          payload: JSON.parse(JSON.stringify(event)),
        },
      });
      await tx.idempotencyRecord.create({
        data: {
          key: context.idempotencyKey,
          requestHash,
          documentId,
          responseCode: 202,
          responseBody: { documentId, fullNumber },
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      return document;
  }
  /** Fail closed: exact bounded attestation for these exact bytes and document, never fiscal acceptance. */
  private async admitProduction(snapshot: FiscalDocumentSnapshot, authorization: string): Promise<void> {
    const unavailable = () => new ServiceUnavailableException('No se obtuvo una admisión fiscal válida; no se registró el comprobante');
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable()); }, 15_000);
    });
    try {
      const endpoint = new URL(`${(process.env.SUNAT_INTERNAL_URL ?? 'http://sunat-service:3003').replace(/\/+$/, '')}/api/v1/setup/sunat/${snapshot.companyId}/PRODUCTION/admission`);
      if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
        throw unavailable();
      await Promise.race([deadline, (async () => {
        const response = await fetch(endpoint.toString(), {
          method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ snapshot }), signal: controller.signal, redirect: 'error',
        });
        if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body)
          throw unavailable();
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > 4096)) throw unavailable();
        reader = response.body.getReader();
        const chunks: Uint8Array[] = []; let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 4096) throw unavailable();
          chunks.push(value);
        }
        const proof: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
        if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw unavailable();
        const p = proof as Record<string, unknown>;
        if (Object.keys(p).sort().join(',') !== 'authorized,documentId,environment,issuerRuc,profile,snapshotSha256' ||
          p.authorized !== true || p.environment !== 'PRODUCTION' || p.issuerRuc !== snapshot.issuer.identityNumber ||
          p.documentId !== snapshot.documentId || !(snapshot.documentTypeCode === '03'
            ? p.profile === '01-03-PEN-0101-IGV18-v2'
            : ['01-PEN-0101-IGV18-v1','01-03-PEN-0101-IGV18-v2'].includes(String(p.profile))) || p.snapshotSha256 !== fiscalSnapshotSha256(snapshot))
          throw unavailable();
      })()]);
    } catch { throw unavailable(); }
    finally {
      clearTimeout(timer); controller.abort();
      if (reader) void reader.cancel().catch(() => undefined);
    }
  }
}
