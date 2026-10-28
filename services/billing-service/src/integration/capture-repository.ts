import type { IntegrationDocumentFiltersV1, IntegrationIdSelection } from '@factuez/contracts/integration';
import { deny, requireIssuer, requireScopes, ruc, uuid, type ReadPrincipal } from '@factuez/service-access/dist/integration';
import type { PrismaService } from '../infrastructure/prisma.service';
import { readIntegrationJournal } from '@factuez/service-access/dist/integration-journal';
import { billingCaptureMaxBytes, billingCaptureMaxDocuments, type BillingCaptureRepository, type BillingCaptureRows, type BillingCaptureSalesType } from './capture';

const typeName = { '01': 'INVOICE', '03': 'SALES_RECEIPT', '07': 'CREDIT_NOTE', '08': 'DEBIT_NOTE' } as const;
const pageSize = 500;
// Only frozen document fields and canonical ownership needed by mapBillingDocument.
const projection = `SELECT d."id", d."companyId", d."type", d."series", d."number", d."fullNumber",
  d."issueDate", d."status", d."sunatStatus", d."sunatResponseCode", d."originSystem", d."originId",
  d."payableAmount"::text AS "payableAmount", d."updatedAt", d."immutableSnapshot",
  jsonb_build_object('ruc', c."ruc") AS "company",
  CASE WHEN e."id" IS NULL THEN NULL ELSE jsonb_build_object('id', e."id", 'companyId', e."companyId",
    'branchId', e."branchId", 'branch', CASE WHEN b."id" IS NULL THEN NULL ELSE
      jsonb_build_object('companyId', b."companyId") END) END AS "emissionPoint",
  CASE WHEN s."id" IS NULL THEN NULL ELSE jsonb_build_object('id', s."id", 'companyId', s."companyId",
    'emissionPointId', s."emissionPointId", 'documentType', s."documentType", 'series', s."series") END AS "seriesCounter"`;
const baseJoins = `FROM "Document" d
  JOIN "CompanySettings" c ON c."id" = d."companyId"
  LEFT JOIN "EmissionPoint" e ON e."id" = d."emissionPointId" AND e."companyId" = d."companyId"
  LEFT JOIN "Branch" b ON b."id" = e."branchId" AND b."companyId" = d."companyId"
  LEFT JOIN "SeriesCounter" s ON s."id" = d."seriesCounterId" AND s."companyId" = d."companyId"`;

function parameters() {
  const values: unknown[] = [];
  const bind = (value: unknown, cast = '') => { values.push(value); return '$' + values.length + cast; };
  return { values, bind };
}

const snapshotBudgetSql = (selection: string) =>
  `SELECT COALESCE(sum(octet_length("immutableSnapshot"::text)), 0) AS "rawBytes"
FROM (SELECT d."immutableSnapshot"
${selection}) bounded`;

function addSnapshotBudget(total: bigint, budget: { rawBytes: bigint }[]): bigint {
  if (!Array.isArray(budget) || budget.length !== 1 || typeof budget[0]?.rawBytes !== 'bigint' || budget[0].rawBytes < 0n)
    return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
  const next = total + budget[0].rawBytes;
  if (next > BigInt(billingCaptureMaxBytes)) return deny(422, 'EXPORT_TOO_LARGE');
  return next;
}

export class PrismaBillingCapture implements BillingCaptureRepository {
  constructor(private readonly db: PrismaService,private readonly changesEnabled=false) {}

