import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { runInThisContext } from 'node:vm';
import { buildBusinessEvidenceXml, createBusinessEvidenceSnapshot } from '../packages/evidence-core/src/fixtures';
import { createEvidenceCryptoFixture, unsignedSyntheticCdr } from './helpers/evidence-crypto.fixture';

const cliPath = resolve('migration/offline-sales-review-cli.cjs');
const cliSource = fs.readFileSync(cliPath, 'utf8');
const localRequire = createRequire(cliPath);
const scope = { schemaVersion: 'factuez.offline-review-scope.v1', environment: 'BETA', purpose: 'DIAGNOSTIC_ONLY',
  issuerRucs: ['00000000001'], fromDate: '2026-10-01', toDate: '2026-10-31' };
const policy = { environment: 'BETA', purpose: 'DIAGNOSTIC_ONLY', transmission: false,
  officialTrust: false, officialAcceptance: false, canEmit: false, canImportHistory: false,
  canChangeCounters: false, phase2Closed: false, phase3Closed: false,
  accountingApproved: false, cutoverAuthorized: false, networkRequests: 0, fiscalWrites: 0, outboxWrites: 0 };
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Role = 'DOCUMENT_XML' | 'CDR_XML';
type Manifest = { schemaVersion: string; scope: typeof scope;
  documentFiles: Array<{ role: Role; path: string; sha256: string }> };
let dir: string, documentPath: string, cdrPath: string, manifestPath: string;
let fixture: ReturnType<typeof createEvidenceCryptoFixture>, documentXml: string, cdrXml: string;

