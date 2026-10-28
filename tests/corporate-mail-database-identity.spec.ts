import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailerDatabaseName, validatedMailerDatabaseUrl } from '../services/mailer-worker/src/mailer-database-identity';
import { CorporateMailStore } from '../services/mailer-worker/src/corporate-mail.store';
import { SmtpConfigurationStore } from '../services/mailer-worker/src/smtp-configuration.store';
beforeEach(() => { vi.stubEnv('MAILER_DATABASE_NAME', 'mailer_production'); vi.stubEnv('DB_NAME', 'mailer_production'); });
afterEach(() => vi.unstubAllEnvs());
describe('identidad explícita de base Mailer para deployment', () => {
  it('admite nombre productivo explícito en ambos stores sin activar envío', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ db: 'mailer_production', configuration: 'found', activation: 'found', job: 'found', audit: 'found' }]) };
    expect(await new CorporateMailStore(db as never).ready()).toBe(true);
    expect(await new SmtpConfigurationStore(db as never).ready()).toBe(true);
    expect(mailerDatabaseName()).toBe('mailer_production');
    expect(validatedMailerDatabaseUrl('postgresql://synthetic:private@db:5432/mailer_production')).toContain('/mailer_production');
  });
  it.each([undefined, '', 'postgres;DROP', 'a/b', 'x'.repeat(64), 'UPPERCASE'])('sin identidad válida %s falla cerrado antes de consultas', async name => {
    if (name === undefined) delete process.env.MAILER_DATABASE_NAME; else vi.stubEnv('MAILER_DATABASE_NAME', name);
    const db = { $queryRaw: vi.fn() };
    expect(await new CorporateMailStore(db as never).ready()).toBe(false);
    expect(await new SmtpConfigurationStore(db as never).ready()).toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled(); expect(() => mailerDatabaseName()).toThrow();
  });
  it('rechaza DB_NAME inconsistente y current_database diferente, incluso QA', async () => {
    vi.stubEnv('DB_NAME', 'billing'); expect(() => mailerDatabaseName()).toThrow();
    vi.stubEnv('DB_NAME', 'mailer_production');
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ db: 'factuez_mailer_qa', configuration: 'found', activation: 'found', job: 'found', audit: 'found' }]) };
    expect(await new CorporateMailStore(db as never).ready()).toBe(false); expect(await new SmtpConfigurationStore(db as never).ready()).toBe(false);
  });
  it.each(['postgresql://synthetic:PRIVATE@db/billing', 'postgresql://synthetic:PRIVATE@db/', 'https://synthetic:PRIVATE@db/mailer_production',
    'postgresql://synthetic:PRIVATE@db/mailer_production?options=-csearch_path%3Dbilling', 'invalid'])('rechaza URL ajena/sin DB/override y no filtra secreto', url => {
    expect(() => validatedMailerDatabaseUrl(url)).toThrow('Conexión de base Mailer no corresponde');
    try { validatedMailerDatabaseUrl(url); } catch (error) { expect(String(error)).not.toContain('PRIVATE'); }
  });
  it('el contrato requiere las tablas; nombre correcto no basta', async () => {
    const db = { $queryRaw: vi.fn().mockResolvedValue([{ db: 'mailer_production', configuration: null, activation: null, job: null, audit: null }]) };
    expect(await new CorporateMailStore(db as never).ready()).toBe(false); expect(await new SmtpConfigurationStore(db as never).ready()).toBe(false);
  });
  it('DDL QA conserva guard fijo y deployment separado exige identidad antes del mismo DDL exacto', () => {
    const qa = readFileSync(new URL('../services/mailer-worker/prisma/corporate-mail-runtime.candidate.sql', import.meta.url), 'utf8');
    const deploy = readFileSync(new URL('../services/mailer-worker/prisma/corporate-mail-runtime.deploy.sql', import.meta.url), 'utf8');
    expect(qa).toContain("current_database() <> 'factuez_mailer_qa'");
    expect(deploy).toContain('expected_mailer_database is required'); expect(deploy).toContain('EXPLICIT_MAILER_DATABASE_IDENTITY_MISMATCH');
    expect(deploy.slice(deploy.indexOf('BEGIN;\nCREATE TABLE'))).toBe(qa.slice(qa.indexOf('BEGIN;\nCREATE TABLE')));
    expect(deploy).not.toMatch(/ALTER TABLE|INSERT INTO "CorporateSmtpActivation"|UPDATE "CorporateSmtpActivation"/);
  });
});
