import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import { assertGuideReferenceCodes, type GuideReferenceCatalogue } from '@factuez/sunat-core/dist/fiscal-guide-catalogues';
import { CarrierGuideProfileError, type CarrierGuideBody } from '@factuez/sunat-core/dist/carrier-guide-profile';
import type { GuideEstablishmentDatabase, GuideEstablishmentSql } from './guide-establishment-store';
import { carrierBinding, carrierCanonicalJson, carrierExact, carrierFail, carrierInteger, carrierJson, validateCarrierIssuance,
  type CarrierGuideBinding, type CarrierGuideReceipt } from './carrier-guide-model';

export type CarrierGuideDraftRecord = { id: string; revision: number; clientId: string; actorKey: string;
  binding: CarrierGuideBinding; body: CarrierGuideBody; bodySha256: string; at: string };
/** Explicit local carrier operating registry, separately versioned. Every route,
 * non-regulated item, vehicle/TUC, MTC and driver must be enrolled and current. */
export type CarrierGuideRegistry = {
  schemaVersion: 'factuez.carrier-guide-registry.v1'; companyId: number; issuerRuc: string; issuerRevision: number;
  revision: number; catalogue: GuideReferenceCatalogue; mtcRegistration: string;
  routes: { origin: CarrierGuideBody['origin']; destination: CarrierGuideBody['destination'] }[];
  goods: { code: string; description: string; unitCode: string; classification: 'NON_REGULATED' }[];
  vehicles: CarrierGuideBody['transport']['vehicle'][]; drivers: CarrierGuideBody['transport']['driver'][];
  sha256: string;
};
export type CarrierGuideContext = { issuer: { ruc: string; legalName: string }; series: string; nextNumber: string;
  counterRevision: number; contextSha256: string };
type Masters = { company: { id: number; ruc: string; legalName: string; active: boolean; environment: string; configVersion: number };
  branch: { id: string; companyId: number; active: boolean; masterRevision: number };
  point: { id: string; companyId: number; branchId: string; active: boolean; masterRevision: number };
  anchor: { id: string; companyId: number; emissionPointId: string; active: boolean; documentType: string; masterRevision: number };
  draftSeries: { id: string; companyId: number; pointId: string; active: boolean; guideType: string; label: string; revision: number; purpose: string };
  mapping: { draftSeriesId: string; fiscalSeriesId: string; companyId: number; active: boolean; revision: number; purpose: string };
  counter: { id: string; companyId: number; emissionPointId: string; active: boolean; documentType: string; series: string; nextNumber: string; masterRevision: number } };