function signedCdr(options: Parameters<typeof unsignedSyntheticCdr>[0] = {}) {
  const xml = unsignedSyntheticCdr({ issuerRuc: scope.issuerRucs[0], reference: 'FQ01-1',
    responseReference: 'FQ01-1', documentTypeCode: '01', ...options })
    .replace('<cbc:ID>', '<cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>' +
      '<cbc:IssueDate>2026-10-04</cbc:IssueDate><cbc:ID>');
  return fixture.sign(xml, 'ApplicationResponse');
}
function saveManifest(m: unknown) { fs.writeFileSync(manifestPath, JSON.stringify(m)); }
function manifest(changes: Record<string, unknown> = {}): Manifest {
  const m = { schemaVersion: 'factuez.offline-sales-files.v1', scope,
    documentFiles: [{ role: 'DOCUMENT_XML' as const, path: documentPath, sha256: sha256(fs.readFileSync(documentPath)) },
      { role: 'CDR_XML' as const, path: cdrPath, sha256: sha256(fs.readFileSync(cdrPath)) }], ...changes } as Manifest;
  saveManifest(m); return m;
}
function run(args = ['--authorized-offline-review', '--manifest', manifestPath]) {
  // Check byte preservation of every supplied fixture after success AND failure.
  const originals = [documentPath, cdrPath, manifestPath].filter(p => fs.existsSync(p))
    .map(p => ({ path: p, bytes: fs.readFileSync(p) }));
  const result = spawnSync(process.execPath, [cliPath, ...args],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  expect(result.error).toBeUndefined();
  for (const original of originals) expect(fs.readFileSync(original.path).equals(original.bytes)).toBe(true);
  return result;
}
function blocked(result: ReturnType<typeof run>, code?: string) {
  expect(result.status).toBe(1); expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toMatchObject({ status: 'BLOCKED', ...policy, ...(code ? { code } : {}) });
  expect(result.stderr).not.toContain(dir);
}

// Fault injection exercises descriptor reads deterministically, with no races,
// service access, file patching or reliance on Windows symlink privileges.
function instrumentedRun(args: string[], overrides: Record<string, unknown> = {}) {
  const accesses: string[] = [], closed: number[] = [], stdout: string[] = [], stderr: string[] = [];
  const fakeProcess = { argv: ['node', cliPath, ...args], platform: process.platform, exitCode: undefined as number | undefined };
  const fileApi = { ...fs,
    lstatSync(path: fs.PathLike) { accesses.push(String(path)); return fs.lstatSync(path); },
    closeSync(fd: number) { closed.push(fd); fs.closeSync(fd); }, ...overrides };
  // Keep the core's strict plain-object checks in the same JavaScript realm.
  const execute = runInThisContext(`(function(require, process, console) {\n${cliSource}\n})`, { filename: cliPath });
  execute((name: string) => name === 'node:fs' ? fileApi : localRequire(name), fakeProcess,
    { log: (value: string) => stdout.push(value), error: (value: string) => stderr.push(value) });
  return { status: fakeProcess.exitCode, stdout: stdout.join('\n'), stderr: stderr.join('\n'), accesses, closed };
}

beforeAll(() => {
  // The parent prepares the build; these tests never build or edit packages.
  expect(fs.existsSync(resolve('packages/evidence-core/dist/offline-sales-review.js'))).toBe(true);
  fixture = createEvidenceCryptoFixture({ leaf: { ruc: scope.issuerRucs[0] } });
  documentXml = fixture.sign(buildBusinessEvidenceXml(createBusinessEvidenceSnapshot('01')), 'Invoice');
  cdrXml = signedCdr();
  dir = fs.mkdtempSync(join(tmpdir(), 'factuez-offline-sales-cli-synthetic-'));
  documentPath = join(dir, 'document.xml'); cdrPath = join(dir, 'cdr.xml'); manifestPath = join(dir, 'manifest.json');
}, 30000);
beforeEach(() => {
  fs.writeFileSync(documentPath, documentXml); fs.writeFileSync(cdrPath, cdrXml); manifest();
});
afterAll(() => {
  if (dir) {
    // Only this test's newly allocated temporary directory can be removed.
    const target = resolve(dir), parent = resolve(tmpdir());
    expect(target.startsWith(parent + sep)).toBe(true);
    expect(dirname(target)).toBe(parent);
    expect(target.slice(parent.length + 1)).toMatch(/^factuez-offline-sales-cli-synthetic-/);
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe('offline sales CLI: diagnostic metadata and explicit pair bindings', () => {
  it.each(['01', '03', '07', '08'] as const)('reviews a fictional signed %s pair with no trust or fiscal permissions', type => {
    const snapshot = createBusinessEvidenceSnapshot(type);
    const fullNumber = `${snapshot.ownership.series}-${snapshot.number}`;
    fs.writeFileSync(documentPath, fixture.sign(buildBusinessEvidenceXml(snapshot)));
    fs.writeFileSync(cdrPath, signedCdr({ reference: fullNumber, responseReference: fullNumber, documentTypeCode: type }));
    const m = manifest(), result = run(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    const report = JSON.parse(result.stdout);
    expect(report).toMatchObject({ ...policy, schemaVersion: 'factuez.offline-sales-review.v1',
      sourceManifestSha256: sha256(fs.readFileSync(manifestPath)), cryptographicPairBound: true, typeBindingVerified: true,
      document: { rawSha256: m.documentFiles[0].sha256, type, fullNumber, issuerRuc: '00000000001',
        issueDate: '2026-10-04', currencyCode: 'PEN', lineCount: 1,
        signature: { status: 'INTEGRITY_VERIFIED_UNTRUSTED', wholeDocumentIntegrity: true, officialTrust: false },
        reconciliation: { checksPassed: true, fiscalRulesVerified: false },
        coverage: { unmappedElementCount: 0, mappingCompleteness: 'PARTIAL_DIAGNOSTIC', attributesFullyMapped: false } },
      cdr: { rawSha256: m.documentFiles[1].sha256, responseCode: '0', reportedResult: 'REPORTED_ACCEPTED', warningCodes: [] },
      bindings: { issuerMatches: true, referenceMatches: true, documentTypeMatches: true } });
    expect(report.issues).toEqual(['PKI_AND_SIGNER_AUTHORIZATION_NOT_VERIFIED', 'PARTIAL_SNAPSHOT_NOT_IMPORTABLE']);
  });

  it('redacts names, addresses, customer IDs, product details, notes, certificate bytes and paths', () => {
    fs.writeFileSync(cdrPath, signedCdr({ notes: ['4001 OBSERVACION PRIVADA FICTICIA', 'NOTA PRIVADA SIN CODIGO'] }));
    manifest(); const result = run(); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).cdr.warningCodes).toEqual(['4001', null]);
    for (const secret of ['EMISOR FICTICIO QA', 'ESTACION FICTICIA', 'AVENIDA FICTICIA 123',
      'CLIENTE FICTICIO QA', '00000000002', 'DIRECCION FICTICIA 456', 'qa@pruebas.invalid', 'FUEL-QA',
      'COMBUSTIBLE FICTICIO', 'CIENTO DIECIOCHO', 'SIN VALIDEZ TRIBUTARIA', 'Resultado FICTICIO',
      'OBSERVACION PRIVADA', 'NOTA PRIVADA', 'SYNTHETIC FICTICIO QA', 'AJUSTE FICTICIO QA',
      'X509Certificate', 'SignatureValue', 'DigestValue', 'BEGIN CERTIFICATE', dir, documentPath, cdrPath])
      expect(result.stdout).not.toContain(secret);
    const certificateBytes = /<X509Certificate>([^<]+)<\/X509Certificate>/.exec(documentXml)?.[1];
    expect(certificateBytes).toBeTruthy(); expect(result.stdout).not.toContain(certificateBytes!);
    expect(Object.keys(JSON.parse(result.stdout).document).sort()).toEqual([
      'coverage', 'currencyCode', 'fullNumber', 'issueDate', 'issuerRuc', 'lineCount', 'rawSha256', 'reconciliation', 'signature', 'type']);
  });

  it('reports unmapped coverage as a count without revealing XML element names or paths', () => {
    const unsigned = buildBusinessEvidenceXml(createBusinessEvidenceSnapshot()).replace('</Invoice>',
      '<PRIVATE_ELEMENT_FICTICIO xmlns="urn:PRIVATE_NAMESPACE_FICTICIO">PRIVATE_VALUE_FICTICIO</PRIVATE_ELEMENT_FICTICIO></Invoice>');
    fs.writeFileSync(documentPath, fixture.sign(unsigned)); manifest();
    const result = run(); expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.document.coverage.unmappedElementCount).toBe(1);
    expect(report.issues).toContain('UNMAPPED_BUSINESS_ELEMENTS');
    expect(result.stdout).not.toMatch(/PRIVATE_|unmappedPaths/);
  });

  it.each(['DOCUMENT_XML', 'CDR_XML'] as const)('redacts arbitrary private text in unsupported %s signature algorithms', role => {
    const path = role === 'DOCUMENT_XML' ? documentPath : cdrPath;
    const xml = fs.readFileSync(path, 'utf8').replace(
      'Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"',
      'Algorithm="PRIVATE_ALGORITHM_NAME_FICTICIO"');
    fs.writeFileSync(path, xml); manifest();
    const result = run(); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)[role === 'DOCUMENT_XML' ? 'document' : 'cdr'].signature)
      .toMatchObject({ status: 'PROFILE_UNSUPPORTED', wholeDocumentIntegrity: false });
    expect(result.stdout).not.toContain('PRIVATE_ALGORITHM');
  });

  it('passes null when the optional CDR is absent and exits 2', () => {
    const m = manifest(); m.documentFiles = m.documentFiles.slice(0, 1); saveManifest(m);
    const result = run(); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ...policy, cdr: null, bindings: null,
      cryptographicPairBound: false, typeBindingVerified: false, issues: expect.arrayContaining(['CDR_NOT_PROVIDED']) });
    expect(instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath]).accesses).not.toContain(cdrPath);
  });

  it('accepts inventory order independent of document/CDR roles', () => {
    const m = manifest(); m.documentFiles.reverse(); saveManifest(m); expect(run().status).toBe(0);
  });

  it('preserves BOM hashes for both XML files and the exact manifest bytes', () => {
    fs.writeFileSync(documentPath, '\uFEFF' + documentXml); fs.writeFileSync(cdrPath, '\uFEFF' + cdrXml);
    const m = manifest(); fs.writeFileSync(manifestPath, '\uFEFF' + JSON.stringify(m));
    const result = run(); expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ sourceManifestSha256: sha256(fs.readFileSync(manifestPath)),
      document: { rawSha256: m.documentFiles[0].sha256 }, cdr: { rawSha256: m.documentFiles[1].sha256 } });
  });

  it.each([
    [{ reference: 'FQ01-2' }, 'CDR_OTHER_DOCUMENT'],
    [{ responseReference: 'FQ01-2' }, 'CDR_OTHER_DOCUMENT'],
    [{ issuerRuc: '00000000003' }, 'CDR_OTHER_ISSUER'],
    [{ documentTypeCode: '03' }, 'CDR_OTHER_TYPE'],
    [{ documentTypeCode: undefined }, 'CDR_TYPE_NOT_DECLARED'],
    [{ reference: 'RC-20261004-1' }, 'CDR_SUMMARY_REQUIRES_BATCH_BINDING'],
  ] as const)('exits 2 for binding discrepancy %j', (options, issue) => {
    fs.writeFileSync(cdrPath, signedCdr(options));
    manifest({ scope: { ...scope, issuerRucs: ['00000000001', '00000000003'] } });
    const result = run(); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ...policy, issues: expect.arrayContaining([issue]) });
  });

  it.each(['DOCUMENT_XML', 'CDR_XML'] as const)('detects signed content tampering even with an updated %s inventory hash', role => {
    const path = role === 'DOCUMENT_XML' ? documentPath : cdrPath;
    const xml = role === 'DOCUMENT_XML' ? documentXml.replace('CLIENTE FICTICIO QA', 'CLIENTE ALTERADO QA') :
      cdrXml.replace('Resultado FICTICIO SYNTHETIC QA', 'RESULTADO ALTERADO FICTICIO');
    fs.writeFileSync(path, xml); manifest(); const result = run(); expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report[role === 'DOCUMENT_XML' ? 'document' : 'cdr'].signature.status).toBe('DIGEST_MISMATCH');
    expect(report.cryptographicPairBound).toBe(false); expect(report).toMatchObject(policy);
  });

  it('exits 2 for signed arithmetic discrepancies even if pair integrity and bindings pass', () => {
    const unsigned = buildBusinessEvidenceXml(createBusinessEvidenceSnapshot()).replace(
      '<cbc:PayableAmount currencyID="PEN">118.00</cbc:PayableAmount>',
      '<cbc:PayableAmount currencyID="PEN">119.00</cbc:PayableAmount>');
    fs.writeFileSync(documentPath, fixture.sign(unsigned)); manifest();
    const result = run(); expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ cryptographicPairBound: true,
      document: { reconciliation: { checksPassed: false } }, issues: expect.arrayContaining(['PAYABLE_TOTAL_MISMATCH']) });
  });
});

