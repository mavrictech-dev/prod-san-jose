import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// PostgreSQL in memory, already bundled locally. No network, Docker, data directory,
// credentials, installed migrations or connection to any existing database.
const require = createRequire(import.meta.url);
const store = fileURLToPath(new URL('../node_modules/.pnpm/', import.meta.url));
const local = readdirSync(store).find(name => /^@electric-sql\+pglite@/.test(name));
if (!local) throw new Error('Bundled in-memory PostgreSQL is required');
const { PGlite } = require(join(store, local, 'node_modules', '@electric-sql', 'pglite'));
const sql = readFileSync(new URL('../services/billing-service/prisma/branch-establishment-expand.sql', import.meta.url), 'utf8');
const check = `CHECK ("establishmentCode" IS NULL OR "establishmentCode" ~ '^[0-9]{4}$')`;
let db: any;
const rows = async (query: string) => (await db.query(query)).rows;
const snapshot = () => rows(`SELECT to_jsonb(b) - 'establishmentCode' AS record FROM public."Branch" b ORDER BY id`);

beforeAll(async () => { db = new PGlite(); await db.waitReady; }, 30000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`CREATE TABLE public."Branch" (id integer PRIMARY KEY, "companyId" integer, name text);
    INSERT INTO public."Branch" VALUES (1, 7, 'SYNTHETIC BRANCH');
    CREATE TABLE public."Document" (id integer, "immutableSnapshot" jsonb);
    INSERT INTO public."Document" VALUES (1, '{"issuer":{"establishmentCode":"0099"}}');
    CREATE TABLE public."SeriesCounter" (id integer, "nextNumber" bigint);
    INSERT INTO public."SeriesCounter" VALUES (1, 87654321);`);
});
afterEach(async () => {
  await db.exec('ROLLBACK; DROP TABLE IF EXISTS public."Branch", public."Document", public."SeriesCounter";');
});