export class PostgresCarrierGuideTransaction {
  constructor(readonly sql: GuideEstablishmentSql) {}
  async lock(key: string): Promise<void> { await this.sql.$queryRawUnsafe('SELECT 1 FROM pg_advisory_xact_lock(hashtextextended($1,0))', key); }
  async context(binding: CarrierGuideBinding, body: CarrierGuideBody): Promise<CarrierGuideContext> {
    carrierBinding(binding);
    const a = binding.draft.anchor;
    // Registry before masters: shared with carrier configuration writers.
    await this.lock(`carrier-registry:${a.issuerId}`);
    const registryRows = await this.sql.$queryRawUnsafe<{ revision: number; payload: CarrierGuideRegistry }[]>(`
      SELECT h."revision",v."payload" FROM "CarrierGuideRegistryHead" h JOIN "CarrierGuideRegistryVersion" v
      ON v."companyId"=h."companyId" AND v."revision"=h."revision" WHERE h."companyId"=$1 AND h."active"=true FOR SHARE OF h`, a.issuerId);
    const rows = await this.sql.$queryRawUnsafe<Masters[]>(`
      SELECT jsonb_build_object('id',c."id",'ruc',c."ruc",'legalName',c."legalName",'active',c."active",'environment',c."environment",'configVersion',c."configVersion") AS company,
        jsonb_build_object('id',b."id",'companyId',b."companyId",'active',b."active",'masterRevision',b."masterRevision") AS branch,
        jsonb_build_object('id',p."id",'companyId',p."companyId",'branchId',p."branchId",'active',p."active",'masterRevision',p."masterRevision") AS point,
        jsonb_build_object('id',a."id",'companyId',a."companyId",'emissionPointId',a."emissionPointId",'active',a."active",'documentType',a."documentType",'masterRevision',a."masterRevision") AS anchor,
        jsonb_build_object('id',g."id",'companyId',g."companyId",'pointId',g."pointId",'active',g."active",'guideType',g."guideType",'label',g."label",'revision',g."revision",'purpose',g."purpose") AS "draftSeries",
        jsonb_build_object('draftSeriesId',m."draftSeriesId",'fiscalSeriesId',m."fiscalSeriesId",'companyId',m."companyId",'active',m."active",'revision',m."revision",'purpose',m."purpose") AS mapping,
        jsonb_build_object('id',f."id",'companyId',f."companyId",'emissionPointId',f."emissionPointId",'active',f."active",'documentType',f."documentType",'series',f."series",'nextNumber',f."nextNumber"::text,'masterRevision',f."masterRevision") AS counter
      FROM "CompanySettings" c JOIN "Branch" b ON b."companyId"=c."id"
      JOIN "EmissionPoint" p ON p."branchId"=b."id" AND p."companyId"=c."id"
      JOIN "SeriesCounter" a ON a."emissionPointId"=p."id" AND a."companyId"=c."id"
      JOIN "B2bGuideDraftSeries" g ON g."pointId"=p."id" AND g."companyId"=c."id"
      JOIN "CarrierGuideSeries" m ON m."draftSeriesId"=g."id" AND m."companyId"=c."id"
      JOIN "SeriesCounter" f ON f."id"=m."fiscalSeriesId" AND f."companyId"=c."id"
      WHERE c."id"=$1 AND b."id"=$2::uuid AND p."id"=$3::uuid AND a."id"=$4::uuid AND g."id"=$5::uuid AND f."id"=$6::uuid
      FOR UPDATE OF c,f FOR SHARE OF b,p,a,g,m`, a.issuerId, a.branchId, a.pointId, a.seriesId, binding.draft.guideSeriesId, binding.fiscalSeriesId);
    if (rows.length !== 1 || registryRows.length !== 1) carrierFail('CARRIER_GUIDE_CONTEXT_MISSING');
    const m = rows[0], c = m.company, f = m.counter, g = m.draftSeries, r = carrierJson<CarrierGuideRegistry>(registryRows[0].payload);
    if (c.ruc !== a.issuerRuc || c.environment !== 'BETA' || !c.active || !m.branch.active || !m.point.active || !m.anchor.active ||
      !g.active || !m.mapping.active || !f.active || !carrierInteger(c.configVersion) ||
      ![m.branch.masterRevision, m.point.masterRevision, m.anchor.masterRevision, g.revision, m.mapping.revision, f.masterRevision].every(v => carrierInteger(v)) ||
      m.anchor.documentType !== (a.documentType === '01' ? 'INVOICE' : 'SALES_RECEIPT') ||
      g.guideType !== '31' || g.purpose !== 'DRAFT_ONLY' || m.mapping.purpose !== 'LOCAL_CANDIDATE' ||
      f.emissionPointId !== a.pointId || f.documentType !== 'DESPATCH_ADVICE' || !/^V[A-Z0-9]{3}$/.test(f.series) ||
      f.series !== g.label || !/^[1-9][0-9]{0,7}$/.test(f.nextNumber)) carrierFail('CARRIER_GUIDE_MASTERS_INVALID');
    carrierExact(r, ['schemaVersion', 'companyId', 'issuerRuc', 'issuerRevision', 'revision', 'catalogue', 'mtcRegistration', 'routes', 'goods', 'vehicles', 'drivers', 'sha256']);
    const { sha256, ...unsigned } = r;
    if (r.schemaVersion !== 'factuez.carrier-guide-registry.v1' || hash(unsigned) !== sha256 || r.companyId !== a.issuerId ||
      r.issuerRuc !== a.issuerRuc || r.issuerRevision !== c.configVersion || !carrierInteger(r.revision) || r.revision !== registryRows[0].revision ||
      r.mtcRegistration !== body.transport.carrier.mtcRegistration || !Array.isArray(r.routes) || !Array.isArray(r.goods) ||
      !Array.isArray(r.vehicles) || !Array.isArray(r.drivers) ||
      !r.routes.some(route => hash(route) === hash({ origin: body.origin, destination: body.destination })) ||
      !r.vehicles.some(v => hash(v) === hash(body.transport.vehicle)) || !r.drivers.some(v => hash(v) === hash(body.transport.driver)) ||
      body.items.some(i => !r.goods.some(v => v.classification === 'NON_REGULATED' && v.code === i.code && v.description === i.description && v.unitCode === i.unitCode)))
      carrierFail('CARRIER_GUIDE_REGISTRY_STALE_OR_DISABLED');
    try { assertGuideReferenceCodes(r.catalogue, body); }
    catch { carrierFail('CARRIER_GUIDE_CATALOGUE_DISABLED'); }
    const issuer = { ruc: c.ruc, legalName: c.legalName };
    if (hash(issuer) !== hash({ ruc: body.transport.carrier.ruc, legalName: body.transport.carrier.legalName })) carrierFail('CARRIER_GUIDE_ISSUER_MISMATCH');
    return { issuer, series: f.series, nextNumber: f.nextNumber, counterRevision: f.masterRevision,
      contextSha256: hash({ schemaVersion: 'factuez.carrier-guide-context.v1', binding, masters: m, registry: r }) };
  }
  async draft(id: string, clientId: string, actorKey: string, binding: CarrierGuideBinding): Promise<CarrierGuideDraftRecord | null> {
    const rows = await this.sql.$queryRawUnsafe<{ payload: CarrierGuideDraftRecord }[]>(`
      SELECT "payload" FROM "CarrierGuideDraft" WHERE "id"=$1::uuid AND "clientId"=$2::uuid AND "actorKey"=$3 AND "binding"=$4::jsonb FOR SHARE`,
    id, clientId, actorKey, JSON.stringify(binding));
    if (rows.length > 1) carrierFail('CARRIER_GUIDE_DRAFT_INCONSISTENT');
    if (!rows.length) return null;
    const d = carrierJson<CarrierGuideDraftRecord>(rows[0].payload);
    carrierExact(d, ['id', 'revision', 'clientId', 'actorKey', 'binding', 'body', 'bodySha256', 'at']);
    if (d.id !== id || d.clientId !== clientId || d.actorKey !== actorKey || hash(d.binding) !== hash(binding) ||
      !carrierInteger(d.revision) || d.bodySha256 !== hash(d.body)) carrierFail('CARRIER_GUIDE_DRAFT_INCONSISTENT');
    return d;
  }
  async receipt(clientId: string, actorKey: string, query: { keySha256: string } | { operationId: string }): Promise<CarrierGuideReceipt | null> {
    const byKey = 'keySha256' in query;
    const rows = await this.sql.$queryRawUnsafe<{ payload: CarrierGuideReceipt; snapshot: unknown; snapshotSha256: string;
      responseBytes: Uint8Array; operationId: string; draftId: string; documentId: string; binding: unknown;
      keySha256: string; requestSha256: string }[]>(`
      SELECT r."payload",r."responseBytes",r."keySha256",r."requestSha256",h."snapshot",h."snapshotSha256",h."operationId",h."draftId",h."binding",h."documentId"
      FROM "CarrierGuideReceipt" r JOIN "CarrierGuideDocument" h ON h."documentId"=r."documentId"
      WHERE r."clientId"=$1::uuid AND r."actorKey"=$2 AND ${byKey ? 'r."keySha256"=$3' : 'h."operationId"=$3::uuid'}`,
    clientId, actorKey, byKey ? query.keySha256 : query.operationId);
    if (!rows.length) return null;
    if (rows.length !== 1) carrierFail('CARRIER_GUIDE_RECEIPT_INCONSISTENT');
    const row = rows[0], r = carrierJson<CarrierGuideReceipt>(row.payload), response = validateCarrierIssuance(r.response), s = response.snapshot;
    carrierExact(r, ['clientId', 'actorKey', 'keySha256', 'requestSha256', 'actor', 'clientRevision', 'grantRevision', 'response']);
    if (r.clientId !== clientId || r.actorKey !== actorKey || r.keySha256 !== row.keySha256 || r.requestSha256 !== row.requestSha256 ||
      !carrierInteger(r.clientRevision) || r.actor.clientId !== clientId || r.actor.revision !== r.clientRevision || !carrierInteger(r.grantRevision) ||
      `${r.actor.kind}:${r.actor.subjectId ?? '-'}` !== actorKey || response.replayed !== false ||
      row.operationId !== response.operationId || row.draftId !== response.draftId || row.documentId !== s.documentId ||
      hash(row.binding) !== hash(response.binding) || hash(row.snapshot) !== response.snapshotSha256 || row.snapshotSha256 !== response.snapshotSha256 ||
      !Buffer.from(row.responseBytes).equals(Buffer.from(carrierCanonicalJson(response)))) carrierFail('CARRIER_GUIDE_RECEIPT_INCONSISTENT');
    const items = await this.sql.$queryRawUnsafe<{ position: number; payload: unknown }[]>('SELECT "position","payload" FROM "CarrierGuideItem" WHERE "documentId"=$1::uuid ORDER BY "position"', s.documentId);
    const events = await this.sql.$queryRawUnsafe<{ operationId: string; payload: unknown; eventType: string }[]>('SELECT "operationId","payload","eventType" FROM "CarrierGuideLocalOutbox" WHERE "documentId"=$1::uuid', s.documentId);
    if (items.length !== s.body.items.length || items.some((v, i) => v.position !== i + 1 || hash(v.payload) !== hash(s.body.items[i])) ||
      events.length !== 1 || events[0].operationId !== s.operationId || events[0].eventType !== 'carrier.guide.issue.prepared.local.v1' || hash(events[0].payload) !== hash(s)) carrierFail('CARRIER_GUIDE_RECEIPT_INCONSISTENT');
    return { ...r, response };
  }
  async commit(r: CarrierGuideReceipt, context: CarrierGuideContext): Promise<void> {
    const response = validateCarrierIssuance(r.response), s = response.snapshot, a = s.binding.draft.anchor;
    // Validate total serialized receipt size BEFORE reserving a number.
    carrierJson(r);
    const collisions = await this.sql.$queryRawUnsafe<{ id: string }[]>(`SELECT d."id" FROM "Document" d
      JOIN "CompanySettings" c ON c."id"=d."companyId" WHERE c."ruc"=$1 AND d."type"='DESPATCH_ADVICE'
        AND d."series"=$2 AND d."number"=$3::bigint FOR SHARE OF d`, s.issuer.ruc, s.series, s.number);
    if (collisions.length) carrierFail('CARRIER_GUIDE_FISCAL_COLLISION');
    const changed = await this.sql.$executeRawUnsafe(`UPDATE "SeriesCounter" SET "nextNumber"="nextNumber"+1,"updatedAt"=$6::timestamptz
      WHERE "id"=$1::uuid AND "companyId"=$2 AND "emissionPointId"=$3::uuid AND "documentType"='DESPATCH_ADVICE'
        AND "series"=$4 AND "nextNumber"=$5::bigint AND "masterRevision"=$7 AND "active"=true`,
    s.binding.fiscalSeriesId, a.issuerId, a.pointId, s.series, s.number, s.at, context.counterRevision);
    if (changed !== 1) carrierFail('CARRIER_GUIDE_COUNTER_CONFLICT');
    await this.sql.$executeRawUnsafe(`INSERT INTO "CarrierGuideDocument"
      ("documentId","operationId","draftId","companyId","issuerRuc","draftSeriesId","fiscalSeriesId","binding","series","number","snapshot","snapshotSha256")
      VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::uuid,$8::jsonb,$9,$10::bigint,$11::jsonb,$12)`,
    s.documentId, s.operationId, s.draftId, a.issuerId, s.issuer.ruc, s.binding.draft.guideSeriesId, s.binding.fiscalSeriesId, JSON.stringify(s.binding), s.series, s.number, JSON.stringify(s), response.snapshotSha256);
    const pinned = await this.sql.$executeRawUnsafe(`INSERT INTO "CarrierGuideReferenceBinding"
      ("documentId","referenceId","referenceRevision","accessRevision","ownerSnapshotSha256","projectionSha256","signedXmlSha256","cdrSha256")
      SELECT $1::uuid,v."documentId",v."revision",g."revision",v."ownerSnapshotSha256",v."projectionSha256",v."signedXmlSha256",v."cdrSha256"
      FROM "CarrierReference09Head" h JOIN "CarrierReference09Version" v ON v."documentId"=h."documentId" AND v."revision"=h."revision"
      JOIN "CarrierReference09Access" g ON g."referenceId"=h."documentId" WHERE h."documentId"=$2::uuid AND h."active"=true
        AND g."companyId"=$3 AND g."branchId"=$4::uuid AND g."issuerRuc"=$5 AND g."active"=true AND v."projectionSha256"=$6`,
    s.documentId, s.body.reference09.documentId, a.issuerId, a.branchId, a.issuerRuc, s.body.reference09.snapshotSha256);
    if (pinned !== 1) carrierFail('CARRIER_GUIDE_REFERENCE_CHANGED');
    for (const [i, item] of s.body.items.entries()) await this.sql.$executeRawUnsafe(`INSERT INTO "CarrierGuideItem" ("documentId","position","payload") VALUES ($1::uuid,$2,$3::jsonb)`, s.documentId, i + 1, JSON.stringify(item));
    await this.sql.$executeRawUnsafe(`INSERT INTO "CarrierGuideReceipt" ("documentId","clientId","actorKey","keySha256","requestSha256","payload","responseBytes") VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7)`,
    s.documentId, r.clientId, r.actorKey, r.keySha256, r.requestSha256, JSON.stringify(r), Buffer.from(carrierCanonicalJson(response)));
    await this.sql.$executeRawUnsafe(`INSERT INTO "CarrierGuideLocalOutbox" ("documentId","operationId","eventType","payload") VALUES ($1::uuid,$2::uuid,'carrier.guide.issue.prepared.local.v1',$3::jsonb)`, s.documentId, s.operationId, JSON.stringify(s));
  }
}
export class PostgresCarrierGuideStore {
  constructor(private readonly database: GuideEstablishmentDatabase) {}
  async transaction<T>(work: (tx: PostgresCarrierGuideTransaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) try {
      return await this.database.$transaction(sql => work(new PostgresCarrierGuideTransaction(sql)), { isolationLevel: 'Serializable', timeout: 15000, maxWait: 3000 });
    } catch (error) {
      if (error instanceof B2bSecurityError) throw error;
      if (error instanceof CarrierGuideProfileError) carrierFail(error.code);
      const e = error as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string; code?: string } } } };
      const state = e.meta?.driverAdapterError?.cause?.originalCode ?? e.meta?.driverAdapterError?.cause?.code ?? e.meta?.code ?? e.code;
      if (attempt < 2 && ['40001', '40P01', 'P2034'].includes(state ?? '')) continue;
      if (state === '23505' || e.code === 'P2002') carrierFail('CARRIER_GUIDE_UNIQUE_CONFLICT');
      carrierFail('CARRIER_GUIDE_STORE_UNAVAILABLE', 503);
    }
    return carrierFail('CARRIER_GUIDE_STORE_UNAVAILABLE', 503);
  }
}
