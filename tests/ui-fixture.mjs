// Únicamente QA visual, en memoria y loopback. NO es una API de FactuEz.
// No se copia en imágenes Docker. No utiliza credenciales ni datos reales.
import http from "node:http";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { documentSample, guideSample, pngLogo } from './qa-print-formats.mjs';
import { createStationAdminVisualFixture } from './station-admin.visual-fixture.mjs';
import { receivedVisual } from './received-visual-fixture.mjs';
const require = createRequire(import.meta.url);
const {
  renderLocalDocumentPdf,
  renderLocalTransportGuidePdf,
} = require("../packages/pdf-renderer/dist/index.js");
const {
  DefaultRolePermissions,
} = require("../packages/contracts/dist/index.js");
const {
  calculateDocumentTotals,
} = require("../packages/sunat-core/dist/index.js");
if (!process.argv.includes("--visual-only"))
  throw new Error("Debe indicar --visual-only");
const visualPort = process.argv.includes('--fresh-port') ? 3131 : 3101;
const branches = [
  {
    id: "10000000-0000-4000-8000-000000000001",
    companyId: 1,
    code: "QA_CENTRAL",
    name: "QA visual · Central",
    address: "Dirección ficticia para revisar la interfaz",
  },
  {
    id: "10000000-0000-4000-8000-000000000002",
    companyId: 2,
    code: "QA_NORTE",
    name: "QA visual · Norte",
  },
];
const points = branches.map((branch, i) => ({
  id: `20000000-0000-4000-8000-00000000000${i + 1}`,
  branchId: branch.id,
  companyId: branch.companyId,
  code: `QA_CAJA${i + 1}`,
  name: `Terminal visual ${i + 1}`,
  series: [
    {
      id: `40000000-0000-4000-8000-00000000000${i * 2 + 1}`,
      documentType: "INVOICE",
      series: "F001",
    },
    {
      id: `40000000-0000-4000-8000-00000000000${i * 2 + 2}`,
      documentType: "SALES_RECEIPT",
      series: "B001",
    },
  ],
}));
const catalog = {
  companies: [
    {
      id: 1,
      legalName: "EMISOR FICTICIO CENTRAL · QA VISUAL",
      ruc: "00000000001",
      environment: "BETA",
    },
    {
      id: 2,
      legalName: "EMISOR FICTICIO · SOLO QA VISUAL",
      ruc: "00000000000",
      environment: "BETA",
    },
  ],
  capabilities: { demoData: true, fiscalTransmission: false },
  branches,
  emissionPoints: points,
  products: [
    {
      id: randomUUID(),
      sku: "QA_DIESEL",
      description: "Diesel B5 · QA visual",
      unitCode: "GLL",
      taxAffectationCode: "10",
      defaultUnitPrice: "18.50",
    },
  ],
};
const users = [
  {
    id: "30000000-0000-4000-8000-000000000001",
    username: "ui.admin",
    fullName: "Administrador · QA visual",
    active: true,
    editable: false,
    roles: [{ code: "ADMIN", name: "Administrador general" }],
    branchIds: [],
    emissionPointIds: [],
    series: [],
  },
  {
    id: "30000000-0000-4000-8000-000000000002",
    username: "ui.cashier",
    fullName: "Cajero · QA visual",
    active: true,
    editable: true,
    roles: [{ code: "CASHIER", name: "Cajero" }],
    branchIds: [branches[0].id],
    emissionPointIds: [points[0].id],
    series: points[0].series.map((counter) => counter.id),
  },
];
const stationAdminVisual = createStationAdminVisualFixture(catalog);
const documents = [];
const intents = new Map();
const visualSessions = new Map();
const printProfiles = new Map();
const printDefaults = { template: 'SAN_JOSE_V1', logoMode: 'DEFAULT', logoWidthMm: 40, logoAlignment: 'LEFT', showBranchAddress: true, footerNote: '' };
function printContext(company, branchId, draft) {
  const own = printProfiles.get(`${company.id}:${branchId ?? ''}`);
  const issuer = printProfiles.get(`${company.id}:`);
  let selected = own?.settings ? own : issuer?.settings ? issuer : undefined;
  let effective = { ...(selected?.settings ?? printDefaults) }, logo = selected?.logo ?? null;
  if (draft) {
    if (draft.settings === null) { selected = branchId && issuer?.settings ? issuer : undefined; effective = { ...(selected?.settings ?? printDefaults) }; logo = selected?.logo ?? null; }
    else { effective = { ...draft.settings }; if (effective.logoMode === 'CUSTOM') logo = draft.logoUpload ? pngLogo() : logo; else logo = null; }
  }
  const branch = branches.find(row => row.id === branchId);
  return { own, issuer, selected, effective, logo, branch,
    presentation: { version: 'factuez.print-presentation.v1', issuerRuc: company.ruc, branchId: branchId ?? null,
      profileRevision: selected?.revision ?? 0, settings: effective, logo,
      ...(branch ? { branchName: branch.name, branchAddress: branch.address } : {}) } };
}
function printStatus(company, branchId) {
  const ctx = printContext(company, branchId);
  return { version: 'factuez.print-settings.v1', companyId: company.id, ruc: company.ruc, branchId: branchId ?? null,
    revision: ctx.own?.revision ?? 0, updatedAt: ctx.own?.updatedAt ?? null,
    override: ctx.own?.settings ?? null, effective: ctx.effective,
    source: ctx.selected ? branchId && ctx.selected === ctx.own ? 'BRANCH' : 'ISSUER' : 'DEFAULT',
    logoPreviewDataUrl: ctx.logo ? `data:image/png;base64,${ctx.logo.base64}` : null, storageReady: true, fiscalTransmission: false };
}
const visualIdlePhase = process.argv.find(value => value.startsWith('--idle-phase='))?.split('=')[1] ?? 'active';
if (!['active', 'warning', 'critical'].includes(visualIdlePhase)) throw new Error('Fase visual inválida');
const visualUser = (role) => ({
  sub: users[role === 'ADMIN' ? 0 : 1].id, username: role === 'ADMIN' ? 'ui.admin' : 'ui.cashier',
  fullName: `${role} · QA VISUAL`, roles: [role], permissions: DefaultRolePermissions[role],
  exp: Math.floor(Date.now() / 1000) + 3600,
  scope: role === 'ADMIN' ? { kind: 'GLOBAL' } : { kind: 'ASSIGNED', branchIds: [branches[0].id], emissionPointIds: [points[0].id], series: points[0].series.map(counter => counter.id) },
});
const visualSummary = (record) => ({ idleExpiresAt: record.lastActivityAt + 1800000, serverNow: Date.now(), idleTimeoutSeconds: 1800 });
let uncertainOnce = process.argv.includes("--uncertain-once");
function json(res, value, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1:3101");
    if (!url.pathname.startsWith("/api/")) {
      const proxy = http.request(
        {
          hostname: "127.0.0.1",
          port: process.argv.includes('--qa-web') ? 8091 : 3100,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: "localhost:3100" },
        },
        (reply) => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        },
      );
      proxy.on("error", () => {
        res.writeHead(502);
        res.end("Inicie primero la vista previa Next.js en 3100");
      });
      req.pipe(proxy);
      return;
    }
    try {
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        if (text.length > (url.pathname.includes('/print-settings/') ? 512 * 1024 : 65536)) throw new Error("Formulario demasiado grande");
      }
      const body = text ? JSON.parse(text) : undefined;
      if (url.pathname.endsWith('/auth/browser-session/logout')) {
        const key = req.headers.cookie?.match(/(?:^|;\s*)visual_session=([a-z0-9-]+)/)?.[1];
        if (key) visualSessions.delete(key);
        res.setHeader('Set-Cookie', 'visual_session=; Path=/api/v1/auth/browser-session; HttpOnly; SameSite=Strict; Max-Age=0');
        return json(res, { loggedOut: true });
      }
      if (url.pathname === '/api/v1/auth/browser-session' || url.pathname.endsWith('/auth/browser-session/activity')) {
        const key = req.headers.cookie?.match(/(?:^|;\s*)visual_session=([a-z0-9-]+)/)?.[1];
        const record = key && visualSessions.get(key);
        if (!record || Date.now() >= record.lastActivityAt + 1800000) return json(res, { message: 'Sesión visual vencida' }, 401);
        if (url.pathname.endsWith('/activity')) { record.lastActivityAt = Date.now(); return json(res, visualSummary(record)); }
        return json(res, { accessToken: record.username, user: visualUser(record.username === 'ui.admin' ? 'ADMIN' : 'CASHIER'), ...visualSummary(record) });
      }
      if (url.pathname.endsWith("/auth/login") || url.pathname.endsWith('/auth/browser-session/login')) {
        if (
          !["ui.admin", "ui.cashier"].includes(body?.username) ||
          body?.password !== "TEST-VISUAL-ONLY"
        )
          return json(
            res,
            {
              message:
                "QA visual: use ui.admin o ui.cashier con TEST-VISUAL-ONLY",
            },
            401,
          );
        if (url.pathname.endsWith('/browser-session/login')) {
          const elapsed = visualIdlePhase === 'critical' ? 1770000 : visualIdlePhase === 'warning' ? 1500000 : 0;
          const key = randomUUID(); const record = { username: body.username, lastActivityAt: Date.now() - elapsed }; visualSessions.set(key, record);
          res.setHeader('Set-Cookie', `visual_session=${key}; Path=/api/v1/auth/browser-session; HttpOnly; SameSite=Strict; Max-Age=1800`);
          return json(res, { accessToken: body.username, user: visualUser(body.username === 'ui.admin' ? 'ADMIN' : 'CASHIER'), ...visualSummary(record) });
        }
        return json(res, { accessToken: body.username, tokenType: "Bearer" });
      }
      const role =
        req.headers.authorization === "Bearer ui.cashier"
          ? "CASHIER"
          : req.headers.authorization === "Bearer ui.admin"
            ? "ADMIN"
            : undefined;
      if (!role) return json(res, { message: "Sesión QA requerida" }, 401);
      const masterResult = stationAdminVisual(url.pathname, req.method, role, body);
      if (masterResult) return json(res, masterResult.body, masterResult.status);
      const printPath = url.pathname.match(/^\/api\/v1\/stations\/print-settings\/(\d+)(\/preview)?$/);
      if (printPath) {
        if (role !== 'ADMIN') return json(res, { message: 'QA visual: requiere ADMIN global' }, 403);
        const company = catalog.companies.find(row => row.id === Number(printPath[1]) && /^00\d{9}$/.test(row.ruc));
        const branchId = url.searchParams.get('branchId') ?? undefined;
        if (!company || branchId && !branches.some(row => row.id === branchId && row.companyId === company.id))
          return json(res, { message: 'QA visual de formatos sólo admite un RUC ficticio y su sede' }, 403);
        if (printPath[2]) {
          if (req.method !== 'POST' || !['01','03','07','08','09','31'].includes(body?.documentTypeCode) || !['a4','ticket'].includes(body?.format))
            return json(res, { message: 'Vista previa ficticia inválida' }, 400);
          const ctx = printContext(company, branchId, body.draft);
          const guide = ['09', '31'].includes(body.documentTypeCode);
          const snapshot = guide ? guideSample(body.documentTypeCode) : documentSample(body.documentTypeCode);
          snapshot.branchId = branchId; snapshot.printPresentation = ctx.presentation;
          if (!guide) snapshot.issuer.identityNumber = company.ruc;
          const bytes = guide ? await renderLocalTransportGuidePdf(snapshot, body.format) : await renderLocalDocumentPdf(snapshot, body.format);
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store' });
          return res.end(bytes);
        }
        if (req.method === 'POST') {
          const key = `${company.id}:${branchId ?? ''}`, previous = printProfiles.get(key);
          if (body.expectedRevision !== (previous?.revision ?? 0)) return json(res, { message: 'Revisión visual cambió' }, 409);
          const ctx = printContext(company, branchId, body);
          printProfiles.set(key, { settings: body.settings, logo: body.settings?.logoMode === 'CUSTOM' ? ctx.logo : null,
            revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() });
        }
        return json(res, printStatus(company, branchId));
      }
      const receptionView = receivedVisual(url, req.method, role);
      if (receptionView) return json(res, receptionView.body, receptionView.status ?? 200);
      if (url.pathname.endsWith("/auth/me"))
        return json(res, {
          sub: users[role === "ADMIN" ? 0 : 1].id,
          username: role === "ADMIN" ? "ui.admin" : "ui.cashier",
          fullName: `${role} · QA VISUAL`,
          roles: [role],
          permissions: DefaultRolePermissions[role],
          exp: Math.floor(Date.now() / 1000) + 3600,
          scope:
            role === "ADMIN"
              ? { kind: "GLOBAL" }
              : {
                  kind: "ASSIGNED",
                  branchIds: [branches[0].id],
                  emissionPointIds: [points[0].id],
                  series: points[0].series.map((counter) => counter.id),
                },
        });
      if (url.pathname === '/api/v1/gre-qa/capabilities')
        return json(res, { enabled: true, fiscalTransmission: false, ubigeos: { '150101': 'Distrito FICTICIO del fixture' }, itemUnits: ['NIU', 'LTR', 'GLL', 'KGM'] });
      if (url.pathname === '/api/v1/gre-qa' && req.method === 'GET') return json(res, { items: [] });
      if (url.pathname.endsWith("/catalog/issuance"))
        return json(
          res,
          role === "ADMIN"
            ? { ...catalog, companies: catalog.companies.filter(c => c.active), branches: branches.filter(b => b.active && catalog.companies.find(c => c.id === b.companyId)?.active),
                emissionPoints: points.filter(p => p.active && branches.find(b => b.id === p.branchId)?.active && catalog.companies.find(c => c.id === p.companyId)?.active).map(p => ({ ...p, series: p.series.filter(s => s.active) })) }
            : {
                ...catalog,
                companies: catalog.companies.slice(0, 1),
                branches: branches.slice(0, 1),
                emissionPoints: points.slice(0, 1),
              },
        );
      if (url.pathname.endsWith("/documents/preview"))
        return json(res, calculateDocumentTotals(body.lines));
      if (url.pathname.endsWith("/documents/dashboard"))
        return json(res, {
          date: "2026-10-01",
          updatedAt: new Date().toISOString(),
          currencyCode: "PEN",
          count: 0,
          amount: "0",
          igv: "0",
          states: [],
          types: [],
          points: [],
        });
      const detailId = url.pathname.match(
        /^\/api\/v1\/documents\/([a-f0-9-]{36})$/,
      )?.[1];
      const artifactMatch = url.pathname.match(
        /^\/api\/v1\/fiscal-artifacts\/([a-f0-9-]{36})\/(ticket|a4)$/,
      );
      if (detailId || artifactMatch) {
        const row = documents.find(
          (item) =>
            item.id === (detailId ?? artifactMatch[1]) &&
            (role === "ADMIN" || item.branchId === branches[0].id),
        );
        if (!row)
          return json(
            res,
            { message: "QA: documento no disponible en su alcance" },
            404,
          );
        if (detailId) return json(res, { ...row, fiscalTransmission: false });
        const bytes = await renderLocalDocumentPdf(
          row.immutableSnapshot,
          artifactMatch[2],
        );
        res.writeHead(200, {
          "Content-Type": "application/pdf",
          "Content-Disposition": 'attachment; filename="boleta-QA.pdf"',
          "Cache-Control": "private, no-store",
        });
        return res.end(bytes);
      }
      if (url.pathname === "/api/v1/documents") {
        if (req.method === "POST") {
          const key = `${role}:${req.headers["idempotency-key"]}`;
          if (intents.has(key)) return json(res, intents.get(key), 202);
          const point = points.find(
            (point) => point.id === body.emissionPointId,
          );
          if (!point) throw new Error("Punto visual inválido");
          if (role === "CASHIER" && point.branchId !== branches[0].id)
            return json(res, { message: "Punto QA fuera de alcance" }, 403);
          const company = catalog.companies.find(
            (company) => company.id === point.companyId,
          );
          const row = {
            companyId: point.companyId,
            issuerRuc: company.ruc,
            branchId: point.branchId,
            id: randomUUID(),
            fullNumber: `${body.series}-${documents.filter((doc) => doc.companyId === point.companyId && doc.documentType === body.documentType && doc.fullNumber.startsWith(body.series + "-")).length + 1}`,
            documentType: body.documentType,
            customerLegalName: body.customer.legalName,
            payableAmount: calculateDocumentTotals(body.lines).totals
              .payableAmount,
            currencyCode: "PEN",
            sunatStatus: "QUEUED",
            issueDate: new Date().toISOString(),
            branchName: branches.find((branch) => branch.id === point.branchId)
              .name,
          };
          row.immutableSnapshot = {
            documentId: row.id,
            companyId: row.companyId,
            branchId: row.branchId,
            environment: "BETA",
            documentTypeCode: row.documentType === "INVOICE" ? "01" : "03",
            series: body.series,
            number: row.fullNumber.split("-")[1],
            fullNumber: row.fullNumber,
            issueDate: row.issueDate,
            currencyCode: row.currencyCode,
            operationTypeCode: "0101",
            issuer: {
              identityType: "6",
              identityNumber: company.ruc,
              legalName: company.legalName,
              address: "Dirección FICTICIA de QA visual",
              ubigeo: "200101",
              establishmentCode: "QA",
            },
            customer: body.customer,
            ...calculateDocumentTotals(body.lines),
          };
          documents.unshift(row);
          const result = {
            documentId: row.id,
            companyId: row.companyId,
            issuerRuc: row.issuerRuc,
            fullNumber: row.fullNumber,
            sunatStatus: row.sunatStatus,
          };
          intents.set(key, result);
          if (uncertainOnce) {
            uncertainOnce = false;
            return json(
              res,
              {
                message:
                  "QA visual: respuesta incierta simulada después del registro. Reintente la misma operación.",
              },
              503,
            );
          }
          return json(res, result, 202);
        }
        const rows = documents.filter(
          (doc) =>
            (url.searchParams.get('dataSource') !== 'BUSINESS' || !/^00\d{9}$/.test(doc.issuerRuc)) &&
            (url.searchParams.get('dataSource') !== 'SYNTHETIC' || /^00\d{9}$/.test(doc.issuerRuc)) &&
            (!url.searchParams.get("companyId") ||
              String(doc.companyId) === url.searchParams.get("companyId")) &&
            (!url.searchParams.get("branchId") ||
              doc.branchId === url.searchParams.get("branchId")) &&
            (role === "ADMIN" || doc.branchId === branches[0].id),
        );
        return json(res, {
          page: 1,
          pageSize: 20,
          total: rows.length,
          items: rows,
        });
      }
      if (
        url.pathname === "/api/v1/stations/issuers" &&
        req.method === "POST"
      ) {
        if (role !== "ADMIN")
          return json(res, { message: "QA: requiere ADMIN" }, 403);
        const company = {
          id: catalog.companies.length + 1,
          ruc: body.ruc,
          legalName: body.legalName,
          environment: "BETA",
        };
        catalog.companies.push(company);
        return json(res, company, 201);
      }
      if (url.pathname === "/api/v1/stations" && req.method === "POST") {
        if (role !== "ADMIN")
          return json(res, { message: "QA: requiere ADMIN" }, 403);
        const branch = { id: randomUUID(), ...body };
        branches.push(branch);
        return json(res, branch, 201);
      }
      if (
        /\/stations\/[^/]+\/issuer$/.test(url.pathname) &&
        req.method === "PATCH"
      ) {
        const branch = branches.find(
          (branch) => branch.id === url.pathname.split("/")[4],
        );
        if (!branch) throw new Error("Sede QA no encontrada");
        if (points.some((point) => point.branchId === branch.id))
          return json(
            res,
            { message: "QA: sede con puntos; reasignación bloqueada" },
            409,
          );
        branch.companyId = body.companyId;
        return json(res, branch);
      }
      if (url.pathname === "/api/v1/roles")
        return json(
          res,
          Object.entries(DefaultRolePermissions).map(([code, permissions]) => ({
            id: code,
            code,
            name: code,
            description: "QA visual",
            permissions,
            assignable: true,
          })),
        );
      if (url.pathname === "/api/v1/users") {
        if (req.method === "POST") {
          const { password: _password, roles, ...values } = body;
          const row = {
            ...values,
            id: randomUUID(),
            editable: true,
            active: true,
            roles: roles.map((code) => ({ code, name: code })),
          };
          users.push(row);
          return json(res, row, 201);
        }
        return json(res, users);
      }
      if (/\/users\/[^/]+\/access$/.test(url.pathname)) {
        const user = users.find(
          (item) => item.id === url.pathname.split("/")[4],
        );
        if (!user)
          return json(res, { message: "Usuario visual no encontrado" }, 404);
        Object.assign(user, body, {
          roles:
            body.roles?.map((code) => ({ code, name: code })) ?? user.roles,
        });
        return json(res, user);
      }
      return json(
        res,
        { message: "Esta acción no forma parte del fixture visual" },
        404,
      );
    } catch (error) {
      json(res, { message: error.message }, 400);
    }
  })
  .listen(visualPort, "127.0.0.1", () =>
    console.log(
      `QA visual temporal: http://127.0.0.1:${visualPort} · Datos ficticios en memoria; no valida backend real.`,
    ),
  );
