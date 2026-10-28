import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { IssuanceQueryService } from "../services/billing-service/src/application/issuance-query.service";
import { ArtifactDeliveryService } from "../services/sunat-service/src/application/artifact-delivery.service";
import { ArtifactStore } from "../services/sunat-service/src/infrastructure/artifact-store";
import { DocumentIssuedConsumer } from "../services/sunat-service/src/application/document-issued.consumer";
import { calculateDocumentTotals } from "../packages/sunat-core/src/tax";
import {
  renderLocalDocumentPdf,
  IMPLEMENTATION_CREDIT,
} from "../packages/pdf-renderer/src";
import type { FiscalDocumentSnapshot } from "../packages/contracts/src/events";
const documentId = "50000000-0000-4000-8000-000000000001";
const snapshot: FiscalDocumentSnapshot = {
  documentId,
  environment: "BETA",
  documentTypeCode: "03",
  series: "B001",
  number: "1",
  fullNumber: "B001-1",
  issueDate: "2026-10-01T15:30:00Z",
  currencyCode: "PEN",
  operationTypeCode: "0101",
  issuer: {
    identityType: "6",
    identityNumber: "00000000000",
    legalName: "EMISOR FICTICIO QA",
    ubigeo: "200101",
    establishmentCode: "QA",
  },
  customer: {
    identityType: "0",
    identityNumber: "0",
    legalName: "CONSUMIDOR FINAL QA",
  },
  ...calculateDocumentTotals([
    {
      description: "Diésel B5 - descripción larga de prueba",
      unitCode: "GLL",
      quantity: "2.5",
      unitPriceWithTax: "18.50",
      taxAffectationCode: "10",
      igvRate: "18",
    },
  ]),
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("P2: representaciones locales", () => {
  it.each(["ticket", "a4"] as const)(
    "genera PDF %s desde el snapshot sin modificarlo",
    async (format) => {
      const before = structuredClone(snapshot);
      const bytes = await renderLocalDocumentPdf(snapshot, format);
      expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(2000);
      expect(snapshot).toEqual(before);
      expect(IMPLEMENTATION_CREDIT).toBe(
        "Desarrollado e implementado por www.mavrictec.com",
      );
    },
  );
  it("no representa GRE ni documentos vacíos como boletas", async () => {
    await expect(
      renderLocalDocumentPdf({ ...snapshot, documentTypeCode: "09" }, "ticket"),
    ).rejects.toThrow("sólo admite");
    await expect(
      renderLocalDocumentPdf({ ...snapshot, lines: [] }, "a4"),
    ).rejects.toThrow("sólo admite");
  });
  it("el detalle aplica sede, punto y UUID de serie; un ID ajeno devuelve 404", async () => {
    const findFirst = vi.fn(async (_args: unknown) => null);
    const service = new IssuanceQueryService({
      document: { findFirst },
    } as never);
    await expect(
      service.documentDetail(
        {
          kind: "ASSIGNED",
          branchIds: ["sede"],
          emissionPointIds: ["punto"],
          series: ["counter"],
        },
        documentId,
      ),
    ).rejects.toThrow("no disponible");
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: {
        id: documentId,
        emissionPoint: { branchId: { in: ["sede"] }, id: { in: ["punto"] } },
        seriesCounterId: { in: ["counter"] },
      },
    });
    await expect(
      service.documentDetail({ kind: "GLOBAL" }, "../../secret"),
    ).rejects.toThrow("inválido");
    expect(findFirst).toHaveBeenCalledOnce();
  });
});
function deliveryFixture() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({ id: documentId, immutableSnapshot: snapshot }),
        { status: 200 },
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  const fiscal = {
    documentId,
    issuerRuc: snapshot.issuer.identityNumber,
    environment: "BETA",
    series: "B001",
    number: 1n,
    documentType: "03",
    status: "BUILDING",
    immutablePayload: JSON.parse(JSON.stringify(snapshot)),
  };
  const document = vi.fn(async () => fiscal);
  const artifact = vi.fn(async () => ({
    storageKey: "QA",
    sha256: "QA",
    sizeBytes: 1n,
  }));
  const read = vi.fn(async () => Buffer.from("%PDF-QA"));
  const service = new ArtifactDeliveryService(
    {
      fiscalDocument: { findUnique: document },
      documentArtifact: { findUnique: artifact },
    } as never,
    { read } as never,
  );
  return { service, fetchMock, fiscal, document, artifact, read };
}
describe("P2: descarga autenticada entre servicios", () => {
  it("revalida con Billing antes de generar el PDF y conserva RUC en nombre", async () => {
    const f = deliveryFixture();
    const result = await f.service.download(
      documentId,
      "ticket",
      "Bearer qa.token",
    );
    expect(result.fileName).toBe("00000000000-03-B001-1-ticket-PRUEBA.pdf");
    expect(result.bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.bytes.length).toBeGreaterThan(2000);
    expect(result.bytes.toString("latin1")).not.toContain("Max Garcia");
    expect(f.fetchMock.mock.calls[0]).toMatchObject([
      expect.stringContaining(documentId),
      {
        headers: {
          Authorization: "Bearer qa.token",
          "Cache-Control": "no-store",
        },
        redirect: "error",
      },
    ]);
    expect(f.artifact).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 500])(
    "deniega respuesta %i de Billing sin leer almacenamiento",
    async (status) => {
      const f = deliveryFixture();
      f.fetchMock.mockResolvedValue(new Response("{}", { status }));
      await expect(
        f.service.download(documentId, "a4", "Bearer qa.token"),
      ).rejects.toThrow();
      expect(f.document).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    },
  );
  it("sin Bearer o con formato privado no consulta otros servicios", async () => {
    const f = deliveryFixture();
    await expect(f.service.download(documentId, "a4")).rejects.toThrow(
      "Bearer",
    );
    await expect(
      f.service.download(documentId, "SIGNED_XML", "Bearer qa.token"),
    ).rejects.toThrow("inválido");
    expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it("falla cerrado si Billing cae o responde un documento distinto", async () => {
    const f = deliveryFixture();
    f.fetchMock.mockRejectedValueOnce(new Error("down"));
    await expect(
      f.service.download(documentId, "a4", "Bearer qa.token"),
    ).rejects.toThrow("verificar");
    f.fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ id: "otro", immutableSnapshot: snapshot })),
    );
    await expect(
      f.service.download(documentId, "a4", "Bearer qa.token"),
    ).rejects.toThrow("inconsistente");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("el mismo número de otro RUC no habilita la descarga", async () => {
    const f = deliveryFixture();
    f.fiscal.issuerRuc = "20450819230";
    await expect(
      f.service.download(documentId, "a4", "Bearer qa.token"),
    ).rejects.toThrow("Contexto fiscal");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("no reimprime desde un snapshot que difiere de Billing", async () => {
    const f = deliveryFixture();
    f.fiscal.immutablePayload.customer.legalName = "OTRO CLIENTE";
    await expect(f.service.download(documentId, "ticket", "Bearer qa.token")).rejects.toThrow("Contexto fiscal");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("no entrega PDF de prueba después de firmar/aceptar", async () => {
    const f = deliveryFixture();
    f.fiscal.status = "ACCEPTED";
    await expect(
      f.service.download(documentId, "a4", "Bearer qa.token"),
    ).rejects.toThrow("representación fiscal");
    expect(f.read).not.toHaveBeenCalled();
  });
  it("no depende del PDF permanente antiguo, ausente o dañado para mostrar formato vigente", async () => {
    const f = deliveryFixture();
    f.artifact.mockResolvedValueOnce(null as never);
    expect((await f.service.download(documentId, "a4", "Bearer qa.token")).bytes.subarray(0, 5).toString()).toBe('%PDF-');
    f.read.mockRejectedValueOnce(new Error("integridad"));
    expect((await f.service.download(documentId, "a4", "Bearer qa.token")).bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(f.artifact).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
});
describe("P2: archivos privados y replay", () => {
  it("persiste bytes y checksum; rechaza traversal, otra carpeta y corrupción", async () => {
    const directory = await mkdtemp(join(tmpdir(), "factuez-pdf-qa-"));
    vi.stubEnv("ARTIFACTS_ROOT", directory);
    try {
      const store = new ArtifactStore();
      const bytes = Buffer.from("%PDF-QA");
      const stored = await store.put(documentId, "boleta.pdf", bytes);
      expect(stored.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await store.read(documentId, stored)).toEqual(bytes);
      await expect(
        store.put(documentId, "../../secret.pdf", bytes),
      ).rejects.toThrow("inválido");
      await expect(
        store.read("50000000-0000-4000-8000-000000000002", stored),
      ).rejects.toThrow("Ruta");
      await writeFile(join(directory, stored.storageKey), "%PDF-XA");
      await expect(store.read(documentId, stored)).rejects.toThrow(
        "Integridad",
      );
      expect(
        (await readFile(join(directory, stored.storageKey))).toString(),
      ).toBe("%PDF-XA");
    } finally {
      const child = relative(resolve(tmpdir()), resolve(directory));
      if (!child.startsWith("factuez-pdf-qa-") || child.includes(sep))
        throw new Error("Cleanup QA inseguro");
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("un replay no regresa un documento aceptado a BUILDING ni rehace archivos", async () => {
    const event = {
      eventId: "60000000-0000-4000-8000-000000000001",
      eventName: "billing.document.issued.v1",
      correlationId: "qa",
      payload: snapshot,
    };
    const upsert = vi.fn();
    const put = vi.fn();
    const inbox = vi.fn(async () => ({}));
    const worker = new DocumentIssuedConsumer(
      {
        inboxEvent: { findUnique: async () => null, create: inbox },
        fiscalDocument: {
          findUnique: async () => ({
            status: "ACCEPTED",
            billingEventId: event.eventId,
            immutablePayload: JSON.parse(JSON.stringify(snapshot)),
          }),
          upsert,
        },
      } as never,
      { put } as never,
    );
    await (worker as any).process({ data: event, name: "QA" });
    expect(upsert).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(inbox).toHaveBeenCalledOnce();
  });
});
