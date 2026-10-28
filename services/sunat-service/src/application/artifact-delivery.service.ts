import {ProductionNotesArtifactsService} from './production-notes-artifacts.service';
import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  ForbiddenException,
  Optional,
} from "@nestjs/common";
import type { FiscalDocumentSnapshot } from "@factuez/contracts";
import { isDeepStrictEqual } from "node:util";
import { ArtifactStore } from "../infrastructure/artifact-store";
import { PrismaService } from "../infrastructure/prisma.service";
import { CurrentPdfService, type PrintOwner } from './current-pdf.service';
import { ProductionPdfService } from './production-pdf.service';

@Injectable()
export class ArtifactDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: ArtifactStore,
    @Optional() private readonly previews: CurrentPdfService = new CurrentPdfService(),
    @Optional() private readonly production?: ProductionPdfService,
    @Optional() private readonly notes?: ProductionNotesArtifactsService,
  ) {}
  async download(documentId: string, format: string, authorization?: string) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        documentId,
      ) ||
      !["ticket", "a4"].includes(format)
    )
      throw new BadRequestException("Documento o formato inválido");
    if (
      !authorization ||
      !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(authorization)
    )
      throw new UnauthorizedException("Se requiere un access token Bearer");
    // Billing valida permisos, alcance sede/punto/serie y revocación en Identity.
    // No se consulta su base ni se confía en IDs o RUC enviados por el cliente.
    let response: Response;
    try {
      response = await fetch(
        `${process.env.BILLING_INTERNAL_URL ?? "http://billing-service:3002"}/api/v1/documents/${documentId}`,
        {
          headers: {
            Authorization: authorization,
            Accept: "application/json",
            "Cache-Control": "no-store",
          },
          signal: AbortSignal.timeout(5000),
          redirect: "error",
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        "No se pudo verificar el acceso al documento",
      );
    }
    if (response.status === 401)
      throw new UnauthorizedException("Inicie sesión nuevamente");
    if (response.status === 403)
      throw new ForbiddenException("Documento no autorizado");
    if (response.status === 404)
      throw new NotFoundException("Documento no disponible en su alcance");
    if (!response.ok)
      throw new ServiceUnavailableException(
        "No se pudo verificar el acceso al documento",
      );
    let permitted: { id: string; companyId?: number; printContext?: PrintOwner; immutableSnapshot: FiscalDocumentSnapshot };
    try {
      permitted = (await response.json()) as typeof permitted;
    } catch {
      throw new ServiceUnavailableException(
        "Respuesta de autorización inválida",
      );
    }
    if (
      permitted.id !== documentId ||
      permitted.immutableSnapshot?.documentId !== documentId
    )
      throw new ServiceUnavailableException(
        "Respuesta de autorización inconsistente",
      );
    const snapshot = permitted.immutableSnapshot;
    if (snapshot.environment === 'PRODUCTION' && ['07','08'].includes(snapshot.documentTypeCode)) {
      if (!this.notes) throw new ServiceUnavailableException('Representación de notas aún no ensamblada.');
      return this.notes.pdf(documentId, format as 'ticket' | 'a4', authorization);
    }
    if (snapshot.environment === 'PRODUCTION') {
      if (!this.production) throw new ServiceUnavailableException('Representación fiscal productiva aún no ensamblada.');
      const bytes = await this.production.document(snapshot, format as 'ticket' | 'a4', authorization,
        permitted.printContext ?? { companyId: permitted.companyId });
      return { bytes, fileName: `${snapshot.issuer.identityNumber}-${snapshot.documentTypeCode}-${snapshot.fullNumber}-${format}-PRODUCCION.pdf` };
    }
    const document = await this.prisma.fiscalDocument.findUnique({
      where: { documentId },
    });
    if (!document)
      throw new ConflictException(
        "PDF en preparación. Reintente en unos segundos",
      );
    if (snapshot.environment !== 'BETA' || !/^[1-9]\d{0,17}$/.test(snapshot.number ?? ''))
      throw new ConflictException('La visualización temporal está limitada a documentos de desarrollo Beta con identidad válida');
    if (
      document.issuerRuc !== snapshot.issuer.identityNumber ||
      document.environment !== snapshot.environment ||
      document.series !== snapshot.series ||
      document.number !== BigInt(snapshot.number) ||
      document.documentType !== snapshot.documentTypeCode ||
      !isDeepStrictEqual(document.immutablePayload, JSON.parse(JSON.stringify(snapshot)))
    )
      throw new ConflictException(
        "Contexto fiscal inconsistente; requiere revisión",
      );
    if (!["QUEUED", "BUILDING"].includes(document.status))
      throw new ConflictException(
        "El documento requiere representación fiscal; no se entrega el PDF local de prueba",
      );
    // La representación de consulta ya no depende del PDF archivado al emitir.
    // La caché se consulta DESPUÉS de autorizar y contrastar el snapshot. XML,
    // CDR y PDFs históricos existentes no se sobrescriben ni se eliminan.
    const bytes = await this.previews.document(snapshot, format as 'ticket' | 'a4', authorization, undefined,
      permitted.printContext ?? { companyId: permitted.companyId });
    return {
      bytes,
      fileName: `${document.issuerRuc}-${document.documentType}-${document.series}-${document.number}-${format}-PRUEBA.pdf`,
    };
  }
}
