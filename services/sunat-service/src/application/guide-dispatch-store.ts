import {
  GuideDispatchError, rebuildGuideDispatch, validateGuideDispatchKey, validateGuideDispatchManifest,
  type GuideDispatchEvent, type GuideDispatchKey, type GuideDispatchManifest,
} from '@factuez/sunat-core/dist/guide-dispatch-journal';
import {fiscalSnapshotSha256} from '@factuez/sunat-core/dist/fiscal-note';
import {boundedSupplementJson} from '@factuez/sunat-core/dist/fiscal-supplement-command';
import type {GuideDispatchRecord, GuideDispatchStore, GuideDispatchTransaction} from './guide-dispatch-types';

/** Structural port: this candidate does not depend on a generated Billing client. */
export interface GuideDispatchSql {
  $queryRawUnsafe<T = unknown>(sql: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...values: unknown[]): Promise<number>;
}
export interface GuideDispatchDatabase {
  $transaction<T>(work: (tx: GuideDispatchSql) => Promise<T>, options: {
    isolationLevel: 'Serializable'; timeout: number; maxWait: number;
  }): Promise<T>;
}

const unavailable = () => new GuideDispatchError('GUIDE_DISPATCH_STORE_UNAVAILABLE');
const identityConflict = () => new GuideDispatchError('GUIDE_DISPATCH_IDENTITY_CONFLICT');
const revisionConflict = () => new GuideDispatchError('GUIDE_DISPATCH_REVISION_CONFLICT');
const options = {isolationLevel: 'Serializable' as const, timeout: 15000, maxWait: 3000};
const same = (a: unknown, b: unknown) => fiscalSnapshotSha256(a) === fiscalSnapshotSha256(b);

function sqlCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as {code?: unknown; meta?: {code?: unknown;
    driverAdapterError?: {cause?: {originalCode?: unknown; code?: unknown}}}};
  return e.code === code || e.code === 'P2010' && (e.meta?.code === code ||
    e.meta?.driverAdapterError?.cause?.originalCode === code || e.meta?.driverAdapterError?.cause?.code === code);
}
function retryable(error: unknown): boolean {return sqlCode(error, '40001') || sqlCode(error, 'P2034');}

/** Never carry a driver message, SQL, credential or arbitrary callback code out. */
export function safeGuideDispatchError(error: unknown): GuideDispatchError {
  if (error instanceof GuideDispatchError && [
    'GUIDE_DISPATCH_IDENTITY_CONFLICT', 'GUIDE_DISPATCH_REVISION_CONFLICT', 'GUIDE_DISPATCH_STORE_UNAVAILABLE',
    'GUIDE_DISPATCH_OWNER_CHANGED', 'GUIDE_DISPATCH_SOURCE_NOT_FOUND', 'GUIDE_DISPATCH_TICKET_REQUIRED',
    'GUIDE_DISPATCH_HISTORY_LIMIT', 'GUIDE_DISPATCH_RESULT_CONFLICT', 'INVALID_GUIDE_DISPATCH_OWNER',
    'GUIDE_DISPATCH_SOURCE_CHANGED', 'GUIDE_DISPATCH_NOT_FOUND', 'GUIDE_DISPATCH_OWNER_UNAVAILABLE',
  ].includes(error.code)) return new GuideDispatchError(error.code);
  if (sqlCode(error, '23505') || sqlCode(error, 'P2002')) return identityConflict();
  return unavailable();
}

type StreamRow = {operationId: string; companyId: number; issuerRuc: string; documentId: string;
  guideType: string; fullNumber: string; manifest: unknown; revision: number; headSha256: string};
type EventRow = {operationId: string; version: number; payload: GuideDispatchEvent; hash: string};

