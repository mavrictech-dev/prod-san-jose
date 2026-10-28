import { BadRequestException, ForbiddenException, Injectable, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  allowsResource,
  type AccessTokenClaims, type FrozenPrintPresentationV1, type PrintPreviewRequest,
  type PrintableTransportGuide, type SavePrintSettingsRequest, type FiscalDocumentSnapshot,
} from '@factuez/contracts';
import { renderLocalDocumentPdf, renderLocalTransportGuidePdf } from '@factuez/pdf-renderer';
import { PrismaService } from '../infrastructure/prisma.service';
import { PrintBrandingStore } from '../infrastructure/print-branding-store';
import { plainObject, validatePrintDraft } from './print-branding-validation';
import { calculateDocumentTotals } from './totals';
import { b2bBindingsContain, validB2bPrincipal, type B2bBinding, type B2bPrincipal } from '@factuez/contracts/b2b-security';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Issuer = { id: number; ruc: string; legalName: string; tradeName?: string | null; taxAddress: string; environment: string };
type Branch = { id: string; companyId: number; name: string; address?: string | null };
type PrintContext = { company: Issuer; branch: Branch | null; target: { companyId: number; issuerRuc: string; branchId: string | null; branchName?: string; branchAddress?: string } };

@Injectable()
export class PrintBrandingService implements OnModuleInit {
  private readonly store = new PrintBrandingStore();
  private storageReady = false;
  constructor(private readonly prisma: PrismaService) {}
  async onModuleInit() {
    if (process.env.PRINT_SETTINGS_ENABLED !== 'true') return;
    try { await this.store.initialize(); this.storageReady = true; }
    catch { this.storageReady = false; } // El estado se informa por API; no imprime rutas ni datos.
  }
  private enabled() {
    if (process.env.PRINT_SETTINGS_ENABLED !== 'true' || !this.storageReady)
      throw new ServiceUnavailableException('Configure el volumen privado de logos y habilite PRINT_SETTINGS_ENABLED en el servidor Beta.');
  }
  private authorize(user?: AccessTokenClaims) {
    if (!user || user.scope.kind !== 'GLOBAL' || !user.roles.includes('ADMIN') || !user.permissions.includes('setup.manage'))
      throw new ForbiddenException('Los formatos y logos requieren administrador general con permiso de configuración.');
  }
  private async context(companyId: string, branchId: unknown, historicalRead = false): Promise<PrintContext> {
    this.enabled();
    if (typeof companyId !== 'string' || !/^[1-9]\d{0,9}$/.test(companyId) || !Number.isSafeInteger(Number(companyId)) ||
        (branchId !== undefined && (typeof branchId !== 'string' || !UUID.test(branchId))))
      throw new BadRequestException('Seleccione un RUC y una sede válidos.');
    const company = await this.prisma.companySettings.findUnique({ where: { id: Number(companyId) },
      select: { id: true, ruc: true, legalName: true, tradeName: true, taxAddress: true, environment: true, active: true } });
    if (!company || company.environment !== 'BETA' || (!historicalRead && company.active === false)) throw new ForbiddenException('Emisor no disponible en el entorno de desarrollo Beta.');
    const branch = branchId ? await this.prisma.branch.findFirst({ where: { id: String(branchId).toLowerCase(), companyId: company.id, ...(!historicalRead ? { active: true } : {}) },
      select: { id: true, companyId: true, name: true, address: true } }) : null;
    if (branchId && !branch) throw new ForbiddenException('La sede no pertenece al RUC seleccionado o no está activa.');
    return { company, branch, target: { companyId: company.id, issuerRuc: company.ruc, branchId: branch?.id ?? null,
      ...(branch ? { branchName: branch.name, ...(branch.address ? { branchAddress: branch.address } : {}) } : {}) } };
  }
  async settings(companyId: string, branchId: unknown, user?: AccessTokenClaims) {
    this.authorize(user); const context = await this.context(companyId, branchId);
    return this.store.response(context.target);
  }
  /** Lectura privada de presentación para otros servicios con identidad vigente. */
  async snapshot(companyId: string, branchId: unknown, user?: AccessTokenClaims) {
    if (!user?.permissions.includes('document.view') ||
        (user.scope.kind === 'ASSIGNED' && (typeof branchId !== 'string' || !allowsResource(user.scope, branchId.toLowerCase()))))
      throw new ForbiddenException('Sede de impresión no autorizada.');
    // Desactivar un maestro impide emitir/configurar, no leer la presentación
    // de un documento histórico ya autorizado. No se modifica el maestro.
    const context = await this.context(companyId, branchId, true);
    return this.store.freeze(context.target);
  }
  /** Dedicated B2B boundary; no fabricated human claims or ADMIN impersonation. */
  async snapshotForB2b(binding: B2bBinding, principal: B2bPrincipal) {
    if (!validB2bPrincipal(principal) || !principal.scopes.includes('b2b:documents:read') || !principal.scopes.includes('b2b:artifacts:read') || !b2bBindingsContain(principal.bindings, binding))
      throw new ForbiddenException('Documento de impresión fuera de su alcance B2B.');
    const context = await this.context(String(binding.issuerId), binding.branchId, true);
    if (context.company.ruc !== binding.issuerRuc) throw new ForbiddenException('RUC de impresión inconsistente.');
    return this.store.freeze(context.target);
  }
  async save(companyId: string, branchId: unknown, body: unknown, user?: AccessTokenClaims) {
    this.authorize(user); const context = await this.context(companyId, branchId);
    if (!plainObject(body, ['expectedRevision', 'settings', 'logoUpload']) || !Object.hasOwn(body, 'expectedRevision'))
      throw new BadRequestException('La solicitud de guardado no admite campos adicionales.');
    const request = body as unknown as SavePrintSettingsRequest;
    const draft = validatePrintDraft({ settings: request.settings, ...(request.logoUpload === undefined ? {} : { logoUpload: request.logoUpload }) });
    // El volumen contiene sólo configuración visual. No cambia Company/Branch/series ni Outbox.
    return this.store.save(context.target, draft, request.expectedRevision, user!.sub);
  }
  /** Usado por Billing después de resolver el punto autorizado; sin llamadas a SUNAT. */
  async freezeIssued(company: Pick<Issuer, 'id' | 'ruc' | 'environment'>, branch: Branch): Promise<FrozenPrintPresentationV1 | undefined> {
    if (process.env.PRINT_SETTINGS_ENABLED !== 'true') return undefined;
    this.enabled();
    if (company.environment !== 'BETA' || branch.companyId !== company.id || !UUID.test(branch.id))
      throw new ForbiddenException('Contexto de impresión no autorizado.');
    return this.store.freeze({ companyId: company.id, issuerRuc: company.ruc, branchId: branch.id,
      branchName: branch.name, ...(branch.address ? { branchAddress: branch.address } : {}) });
  }
  async preview(companyId: string, branchId: unknown, body: unknown, user?: AccessTokenClaims) {
    this.authorize(user); const context = await this.context(companyId, branchId);
    if (!plainObject(body, ['documentTypeCode', 'format', 'draft']) || typeof body.documentTypeCode !== 'string' || typeof body.format !== 'string' ||
        !['01', '03', '07', '08', '09', '31'].includes(body.documentTypeCode) || !['a4', 'ticket'].includes(body.format))
      throw new BadRequestException('Seleccione un documento y formato de impresión admitidos.');
    const request = body as unknown as PrintPreviewRequest;
    const draft = request.draft === undefined ? undefined : validatePrintDraft(request.draft);
    const presentation = await this.store.freeze(context.target, draft);
    const bytes = request.documentTypeCode === '09' || request.documentTypeCode === '31'
      ? await renderLocalTransportGuidePdf(this.guidePreview(context, request.documentTypeCode, presentation), request.format)
      : await renderLocalDocumentPdf(this.salePreview(context, request.documentTypeCode, presentation), request.format);
    return { bytes, fileName: `vista-previa-${request.documentTypeCode}-${request.format}-NO-FISCAL.pdf` };
  }
  private salePreview(context: PrintContext, type: '01' | '03' | '07' | '08', presentation: FrozenPrintPresentationV1) {
    const series = type === '03' ? 'BQ00' : 'FQ00', issueDate = new Date().toISOString();
    const amounts = calculateDocumentTotals([{ productCode: 'QA-DIESEL', description: 'DIÉSEL B5 - ÍTEM FICTICIO DE VISTA PREVIA',
      quantity: '2.500000', unitCode: 'GLL', unitPriceWithTax: '18.500000', taxAffectationCode: '10', igvRate: '18' }]);
    const snapshot: FiscalDocumentSnapshot = {
      documentId: randomUUID(), companyId: context.company.id, ...(context.branch ? { branchId: context.branch.id } : {}),
      environment: 'BETA', documentTypeCode: type, series, number: '1', fullNumber: `${series}-1`, issueDate,
      currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' },
      issuer: { identityType: '6', identityNumber: context.company.ruc, legalName: context.company.legalName,
        ...(context.company.tradeName ? { tradeName: context.company.tradeName } : {}), address: context.company.taxAddress,
        ubigeo: '000000', establishmentCode: '0000' },
      customer: { identityType: type === '03' ? '0' : '6', identityNumber: type === '03' ? '0' : '00000000000',
        legalName: 'CLIENTE FICTICIO - NO ES UNA VENTA', address: 'Dirección ficticia de vista previa' },
      ...amounts, printPresentation: presentation,
      printOperation: { branchName: context.branch?.name, branchAddress: context.branch?.address ?? undefined,
        attendedBy: 'OPERADOR FICTICIO QA', shiftLabel: 'TURNO DE PRUEBA', vehiclePlate: 'QA-000',
        observations: 'Vista previa del diseño. Sin emisión, firma, correlativo fiscal ni envío a SUNAT.',
        amountInWords: 'CUARENTA Y SEIS CON 25/100 SOLES' },
    };
    return ['07', '08'].includes(type) ? { ...snapshot, documentTypeCode: type as '07' | '08',
      reasonCode: type === '07' ? '01' : '02', reasonDescription: type === '07' ? 'Anulación - motivo ficticio de diseño' : 'Aumento en el valor - motivo ficticio de diseño',
      reference: { fullNumber: 'FQ00-1', documentTypeCode: '01', issueDate } } : snapshot;
  }
  private guidePreview(context: PrintContext, type: '09' | '31', presentation: FrozenPrintPresentationV1): PrintableTransportGuide {
    const recipient = { identityNumber: '00000000000', legalName: 'DESTINATARIO FICTICIO - NO ES UN TRASLADO' };
    return {
      documentTypeCode: type, fullNumber: `${type === '09' ? 'TQ00' : 'VQ00'}-1`, issueDate: new Date().toISOString(),
      transferDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Lima' }).format(new Date()),
      issuer: { identityNumber: context.company.ruc, legalName: context.company.legalName, address: context.company.taxAddress },
      sender: { identityNumber: '00000000000', legalName: 'REMITENTE FICTICIO' }, recipient,
      origin: { address: 'Dirección de partida ficticia de la vista previa', ubigeo: '000000' },
      destination: { address: 'Dirección de llegada ficticia de la vista previa', ubigeo: '000000' },
      transferReason: { code: '04', description: 'Traslado entre establecimientos - ejemplo de diseño' },
      transportModeCode: type === '09' ? '02' : '01', grossWeight: '1000.000', weightUnit: 'KGM', packageCount: '1',
      carrier: { identityNumber: '00000000000', legalName: 'TRANSPORTISTA FICTICIO', mtcRegistration: 'QA-NO-REGISTRADO' },
      vehicles: [{ plate: 'QA-000', circulationCard: 'NO-FISCAL' }],
      drivers: [{ identityNumber: '00000000', legalName: 'CONDUCTOR FICTICIO QA', license: 'QA-NO-VALIDA' }],
      relatedDocuments: type === '31' ? [{ documentTypeCode: '09', fullNumber: 'TQ00-1', issuerRuc: '00000000000' }] : [],
      observations: 'Sólo vista previa del formato. No autoriza traslado, no consume serie y no genera XML ni CDR.',
      items: [{ code: 'QA-DIESEL', description: 'DIÉSEL B5 - PRODUCTO FICTICIO', quantity: '1000.000', unitCode: 'GLL' }],
      ...(context.branch ? { branchId: context.branch.id } : {}), printPresentation: presentation,
    };
  }
}
