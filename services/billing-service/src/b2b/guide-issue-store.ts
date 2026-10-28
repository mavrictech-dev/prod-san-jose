import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { parseGuideBody, type GuideDraft } from './guide-model';
import { validGuideIssueBinding, validateGuideIssueReceipt } from './guide-issue-producer';
import type { GuideEstablishmentDatabase, GuideEstablishmentSql } from './guide-establishment-store';
import type { GuideIssueContext, GuideIssueReceipt, GuideIssueScope, GuideIssueStore, GuideIssueTransaction } from './guide-issue-model';

const options = { isolationLevel: 'Serializable' as const, timeout: 15000, maxWait: 3000 };
const unavailable = () => new B2bSecurityError(503, 'GUIDE_ISSUE_STORE_UNAVAILABLE');
const inconsistent = () => new B2bSecurityError(409, 'GUIDE_ISSUE_RECEIPT_INCONSISTENT');
const conflict = () => new B2bSecurityError(409, 'GUIDE_ISSUE_COUNTER_CONFLICT');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const integer = (n: unknown, min = 1): n is number => Number.isSafeInteger(n) && Number(n) >= min && Number(n) <= 2147483647;
function sqlState(e: unknown): unknown {
  const v = e as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } } } | null;
  return v?.meta?.driverAdapterError?.cause?.originalCode ?? v?.meta?.driverAdapterError?.cause?.code ?? v?.meta?.code ?? v?.code;
}
function retryable(e: unknown): boolean {
  return sqlState(e) === '40001' || sqlState(e) === '40P01' ||
    (e as { code?: unknown } | null)?.code === 'P2034';
}

// Scope is repeated in every owner read, including joins used to read children.
const scoped = `h."companyId"=$1 AND h."issuerRuc"=$2 AND h."clientId"=$3::uuid
  AND h."actorKey"=$4 AND h."binding"=$5::jsonb AND h."draftId"=$6::uuid`;
type Header = { id: string; operationId: string; companyId: number; issuerRuc: string; type: string;
  draftSeriesId: string; fiscalSeriesId: string; draftId: string; draftRevision: number;
  clientId: string; actorKey: string; binding: unknown; series: string; number: bigint | string;
  fullNumber: string; itemCount: number; snapshot: unknown; snapshotSha256: string };
type ReceiptRow = { id: string; documentId: string; clientId: string; actorKey: string; keySha256: string;
  requestSha256: string; payload: GuideIssueReceipt };

