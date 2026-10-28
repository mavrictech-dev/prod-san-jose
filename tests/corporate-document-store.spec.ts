import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CorporateDocumentStore } from '../services/mailer-worker/src/corporate-document-store';
import { digest } from '../services/mailer-worker/src/corporate-mail.policy';
import { documentConfigurationDigest as configurationDigest } from '../services/mailer-worker/src/corporate-document-policy';
import { documentIssuer, documentActor } from './corporate-document.fixture';
const row = { ...documentIssuer, revision: 1, keyVersion: 1, configurationCipher: 'v1.1.synthetic.cipher', updatedAt: new Date() };
const grant = { companyId: 1, issuerRuc: documentIssuer.ruc, enabled: true, revision: 1, configurationRevision: 1, configurationDigest: configurationDigest(row) };
function fixture() {
  const tx = { $queryRaw: vi.fn(), $executeRaw: vi.fn(async () => 1) };
  const db = { $queryRaw: vi.fn(async () => [{ db: 'mailer_deployment', activation: 'yes', job: 'yes', audit: 'yes' }]),
    $transaction: vi.fn(async (action: any) => action(tx)) };
  return { tx, db, store: new CorporateDocumentStore(db as never) };
}
beforeEach(() => { vi.stubEnv('MAILER_DATABASE_NAME', 'mailer_deployment'); vi.stubEnv('DB_NAME', 'mailer_deployment'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('persistencia DOCUMENT aditiva e independiente', () => {
  it('DDL nuevo sólo crea tres tablas DOCUMENT, guard explícito y payload expirable; no cambia TEST', () => {
    const sql = readFileSync(new URL('../services/mailer-worker/prisma/corporate-document-runtime.deploy.sql', import.meta.url), 'utf8');
    expect(sql.match(/CREATE TABLE IF NOT EXISTS/g)).toHaveLength(3); expect(sql.match(/^COMMIT;/gm)).toHaveLength(1);
    for (const table of ['CorporateDocumentActivation', 'CorporateDocumentJob', 'CorporateDocumentAudit']) expect(sql).toContain('CREATE TABLE IF NOT EXISTS "' + table + '"');
    expect(sql).toContain('expected_mailer_database is required'); expect(sql).toContain('EXPLICIT_MAILER_DATABASE_IDENTITY_MISMATCH');
    expect(sql).toContain('"documentProof" char(64) NOT NULL CHECK ("documentProof" ~ \'^[a-f0-9]{64}$\'),');
    expect(sql).toContain("interval '2 minutes'"); expect(sql).toContain('"payloadCipher" IS NULL');
    expect(sql).not.toMatch(/ALTER TABLE|INSERT INTO|CorporateMailTestJob|CorporateSmtpActivation|COPY.*FROM/);
    const baseline = readFileSync(new URL('../services/mailer-worker/prisma/corporate-mail-runtime.candidate.sql', import.meta.url), 'utf8');
    expect(digest(baseline)).toBe('930b7be5214f443d20072eb5bcac140edbee0a4888c36a0e7685ee459e534439');
  });
  it('identidad de DB y contrato de tablas requerido; sin configuración no consulta', async () => {
    const f = fixture(); expect(await f.store.ready()).toBe(true);
    expect(f.db.$queryRaw.mock.calls[0][0].join('')).toContain('CorporateDocumentActivation');
    vi.stubEnv('MAILER_DATABASE_NAME', 'other'); expect(await f.store.ready()).toBe(false);
  });
  it('CAS DOCUMENT comparte lock de configuración pero escribe sólo su autorización/auditoría', async () => {
    const f = fixture(); f.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValueOnce([]).mockResolvedValueOnce([grant]);
    expect(await f.store.setActivation(row, documentActor, 0, true)).toEqual(grant);
    const calls = f.tx.$queryRaw.mock.calls;
    expect(calls[0][0].join('')).toContain('pg_advisory_xact_lock'); expect(calls[0][1]).toBe('smtp-config:' + documentIssuer.ruc);
    expect(calls[1][0].join('')).toContain('FOR SHARE'); expect(calls[3][0].join('')).toContain('INSERT INTO "CorporateDocumentActivation"');
    expect(f.tx.$executeRaw.mock.calls[0][0].join('')).toContain('CorporateDocumentAudit');
    expect(JSON.stringify(f.tx.$executeRaw.mock.calls)).not.toMatch(/recipient@|Bearer|cipher|PRIVATE/);
  });
  it('revisión o huella de configuración cambiada no concede grant', async () => {
    const f = fixture(); f.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...row, configurationCipher: 'v1.1.changed.cipher' }]);
    await expect(f.store.setActivation(row, documentActor, 0, true)).rejects.toMatchObject({ status: 409 }); expect(f.tx.$executeRaw).not.toHaveBeenCalled();
    const g = fixture(); g.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValueOnce([grant]);
    await expect(g.store.setActivation(row, documentActor, 0, true)).rejects.toMatchObject({ status: 409 }); expect(g.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('encola ID/documento/formato/proof con consultas parametrizadas y rate locks persistentes', async () => {
    const f = fixture(), id = randomUUID(), documentId = randomUUID();
    const input = { row, actorId: documentActor, activationRevision: 1, id, documentId, format: 'a4' as const, documentProof: 'a'.repeat(64), idempotencyHash: 'b'.repeat(64), requestHash: 'c'.repeat(64), payloadCipher: 'encrypted-private' };
    f.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValueOnce([grant]).mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ actor: 0, issuer: 0 }]).mockResolvedValueOnce([{ ...input, state: 'QUEUED' }]);
    await f.store.enqueue(input);
    const insert = f.tx.$queryRaw.mock.calls.at(-1)!;
    expect(insert[0].join('')).toContain('"documentId", format, "documentProof"');
    expect(insert).toContain(documentId); expect(insert).toContain('a4'); expect(insert).toContain('a'.repeat(64));
    expect(insert[0].join('')).not.toContain(documentId);
    expect(f.tx.$queryRaw.mock.calls[0][1]).toBe('smtp-document-actor:' + documentActor);
    expect(JSON.stringify(f.tx.$executeRaw.mock.calls)).not.toContain('encrypted-private');
  });
  it('ausencia de grant DOCUMENT no acepta TEST, rate limit deniega y idempotencia evita duplicar', async () => {
    const input = { row, actorId: documentActor, activationRevision: 1, id: randomUUID(), documentId: randomUUID(), format: 'a4' as const,
      documentProof: 'a'.repeat(64), idempotencyHash: 'b'.repeat(64), requestHash: 'c'.repeat(64), payloadCipher: 'encrypted' };
    const f = fixture(); f.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValueOnce([]);
    await expect(f.store.enqueue(input)).rejects.toMatchObject({ status: 409 });
    const g = fixture(); g.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValueOnce([grant]).mockResolvedValueOnce([{ ...input, id: 'existing' }]);
    expect((await g.store.enqueue(input)).id).toBe('existing'); expect(g.tx.$executeRaw).not.toHaveBeenCalled();
    const h = fixture(); h.tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([row]).mockResolvedValueOnce([grant]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ actor: 6, issuer: 0 }]);
    await expect(h.store.enqueue(input)).rejects.toMatchObject({ status: 429 }); expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });
  it('claim/transición CAS no puede reiniciar envío terminal; cierre elimina payload y no persiste errores', async () => {
    const f = fixture(); f.tx.$queryRaw.mockResolvedValueOnce([{ ...row, issuerRuc: row.ruc, actorId: documentActor, configurationRevision: 1, activationRevision: 1, state: 'UNKNOWN' }]);
    await f.store.transition(randomUUID(), 'SENDING', 'UNKNOWN');
    expect(f.tx.$queryRaw.mock.calls[0][0].join('')).toContain('"payloadCipher" = CASE WHEN');
    expect(f.tx.$queryRaw.mock.calls[0]).toContain(true);
    expect(() => f.store.transition(randomUUID(), 'SENDING', 'QUEUED')).toThrow();
  });
});
