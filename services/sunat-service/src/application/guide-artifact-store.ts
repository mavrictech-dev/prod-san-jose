import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import { boundedSupplementJson } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type { GuideDispatchDatabase, GuideDispatchSql } from './guide-dispatch-store';
import { GuideArtifactError, artifactFailure, validateGuideArtifactScope, type GuideArtifactScope } from './guide-artifact-owner';
import type { GuideArtifactMetadata, GuideArtifactRecord, GuideArtifactStore, GuideArtifactTransaction, GuideCdrArchive } from './guide-artifact-pipeline';

const options = { isolationLevel: 'Serializable' as const, timeout: 30000, maxWait: 3000 };
const fail = () => artifactFailure('GUIDE_ARTIFACT_STORE_UNAVAILABLE');
function code(e: any, c: string) { return e?.code === c || e?.code === 'P2010' &&
  [e.meta?.code, e.meta?.driverAdapterError?.cause?.originalCode, e.meta?.driverAdapterError?.cause?.code].includes(c); }
type Row = { operationId: string; documentId: string; issuerRuc: string; fullNumber: string; metadata: GuideArtifactMetadata;
  metadataSha256: string; unsignedXml: Uint8Array; signedXml: Uint8Array; zip: Uint8Array; certificatePem: string };
class Transaction implements GuideArtifactTransaction {
  private open = true;
  private failure: unknown;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly db: GuideDispatchSql, private readonly scope: GuideArtifactScope) {}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const p = (async () => {
      if (!this.open || this.failure) return fail();
      try { return await work(); } catch (e) { this.failure ??= e; throw e; }
    })();
    this.pending.add(p); void p.then(() => this.pending.delete(p), () => this.pending.delete(p)); return p;
  }
  async finish() { this.open = false; await Promise.allSettled([...this.pending]); if (this.failure) throw this.failure; }
  read(): Promise<GuideArtifactRecord | null> { return this.run(async () => {
    const rows = await this.db.$queryRawUnsafe<Row[]>(`SELECT "operationId","documentId","issuerRuc","fullNumber", "metadata",
      "metadataSha256","unsignedXml","signedXml","zip","certificatePem" FROM "GuideLocalArtifact"
      WHERE "operationId"=$1::uuid FOR UPDATE`, this.scope.operationId);
    if (!rows.length) return null;
    if (rows.length !== 1) return fail();
    const r = rows[0], m = boundedSupplementJson(r.metadata) as GuideArtifactMetadata;
    if (hash(m.scope) !== hash(this.scope) || r.operationId !== this.scope.operationId || r.documentId !== m.documentId ||
      r.issuerRuc !== m.issuerRuc || r.fullNumber !== m.fullNumber || hash(m) !== r.metadataSha256 ||
      !(r.unsignedXml instanceof Uint8Array) || !(r.signedXml instanceof Uint8Array) || !(r.zip instanceof Uint8Array)) return fail();
    const unsigned = Buffer.from(r.unsignedXml), signed = Buffer.from(r.signedXml);
    if (!Buffer.from(unsigned.toString('utf8')).equals(unsigned) || !Buffer.from(signed.toString('utf8')).equals(signed)) return fail();
    return { metadata: m, unsignedXml: unsigned.toString('utf8'), signedXml: signed.toString('utf8'),
      zip: Buffer.from(r.zip), certificatePem: r.certificatePem };
  }); }
  insert(r: GuideArtifactRecord): Promise<void> { return this.run(async () => {
    const m = boundedSupplementJson(r.metadata) as GuideArtifactMetadata;
    if (hash(m.scope) !== hash(this.scope) || m.environment !== 'BETA') return fail();
    const n = await this.db.$executeRawUnsafe(`INSERT INTO "GuideLocalArtifact"
      ("operationId","documentId","issuerRuc","fullNumber","metadata","metadataSha256","unsignedXml","signedXml","zip","certificatePem")
      VALUES ($1::uuid,$2::uuid,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`, this.scope.operationId, m.documentId, m.issuerRuc,
    m.fullNumber, JSON.stringify(m), hash(m), Buffer.from(r.unsignedXml), Buffer.from(r.signedXml), Buffer.from(r.zip), r.certificatePem);
    if (n !== 1) return fail();
  }); }
  readCdr(): Promise<GuideCdrArchive | null> { return this.run(async () => {
    const rows = await this.db.$queryRawUnsafe<Array<{ operationId: string; packageSha256: string; evidence: unknown; zip: Uint8Array }>>(
      'SELECT "operationId","packageSha256","evidence","zip" FROM "GuideLocalCdr" WHERE "operationId"=$1::uuid', this.scope.operationId);
    if (!rows.length) return null;
    if (rows.length !== 1 || rows[0].operationId !== this.scope.operationId || !(rows[0].zip instanceof Uint8Array)) return fail();
    return { schemaVersion: 'factuez.guide-cdr-archive-local.v1', operationId: rows[0].operationId,
      packageSha256: rows[0].packageSha256, evidence: boundedSupplementJson(rows[0].evidence) as GuideCdrArchive['evidence'],
      zip: Buffer.from(rows[0].zip) };
  }); }
  insertCdr(r: GuideCdrArchive): Promise<void> { return this.run(async () => {
    if (r.schemaVersion !== 'factuez.guide-cdr-archive-local.v1' || r.operationId !== this.scope.operationId) return fail();
    const n = await this.db.$executeRawUnsafe(`INSERT INTO "GuideLocalCdr" ("operationId","packageSha256","evidence","zip")
      VALUES ($1::uuid,$2,$3::jsonb,$4)`, r.operationId, r.packageSha256, JSON.stringify(r.evidence), Buffer.from(r.zip));
    if (n !== 1) return fail();
  }); }
}
/** Bytea originals are append-only, scoped by immutable operation and fiscal
 * identity. No path, filesystem, default database, schema install or secret IO. */
export class PostgresGuideArtifactStore implements GuideArtifactStore {
  constructor(private readonly db: GuideDispatchDatabase) {}
  async transaction<T>(input: GuideArtifactScope, work: (tx: GuideArtifactTransaction) => Promise<T>): Promise<T> {
    const scope = validateGuideArtifactScope(input);
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.$transaction(async db => {
          await db.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',
            'factuez:guide-artifacts:' + scope.operationId);
          const tx = new Transaction(db, scope);
          try { const r = await work(tx); await tx.finish(); return r; }
          catch (e) { await tx.finish(); throw e; }
        }, options);
      } catch (e) {
        // A SERIALIZABLE snapshot can predate the advisory-lock wait. A second
        // same-operation insert then sees 23505 rather than 40001: restart the
        // entire LOCAL transaction, reauthorize and authenticate the prior row.
        // No external effect exists in this callback; fiscal identity collisions
        // with a different operation remain conflicts after the bounded retry.
        if (attempt < 2 && (code(e, '40001') || code(e, 'P2034') || code(e, '23505') || code(e, 'P2002'))) continue;
        if (e instanceof GuideArtifactError && /^GUIDE_ARTIFACT_[A-Z_]+$/.test(e.code)) throw e;
        if (code(e, '23505') || code(e, 'P2002')) artifactFailure('GUIDE_ARTIFACT_IDENTITY_CONFLICT');
        return fail();
      }
    }
    return fail();
  }
}
