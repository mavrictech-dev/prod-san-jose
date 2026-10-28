import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { historyExport as exported, historyRow as row } from './helpers/history-stage3-fixtures';

const cwd = resolve(import.meta.dirname, '..'), localRequire = createRequire(new URL('../package.json', import.meta.url));
const owned: string[] = [];
function temporary() { const root = fs.mkdtempSync(join(tmpdir(), 'factuez-history-cli-')); owned.push(root); return root; }
afterEach(() => {
  for (const value of owned.splice(0)) {
    expect(dirname(resolve(value))).toBe(resolve(tmpdir()));
    expect(value.split(/[\\/]/).at(-1)).toMatch(/^factuez-history-cli-/);
    fs.rmSync(value, { recursive: true, force: true });
  }
});
beforeAll(() => {
  const result = spawnSync(process.execPath, [localRequire.resolve('typescript/bin/tsc'), '-p', 'migration/tsconfig.preview.json'],
    { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 512 * 1024 });
  expect(result.status, result.stdout || result.stderr).toBe(0);
}, 35000);
function run(args: string[]) { return spawnSync(process.execPath, ['migration/history-bundle-cli.cjs', ...args],
  { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }); }
const fixture = 'migration/fixtures/history-development-bundle.json';
const bundle = 'migration/fixtures/history-bundle';
const flags = ['--dry-run', '--development-only', '--input', fixture];
describe('CLI local de fase 3, sin importación ni persistencia', () => {
  it.each([
    [], ['--apply'], ['--send'], ['--production'], ['--import'], ['--input', fixture],
    ['--dry-run', '--input', fixture], ['--development-only', '--input', fixture],
    [...flags, '--dry-run'], [...flags, '--bundle-root'], [...flags, '--batches', '0'], [...flags, '--batches', '21'],
    [...flags, '--batches', '01'], [...flags, '--batches', '1.5'], [...flags, '--batches', '--full-report'],
    ['--dry-run', '--development-only', '--input', '.env'],
    ['--dry-run', '--development-only', '--input', 'certificate.p12'],
    ['--dry-run', '--development-only', '--input', 'credential.json'],
  ].map(args => ({ args })))('rechaza argumentos inseguros %# sin filtrar datos', ({ args }) => {
    const result = run(args); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ status: 'BLOCKED', persisted: false, simulationOnly: true,
      fiscalWrites: 0, transmission: false, productionBlocked: true });
    expect(result.stderr).not.toContain(cwd); expect(result.stderr).not.toContain('password');
  });
  it('fixture: verifica dos archivos pero siempre requiere revisión fiscal', () => {
    const result = run([...flags, '--bundle-root', bundle]);
    expect(result.status).toBe(3); expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ status: 'REVIEW_REQUIRED',
      rehearsal: { candidateRowCount: 2, complete: true, persisted: false, addedRows: 2, databaseWrites: 0, countersChanged: false },
      bundle: { status: 'BYTES_MATCH_METADATA', fileCount: 2, verifiedFiles: 2, verifiedBytes: 294, cdrAuthenticityVerified: false } });
    expect(report.rehearsal.state).toBeUndefined();
    expect(result.stdout).not.toContain('FIXTURE-HISTORICO');
  });
  it('sin bundle no afirma haber verificado bytes', () => {
    const result = run(flags); expect(result.status).toBe(3);
    expect(JSON.parse(result.stdout).bundle).toBeNull();
  });
  it('full-report expone estado de ensayo, no un checkpoint de PostgreSQL', () => {
    const result = run([...flags, '--full-report']);
    expect(result.status).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.rehearsal.state.records).toHaveLength(2);
    expect(report.rehearsal.checkpointPurpose).toBe('IN_MEMORY_REHEARSAL_NOT_DATABASE_COMMIT');
    expect(report.rehearsal.state.records[0].disposition).toBe('QUARANTINED_PENDING_FISCAL_REVIEW');
  });
  it('reanuda estado serializado sin escribir nuevos archivos', () => {
    const root = temporary(), inputFile = join(root, 'input.json'), stateFile = join(root, 'state.json');
    fs.writeFileSync(inputFile, JSON.stringify(exported(Array.from({ length: 501 }, (_, i) => row(i + 1)))));
    const args = ['--dry-run', '--development-only', '--input', inputFile, '--full-report'];
    const first = run(args); expect(first.status).toBe(3);
    const state = JSON.parse(first.stdout).rehearsal.state;
    expect(state.records).toHaveLength(500); fs.writeFileSync(stateFile, JSON.stringify(state));
    const files = fs.readdirSync(root), bytes = fs.readFileSync(stateFile);
    const second = run([...args, '--rehearsal-state', stateFile]); expect(second.status).toBe(3);
    expect(JSON.parse(second.stdout).rehearsal).toMatchObject({ complete: true, addedRows: 1, candidateRowCount: 501, persisted: false });
    expect(fs.readFileSync(stateFile)).toEqual(bytes); expect(fs.readdirSync(root)).toEqual(files);
  });
  it('bundle incompleto bloquea integridad sin cambiar datos', () => {
    const root = temporary(), files = fs.readdirSync(root);
    const result = run([...flags, '--bundle-root', root]); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout).bundle).toMatchObject({ status: 'BLOCKED', failureCount: 2, verifiedFiles: 0 });
    expect(fs.readdirSync(root)).toEqual(files);
  });
  it('input de producción se rechaza sin leer ningún bundle', () => {
    const inputFile = join(temporary(), 'input.json'); fs.writeFileSync(inputFile, JSON.stringify({ ...exported(), environment: 'PRODUCTION' }));
    const result = run(['--dry-run', '--development-only', '--input', inputFile, '--bundle-root', 'NO_EXISTE']);
    expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).reason).toBe('UNSUPPORTED_VALUE');
  });
  it('metadatos duplicados se clasifican como bloqueo de conciliación', () => {
    const inputFile = join(temporary(), 'input.json'); fs.writeFileSync(inputFile, JSON.stringify(exported([row(), row()])));
    const result = run(['--dry-run', '--development-only', '--input', inputFile, '--bundle-root', 'NO_EXISTE']);
    expect(result.status).toBe(2); expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr).reason).toBe('BLOCKED_METADATA');
  });
  it.each(['truncated', 'extra', 'utf8'])('JSON inválido %s no expone contenido', kind => {
    const inputFile = join(temporary(), 'input.json');
    fs.writeFileSync(inputFile, kind === 'utf8' ? Buffer.from([0xff, 0xfe, 0x00]) : kind === 'extra' ?
      JSON.stringify({ ...exported(), password: 'DO_NOT_EXPOSE' }) : '{"password":"DO_NOT_EXPOSE"');
    const result = run(['--dry-run', '--development-only', '--input', inputFile]);
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('DO_NOT_EXPOSE');
    expect(result.stderr).not.toContain(inputFile);
  });
});