class PgGuideIssueTransaction implements GuideIssueTransaction {
  private failed = false;
  private failure: unknown;
  readonly sql: GuideEstablishmentSql;
  constructor(private readonly db: GuideEstablishmentSql, private readonly scope: GuideIssueScope) {
    // Context SQL must also poison the transaction when a caller swallows errors.
    this.sql = {
      $queryRawUnsafe: <T = unknown>(text: string, ...values: unknown[]) => this.run(() => db.$queryRawUnsafe<T>(text, ...values)),
      $executeRawUnsafe: (text, ...values) => this.run(() => db.$executeRawUnsafe(text, ...values)),
    };
  }
  assertHealthy(): void { if (this.failed) throw this.failure; }
  private async run<T>(work: () => Promise<T>): Promise<T> {
    this.assertHealthy();
    try { return await work(); } catch (e) { this.failed = true; this.failure = e; throw e; }
  }
  private args(): unknown[] {
    const s = this.scope;
    return [s.binding.draft.anchor.issuerId, s.binding.draft.anchor.issuerRuc,
      s.clientId, s.actorKey, JSON.stringify(s.binding), s.draftId];
  }
  prior(): Promise<GuideIssueReceipt | null> {
    return this.run(async () => {
      // Metadata only, within the caller's idempotency namespace. Never return
      // another draft/binding's payload and never consume a number on key reuse.
      const conflicts = await this.db.$queryRawUnsafe<{ conflict: boolean }[]>(`
        SELECT EXISTS (SELECT 1 FROM "B2bGuideIssueReceipt" r
          JOIN "B2bGuideIssueDocument" h ON h."id"=r."documentId"
          WHERE r."clientId"=$3::uuid AND r."actorKey"=$4 AND r."keySha256"=$7
            AND NOT (${scoped})) AS conflict`, ...this.args(), this.scope.keySha256);
      if (conflicts.length !== 1 || typeof conflicts[0].conflict !== 'boolean') throw inconsistent();
      if (conflicts[0].conflict) throw new B2bSecurityError(409, 'IDEMPOTENCY_CONFLICT');
      return this.receipt(null);
    });
  }
  operation(id: string): Promise<GuideIssueReceipt | null> {
    return this.run(async () => { if (!uuid(id)) throw inconsistent(); return this.receipt(id); });
  }
  private async receipt(operationId: string | null): Promise<GuideIssueReceipt | null> {
      const rows = await this.db.$queryRawUnsafe<(ReceiptRow & { header: Header })[]>(`
        SELECT r."id",r."documentId",r."clientId",r."actorKey",r."keySha256",r."requestSha256",r."payload",
          to_jsonb(h) AS header FROM "B2bGuideIssueReceipt" r JOIN "B2bGuideIssueDocument" h ON h."id"=r."documentId"
        WHERE ${scoped} AND r."clientId"=$3::uuid AND r."actorKey"=$4 AND ${operationId === null ? 'r."keySha256"=$7' : 'r."id"=$7::uuid'}`,
      ...this.args(), operationId ?? this.scope.keySha256);
      if (!rows.length) return null;
      if (rows.length !== 1) throw inconsistent();
      const row = rows[0], r = validateGuideIssueReceipt(row.payload, operationId === null ? this.scope : { ...this.scope, keySha256: row.keySha256 }), s = r.snapshot, h = row.header;
      if (operationId !== null && r.id !== operationId) throw inconsistent();
      if (row.id !== r.id || row.documentId !== s.documentId || row.clientId !== r.clientId ||
        row.actorKey !== r.actorKey || row.keySha256 !== r.keySha256 || row.requestSha256 !== r.requestSha256 ||
        h.id !== s.documentId || h.operationId !== r.id || h.companyId !== s.binding.draft.anchor.issuerId ||
        h.issuerRuc !== s.issuer.ruc || h.type !== '09' || h.draftSeriesId !== s.binding.draft.guideSeriesId ||
        h.fiscalSeriesId !== s.binding.fiscalSeriesId || h.draftId !== s.draftId || h.draftRevision !== s.draftRevision ||
        h.clientId !== r.clientId || h.actorKey !== r.actorKey || !same(h.binding, s.binding) ||
        h.series !== s.series || String(h.number) !== s.number || h.fullNumber !== s.fullNumber ||
        h.itemCount !== s.body.items.length || h.snapshotSha256 !== r.snapshotSha256 || !same(h.snapshot, s)) throw inconsistent();
      const items = await this.db.$queryRawUnsafe<{ position: number; payload: unknown }[]>(`
        SELECT i."position",i."payload" FROM "B2bGuideIssueItem" i JOIN "B2bGuideIssueDocument" h ON h."id"=i."documentId"
        WHERE ${scoped} AND h."id"=$7::uuid ORDER BY i."position"`, ...this.args(), s.documentId);
      if (items.length !== h.itemCount || items.some((v, i) => v.position !== i + 1 || !same(v.payload, s.body.items[i]))) throw inconsistent();
      const events = await this.db.$queryRawUnsafe<{ operationId: string; eventType: string; payload: unknown }[]>(`
        SELECT o."operationId",o."eventType",o."payload" FROM "B2bGuideIssueLocalOutbox" o
        JOIN "B2bGuideIssueDocument" h ON h."id"=o."documentId" WHERE ${scoped} AND h."id"=$7::uuid`, ...this.args(), s.documentId);
      if (events.length !== 1 || events[0].operationId !== r.id || events[0].eventType !== 'guide.issue.prepared.local.v1' || !same(events[0].payload, s)) throw inconsistent();
      return r;
  }
  draft(): Promise<GuideDraft | null> {
    return this.run(async () => {
      const s = this.scope, b = s.binding.draft;
      const rows = await this.db.$queryRawUnsafe<(GuideDraft & { guideSeriesId: string; companyId: number; issuerRuc: string })[]>(`
        SELECT d."id",d."clientId",d."actorKey",d."guideSeriesId",d."binding",d."body",d."bodySha256",
          d."revision",d."state",d."createdAt",d."updatedAt",c."id" AS "companyId",c."ruc" AS "issuerRuc"
        FROM "B2bGuideDraft" d JOIN "B2bGuideDraftSeries" g ON g."id"=d."guideSeriesId"
        JOIN "CompanySettings" c ON c."id"=g."companyId"
        WHERE d."id"=$1::uuid AND d."clientId"=$2::uuid AND d."actorKey"=$3 AND d."binding"=$4::jsonb
          AND c."id"=$5 AND c."ruc"=$6 AND d."guideSeriesId"=$7::uuid FOR UPDATE OF d`,
      s.draftId, s.clientId, s.actorKey, JSON.stringify(b), b.anchor.issuerId, b.anchor.issuerRuc, b.guideSeriesId);
      if (!rows.length) return null;
      const r = rows[0];
      const at = (v: unknown) => v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : '';
      const d: GuideDraft = { id: r.id, clientId: r.clientId, actorKey: r.actorKey, binding: r.binding,
        body: r.body, bodySha256: r.bodySha256, revision: r.revision, state: r.state,
        createdAt: at(r.createdAt), updatedAt: at(r.updatedAt) };
      if (rows.length !== 1 || d.id !== s.draftId || d.clientId !== s.clientId || d.actorKey !== s.actorKey ||
        r.companyId !== b.anchor.issuerId || r.issuerRuc !== b.anchor.issuerRuc || r.guideSeriesId !== b.guideSeriesId ||
        !same(d.binding, b) || !integer(d.revision) || d.revision > 999999999 || !['DRAFT', 'READY', 'CANCELLED'].includes(d.state) ||
        !same(parseGuideBody(d.body, b), d.body) || hash(d.body) !== d.bodySha256 ||
        !d.createdAt || !d.updatedAt || d.updatedAt < d.createdAt) throw inconsistent();
      return d;
    });
  }
  issuedForDraft(): Promise<boolean> {
    return this.run(async () => {
      const rows = await this.db.$queryRawUnsafe<{ id: string }[]>(`
        SELECT h."id" FROM "B2bGuideIssueDocument" h WHERE ${scoped}`, ...this.args());
      if (rows.length > 1) throw inconsistent();
      return rows.length === 1;
    });
  }
  commit(input: GuideIssueReceipt, inputContext: GuideIssueContext): Promise<void> {
    return this.run(async () => {
      const r = validateGuideIssueReceipt(input, this.scope), s = r.snapshot;
      const c = boundedSupplementJson(inputContext) as GuideIssueContext;
      if (!c || Object.keys(c).sort().join(',') !== 'contextSha256,counter,issuer' || !c.counter || !c.issuer ||
        Object.keys(c.counter).sort().join(',') !== 'id,masterRevision,nextNumber,series' ||
        Object.keys(c.issuer).sort().join(',') !== 'legalName,ruc' || !same(c.issuer, s.issuer) ||
        c.contextSha256 !== s.contextSha256 || !sha(c.contextSha256) || c.counter.id !== s.binding.fiscalSeriesId ||
        c.counter.series !== s.series || c.counter.nextNumber !== s.number || !integer(c.counter.masterRevision, 0)) throw inconsistent();
      const d = await this.draft();
      if (!d || d.state !== 'READY' || d.revision !== s.draftRevision || d.bodySha256 !== s.bodySha256 ||
        !same(d.body, s.body) || s.at < d.updatedAt) throw inconsistent();
      if (await this.issuedForDraft()) throw new B2bSecurityError(409, 'GUIDE_ALREADY_PREPARED');
      // Fiscal uniqueness is across every company sharing this RUC.
      const legacy = await this.db.$queryRawUnsafe<{ id: string }[]>(`
        SELECT d."id" FROM "Document" d JOIN "CompanySettings" c ON c."id"=d."companyId"
        WHERE c."ruc"=$1 AND d."type"='DESPATCH_ADVICE' AND d."series"=$2 AND d."number"=$3::bigint FOR SHARE OF d`,
      s.issuer.ruc, s.series, s.number);
      if (legacy.length) throw new B2bSecurityError(409, 'GUIDE_ISSUE_FISCAL_COLLISION');
      const b = s.binding.draft;
      const changed = await this.db.$executeRawUnsafe(`
        UPDATE "SeriesCounter" f SET "nextNumber"=f."nextNumber"+1,"updatedAt"=$7::timestamptz
        FROM "B2bGuideIssueSeries" m,"B2bGuideDraftSeries" g,"CompanySettings" c,"EmissionPoint" p
        WHERE f."id"=$1::uuid AND f."companyId"=$2 AND f."emissionPointId"=$3::uuid
          AND f."masterRevision"=$4 AND f."nextNumber"=$5::bigint AND f."series"=$6
          AND f."active"=true AND f."documentType"='DESPATCH_ADVICE'
          AND m."draftSeriesId"=$8::uuid AND m."fiscalSeriesId"=f."id" AND m."companyId"=f."companyId"
          AND m."active"=true AND m."purpose"='LOCAL_CANDIDATE'
          AND g."id"=m."draftSeriesId" AND g."companyId"=m."companyId" AND g."pointId"=f."emissionPointId"
          AND g."guideType"='09' AND g."active"=true AND g."purpose"='DRAFT_ONLY' AND g."label"=f."series"
          AND c."id"=f."companyId" AND c."ruc"=$9 AND c."active"=true AND c."environment"='BETA'
          AND p."id"=f."emissionPointId" AND p."companyId"=c."id" AND p."branchId"=$10::uuid AND p."active"=true`,
      c.counter.id, b.anchor.issuerId, b.anchor.pointId, c.counter.masterRevision, s.number, s.series, s.at,
      b.guideSeriesId, b.anchor.issuerRuc, b.anchor.branchId);
      if (changed !== 1) throw conflict();
      const append = async (text: string, ...values: unknown[]) => {
        if (await this.db.$executeRawUnsafe(text, ...values) !== 1) throw unavailable();
      };
      await append(`INSERT INTO "B2bGuideIssueDocument"
        ("id","operationId","companyId","issuerRuc","type","draftSeriesId","fiscalSeriesId","draftId","draftRevision",
         "clientId","actorKey","binding","series","number","fullNumber","itemCount","snapshot","snapshotSha256")
        VALUES ($1::uuid,$2::uuid,$3,$4,'09',$5::uuid,$6::uuid,$7::uuid,$8,$9::uuid,$10,$11::jsonb,$12,$13::bigint,$14,$15,$16::jsonb,$17)`,
      s.documentId, r.id, b.anchor.issuerId, s.issuer.ruc, b.guideSeriesId, s.binding.fiscalSeriesId, s.draftId,
      s.draftRevision, r.clientId, r.actorKey, JSON.stringify(s.binding), s.series, s.number, s.fullNumber,
      s.body.items.length, JSON.stringify(s), r.snapshotSha256);
      for (const [i, item] of s.body.items.entries()) await append(`INSERT INTO "B2bGuideIssueItem" ("documentId","position","payload") VALUES ($1::uuid,$2,$3::jsonb)`, s.documentId, i + 1, JSON.stringify(item));
      await append(`INSERT INTO "B2bGuideIssueReceipt" ("id","documentId","clientId","actorKey","keySha256","requestSha256","payload")
        VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6,$7::jsonb)`, r.id, s.documentId, r.clientId, r.actorKey, r.keySha256, r.requestSha256, JSON.stringify(r));
      await append(`INSERT INTO "B2bGuideIssueLocalOutbox" ("documentId","operationId","eventType","payload")
        VALUES ($1::uuid,$2::uuid,'guide.issue.prepared.local.v1',$3::jsonb)`, s.documentId, r.id, JSON.stringify(s));
    });
  }
}