  async capture(filters: IntegrationDocumentFiltersV1, principal: ReadPrincipal): Promise<BillingCaptureRows> {
    requireScopes(principal, ['integration:documents:read']); requireIssuer(principal, filters.issuerRuc);
    if (filters.environment !== 'BETA' || filters.dataset !== 'ISSUED_BUSINESS' || filters.cursor !== null)
      return deny(400, 'INVALID_QUERY');
    if (filters.fiscalStatus !== null && filters.fiscalStatus !== 'NOT_CHECKED')
      return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
    return this.db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const clock = await tx.$queryRaw<{ snapshotAt: Date }[]>`SELECT transaction_timestamp() AS "snapshotAt"`;
      if (clock.length !== 1 || !(clock[0].snapshotAt instanceof Date) || !Number.isFinite(clock[0].snapshotAt.getTime()))
        return deny(503, 'CONSISTENT_READ_UNAVAILABLE');
      const rows: BillingCaptureRows = Object.assign([], { snapshotAt: clock[0].snapshotAt.toISOString() });
      if(this.changesEnabled) {
        // This head and all document pages share the SAME read-only RepeatableRead snapshot.
        const barrier=await readIntegrationJournal({query:async(sql:string,values:unknown[]=[])=>({rows:await tx.$queryRawUnsafe<any[]>(sql,...values)})},filters.issuerRuc,null,1);
        rows.changeBarrier={epoch:barrier.epoch,sequence:barrier.head};
      }
      let rawBytes = 0n;
      let after: { issueDate: Date; id: string } | null = null;
      for (;;) {
        const { values, bind } = parameters();
        const where = [`c."ruc" = ${bind(filters.issuerRuc)}`, `d."immutableSnapshot"->>'environment' = 'BETA'`,
          `d."status"::text IN ('ISSUED', 'CANCELLED')`,
          `d."type"::text = ANY(${bind(filters.types.filter(t => t in typeName).map(t => typeName[t as BillingCaptureSalesType]), '::text[]')})`,
          `d."issueDate" >= (${bind(filters.from, '::date')}::timestamp AT TIME ZONE 'America/Lima')`,
          `d."issueDate" < ((${bind(filters.to, '::date')} + 1)::timestamp AT TIME ZONE 'America/Lima')`];
        if (filters.branchId !== null) where.push(`e."branchId" = ${bind(filters.branchId, '::uuid')}`);
        if (filters.pointId !== null) where.push(`e."id" = ${bind(filters.pointId, '::uuid')}`);
        if (filters.series !== null) where.push(`d."series" = ${bind(filters.series)}`);
        if (filters.currency !== null) where.push(`d."immutableSnapshot"->>'currencyCode' = ${bind(filters.currency)}`);
        const rules = principal.grants.filter(g => g.issuerRuc === filters.issuerRuc && g.environment === 'BETA').map(g => {
          const rule = [`d."type"::text = ANY(${bind(g.documentTypes.filter(t => t in typeName).map(t => typeName[t as BillingCaptureSalesType]), '::text[]')})`];
          const selection = (column: string, s: IntegrationIdSelection) => {
            if (s.kind === 'IDS') rule.push(`${column} = ANY(${bind(s.ids, '::uuid[]')})`);
          };
          selection('e."branchId"', g.branches); selection('e."id"', g.points); selection('s."id"', g.series);
          return '(' + rule.join(' AND ') + ')';
        });
        where.push('(' + (rules.length ? rules.join(' OR ') : 'FALSE') + ')');
        if (after) where.push(`(d."issueDate", d."id") > (${bind(after.issueDate, '::timestamptz')}, ${bind(after.id, '::uuid')})`);
        // Look ahead by exactly one authorized document; LIMIT is after the complete grant predicates.
        const limit = Math.min(pageSize, billingCaptureMaxDocuments + 1 - rows.length);
        const selection = `${baseJoins}\nWHERE ${where.join(' AND ')}\nORDER BY d."issueDate" ASC, d."id" ASC LIMIT ${bind(limit, '::int')}`;
        // Count uncompressed JSON text on the server before any snapshot crosses the connection.
        // Both queries reuse exactly the same authorized selection and bound values in this transaction.
        rawBytes = addSnapshotBudget(rawBytes, await tx.$queryRawUnsafe<{ rawBytes: bigint }[]>(snapshotBudgetSql(selection), ...values));
        // SQL text uses fixed fragments only; every caller-controlled value is a bound parameter.
        const page = await tx.$queryRawUnsafe<any[]>(`${projection}\n${selection}`, ...values);
        rows.push(...page);
        if (rows.length > billingCaptureMaxDocuments) return deny(422, 'EXPORT_TOO_LARGE');
        if (page.length < limit) return rows;
        const last = page[page.length - 1];
        after = { issueDate: last.issueDate, id: last.id };
      }
    }, { isolationLevel: 'RepeatableRead' });
  }

  async reauthorize(issuerRuc: string, ids: string[]): Promise<any[]> {
    if (!ruc(issuerRuc) || !Array.isArray(ids) || ids.some(id => !uuid(id)) ||
        new Set(ids.map(id => id.toLowerCase())).size !== ids.length) return deny(400, 'INVALID_REQUEST');
    if (ids.length > billingCaptureMaxDocuments) return deny(422, 'EXPORT_TOO_LARGE');
    return this.db.$transaction(async tx => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const rows: any[] = [];
      let rawBytes = 0n;
      for (let offset = 0; offset < ids.length; offset += pageSize) {
        const values = [issuerRuc, Object.values(typeName), ids.slice(offset, offset + pageSize)];
        const selection = `${baseJoins}
WHERE c."ruc" = $1 AND d."immutableSnapshot"->>'environment' = 'BETA'
  AND d."status"::text IN ('ISSUED', 'CANCELLED')
  AND d."type"::text = ANY($2::text[]) AND d."id" = ANY($3::uuid[])
ORDER BY d."issueDate" ASC, d."id" ASC LIMIT ${pageSize}`;
        rawBytes = addSnapshotBudget(rawBytes, await tx.$queryRawUnsafe<{ rawBytes: bigint }[]>(snapshotBudgetSql(selection), ...values));
        rows.push(...await tx.$queryRawUnsafe<any[]>(`${projection}\n${selection}`, ...values));
      }
      return rows;
    }, { isolationLevel: 'RepeatableRead' });
  }
}
