// QA visual exclusivamente en memoria. NO es el servicio de producción ni valida reglas SUNAT.
// La autorización/validación real se prueba en station-admin.spec.ts contra el servicio NestJS.
import { randomUUID } from 'node:crypto';
export function createStationAdminVisualFixture(catalog) {
  for (const c of catalog.companies) Object.assign(c, { active: true, revision: 1, tradeName: null, taxAddress: 'Dirección FICTICIA de QA', ubigeo: '200101', phone: null, contactEmails: [] });
  for (const b of catalog.branches) Object.assign(b, { active: true, revision: 1, address: b.address ?? null });
  for (const p of catalog.emissionPoints) {
    Object.assign(p, { active: true, revision: 1, address: null, trackNumber: null });
    for (const s of p.series) Object.assign(s, { companyId: p.companyId, emissionPointId: p.id, active: true, revision: 1, nextNumber: s.documentType === 'INVOICE' ? '26' : '1', documentCount: s.documentType === 'INVOICE' ? 25 : 0 });
  }
  const company = id => catalog.companies.find(c => c.id === Number(id));
  const branch = id => catalog.branches.find(b => b.id === id);
  const point = id => catalog.emissionPoints.find(p => p.id === id);
  const series = () => catalog.emissionPoints.flatMap(p => p.series);
  const companyActive = row => !!row?.active;
  const branchActive = row => !!row?.active && companyActive(company(row.companyId));
  const pointActive = row => !!row?.active && branchActive(branch(row.branchId));
  const reply = (body, status = 200) => ({ body, status });
  const conflict = message => reply({ message: `QA VISUAL: ${message}` }, 409);
  function snapshot() {
    return { version: 'factuez.station-admin.v1', capabilities: { betaOnly: true, softDelete: true, counterEditing: false },
      companies: catalog.companies.map(c => ({ ...c })), branches: catalog.branches.map(b => ({ ...b, effectiveActive: branchActive(b), pointCount: catalog.emissionPoints.filter(p => p.branchId === b.id).length, openShiftCount: 0 })),
      emissionPoints: catalog.emissionPoints.map(({ series: _, ...p }) => ({ ...p, effectiveActive: pointActive(p), openShiftCount: 0 })),
      series: series().map(s => ({ ...s, effectiveActive: s.active && pointActive(point(s.emissionPointId)), canRename: s.nextNumber === '1' && s.documentCount === 0 })) };
  }
  return function handle(path, method, role, body) {
    const route = path.match(/^\/api\/v1\/stations(?:\/(admin\/catalog|issuers|points|series|[0-9a-f-]{36}))?(?:\/([0-9a-f-]{36}|\d+|issuer|points|series))?(?:\/(series))?$/);
    if (!route) return;
    if (role !== 'ADMIN') return reply({ message: 'QA VISUAL: requiere ADMIN general' }, 403);
    if (path.endsWith('/admin/catalog') && method === 'GET') return reply(snapshot());
    if (method === 'POST') {
      if (path.endsWith('/issuers')) {
        if (!/^00\d{9}$/.test(body.ruc)) return reply({ message: 'QA VISUAL: sólo RUC ficticio que comienza con 00' }, 400);
        if (catalog.companies.some(c => c.ruc === body.ruc)) return conflict('RUC duplicado');
        const row = { id: catalog.companies.length + 1, ...body, environment: 'BETA', active: true, revision: 1, tradeName: body.tradeName ?? null, phone: body.phone ?? null, contactEmails: body.contactEmails ?? [] };
        catalog.companies.push(row); return reply(row, 201);
      }
      if (path === '/api/v1/stations') {
        if (!companyActive(company(body.companyId))) return conflict('emisor inactivo');
        if (catalog.branches.some(b => b.code === body.code)) return conflict('código de sede duplicado');
        const row = { id: randomUUID(), ...body, active: true, revision: 1 }; catalog.branches.push(row); return reply(row, 201);
      }
      if (route[2] === 'points' && !route[3]) {
        const parent = branch(route[1]); if (!branchActive(parent)) return conflict('sede inactiva');
        if (catalog.emissionPoints.some(p => p.code === body.code) || series().some(s => s.companyId === parent.companyId && (s.documentType === 'INVOICE' && s.series === body.invoiceSeries || s.documentType === 'SALES_RECEIPT' && s.series === body.receiptSeries))) return conflict('código o serie duplicado');
        const row = { id: randomUUID(), companyId: parent.companyId, branchId: parent.id, code: body.code, name: body.name, address: body.address ?? null, trackNumber: body.trackNumber ?? null, active: true, revision: 1, series: [] };
        row.series = [['INVOICE', body.invoiceSeries], ['SALES_RECEIPT', body.receiptSeries]].map(([documentType, label]) => ({ id: randomUUID(), companyId: row.companyId, emissionPointId: row.id, documentType, series: label, nextNumber: '1', documentCount: 0, active: true, revision: 1 }));
        catalog.emissionPoints.push(row); return reply(row, 201);
      }
      if (route[1] === 'points' && route[3] === 'series') {
        const parent = point(route[2]); if (!pointActive(parent)) return conflict('punto inactivo');
        if (series().some(s => s.companyId === parent.companyId && s.documentType === body.documentType && s.series === body.series)) return conflict('serie duplicada');
        const row = { id: randomUUID(), companyId: parent.companyId, emissionPointId: parent.id, documentType: body.documentType, series: body.series, nextNumber: '1', documentCount: 0, active: true, revision: 1 };
        parent.series.push(row); return reply(row, 201);
      }
    }
    if (method === 'PATCH' || method === 'DELETE') {
      const type = route[1] === 'issuers' ? 'issuer' : route[1] === 'points' ? 'point' : route[1] === 'series' ? 'series' : 'branch';
      const row = type === 'issuer' ? company(route[2]) : type === 'point' ? point(route[2]) : type === 'series' ? series().find(s => s.id === route[2]) : branch(route[1]);
      if (!row) return reply({ message: 'QA VISUAL: no encontrado' }, 404);
      if (body.expectedRevision !== row.revision) return conflict('El registro cambió. Recargue los maestros.');
      if (route[2] === 'issuer') {
        if (catalog.emissionPoints.some(p => p.branchId === row.id)) return conflict('sede con puntos; RUC protegido');
        if (!companyActive(company(body.companyId))) return conflict('emisor inactivo');
        row.companyId = body.companyId;
      } else if (method === 'DELETE') row.active = false;
      else {
        if (body.active === true && (type === 'branch' && !companyActive(company(row.companyId)) || type === 'point' && !branchActive(branch(row.branchId)) || type === 'series' && !pointActive(point(row.emissionPointId)))) return conflict('padre inactivo');
        if (type === 'series' && body.series && body.series !== row.series && (row.nextNumber !== '1' || row.documentCount)) return conflict('serie con historial; renombrado bloqueado');
        const allowed = type === 'issuer' ? ['legalName', 'tradeName', 'taxAddress', 'ubigeo', 'phone', 'contactEmails', 'active']
          : type === 'series' ? ['series', 'active'] : type === 'point' ? ['code', 'name', 'address', 'trackNumber', 'active'] : ['code', 'name', 'address', 'active'];
        for (const key of allowed) if (Object.hasOwn(body, key)) row[key] = body[key];
      }
      row.revision++; return reply(row);
    }
    return reply({ message: 'QA VISUAL: operación no disponible' }, 405);
  };
}
