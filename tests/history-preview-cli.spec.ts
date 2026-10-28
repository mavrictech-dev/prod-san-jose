import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const cwd = resolve(import.meta.dirname, '..');
const localRequire = createRequire(new URL('../package.json', import.meta.url));
beforeAll(() => {
  const result = spawnSync(process.execPath, [localRequire.resolve('typescript/bin/tsc'), '-p', 'migration/tsconfig.preview.json'],
    { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 512 * 1024 });
  expect(result.status, result.stdout || result.stderr).toBe(0);
}, 35000);
function run(args: string[]) { return spawnSync(process.execPath, ['migration/history-preview-cli.cjs', ...args],
  { cwd, encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 512 * 1024 }); }
describe('CLI histórico development/dry-run sin importación', () => {
  it.each([[], ['--apply'], ['--send'], ['--dry-run', '--input', 'migration/fixtures/history-development.json'],
    ['--dry-run', '--development-only', '--input', '.env'], ['--dry-run', '--development-only', '--input', 'credential.json'],
    ['--dry-run', '--development-only', '--development-only', '--input', 'migration/fixtures/history-development.json']].map(args => ({ args })))('rechaza argumentos inseguros %# sin exponer archivos', ({ args }) => {
    const result = run(args); expect(result.status).toBe(1); const message = JSON.parse(result.stderr);
    expect(message).toMatchObject({ status: 'BLOCKED', dryRun: true, fiscalWrites: 0, transmission: false, productionBlocked: true });
    expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('password');
  });
  it('fixture ficticio requiere revisión y no genera outbox/reserva', () => {
    const result = run(['--dry-run', '--development-only', '--input', 'migration/fixtures/history-development.json']);
    expect(result.status).toBe(3); const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ status: 'REVIEW_REQUIRED', rowCount: 2, fiscalWrites: 0, transmission: false,
      reviewCount: 2, artifacts: { rowsRequiringCdrReview: 2, assessment: 'DECLARED_METADATA_ONLY_NOT_VERIFIED' } });
    expect(result.stderr).toBe(''); expect(result.stdout).not.toContain('nextNumber');
  });
});
