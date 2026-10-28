import { ConflictException, HttpException, Inject, Injectable, OnModuleDestroy, Optional, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { FiscalDocumentSnapshot, FrozenPrintPresentationV1 } from '@factuez/contracts';
import { AccessError, privateJson, UUID } from '@factuez/service-access';
import {
  PDF_RENDERER_VERSION, PdfPreviewCache, renderLocalDocumentPdf, renderLocalGrePdf,
  type PrintableGre, type PrintableNote, type PrintFormat,
} from '@factuez/pdf-renderer';
import { resolvePresentation } from '@factuez/pdf-renderer/dist/presentation';

export interface PrintOwner { companyId?: number; branchId?: string | null }
type QaProof = { digestValue: string; status: string };
type PrintSnapshot = FiscalDocumentSnapshot | PrintableNote;
export const CURRENT_PDF_RENDERERS = 'CURRENT_PDF_RENDERERS';
export interface CurrentPdfRenderers {
  document: typeof renderLocalDocumentPdf;
  gre: typeof renderLocalGrePdf;
}

/** Sólo representaciones LOCAL/BETA. Ninguna firma, escritura ni consulta a SUNAT. */
@Injectable()
export class CurrentPdfService implements OnModuleDestroy {
  private readonly cache = new PdfPreviewCache();
  constructor(@Optional() @Inject(CURRENT_PDF_RENDERERS) private readonly renderers: CurrentPdfRenderers = {
    document: renderLocalDocumentPdf, gre: renderLocalGrePdf,
  }) {}

  private async current(
    original: FrozenPrintPresentationV1 | undefined, issuerRuc: string,
    owner: PrintOwner, authorization?: string,
  ): Promise<FrozenPrintPresentationV1 | undefined> {
    if (process.env.PRINT_SETTINGS_ENABLED !== 'true') return original && structuredClone(original);
    if (!Number.isSafeInteger(owner.companyId) || Number(owner.companyId) < 1 ||
        (owner.branchId != null && !UUID.test(owner.branchId)))
      throw new ConflictException('El documento histórico requiere resolver su RUC y sede antes de actualizar la presentación.');
    let value: FrozenPrintPresentationV1;
    try {
      value = await privateJson<FrozenPrintPresentationV1>(
        process.env.BILLING_INTERNAL_URL ?? 'http://billing-service:3002',
        `/api/v1/stations/print-settings/${owner.companyId}/snapshot${owner.branchId ? `?branchId=${encodeURIComponent(owner.branchId)}` : ''}`,
        authorization ?? '',
      );
    } catch (error) {
      if (error instanceof AccessError) throw new HttpException('No se pudo consultar el formato vigente con su acceso autorizado.', error.status);
      throw new ServiceUnavailableException('Formato vigente no disponible. Reintente sin sustituir los datos de la emisión.');
    }
    try { resolvePresentation(value, issuerRuc, owner.branchId ?? undefined); }
    catch { throw new ConflictException('El formato vigente no corresponde al RUC/sede del documento o está dañado.'); }
    // El perfil actual aporta SÓLO diseño/logo. Su dirección/nombre actuales nunca
    // sustituyen los hechos históricos; los campos antiguos se conservan aparte.
    const { branchName: _currentName, branchAddress: _currentAddress, ...visual } = structuredClone(value);
    return { ...visual,
      ...(original?.branchName ? { branchName: original.branchName } : {}),
      ...(original?.branchAddress ? { branchAddress: original.branchAddress } : {}),
    };
  }

  private async cached(value: unknown, render: () => Promise<Buffer>): Promise<Buffer> {
    const key = createHash('sha256').update(JSON.stringify({ renderer: PDF_RENDERER_VERSION, value })).digest('hex');
    try { return await this.cache.getOrRender(key, render); }
    catch { throw new ServiceUnavailableException('No se pudo preparar el PDF temporal. Reintente en unos segundos.'); }
  }

  async document(snapshot: PrintSnapshot, format: PrintFormat, authorization?: string, proof?: QaProof, binding?: PrintOwner): Promise<Buffer> {
    if (snapshot.environment !== 'BETA') throw new ConflictException('La generación temporal actual está limitada a desarrollo Beta.');
    const { printable, owner } = await this.presentationForDocument(snapshot, authorization, binding);
    const evidence = proof && { ...proof };
    return this.cached({ mode: 'LOCAL_SALE', owner, format, printable, evidence }, () => this.renderers.document(printable, format, evidence));
  }
  /** Visual settings only; caller must authorize and validate its fiscal originals first. */
  async presentationForDocument<T extends PrintSnapshot>(snapshot: T, authorization?: string, binding?: PrintOwner): Promise<{ printable: T; owner: PrintOwner }> {
    const owner = { companyId: snapshot.companyId ?? binding?.companyId, branchId: snapshot.branchId ?? binding?.branchId };
    if ((binding?.companyId != null && snapshot.companyId != null && binding.companyId !== snapshot.companyId) ||
        (binding?.branchId != null && snapshot.branchId != null && binding.branchId !== snapshot.branchId))
      throw new ConflictException('La pertenencia histórica del documento no coincide con su snapshot.');
    const presentation = await this.current(snapshot.printPresentation, snapshot.issuer.identityNumber, owner, authorization);
    const printable: T = { ...structuredClone(snapshot),
      ...(presentation ? { printPresentation: presentation, ...(owner.branchId ? { branchId: owner.branchId } : {}) } : {}),
    };
    return { printable: printable as T, owner };
  }
  /** Owner-authorized B2B path: presentation came from Billing's dedicated B2B read. */
  async b2bDocument(snapshot: FiscalDocumentSnapshot, format: PrintFormat, presentation: FrozenPrintPresentationV1 | null, owner: Required<PrintOwner>): Promise<Buffer> {
    if (snapshot.environment !== 'BETA' || snapshot.companyId !== owner.companyId || snapshot.branchId !== owner.branchId || !['a4','ticket'].includes(format))
      throw new ConflictException('Contexto B2B de impresión inconsistente.');
    if (!presentation) throw new ServiceUnavailableException('Formato vigente B2B no configurado.');
    resolvePresentation(presentation, snapshot.issuer.identityNumber, owner.branchId ?? undefined);
    const { branchName: _currentName, branchAddress: _currentAddress, ...visual } = structuredClone(presentation);
    const historical = snapshot.printPresentation;
    const printable = { ...structuredClone(snapshot), printPresentation: { ...visual,
      ...(historical?.branchName ? {branchName: historical.branchName} : {}),
      ...(historical?.branchAddress ? {branchAddress: historical.branchAddress} : {}) } };
    return this.cached({mode:'B2B_LOCAL_SALE',owner,format,printable},()=>this.renderers.document(printable,format));
  }

  async gre(snapshot: PrintableGre, owner: PrintOwner, format: PrintFormat, authorization?: string, digest?: string): Promise<Buffer> {
    if (!/^00\d{9}$/.test(snapshot.issuer.ruc) || (snapshot.branchId && snapshot.branchId !== owner.branchId))
      throw new ConflictException('La representación GRE requiere el mismo emisor/sede del laboratorio ficticio.');
    const presentation = await this.current(snapshot.printPresentation, snapshot.issuer.ruc, owner, authorization);
    const printable: PrintableGre = { ...structuredClone(snapshot),
      ...(presentation ? { printPresentation: presentation, ...(owner.branchId ? { branchId: owner.branchId } : {}) } : {}),
    };
    return this.cached({ mode: 'LOCAL_GRE', owner, format, printable, digest }, () => this.renderers.gre(printable, format, digest));
  }

  onModuleDestroy() { this.cache.close(); }
}
