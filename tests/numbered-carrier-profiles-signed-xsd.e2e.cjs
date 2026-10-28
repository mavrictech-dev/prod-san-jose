'use strict';

// node tests/numbered-carrier-profiles-signed-xsd.e2e.cjs --isolated-synthetic-only
// Executes the scoped specs directly from source: no build/dist writes, services,
// databases, .env, installed certificates, dependency installation or network.
// Real signatures/verification are supplied by the existing in-memory ephemeral
// PKI + signLocalGuideXml harness in carrier-guide-profile.spec.ts. No empty or
// fabricated ds:Signature is inserted to make the XSD accept the input.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const REPO = resolve(__dirname, '..');
const PREFIX = 'factuez-numbered-carrier-signed-xsd-';
const ZIP_SHA256 = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5';

// Same bounded ZIP preflight and isolated resolver as guide-preparation-xsd.e2e.cjs.
// Reuse validate-official-xsd.py's parser/resolver without invoking its main.
const PYTHON = String.raw`
import copy
import hashlib
import json
import re
import runpy
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath
from lxml import etree

def require(condition, message):
    if not condition:
        raise ValueError(message)

def validate(p):
    root = Path(p['ownRoot']).resolve(strict=True)
    require(root.is_dir() and root.name.startswith('factuez-numbered-carrier-signed-xsd-'), 'OWN_ROOT_REQUIRED')
    archive = Path(p['archive'])
    require(archive.is_file() and archive.stat().st_size <= 4 * 1024 * 1024, 'ARCHIVE_SIZE_LIMIT')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == '${ZIP_SHA256}', 'ARCHIVE_SHA256_MISMATCH')
    with zipfile.ZipFile(archive) as z:
        entries = z.infolist()
        require(0 < len(entries) <= 256, 'ZIP_ENTRY_COUNT_LIMIT')
        seen, checked, total = set(), [], 0
        for entry in entries:
            name = entry.filename
            require(name == entry.orig_filename and 0 < len(name) <= 240, 'ZIP_ENTRY_NAME_INVALID')
            require(not re.search(r'[\\:\x00-\x1f\x7f%?#]', name), 'ZIP_ENTRY_UNSAFE_CHARACTERS')
            parts = name.rstrip('/').split('/')
            require(0 < len(parts) <= 16 and parts[0] == 'Archivos XSD', 'ZIP_ENTRY_OUTSIDE_BUNDLE')
            require(not PurePosixPath(name).is_absolute(), 'ZIP_ENTRY_ABSOLUTE')
            require(all(part and part not in ('.', '..') and part == part.strip()
                        and not part.endswith('.') and not re.match(
                            r'^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I)
                        for part in parts), 'ZIP_ENTRY_UNSAFE_COMPONENT')
            key = '/'.join(parts).casefold()
            require(key not in seen, 'ZIP_ENTRY_DUPLICATE')
            seen.add(key)
            mode = stat.S_IFMT(entry.external_attr >> 16)
            require(mode in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG), 'ZIP_ENTRY_LINK_OR_SPECIAL')
            require(not entry.external_attr & 0x400, 'ZIP_ENTRY_REPARSE_POINT')
            require(not entry.flag_bits & 1 and entry.compress_type in (0, 8), 'ZIP_ENTRY_ENCRYPTION_OR_COMPRESSION')
            require(0 <= entry.file_size <= 5 * 1024 * 1024, 'ZIP_ENTRY_SIZE_LIMIT')
            require(entry.file_size <= max(1, entry.compress_size) * 1000, 'ZIP_ENTRY_RATIO_LIMIT')
            total += entry.file_size
            require(total <= 16 * 1024 * 1024, 'ZIP_TOTAL_SIZE_LIMIT')
            destination = root.joinpath(*parts).resolve()
            require(destination.is_relative_to(root) and destination != root, 'ZIP_ENTRY_ESCAPE')
            if not entry.is_dir():
                require(destination.suffix.lower() in ('.xsd', '.xml', '.xsl'), 'ZIP_ENTRY_TYPE_INVALID')
            checked.append((entry, destination))
        for entry, destination in checked:
            if entry.is_dir():
                require(entry.file_size == 0, 'ZIP_DIRECTORY_WITH_DATA')
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with z.open(entry) as source:
                    data = source.read(5 * 1024 * 1024 + 1)
                require(len(data) == entry.file_size, 'ZIP_ENTRY_ACTUAL_SIZE_MISMATCH')
                with destination.open('xb') as output:
                    output.write(data)

    helpers = runpy.run_path(p['validator'], run_name='factuez_numbered_carrier_offline_helpers')
    bundle = (root / 'Archivos XSD').resolve(strict=True)
    schema_path = helpers['bounded'](bundle / '2.1/maindoc/UBL-DespatchAdvice-2.1.xsd', bundle)
    resolver = helpers['LocalSchemasOnly'](bundle)
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False)
    parser.resolvers.add(resolver)
    schema = etree.XMLSchema(etree.parse(str(schema_path), parser))
    ns = {'cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
          'cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
          'ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
          'ds': 'http://www.w3.org/2000/09/xmldsig#'}
    results = []
    def result(kind, name, value, expected):
        valid = schema.validate(value)
        errors = [{'type': e.type_name, 'path': e.path, 'message': e.message[:1000]}
                  for e in list(schema.error_log)[:10]]
        results.append({'documentType': kind, 'case': name, 'xsdValid': valid,
                        'expectedValid': expected, 'passed': valid == expected, 'errors': errors})

    require(len(p['cases']) == 2 and {c['documentType'] for c in p['cases']} == {'09', '31'}, 'BOTH_PROFILES_REQUIRED')
    for case in p['cases']:
        document = helpers['xml_root'](case['xml'].encode('utf-8'))
        require(document.tag == '{urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2}DespatchAdvice', 'WRONG_ROOT')
        require(document.findtext('cbc:ID', namespaces=ns) == case['fullNumber'], 'WRONG_NUMBER')
        require(document.findtext('cbc:DespatchAdviceTypeCode', namespaces=ns) == case['documentType'], 'WRONG_TYPE')
        signatures = document.xpath('ext:UBLExtensions/ext:UBLExtension/ext:ExtensionContent/ds:Signature', namespaces=ns)
        require(len(signatures) == 1 and len(document.xpath('//ds:Signature', namespaces=ns)) == 1, 'REAL_SIGNATURE_REQUIRED')
        require(signatures[0].get('Id') == 'signatureFactuEz', 'WRONG_SIGNATURE_ID')
        for name in ('DigestValue', 'SignatureValue', 'X509Certificate'):
            values = signatures[0].xpath('.//ds:' + name + '/text()', namespaces=ns)
            require(len(values) == 1 and len(values[0].strip()) >= 20, 'INCOMPLETE_SIGNATURE')
        kind = case['documentType']
        result(kind, 'actual-signed-numbered-xml', document, True)
        # Unsigned input must fail with its actual empty ExtensionContent.
        unsigned = helpers['xml_root'](case['unsignedXml'].encode('utf-8'))
        require(not unsigned.xpath('//ds:Signature', namespaces=ns), 'UNSIGNED_CONTROL_CHANGED')
        result(kind, 'unsigned-empty-signature-slot', unsigned, False)
        missing = copy.deepcopy(document)
        missing.remove(missing.find('cbc:ID', ns))
        result(kind, 'missing-root-ID', missing, False)
        reordered = copy.deepcopy(document)
        identifier, date = reordered.find('cbc:ID', ns), reordered.find('cbc:IssueDate', ns)
        reordered.remove(identifier)
        reordered.insert(list(reordered).index(date) + 1, identifier)
        result(kind, 'ID-after-IssueDate', reordered, False)
        wrong = copy.deepcopy(document)
        wrong.tag = '{urn:invalid:synthetic}DespatchAdvice'
        result(kind, 'wrong-root-namespace', wrong, False)

    try:
        helpers['xml_root'](b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///blocked">]><x>&e;</x>')
    except ValueError:
        pass
    else:
        raise ValueError('DTD_ENTITY_WAS_ACCEPTED')
    for target in ('https://example.invalid/blocked.xsd', str(archive.resolve(strict=True))):
        try:
            helpers['LocalSchemasOnly'](bundle).resolve(target, None, None)
        except (ValueError, OSError):
            pass
        else:
            raise ValueError('EXTERNAL_SCHEMA_WAS_ACCEPTED')
    return {'result': 'PASS' if all(r['passed'] for r in results) else 'FAIL',
            'scope': 'SYNTHETIC_SIGNED_GRE09_GRE31_OFFLINE_STRUCTURE', 'archiveSha256': '${ZIP_SHA256}',
            'schema': '2.1/maindoc/UBL-DespatchAdvice-2.1.xsd', 'results': results,
            'negativeChecks': ['unsigned extension', 'missing ID', 'wrong order', 'wrong namespace', 'DTD', 'external schemas'],
            'officialRulesValidated': False, 'transmissionAuthorized': False, 'authorizedForTransfer': False}

try:
    payload = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    require(len(payload) <= 4 * 1024 * 1024, 'INPUT_SIZE_LIMIT')
    report = validate(json.loads(payload))
except Exception as error:
    report = {'result': 'FAIL', 'stage': 'OFFLINE_XSD', 'error': type(error).__name__, 'message': str(error)[:2000]}
print(json.dumps(report, ensure_ascii=True))
sys.exit(0 if report['result'] == 'PASS' else 1)
`;