/** Construction is inert. Schema application and fiscal transport are deliberately absent.
 * Only serialization/deadlock failures retry the whole callback, at most three attempts. */
export class PostgresGuideIssueStore implements GuideIssueStore {
  constructor(private readonly db: GuideEstablishmentDatabase) {}
  async transaction<T>(input: GuideIssueScope, work: (tx: GuideIssueTransaction) => Promise<T>): Promise<T> {
    let scope: GuideIssueScope;
    try {
      scope = boundedSupplementJson(input) as GuideIssueScope;
      if (!scope || Object.keys(scope).sort().join(',') !== 'actorKey,binding,clientId,draftId,keySha256' ||
        !validGuideIssueBinding(scope.binding) || scope.binding.draft.guideType !== '09' || !uuid(scope.draftId) ||
        !uuid(scope.clientId) || !sha(scope.keySha256) || !(scope.actorKey === 'SERVICE:-' ||
        typeof scope.actorKey === 'string' && scope.actorKey.startsWith('USER:') && uuid(scope.actorKey.slice(5)))) throw inconsistent();
    } catch { throw inconsistent(); }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.$transaction(async db => {
          // Global order: idempotency namespace, then owner draft. Reuse of a key
          // on another binding still serializes on the unique receipt namespace.
          for (const key of [JSON.stringify(['guide-issue-key', scope.clientId, scope.actorKey, scope.keySha256]),
            JSON.stringify(['guide-issue-draft', scope.binding.draft.anchor.issuerId,
              scope.binding.draft.anchor.issuerRuc, scope.clientId, scope.actorKey, scope.binding, scope.draftId])])
            await db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))', key);
          const tx = new PgGuideIssueTransaction(db, scope);
          try { const result = await work(tx); tx.assertHealthy(); return result; }
          catch (e) { tx.assertHealthy(); throw e; }
        }, options);
      } catch (e) {
        if (e instanceof B2bSecurityError) throw e;
        if (attempt < 2 && retryable(e)) continue;
        if (sqlState(e) === '23505' || (e as { code?: unknown } | null)?.code === 'P2002')
          throw new B2bSecurityError(409, 'GUIDE_ISSUE_UNIQUE_CONFLICT');
        throw unavailable();
      }
    }
    throw unavailable();
  }
}