class PgGuideDispatchTransaction implements GuideDispatchTransaction {
  private failed = false;
  private failure: unknown;
  private open = true;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly db: GuideDispatchSql, private readonly key: GuideDispatchKey) {}

  private healthy(): void {if (this.failed) throw this.failure;}
  private run<T>(work: () => Promise<T>): Promise<T> {
    const promise = (async () => {
      this.healthy();
      try {if (!this.open) throw unavailable(); return await work();}
      catch (error) {if (!this.failed) {this.failed = true; this.failure = error;} throw error;}
    })();
    this.pending.add(promise);
    void promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  async finish(): Promise<void> {
    this.open = false;
    await Promise.allSettled([...this.pending]);
    this.healthy();
  }
  private scope(manifest: GuideDispatchManifest): void {
    if (!same(manifest.key, this.key)) throw identityConflict();
  }
  private async load(): Promise<GuideDispatchRecord | null> {
    const {companyId, issuerRuc, operationId} = this.key;
    const roots = await this.db.$queryRawUnsafe<StreamRow[]>(`
      SELECT "operationId","companyId","issuerRuc","documentId","guideType","fullNumber",
        "manifest","revision","headSha256" FROM "GuideDispatchStream"
      WHERE "companyId"=$1 AND "issuerRuc"=$2 AND "operationId"=$3::uuid FOR UPDATE`,
    companyId, issuerRuc, operationId);
    const rows = await this.db.$queryRawUnsafe<EventRow[]>(`
      SELECT e."operationId",e."version",e."payload",e."hash" FROM "GuideDispatchEvent" e
      JOIN "GuideDispatchStream" s ON s."operationId"=e."operationId"
      WHERE s."companyId"=$1 AND s."issuerRuc"=$2 AND s."operationId"=$3::uuid
      ORDER BY e."version" LIMIT 129`, companyId, issuerRuc, operationId);
    if (!roots.length && !rows.length) return null;
    if (roots.length !== 1 || rows.length < 1 || rows.length > 128) throw unavailable();
    const root = roots[0], manifest = validateGuideDispatchManifest(root.manifest);
    if (!same(manifest.key, this.key) || root.operationId !== operationId || root.companyId !== companyId || root.issuerRuc !== issuerRuc ||
      root.documentId !== manifest.documentId || root.guideType !== manifest.guideType ||
      root.fullNumber !== manifest.fullNumber) throw unavailable();
    const events = rows.map((row, index) => {
      if (!row.payload || row.operationId !== operationId || row.version !== index + 1 ||
        row.payload.operationId !== row.operationId || row.payload.version !== row.version ||
        row.payload.sha256 !== row.hash) throw unavailable();
      return row.payload;
    });
    const projection = rebuildGuideDispatch(manifest, events);
    if (root.revision !== projection.revision || root.headSha256 !== projection.headSha256) throw unavailable();
    // Detach returned metadata from driver rows and subsequent caller mutations.
    return boundedSupplementJson({manifest, events}) as GuideDispatchRecord;
  }
  read(): Promise<GuideDispatchRecord | null> {return this.run(() => this.load());}

  register(input: GuideDispatchManifest, eventInput: GuideDispatchEvent): Promise<void> {
    return this.run(async () => {
      const manifest = validateGuideDispatchManifest(input);
      this.scope(manifest);
      const event = boundedSupplementJson(eventInput) as GuideDispatchEvent;
      const projection = rebuildGuideDispatch(manifest, [event]);
      if (projection.revision !== 1 || event.kind !== 'REGISTER') throw unavailable();
      const current = await this.load();
      if (current) {
        if (!same(current.manifest, manifest) || !same(current.events[0], event)) throw identityConflict();
        return;
      }
      const {companyId, issuerRuc, operationId} = this.key;
      const inserted = await this.db.$executeRawUnsafe(`
        INSERT INTO "GuideDispatchStream"
          ("operationId","companyId","issuerRuc","documentId","guideType","fullNumber","manifest","revision","headSha256")
        VALUES ($1::uuid,$2,$3,$4::uuid,$5,$6,$7::jsonb,1,$8)`, operationId, companyId, issuerRuc,
      manifest.documentId, manifest.guideType, manifest.fullNumber, JSON.stringify(manifest), event.sha256);
      if (inserted !== 1) throw unavailable();
      await this.insert(event);
    });
  }
  private async insert(event: GuideDispatchEvent): Promise<void> {
    const inserted = await this.db.$executeRawUnsafe(`
      INSERT INTO "GuideDispatchEvent" ("operationId","version","payload","hash")
      VALUES ($1::uuid,$2,$3::jsonb,$4)`, this.key.operationId, event.version, JSON.stringify(event), event.sha256);
    if (inserted !== 1) throw unavailable();
  }
  append(eventInput: GuideDispatchEvent, expectedRevision: number): Promise<void> {
    return this.run(async () => {
      if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision > 128) throw revisionConflict();
      const event = boundedSupplementJson(eventInput) as GuideDispatchEvent;
      const current = await this.load();
      if (!current || current.events.length !== expectedRevision) throw revisionConflict();
      const projection = rebuildGuideDispatch(current.manifest, [...current.events, event]);
      const previous = current.events[current.events.length - 1];
      const changed = await this.db.$executeRawUnsafe(`
        UPDATE "GuideDispatchStream" SET "revision"=$4,"headSha256"=$5
        WHERE "companyId"=$1 AND "issuerRuc"=$2 AND "operationId"=$3::uuid
          AND "revision"=$6 AND "headSha256"=$7`, this.key.companyId, this.key.issuerRuc,
      this.key.operationId, projection.revision, projection.headSha256, expectedRevision, previous.sha256);
      if (changed !== 1) throw revisionConflict();
      await this.insert(event);
    });
  }
}

/** Candidate dispatch journal only; no numbering, transport or schema installation. */
export class PostgresGuideDispatchStore implements GuideDispatchStore {
  constructor(private readonly db: GuideDispatchDatabase) {}
  async transaction<T>(input: GuideDispatchKey, work: (tx: GuideDispatchTransaction) => Promise<T>): Promise<T> {
    let key: GuideDispatchKey;
    try {key = validateGuideDispatchKey(input);} catch {throw unavailable();}
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.db.$transaction(async db => {
          // Global operation lock also serializes attempts using the wrong tenant scope.
          await db.$queryRawUnsafe(`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))`,
            'factuez:guide-dispatch:' + key.operationId);
          const tx = new PgGuideDispatchTransaction(db, key);
          try {const result = await work(tx); await tx.finish(); return result;}
          catch (error) {await tx.finish(); throw error;}
        }, options);
      } catch (error) {
        if (attempt < 2 && retryable(error)) continue;
        throw safeGuideDispatchError(error);
      }
    }
    throw unavailable();
  }
}
