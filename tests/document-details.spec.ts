import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentTable } from "../apps/web-pwa/features/workspace/document-table";
import type { DocumentRow } from "../apps/web-pwa/features/workspace/types";

const webRequire = createRequire(new URL("../apps/web-pwa/package.json", import.meta.url));
const React = webRequire("react");
const { renderToStaticMarkup } = webRequire("react-dom/server");
beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

const invoice: DocumentRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  companyId: 1,
  issuerRuc: "00000000001",
  fullNumber: "FQ01-1",
  documentType: "01",
  customerLegalName: "CLIENTE FICTICIO QA",
  payableAmount: "46.25",
  currencyCode: "PEN",
  sunatStatus: "PROCESSING",
  issueDate: "2026-10-01T23:00:00.000Z",
  branchName: "SEDE FICTICIA QA",
};
const render = (items: DocumentRow[]) => renderToStaticMarkup(
  React.createElement(DocumentTable, { items }),
);
const actions = (html: string) => [...html.matchAll(/<a\b[^>]*aria-label="Ver detalles[^>]*>[\s\S]*?<\/a>/g)]
  .map((match) => match[0]);

describe("acceso explícito al detalle de comprobantes", () => {
  it("muestra Acciones y un botón shadcn que abre la ficha existente por UUID", () => {
    const html = render([invoice]);
    const [action] = actions(html);
    expect(html).toContain(">Acciones</th>");
    expect(actions(html)).toHaveLength(1);
    expect(action).toContain(`href="/documents/${invoice.id}"`);
    expect(action).toContain('data-slot="button"');
    expect(action).toContain('data-variant="outline"');
    expect(action).toContain("Ver detalles</a>");
    expect(action).not.toContain("<button");
  });

  it("mantiene separados comprobantes con el mismo número pero distinto RUC", () => {
    const second = {
      ...invoice,
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      companyId: 2,
      issuerRuc: "00000000002",
    };
    const result = actions(render([invoice, second]));
    expect(result).toHaveLength(2);
    expect(result[0]).toContain(`href="/documents/${invoice.id}"`);
    expect(result[0]).toContain(`Ver detalles de FQ01-1 de RUC ${invoice.issuerRuc}`);
    expect(result[1]).toContain(`href="/documents/${second.id}"`);
    expect(result[1]).toContain(`Ver detalles de FQ01-1 de RUC ${second.issuerRuc}`);
  });

  it("también permite abrir boletas y conserva datos y estado local sin fingir aceptación SUNAT", () => {
    const html = render([{ ...invoice, fullNumber: "BQ01-1", documentType: "03" }]);
    expect(actions(html)[0]).toContain("Ver detalles de BQ01-1");
    expect(html).toContain("CLIENTE FICTICIO QA");
    expect(html).toContain("SEDE FICTICIA QA");
    expect(html).toContain("46.25");
    expect(html).toContain("Procesando localmente");
    expect(html).not.toContain("Aceptado");
    expect(html).toContain('aria-label="Ver BQ01-1 de RUC 00000000001"');
  });

  it("no agrega acciones falsas cuando no hay comprobantes", () => {
    const html = render([]);
    expect(html).toContain("Sin comprobantes todavía");
    expect(actions(html)).toHaveLength(0);
    expect(html).not.toContain("/documents/");
  });
});