describe('Expansión SQL idempotente estricta de Branch.establishmentCode', () => {
  it('ejecuta dos veces, conserva filas/historial/contadores y deja null sin inventar código', async () => {
    const before = await snapshot();
    const history = await rows('SELECT * FROM public."Document"');
    const counters = await rows('SELECT * FROM public."SeriesCounter"');
    await db.exec(sql); await db.exec(sql);
    expect(await snapshot()).toEqual(before);
    expect(await rows('SELECT * FROM public."Document"')).toEqual(history);
    expect(await rows('SELECT * FROM public."SeriesCounter"')).toEqual(counters);
    expect(await rows('SELECT "establishmentCode" FROM public."Branch"')).toEqual([{ establishmentCode: null }]);
    expect(await rows(`SELECT count(*)::integer AS checks FROM pg_catalog.pg_constraint WHERE conrelid='public."Branch"'::regclass AND conname='Branch_establishmentCode_check' AND contype='c' AND convalidated`)).toEqual([{ checks: 1 }]);
    expect(await rows(`SELECT data_type, character_maximum_length, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name='Branch' AND column_name='establishmentCode'`)).toEqual([
      { data_type: 'character varying', character_maximum_length: 4, is_nullable: 'YES', column_default: null },
    ]);
  });
  it('conserva código existente y ceros iniciales al repetir, y completa un CHECK faltante', async () => {
    await db.exec(`ALTER TABLE public."Branch" ADD COLUMN "establishmentCode" varchar(4);
      UPDATE public."Branch" SET "establishmentCode" = '0042';`);
    await db.exec(sql); await db.exec(sql);
    expect(await rows('SELECT "establishmentCode" FROM public."Branch"')).toEqual([{ establishmentCode: '0042' }]);
  });
  it.each(['text', 'varchar', 'varchar(5)', 'char(4)', 'varchar(4) NOT NULL', "varchar(4) DEFAULT '0099'", "varchar(4) DEFAULT NULL", "varchar(4) GENERATED ALWAYS AS ('0042') STORED"])(
    'rechaza columna incompatible sin repararla ni añadir constraints: %s', async definition => {
      await db.exec('DELETE FROM public."Branch"');
      await db.exec(`ALTER TABLE public."Branch" ADD COLUMN "establishmentCode" ${definition}`);
      const before = await rows(`SELECT format_type(atttypid,atttypmod) AS type, attnotnull, atthasdef, attgenerated FROM pg_catalog.pg_attribute WHERE attrelid='public."Branch"'::regclass AND attname='establishmentCode'`);
      await expect(db.exec(sql)).rejects.toThrow('Billing baseline mismatch: Branch.establishmentCode');
      await db.exec('ROLLBACK');
      expect(await rows(`SELECT format_type(atttypid,atttypmod) AS type, attnotnull, atthasdef, attgenerated FROM pg_catalog.pg_attribute WHERE attrelid='public."Branch"'::regclass AND attname='establishmentCode'`)).toEqual(before);
      expect(await rows(`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid='public."Branch"'::regclass AND conname='Branch_establishmentCode_check'`)).toEqual([]);
    },
  );
  it.each([
    `${check} NOT VALID`,
    `${check} NO INHERIT`,
    `CHECK ("establishmentCode" IS NULL OR "establishmentCode" ~ '^[0-9]{3,4}$')`,
    `CHECK ("establishmentCode" IS NULL OR "establishmentCode" ~ '^[0-9]{4}')`,
    `CHECK ("establishmentCode" IS NULL OR "establishmentCode" ~ '^[0-9]{4}($)')`,
    `CHECK ("establishmentCode" IS NULL OR "establishmentCode" ~ '^[0-9]{4}$ ')`,
    `CHECK ("establishmentCode" IS NULL OR name <> '')`,
    'UNIQUE ("establishmentCode")',
  ])('rechaza constraint incompatible, conserva definición y validación: %s', async definition => {
    await db.exec(`ALTER TABLE public."Branch" ADD COLUMN "establishmentCode" varchar(4);
      ALTER TABLE public."Branch" ADD CONSTRAINT "Branch_establishmentCode_check" ${definition}`);
    const query = `SELECT pg_get_constraintdef(oid) AS definition, convalidated FROM pg_catalog.pg_constraint WHERE conrelid='public."Branch"'::regclass AND conname='Branch_establishmentCode_check'`;
    const before = await rows(query);
    await expect(db.exec(sql)).rejects.toThrow('Billing baseline mismatch: Branch_establishmentCode_check');
    await db.exec('ROLLBACK');
    expect(await rows(query)).toEqual(before);
    expect(await rows('SELECT "establishmentCode" FROM public."Branch"')).toEqual([{ establishmentCode: null }]);
  });
  it('datos inválidos hacen fallar ADD CHECK sin corregir filas ni esconder el error', async () => {
    await db.exec(`ALTER TABLE public."Branch" ADD COLUMN "establishmentCode" varchar(4);
      UPDATE public."Branch" SET "establishmentCode"='BAD';`);
    await expect(db.exec(sql)).rejects.toMatchObject({ code: '23514' });
    await db.exec('ROLLBACK');
    expect(await rows('SELECT "establishmentCode" FROM public."Branch"')).toEqual([{ establishmentCode: 'BAD' }]);
    expect(await rows(`SELECT conname FROM pg_catalog.pg_constraint WHERE conrelid='public."Branch"'::regclass AND conname='Branch_establishmentCode_check'`)).toEqual([]);
  });
  it.each(['123', '12a4', '１２３４', '', '0042\n'])('CHECK real rechaza %j después de expandir', async value => {
    await db.exec(sql);
    await expect(db.query('UPDATE public."Branch" SET "establishmentCode"=$1 WHERE id=1', [value])).rejects.toThrow();
    expect(await rows('SELECT "establishmentCode" FROM public."Branch"')).toEqual([{ establishmentCode: null }]);
  });
  it('incluye transacción y tiempos acotados; no silencia excepciones', () => {
    expect(sql).toMatch(/BEGIN;/);
    expect(sql).toContain("SET LOCAL lock_timeout = '5s';");
    expect(sql).toContain("SET LOCAL statement_timeout = '15s';");
    expect(sql).toContain('LOCK TABLE public."Branch" IN ACCESS EXCLUSIVE MODE;');
    expect(sql.trim()).toMatch(/COMMIT;$/);
    expect(sql).not.toMatch(/EXCEPTION\s+WHEN/i);
  });
});
