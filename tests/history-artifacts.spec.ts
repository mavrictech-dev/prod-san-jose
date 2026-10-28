import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { buildHistoryArtifactPlan, HISTORY_BUNDLE_LIMITS as limits, verifyHistoryArtifactBundle } from '../migration/history-artifacts';
import { historyExport as exported, historyRow as row, cloneHistory as clone } from './helpers/history-stage3-fixtures';
import type { HistoryArtifactKind } from '../migration/history-preview';

const owned: string[] = [];
function directory() { const value = fs.mkdtempSync(join(tmpdir(), 'factuez-history-stage3-')); owned.push(value); return value; }
afterEach(() => {
  vi.restoreAllMocks();
  for (const value of owned.splice(0)) {
    // Cleanup ONLY test-created, resolved directories, never a caller's root.
    expect(dirname(resolve(value))).toBe(resolve(tmpdir()));
    expect(value.split(/[\\/]/).at(-1)).toMatch(/^factuez-history-stage3-/);
    fs.rmSync(value, { recursive: true, force: true });
  }
});
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(kind: HistoryArtifactKind = 'CDR_XML', content = '<Ficticio>SIN VALIDEZ FISCAL. SOLO BYTES.</Ficticio>\n') {
  const work = directory(), root = join(work, 'bundle'); fs.mkdirSync(root);
  const bytes = Buffer.from(content);
  const name = `ficticio.${kind.endsWith('_XML') ? 'xml' : kind.startsWith('PDF_') ? 'pdf' : 'zip'}`;
  const input = exported([row(1, { artifacts: [{ kind, originalName: name, sizeBytes: bytes.length, sha256: digest(bytes) }] })]);
  const target = join(root, ...buildHistoryArtifactPlan(input).tasks[0].relativePath.split('/'));
  fs.mkdirSync(dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
  return { work, root, target, input, bytes };
}
describe('fase 3: verificación de integridad de bundle, readonly', () => {
  it.each(['UNSIGNED_XML', 'SIGNED_XML', 'CDR_XML', 'CDR_ZIP', 'SUBMISSION_ZIP', 'PDF_TICKET_80MM', 'PDF_A4', 'DELIVERY_ZIP'] as const)
    ('%s: sólo hash/tamaño, sin inferir validez del contenido', kind => {
      const f = fixture(kind), before = fs.statSync(f.target);
      const report = verifyHistoryArtifactBundle(f.input, f.root);
      expect(report).toMatchObject({ status: 'BYTES_MATCH_METADATA', environment: 'BETA', readonly: true,
        productionBlocked: true, databaseWrites: 0, fiscalWrites: 0, artifactCopies: 0, transmission: false,
        certificateAccess: false, cdrAuthenticityVerified: false, fileCount: 1, verifiedFiles: 1, failureCount: 0,
        declaredBytes: f.bytes.length, verifiedBytes: f.bytes.length });
      expect(fs.readFileSync(f.target)).toEqual(f.bytes);
      expect(fs.statSync(f.target).mtimeMs).toBe(before.mtimeMs);
      expect(Object.isFrozen(report.byCode)).toBe(true);
      expect(JSON.stringify(report)).not.toContain(f.root);
    });
  it('sin artefactos no declara verificación realizada', () => {
    const root = directory();
    expect(verifyHistoryArtifactBundle(exported([row(1, { artifacts: [] })]), root)).toMatchObject({
      status: 'NO_ARTIFACTS_TO_VERIFY', verifiedFiles: 0, verifiedBytes: 0, cdrAuthenticityVerified: false });
  });
  it('plan determinista, separado de reanudación y ligado al metadata completo', () => {
    const input = exported([row(2), row(1)]), first = buildHistoryArtifactPlan(input);
    expect(buildHistoryArtifactPlan(exported([...input.rows].reverse())).planSha256).toBe(first.planSha256);
    expect(first.tasks[0].relativePath).toBe('00000000000/03/BQ01/1/CDR_XML/ficticio.xml');
    const changed = clone(input); (changed.rows[0] as any).originId = 'OTRO';
    expect(buildHistoryArtifactPlan(changed).planSha256).not.toBe(first.planSha256);
    expect(Object.isFrozen(first.tasks[0])).toBe(true);
  });
  it('detecta archivo faltante sin exponer su ruta absoluta', () => {
    const f = fixture(); fs.unlinkSync(f.target);
    const report = verifyHistoryArtifactBundle(f.input, f.root);
    expect(report).toMatchObject({ status: 'BLOCKED', verifiedFiles: 0, failureCount: 1, byCode: { ARTIFACT_MISSING: 1 } });
    expect(JSON.stringify(report)).not.toContain(f.root);
  });
  it('detecta tamaño distinto antes de leer', () => {
    const f = fixture(); fs.writeFileSync(f.target, 'DIFERENTE');
    expect(verifyHistoryArtifactBundle(f.input, f.root).byCode).toEqual({ ARTIFACT_SIZE_MISMATCH: 1 });
  });
  it('detecta hash distinto con igual tamaño', () => {
    const f = fixture(); fs.writeFileSync(f.target, Buffer.alloc(f.bytes.length, 65));
    expect(verifyHistoryArtifactBundle(f.input, f.root)).toMatchObject({ status: 'BLOCKED', byCode: { ARTIFACT_HASH_MISMATCH: 1 }, verifiedFiles: 0 });
  });
  it.each(['a.p12', 'a.pfx', '.env', 'a.key', 'a.pem', 'a.zip', 'password.xml', 'certificado.xml', 'credential.xml', '../a.xml', 'a.xml:stream', 'CON.xml'])
    ('rechaza nombre %s antes de tocar el bundle', name => {
      const input = exported([row(1, { artifacts: [{ ...row().artifacts[0], originalName: name }] })]);
      expect(() => verifyHistoryArtifactBundle(input, 'ROOT_THAT_DOES_NOT_EXIST')).toThrow();
      expect(() => buildHistoryArtifactPlan(input)).toThrow();
    });
  it.each(['', ' http://invalid ', 'https://invalid', '\\\\server\\share', '//server/share', '\0', ' root '])
    ('rechaza raíz no local o inválida %#', root => {
      expect(() => verifyHistoryArtifactBundle(exported(), root)).toThrow(/INVALID_BUNDLE_ROOT/);
    });
  it('raíz inexistente falla con mensaje sanitizado', () => {
    expect(() => verifyHistoryArtifactBundle(exported(), join(directory(), 'absent'))).toThrow(/UNSAFE_BUNDLE_ROOT/);
  });
  it('raíz archivo no es directorio válido', () => {
    const f = fixture(); expect(() => verifyHistoryArtifactBundle(f.input, f.target)).toThrow(/UNSAFE_BUNDLE_ROOT/);
  });
  it('bloquea junction/enlace de raíz sin leer destino', () => {
    const f = fixture(), link = join(f.work, 'linked'); fs.symlinkSync(f.root, link, 'junction');
    expect(() => verifyHistoryArtifactBundle(f.input, link)).toThrow(/UNSAFE_BUNDLE_ROOT/);
    expect(fs.readFileSync(f.target)).toEqual(f.bytes);
  });
  it('bloquea junction de directorio intermedio', () => {
    const f = fixture(), ownIssuerDir = join(f.root, '00000000000'), moved = join(f.work, 'alternate');
    fs.renameSync(ownIssuerDir, moved); fs.symlinkSync(moved, ownIssuerDir, 'junction');
    expect(verifyHistoryArtifactBundle(f.input, f.root)).toMatchObject({ status: 'BLOCKED', verifiedFiles: 0,
      byCode: { UNSAFE_BUNDLE_PATH: 1 } });
    expect(fs.readFileSync(join(moved, '03/BQ01/1/CDR_XML/ficticio.xml'))).toEqual(f.bytes);
  });
  it('bloquea hard links al archivo', () => {
    const f = fixture(); fs.linkSync(f.target, join(f.work, 'linked.xml'));
    expect(verifyHistoryArtifactBundle(f.input, f.root).byCode).toEqual({ UNSAFE_BUNDLE_PATH: 1 });
  });
  it('bloquea directorio donde debería haber un archivo', () => {
    const f = fixture(); fs.unlinkSync(f.target); fs.mkdirSync(f.target);
    expect(verifyHistoryArtifactBundle(f.input, f.root).byCode).toEqual({ UNSAFE_BUNDLE_PATH: 1 });
  });
  it('datos BLOCKED se rechazan antes de I/O', () => {
    expect(() => verifyHistoryArtifactBundle(exported([row(), row()]), 'ROOT_THAT_DOES_NOT_EXIST')).toThrow(/BLOCKED_METADATA/);
  });
  it.each(['PRODUCTION', 'production', 'TEST'])('rechaza ambiente %s', environment => {
    expect(() => buildHistoryArtifactPlan({ ...exported(), environment })).toThrow();
  });
  it('limita tamaño individual antes de I/O', () => {
    const input = exported([row(1, { artifacts: [{ ...row().artifacts[0], sizeBytes: limits.maxFileBytes + 1 }] })]);
    expect(() => verifyHistoryArtifactBundle(input, 'NO_EXISTE')).toThrow(/ARTIFACT_READ_LIMIT/);
  });
  it('limita bytes agregados antes de I/O', () => {
    const input = exported(Array.from({ length: 9 }, (_, i) => row(i + 1, {
      artifacts: [{ ...row().artifacts[0], sizeBytes: limits.maxFileBytes }] })));
    expect(() => verifyHistoryArtifactBundle(input, 'NO_EXISTE')).toThrow(/BUNDLE_READ_LIMIT/);
  });
  it('limita cantidad de archivos antes de I/O', () => {
    const input = exported(Array.from({ length: limits.maxFiles + 1 }, (_, i) => row(i + 1)));
    expect(() => verifyHistoryArtifactBundle(input, 'NO_EXISTE')).toThrow(/BUNDLE_READ_LIMIT/);
  });
  it('diagnósticos acotados conservan conteo completo de errores', () => {
    const input = exported(Array.from({ length: 101 }, (_, i) => row(i + 1)));
    const report = verifyHistoryArtifactBundle(input, directory());
    expect(report).toMatchObject({ failureCount: 101, truncated: true, byCode: { ARTIFACT_MISSING: 101 } });
    expect(report.examples).toHaveLength(100);
  });
  it('lectura por chunks comprueba todo el archivo, no sólo la cabecera', () => {
    const f = fixture('CDR_XML', 'X'.repeat(limits.chunkBytes * 2 + 17));
    expect(verifyHistoryArtifactBundle(f.input, f.root).verifiedBytes).toBe(f.bytes.length);
    const bytes = Buffer.from(f.bytes); bytes[bytes.length - 1] = 65; fs.writeFileSync(f.target, bytes);
    expect(verifyHistoryArtifactBundle(f.input, f.root).byCode).toEqual({ ARTIFACT_HASH_MISMATCH: 1 });
  });
  it('archivo que crece durante la lectura queda bloqueado', () => {
    const f = fixture(), originalRead = fs.readSync;
    const spy = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      const length = originalRead(...args); fs.truncateSync(f.target, f.bytes.length + 1); return length;
    });
    const report = verifyHistoryArtifactBundle(f.input, f.root);
    expect(spy).toHaveBeenCalled(); expect(report.byCode).toEqual({ ARTIFACT_CHANGED: 1 });
    expect(report.verifiedFiles).toBe(0);
  });
  it('reemplazo por otro inode durante lectura no pasa aunque tenga iguales bytes', () => {
    const f = fixture(), originalRead = fs.readSync;
    const spy = vi.spyOn(fs, 'readSync').mockImplementationOnce((...args: Parameters<typeof fs.readSync>) => {
      const length = originalRead(...args); fs.renameSync(f.target, join(f.work, 'old.xml'));
      fs.writeFileSync(f.target, f.bytes); return length;
    });
    const report = verifyHistoryArtifactBundle(f.input, f.root);
    expect(spy).toHaveBeenCalled(); expect(report.byCode).toEqual({ ARTIFACT_CHANGED: 1 });
  });
  it('root relativo explícito apunta al mismo bundle', () => {
    const f = fixture(); expect(verifyHistoryArtifactBundle(f.input, relative(process.cwd(), f.root)).planSha256).toBe(buildHistoryArtifactPlan(f.input).planSha256);
  });
});
