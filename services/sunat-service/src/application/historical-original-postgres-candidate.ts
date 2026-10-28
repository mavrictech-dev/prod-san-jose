import { checkHistoricalOriginal, type HistoricalOriginal, type HistoricalOriginalStore } from './historical-original-contract';

/** Candidate only: inject a private PostgreSQL pool; no connection or runtime registration. */
export interface HistoricalOriginalPg {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
const validHandle = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v);

export class PostgresHistoricalOriginalStore implements HistoricalOriginalStore {
  constructor(private readonly db: HistoricalOriginalPg) {}

  async insert(value: HistoricalOriginal): Promise<void> {
    if (!value || !validHandle(value.handle)) throw new Error('HISTORICAL_ORIGINAL_INVALID');
    const record = checkHistoricalOriginal(value, value.handle);
    const json = JSON.stringify(record);
    const inserted = await this.db.query(`INSERT INTO public.b2b_historical_original_candidate
      (handle, document_id, version, record_sha256, record)
      VALUES ($1, $2::uuid, $3, $4, $5::jsonb) ON CONFLICT DO NOTHING RETURNING handle`,
      [record.handle, record.member.documentId, record.member.version, record.recordSha256, json]);
    if (inserted.rows.length === 1) return;
    // A second statement observes a committed concurrent winner at READ COMMITTED.
    // Equality of the full JSON as well as both keys prevents aliasing or replacement.
    const existing = await this.db.query(`SELECT handle FROM public.b2b_historical_original_candidate
      WHERE handle = $1 AND document_id = $2::uuid AND version = $3
        AND record_sha256 = $4 AND record = $5::jsonb`,
      [record.handle, record.member.documentId, record.member.version, record.recordSha256, json]);
    if (existing.rows.length !== 1) throw new Error('HISTORICAL_ORIGINAL_CONFLICT');
  }

  async loadExact(handle: string): Promise<HistoricalOriginal | null> {
    if (!validHandle(handle)) throw new Error('HISTORICAL_ORIGINAL_INVALID');
    const result = await this.db.query(`SELECT handle, document_id::text AS document_id, version, record_sha256, record
      FROM public.b2b_historical_original_candidate WHERE handle = $1`, [handle]);
    if (result.rows.length === 0) return null;
    if (result.rows.length !== 1) throw new Error('HISTORICAL_ORIGINAL_INVALID');
    const row = result.rows[0];
    const record = checkHistoricalOriginal(row.record, handle);
    if (row.handle !== record.handle || row.document_id !== record.member.documentId ||
        Number(row.version) !== record.member.version || row.record_sha256 !== record.recordSha256)
      throw new Error('HISTORICAL_ORIGINAL_INVALID');
    return record;
  }
}