describe('offline sales CLI: access, manifest, scope and byte safety', () => {
  it.each([
    [], ['--manifest', 'anything'], ['--authorized-offline-review'],
    ['--manifest', 'anything', '--authorized-offline-review'],
    ['--authorized-offline-review', '--manifest', 'anything', '--send'],
    ['--authorized-offline-review', '--manifest', 'anything', '--output', 'anything'],
  ].map(args => ({ args })))('blocks bad arguments before any file access: $args', ({ args }) => {
    const result = instrumentedRun(args); expect(result.status).toBe(1); expect(result.accesses).toEqual([]);
    expect(JSON.parse(result.stderr).code).toBe('EXPLICIT_SCOPE_REQUIRED');
    blocked(run(args), 'EXPLICIT_SCOPE_REQUIRED');
  });

  it('does not treat an existing manifest as authorization', () => {
    const result = instrumentedRun(['--manifest', manifestPath]);
    expect(result.status).toBe(1); expect(result.accesses).toEqual([]);
  });

  it.each(['relative.json', '\\manifest.json', '//server.invalid/share/manifest.json', '\\\\server.invalid\\share\\manifest.json'])
    ('blocks relative, root-relative and network manifest paths: %s', path => {
      const result = instrumentedRun(['--authorized-offline-review', '--manifest', path]);
      expect(result.status).toBe(1); expect(result.accesses).toEqual([]); expect(JSON.parse(result.stderr).code).toBe('FILE_PATH');
    });

  it.each([
    { schemaVersion: 'factuez.offline-guide-files.v1' }, { authorizedOfflineReview: true },
    { documentFiles: [] }, { documentFiles: null },
  ])('rejects manifest schema/authorization/inventory extensions: %j', changes => {
    manifest(changes); blocked(run());
    expect(instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath]).accesses).not.toContain(documentPath);
  });

  it.each([null, [], 'not a manifest'])('rejects a non-object manifest: %j', value => {
    saveManifest(value); blocked(run(), 'MANIFEST_FIELDS');
  });

  it.each([
    { environment: 'PRODUCTION' }, { purpose: 'IMPORT_HISTORY' }, { authorized: true },
    { schemaVersion: 'factuez.other-scope.v1' }, { issuerRucs: [] }, { issuerRucs: ['00000000001', '00000000001'] },
    { issuerRucs: ['INVALID'] }, { fromDate: '2026-02-30' }, { fromDate: '2026-11-01' },
    { issuerRucs: ['00000000003'] }, { toDate: '2026-10-03' },
  ])('blocks invalid or out-of-scope input: %j', changes => {
    manifest({ scope: { ...scope, ...changes } }); blocked(run());
  });

  it.each(['schemaVersion', 'environment', 'purpose', 'issuerRucs', 'fromDate', 'toDate'])('requires exact scope field %s', key => {
    const s = { ...scope } as Record<string, unknown>; delete s[key]; manifest({ scope: s }); blocked(run(), 'SCOPE_FIELDS');
  });

  it.each(['missingDocument', 'duplicateDocument', 'duplicateCdr', 'unknownRole', 'extraField', 'threeFiles'])
    ('rejects invalid inventory before XML access: %s', kind => {
      const m = manifest();
      if (kind === 'missingDocument') m.documentFiles.shift();
      if (kind === 'duplicateDocument') m.documentFiles[1].role = 'DOCUMENT_XML';
      if (kind === 'duplicateCdr') m.documentFiles = [m.documentFiles[1], m.documentFiles[1]];
      if (kind === 'unknownRole') (m.documentFiles[1] as { role: string }).role = 'GUIDE_XML';
      if (kind === 'extraField') Object.assign(m.documentFiles[1], { authorized: true });
      if (kind === 'threeFiles') m.documentFiles.push(m.documentFiles[1]);
      saveManifest(m); blocked(run(), 'FILE_INVENTORY');
      expect(instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath]).accesses).not.toContain(documentPath);
    });

  it.each(['XML', 'manifest'])('rejects fatal invalid UTF-8 in %s without content output', target => {
    const bytes = Buffer.from([0xc3, 0x28]);
    if (target === 'XML') { fs.writeFileSync(documentPath, bytes); manifest(); }
    else fs.writeFileSync(manifestPath, bytes);
    blocked(run(), 'ERR_ENCODING_INVALID_ENCODED_DATA');
  });

  it.each(['DOCUMENT_XML', 'CDR_XML'] as const)('blocks an incorrect %s SHA256', role => {
    const m = manifest(); m.documentFiles.find(e => e.role === role)!.sha256 = '0'.repeat(64); saveManifest(m);
    blocked(run(), 'FILE_SHA256_MISMATCH');
  });

  it.each(['A'.repeat(64), 'f'.repeat(63), 0, null])('rejects malformed SHA256 %j', value => {
    const m = manifest(); Object.assign(m.documentFiles[1], { sha256: value }); saveManifest(m); blocked(run(), 'FILE_INVENTORY');
    expect(instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath]).accesses).not.toContain(documentPath);
  });

  it.each(['samePath', 'hardLink'])('blocks the same physical file for both roles: %s', kind => {
    const m = manifest();
    if (kind === 'samePath') m.documentFiles[1].path = documentPath;
    else {
      const alias = join(dir, 'same-file.xml');
      if (fs.existsSync(alias)) fs.unlinkSync(alias);
      fs.linkSync(documentPath, alias); m.documentFiles[1].path = alias;
    }
    m.documentFiles[1].sha256 = m.documentFiles[0].sha256; saveManifest(m); blocked(run(), 'DUPLICATE_FILE');
  });

  it.each(['relative.xml', '//server.invalid/share/file.xml', '\\\\server.invalid\\share\\file.xml'])
    ('blocks non-local or relative XML inventory paths before XML access: %s', path => {
      const m = manifest(); m.documentFiles[1].path = path; saveManifest(m); blocked(run(), 'FILE_PATH');
      expect(instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath]).accesses).not.toContain(documentPath);
    });

  it('redacts missing file errors', () => {
    const m = manifest(); m.documentFiles[0].path = join(dir, 'PRIVATE_FILENAME_FICTICIO.xml'); saveManifest(m);
    const result = run(); blocked(result, 'ENOENT'); expect(result.stderr).not.toContain('PRIVATE_FILENAME');
  });

  it.each([
    ['XML', 0], ['XML', 2 * 1024 * 1024 + 1], ['manifest', 0], ['manifest', 16385],
  ] as const)('blocks empty/oversized %s (%s bytes)', (target, size) => {
    fs.writeFileSync(target === 'XML' ? documentPath : manifestPath, Buffer.alloc(size, 0x20));
    if (target === 'XML') manifest(); blocked(run(), 'FILE_SIZE');
  });

  it('rejects a directory instead of an XML file', () => {
    const m = manifest(); m.documentFiles[0].path = dir; saveManifest(m); blocked(run(), 'FILE_SIZE');
  });

  it('rejects malformed JSON without echoing its private content', () => {
    fs.writeFileSync(manifestPath, '{"PRIVATE_MANIFEST_CONTENT":');
    const result = run(); blocked(result, 'OFFLINE_REVIEW_FAILED'); expect(result.stderr).not.toContain('PRIVATE_MANIFEST_CONTENT');
  });

  it('rejects symlinks before opening their target', () => {
    let opened = 0;
    const result = instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath], {
      lstatSync: () => ({ isSymbolicLink: () => true }), openSync: () => { opened++; throw Error('UNEXPECTED'); },
    });
    expect(result.status).toBe(1); expect(JSON.parse(result.stderr).code).toBe('FILE_PATH'); expect(opened).toBe(0);
  });

  it('fills buffers over partial descriptor reads', () => {
    const result = instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath], {
      readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number) =>
        fs.readSync(fd, bytes, offset, Math.min(length, 37), position),
    });
    expect(result.status).toBe(0); expect(result.closed).toHaveLength(3);
    expect(JSON.parse(result.stdout).document.rawSha256).toBe(sha256(documentXml));
  });

  it.each(['shortRead', 'growth', 'changedStat', 'replacedPath'])('blocks unstable descriptor reads and closes the descriptor: %s', kind => {
    let stats = 0, pathStats = 0;
    const result = instrumentedRun(['--authorized-offline-review', '--manifest', manifestPath], {
      readSync: (fd: number, bytes: Buffer, offset: number, length: number, position: number) => {
        if (kind === 'shortRead') return 0;
        if (kind === 'growth' && length === 1 && position === fs.fstatSync(fd).size) return 1;
        return fs.readSync(fd, bytes, offset, length, position);
      },
      fstatSync: (fd: number) => {
        const s = fs.fstatSync(fd); stats++;
        return kind === 'changedStat' && stats === 2 ? Object.assign(s, { mtimeMs: s.mtimeMs + 1 }) : s;
      },
      lstatSync: (path: fs.PathLike) => {
        const s = fs.lstatSync(path); pathStats++;
        return kind === 'replacedPath' && pathStats === 2 ? Object.assign(s, { dev: s.dev + 1 }) : s;
      },
    });
    expect(result.status).toBe(1); expect(result.stdout).toBe(''); expect(result.closed).toHaveLength(1);
    expect(JSON.parse(result.stderr)).toMatchObject({ code: 'FILE_CHANGED', ...policy });
  });

  it('imports only local review code and read-only builtins, with no scans or external effects', () => {
    expect([...cliSource.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1])).toEqual([
      'node:fs', 'node:path', 'node:crypto', 'node:util',
      '../packages/evidence-core/dist/offline-review.js', '../packages/evidence-core/dist/offline-sales-review.js']);
    expect(cliSource).not.toMatch(/process\s*\.\s*env|readdir|glob|writeFile|appendFile|mkdir|unlink|rmSync|rename|fetch\s*\(|https?:\/\/|dotenv|Prisma|sendBill|sendSummary|child_process/);
  });
});