function pythonRuntime() {
  for (const [command, prefix] of [['python', []], ['python3', []], ['py', ['-3']]]) {
    const probe = spawnSync(command, [...prefix, '-I', '-B', '-c', 'import json,sys; from lxml import etree; print(json.dumps(sys.executable))'],
      { env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true });
    if (!probe.error && probe.status === 0) {
      const executable = JSON.parse(probe.stdout); assert.ok(isAbsolute(executable)); return executable;
    }
  }
  throw new Error('PYTHON_LXML_REQUIRED: XSD test was not skipped');
}

function validateSignedProfiles(cases) {
  const archive = join(REPO, 'services/sunat-service/assets/sunat/xsd-20220228.zip');
  assert.ok(statSync(archive).size <= 4 * 1024 * 1024);
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), ZIP_SHA256);
  const executable = pythonRuntime(), tempParent = realpathSync(tmpdir());
  const ownRoot = mkdtempSync(join(tempParent, PREFIX));
  let report;
  try {
    const child = spawnSync(executable, ['-I', '-B', '-c', PYTHON], {
      input: JSON.stringify({ ownRoot, archive, validator: join(__dirname, 'validate-official-xsd.py'), cases }),
      env: {}, encoding: 'utf8', timeout: 45000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    assert.ifError(child.error); assert.ok(child.stdout.trim(), child.stderr || 'NO_XSD_REPORT');
    report = JSON.parse(child.stdout);
    assert.equal(child.status, report.result === 'PASS' ? 0 : 1, 'PYTHON_REPORT_EXIT_MISMATCH');
  } finally {
    // Only our exact fresh directory is eligible for recursive removal.
    assert.equal(dirname(ownRoot), tempParent); assert.ok(basename(ownRoot).startsWith(PREFIX));
    assert.match(basename(ownRoot).slice(PREFIX.length), /^[A-Za-z0-9]{6}$/);
    assert.ok(lstatSync(ownRoot).isDirectory() && !lstatSync(ownRoot).isSymbolicLink());
    assert.equal(realpathSync(ownRoot), ownRoot);
    rmSync(ownRoot, { recursive: true, force: false });
  }
  report.cleanup = 'OWN_TEMP_REMOVED';
  assert.equal(report.result, 'PASS', JSON.stringify(report));
  return report;
}
module.exports = { validateSignedProfiles };

if (require.main === module) {
  assert.deepEqual(process.argv.slice(2), ['--isolated-synthetic-only'], 'ISOLATED_SYNTHETIC_ONLY_REQUIRED');
  // Child receives no application secrets or environment customization. Vitest's
  // cache is disabled; no test setup imports a service bootstrap or loads .env.
  const executable = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const result = spawnSync(process.execPath, [executable, 'run', 'tests/numbered-guide-profile.spec.ts',
    'tests/carrier-guide-profile.spec.ts', '--maxWorkers=1', '--no-cache'], {
    cwd: REPO, env: {}, stdio: 'inherit', timeout: 120000, windowsHide: true,
  });
  if (result.error) { console.error('SIGNED_PROFILE_TEST_FAILED: ' + result.error.code); process.exitCode = 1; }
  else process.exitCode = result.status ?? 1;
}
