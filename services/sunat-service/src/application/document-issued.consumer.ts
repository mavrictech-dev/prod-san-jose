import { ProductionIssuanceRepository } from './production-issuance.repository';
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  Injectable,
  Optional,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import { Worker, type Job } from "bullmq";
import {
  EventNames,
  QueueNames,
  isDocumentIssuedEventV1,
  type DocumentIssuedEventV1,
  type SunatStatusChangedEventV1,
} from "@factuez/contracts";
import { buildInvoiceUbl } from "@factuez/sunat-core";
import { ArtifactStore } from "../infrastructure/artifact-store";
import { PrismaService } from "../infrastructure/prisma.service";
import { BetaIssuanceRepository } from './beta-issuance.repository';

function connection() {
  const file = process.env.REDIS_PASSWORD_FILE;
  return {
    host: process.env.REDIS_HOST ?? "redis",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: file ? readFileSync(file, "utf8").trim() : undefined,
  };
}

@Injectable()
export class DocumentIssuedConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private worker?: Worker;
  private closing?:Promise<void>;
  constructor(
    private readonly prisma: PrismaService,
    private readonly artifacts: ArtifactStore,
    @Optional() private readonly beta?: BetaIssuanceRepository,
    @Optional() private readonly production?: ProductionIssuanceRepository,
  ) {}

  onApplicationBootstrap() {
    this.worker = new Worker(
      QueueNames.sunatSubmissions,
      (job) => this.process(job),
      {
        connection: connection(),
        concurrency: Number(process.env.SUNAT_WORKER_CONCURRENCY ?? 3),
      },
    );
  }

  private async process(job: Job) {
    if (!isDocumentIssuedEventV1(job.data))
      throw new Error(`Contrato no soportado: ${job.name}`);
    const event = job.data as DocumentIssuedEventV1;
    if (
      await this.prisma.inboxEvent.findUnique({
        where: { eventId: event.eventId },
      })
    )
      return;

    const environment = event.payload.environment;
    const issuerRuc = event.payload.issuer?.identityNumber;
    if (
      !["BETA", "PRODUCTION"].includes(environment ?? "") ||
      !/^\d{11}$/.test(issuerRuc ?? "")
    )
      throw new Error(
        "Falta el contexto fiscal del evento: revisar y reponer desde su snapshot, sin usar credenciales globales",
      );
    const existing = await this.prisma.fiscalDocument.findUnique({
      where: { documentId: event.payload.documentId },
    });
    if (
      existing &&
      (existing.billingEventId !== event.eventId ||
        !isDeepStrictEqual(
          existing.immutablePayload,
          JSON.parse(JSON.stringify(event.payload)),
        ))
    )
      throw new Error("Evento incompatible con el snapshot fiscal congelado");
    if (existing && !["QUEUED", "BUILDING"].includes(existing.status)) {
      // Un replay nunca degrada un documento firmado, enviado o aceptado.
      await this.prisma.inboxEvent.create({
        data: { eventId: event.eventId, eventType: event.eventName },
      });
      return;
    }
    // Sólo artefactos locales: ningún adaptador de transmisión se invoca aquí.
    await this.prisma.fiscalDocument.upsert({
      where: { documentId: event.payload.documentId },
      create: {
        issuerRuc,
        documentId: event.payload.documentId,
        documentType: event.payload.documentTypeCode,
        series: event.payload.series,
        number: BigInt(event.payload.number),
        environment: environment as "BETA" | "PRODUCTION",
        status: "BUILDING",
        billingEventId: event.eventId,
        immutablePayload: JSON.parse(JSON.stringify(event.payload)),
      },
      update: {},
    });

    const xml = buildInvoiceUbl(event.payload);
    const fileName = `${event.payload.issuer.identityNumber}-${event.payload.documentTypeCode}-${event.payload.series}-${event.payload.number}`;
    const artifact = await this.artifacts.putUnsignedXml(
      event.payload.documentId,
      fileName,
      xml,
    );
    const generated = [
      {
        ...artifact,
        kind: "UNSIGNED_XML" as const,
        mediaType: "application/xml",
      },
    ];
    const statusEvent: SunatStatusChangedEventV1 = {
      eventId: randomUUID(),
      eventName: EventNames.sunatStatusChanged,
      occurredAt: new Date().toISOString(),
      correlationId: event.correlationId,
      causationId: event.eventId,
      producer: "sunat-service",
      payload: {
        documentId: event.payload.documentId,
        ...(environment === "PRODUCTION" ? { environment: "PRODUCTION", provenance: "SUNAT_PRODUCTION", documentTypeCode: event.payload.documentTypeCode } : {}),
        status: "BUILDING",
        description:
          "Documento preparado; pendiente de autorización de despacho del emisor",
      },
    };

    const betaStage = (environment === 'PRODUCTION' ? this.production : this.beta)?.stageOperation(event);
    await this.prisma.$transaction([
      ...generated.map((file) =>
        this.prisma.documentArtifact.upsert({
          where: {
            documentId_kind: {
              documentId: event.payload.documentId,
              kind: file.kind,
            },
          },
          create: {
            documentId: event.payload.documentId,
            kind: file.kind,
            storageKey: file.storageKey,
            mediaType: file.mediaType,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          },
          update: {
            storageKey: file.storageKey,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256,
          },
        }),
      ),
      this.prisma.outboxEvent.create({
        data: {
          id: statusEvent.eventId,
          eventType: statusEvent.eventName,
          aggregateId: event.payload.documentId,
          payload: JSON.parse(JSON.stringify(statusEvent)),
        },
      }),
      ...(betaStage ? [betaStage] : []),
      this.prisma.inboxEvent.create({
        data: { eventId: event.eventId, eventType: event.eventName },
      }),
    ]);
  }

  close(){return this.closing??=Promise.resolve().then(()=>this.worker?.close()).then(()=>{},()=>{throw Error('DOCUMENT_ISSUED_CONSUMER_CLOSE_FAILED');});}
  onModuleDestroy(){return this.close();}
}
