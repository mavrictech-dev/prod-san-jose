import { describe, it, expect, vi } from 'vitest';
import { PostgresB2bGuideIssueStore } from '../services/identity-service/src/b2b/guide-issue-store';
import type { Sql, TransactionalSql } from '../services/identity-service/src/integration/postgres-store';
import type { Audit, Client } from '../services/identity-service/src/b2b/model';
import { issuePair, allIssueScopes } from './b2b-guide-issue-authority.fixture';
import { binding, id, ctx } from './b2b-identity.fixture';

/** Synthetic transactional SQL port; actual production store and validation run unchanged. */
function fixture() {
  const client: Client = { id: id(90), label: 'SYNTHETIC', kind: 'SERVICE', enabled: true, revision: 1,
    secretHash: '0'.repeat(64), oidcClientId: null, scopes: [...allIssueScopes], bindings: [binding] };
  let state = { revision: 0, rows: [] as any[], audits: [] as Audit[] };
  let physical: any = undefined, queryFailure = false, auditFailure = false, casCount = 1;
  const statements: string[] = [];
  const db: TransactionalSql = {
    $queryRawUnsafe: async <T>() => [] as T, $executeRawUnsafe: async () => 1,
    async $transaction<T>(work: (tx: Sql) => Promise<T>) {
      const copy = structuredClone(state);
      const sql: Sql = {
        async $queryRawUnsafe<T>(query: string) {
          statements.push(query); if (queryFailure) throw new Error('SYNTHETIC_SQL_FAILURE');
          if (query.includes('FROM "B2bClient" WHERE')) return [structuredClone(client)] as T;
          return [physical === undefined ? copy.revision ? { clientId: client.id, headRevision: copy.revision,
            ...copy.rows.at(-1), total: copy.rows.length, last: copy.revision } : { clientId: client.id, headRevision: null,
            clientRevision: null, revision: null, bindings: null, environment: null, total: 0, last: null } : physical] as T;
        },
        async $executeRawUnsafe(query: string, ...values: unknown[]) {
          statements.push(query);
          if (query.includes('INSERT INTO "B2bGuideIssueGrantRevision"')) copy.rows.push({ clientRevision: values[2], revision: values[1], bindings: JSON.parse(values[3] as string), environment: 'BETA' });
          if (query.includes('"B2bGuideIssueGrantHead"')) { copy.revision = values[1] as number; return casCount; }
          if (query.includes('INSERT INTO "B2bAudit"')) {
            if (auditFailure) throw new Error('SYNTHETIC_AUDIT_FAILURE');
            copy.audits.push({ id: values[0], requestId: values[1], clientId: values[2], actorId: values[3], action: values[4], outcome: values[5], revision: values[6], peerHash: values[7], at: values[8] } as Audit);
          }
          return 1;
        },
      };
      const result = await work(sql); state = copy; return result;
    },
  };
  const store = new PostgresB2bGuideIssueStore(db);
  const grant = () => ({ clientId: client.id, clientRevision: 1, revision: 1, bindings: [issuePair()] });
  const audit = (): Audit => ({ id: id(91), requestId: ctx().requestId, peerHash: 'a'.repeat(64), clientId: client.id,
    revision: 1, actorId: id(9), action: 'REPLACE_GUIDE_ISSUE_GRANTS', outcome: 'OK', at: '2026-10-23T00:00:00.000Z' });
  const write = () => store.transaction(async tx => {
    await tx.get(client.id); await tx.guideIssueGrants(client.id);
    await tx.saveGuideIssueGrants(grant(), 0, id(9), audit().at); await tx.audit(audit());
  });
  return { client, store, grant, audit, write, statements, state: () => state,
    corrupt: (value: any) => { physical = value; }, failQuery: () => { queryFailure = true; },
    failAudit: () => { auditFailure = true; }, loseCas: () => { casCount = 0; } };
}
describe('guide issue PostgreSQL transaction validation through a synthetic SQL port', () => {
  it('uses Serializable before reading, persists the exact grant, and reconstructs it across store transactions', async () => {
    const f = fixture(); await f.write();
    expect(f.statements[0]).toBe('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
    expect(f.state().audits).toHaveLength(1);
    const row = await f.store.transaction(async tx => { await tx.get(f.client.id); return tx.guideIssueGrants(f.client.id); });
    expect(row).toEqual(f.grant());
  });
  it('CAS loss and audit failure roll back the inserted revision and head', async () => {
    for (const mode of ['cas', 'audit']) {
      const f = fixture(); if (mode === 'cas') f.loseCas(); else f.failAudit();
      await expect(f.write()).rejects.toMatchObject({ status: mode === 'cas' ? 409 : 503 });
      expect(f.state()).toEqual({ revision: 0, rows: [], audits: [] });
    }
  });
  it('requires the matching replacement audit before committing and poisons a swallowed write failure', async () => {
    const f = fixture();
    await expect(f.store.transaction(async tx => {
      await tx.get(f.client.id); await tx.guideIssueGrants(f.client.id);
      await tx.saveGuideIssueGrants(f.grant(), 0, id(9), f.audit().at);
    })).rejects.toMatchObject({ status: 503 });
    f.loseCas();
    await expect(f.store.transaction(async tx => {
      await tx.get(f.client.id); await tx.guideIssueGrants(f.client.id);
      try { await tx.saveGuideIssueGrants(f.grant(), 0, id(9), f.audit().at); } catch {}
    })).rejects.toMatchObject({ status: 503 });
    expect(f.state().rows).toEqual([]);
  });
  it('poisons swallowed read/client/audit failures and forbids inherited client writes', async () => {
    const f = fixture();
    await expect(f.store.transaction(async tx => { try { await tx.create(f.client); } catch {} })).rejects.toMatchObject({ status: 503 });
    await expect(f.store.transaction(async tx => { try { await tx.save(f.client, 1); } catch {} })).rejects.toMatchObject({ status: 503 });
    f.failQuery();
    await expect(f.store.transaction(async tx => { try { await tx.get(f.client.id); } catch {} })).rejects.toMatchObject({ status: 503 });
    const g = fixture(); g.failAudit();
    await expect(g.store.transaction(async tx => { try { await tx.audit({ ...g.audit(), action: 'AUTHORIZE_GUIDE_ISSUE_READ', outcome: 'DENIED' }); } catch {} })).rejects.toMatchObject({ status: 503 });
  });
  it('refuses broken head, environment, revision, physical JSON and scoping without treating corruption as no grant', async () => {
    const base = { clientId: id(90), headRevision: 1, clientRevision: 1, revision: 1, bindings: [issuePair()], environment: 'BETA', total: 1, last: 1 };
    const getter = vi.fn();
    const badBinding = Object.defineProperty({}, 'draft', { enumerable: true, get: getter });
    for (const patch of [
      { headRevision: null }, { headRevision: 2 }, { clientId: id(99) }, { environment: 'PRODUCTION' }, { total: 2 }, { last: 2 },
      { clientRevision: 2 }, { bindings: '[{"unparsed":true}]' }, { bindings: [badBinding] },
      { bindings: [{ ...issuePair(), draft: { ...issuePair().draft, anchor: { ...binding, pointId: id(99) } } }] },
    ]) {
      const f = fixture(); f.corrupt({ ...base, ...patch });
      await expect(f.store.transaction(async tx => { await tx.get(f.client.id); return tx.guideIssueGrants(f.client.id); })).rejects.toMatchObject({ status: 503 });
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it('refuses malformed client JSON before grants and denies operations after the transaction closes', async () => {
    const f = fixture(); (f.client.scopes as any) = 'b2b:guides:issue';
    await expect(f.store.transaction(tx => tx.get(f.client.id))).rejects.toMatchObject({ status: 503 });
    const g = fixture(); const escaped = await g.store.transaction(async tx => tx);
    await expect(escaped.get(g.client.id)).rejects.toMatchObject({ status: 503 });
  });
});
