import 'reflect-metadata';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorporateMailStore } from '../services/mailer-worker/src/corporate-mail.store';
import { activeGrant, configurationDigest, digest } from '../services/mailer-worker/src/corporate-mail.policy';
import { SmtpConfigurationStore } from '../services/mailer-worker/src/smtp-configuration.store';
const { withPwaCorporateDatabase } = createRequire(import.meta.url)('./corporate-mail-runtime-db.fixture.cjs');
function prisma(pool: any) {
  const port = (connection: any) => ({
    $queryRaw: async (parts: TemplateStringsArray, ...values: any[]) => (await connection.query(parts.map((p, i) => p + (i < values.length ? '$' + (i + 1) : '')).join(''), values)).rows,
    $executeRaw: async (parts: TemplateStringsArray, ...values: any[]) => (await connection.query(parts.map((p, i) => p + (i < values.length ? '$' + (i + 1) : '')).join(''), values)).rowCount,
  });
  return { ...port(pool), $transaction: async (action: (tx: any) => unknown) => {
    const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query("SET LOCAL statement_timeout='5s'"); const result = await action(port(client)); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  } };
}
beforeEach(() => { vi.stubEnv('MAILER_DATABASE_NAME', 'factuez_mailer_qa'); vi.stubEnv('DB_NAME', 'factuez_mailer_qa'); });
afterEach(() => vi.unstubAllEnvs());
describe('SQL corporativo PWA en PostgreSQL NUEVO tmpfs sin puertos ni red externa', () => {
  it('ensaya CAS, rollback, aislamiento RUC, idempotencia, claim único, caducidad, auditoría y concurrencia real', async () => {
    await withPwaCorporateDatabase(async ({ pool, secondPool, sql }: any) => {
      const a = prisma(pool), b = prisma(secondPool), store = new CorporateMailStore(a as never), second = new CorporateMailStore(b as never);
      expect(await store.ready()).toBe(true);
      expect((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map((r: any) => r.tablename))
        .toEqual(['CorporateMailAudit', 'CorporateMailTestJob', 'CorporateSmtpActivation', 'CorporateSmtpConfiguration', 'CorporateSmtpConfigurationAudit']);
      const actor = randomUUID(), issuer = { companyId: 1, ruc: '00000000001' };
      const configStore = new SmtpConfigurationStore(a as never), configSecond = new SmtpConfigurationStore(b as never);
      const row = await configStore.save(issuer, { cipher: 'v1.1.QQ.QQ.QQ', keyVersion: 1 }, 0, actor, true);
      // CAS competing administrators: exactly one grant and one audit row.
      const activations = await Promise.allSettled([store.setActivation(row, actor, 0, true), second.setActivation(row, actor, 0, true)]);
      expect(activations.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(activations.filter(r => r.status === 'rejected')).toHaveLength(1);
      const grant = await store.activation(issuer); expect(activeGrant(grant, row)).toBe(true);
      expect(await store.activation({ companyId: 2, ruc: issuer.ruc })).toBeNull();
      expect(await store.activation({ companyId: 2, ruc: '00000000002' })).toBeNull();
      await expect(store.setActivation({ ...row, revision: 2 }, actor, 1, true)).rejects.toMatchObject({ status: 409 });
      const create = (key = randomUUID(), body = 'same') => ({ row, actorId: actor, activationRevision: 1, id: randomUUID(),
        idempotencyHash: digest(key), requestHash: digest(body), payloadCipher: 'encrypted-synthetic-no-plaintext' });
      const input = create();
      const [one, duplicate] = await Promise.all([store.enqueue(input), second.enqueue({ ...input, id: randomUUID() })]);
      expect(one.id).toBe(duplicate.id);
      await expect(store.enqueue({ ...input, id: randomUUID(), requestHash: digest('different') })).rejects.toMatchObject({ status: 409 });
      const claims = await Promise.all([store.claim(one.id), second.claim(one.id)]); expect(claims.filter(Boolean)).toHaveLength(1);
      expect(await store.transition(one.id, 'PREPARING', 'SENDING')).toBe(true);
      expect(await second.transition(one.id, 'PREPARING', 'SENDING')).toBe(false);
      expect(await store.transition(one.id, 'SENDING', 'HANDED_OFF')).toBe(true);
      expect(await store.claim(one.id)).toBeNull(); expect(await store.get(one.id)).toMatchObject({ state: 'HANDED_OFF', payloadCipher: null });
      const history = await store.history(issuer); expect(JSON.stringify(history.events)).not.toMatch(/encrypted|recipient|password|Bearer|cipher/i);
      expect(history.events.map(e => e.event)).toEqual(expect.arrayContaining(['ACTIVATED', 'QUEUED', 'PREPARING', 'SENDING', 'HANDED_OFF']));
      // Disable grant; no task can be admitted using the old authorization.
      const revoked = await second.setActivation(row, actor, 1, false); expect(revoked.revision).toBe(2);
      await expect(store.enqueue(create())).rejects.toMatchObject({ status: 409 });
      await store.setActivation(row, actor, 2, true);
      // Configuration CAS and activation share the same advisory lock. New revision invalidates old grant.
      const updated = await configSecond.save(issuer, { cipher: 'v1.1.Qg.Qg.Qg', keyVersion: 1 }, 1, actor, true);
      expect(activeGrant(await store.activation(issuer), updated)).toBe(false);
      await expect(store.setActivation(row, actor, 3, true)).rejects.toMatchObject({ status: 409 });
      await expect(store.enqueue({ ...create(), activationRevision: 3 })).rejects.toMatchObject({ status: 409 });
      await store.setActivation(updated, actor, 3, true);
      // Persistent rate limit under two concurrent DB clients, not just one process counter.
      const admitted = await Promise.allSettled(Array.from({ length: 5 }, (_, n) => (n % 2 ? store : second).enqueue({ ...create(), row: updated, activationRevision: 4 })));
      expect(admitted.filter(r => r.status === 'fulfilled')).toHaveLength(2); // first job already counted in this minute
      expect(admitted.filter(r => r.status === 'rejected')).toHaveLength(3);
      const pending = await store.pending(); expect(pending).toHaveLength(2);
      const preparing = pending[0].id, sending = pending[1].id;
      await store.claim(preparing); await store.claim(sending); await store.transition(sending, 'PREPARING', 'SENDING');
      // Move synthetic timestamps only, in this newly created disposable database.
      await pool.query('UPDATE "CorporateMailTestJob" SET "createdAt"=CURRENT_TIMESTAMP-interval \'3 minutes\', "expiresAt"=CURRENT_TIMESTAMP-interval \'1 minute\' WHERE id=ANY($1::uuid[])', [[preparing, sending]]);
      await store.expire();
      expect(await store.get(preparing)).toMatchObject({ state: 'CANCELLED', payloadCipher: null });
      expect(await store.get(sending)).toMatchObject({ state: 'UNKNOWN', payloadCipher: null });
      expect(await store.pending()).toHaveLength(0);
      // DDL is additive/reentrant and does not rewrite existing configuration data.
      const { readFileSync } = await import('node:fs');
      sql(readFileSync(new URL('../services/mailer-worker/prisma/corporate-mail-runtime.candidate.sql', import.meta.url), 'utf8'));
      expect((await configStore.read(issuer))?.revision).toBe(2);
      expect((await pool.query('SELECT COUNT(*)::integer AS count FROM "CorporateMailTestJob"')).rows[0].count).toBe(3);
      // The database CHECK denies terminal payload retention.
      await expect(pool.query('UPDATE "CorporateMailTestJob" SET "payloadCipher"=$2 WHERE id=$1', [one.id, 'never-retain'])).rejects.toMatchObject({ code: '23514' });
    });
  });
});
