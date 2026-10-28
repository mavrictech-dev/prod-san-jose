'use strict';

// Main must confirm rebuilt sunat-core dist before running:
// node tests/guide-preparation-xsd.e2e.cjs --isolated-synthetic-only
// Offline structure check only: no number reservation, signature, transfer permit,
// SUNAT rules/acceptance, service bootstrap, Docker, credentials or .env loading.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, isAbsolute, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = resolve(__dirname, '..');
const ZIP_SHA256 = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5';
const PROFILE = 'FACTUEZ-BETA-GRE09-PRIVATE04-PREPARATION-v1';
const POLICY = Object.freeze({ candidateOnly: true, fiscalExecutionEnabled: false,
  transmissionAuthorized: false, authorizedForTransfer: false, numberReserved: false,
  signatureVerified: false, officialRulesValidated: false, referenceVerification: 'NOT_VERIFIED' });

// Embedded source is passed to Python directly; no helper script is written.
// Reuse the existing offline parser/resolver without invoking its main routine.
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
    require(root.is_dir() and root.name.startswith('factuez-guide09-xsd-'), 'OWN_ROOT_REQUIRED')
    archive = Path(p['archive'])
    require(archive.is_file() and archive.stat().st_size <= 4 * 1024 * 1024, 'ARCHIVE_SIZE_LIMIT')
    require(hashlib.sha256(archive.read_bytes()).hexdigest() == p['archiveSha256'], 'ARCHIVE_SHA256_MISMATCH')
    # Validate all ZIP metadata before creating any entry. Never use extractall.
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
                # A bounded read also checks the entry CRC; exclusive create forbids overwrite.
                with z.open(entry) as source:
                    data = source.read(5 * 1024 * 1024 + 1)
                require(len(data) == entry.file_size, 'ZIP_ENTRY_ACTUAL_SIZE_MISMATCH')
                with destination.open('xb') as output:
                    output.write(data)

    helpers = runpy.run_path(p['validator'], run_name='factuez_offline_xsd_helpers')
    bundle = (root / 'Archivos XSD').resolve(strict=True)
    schema_path = helpers['bounded'](bundle / '2.1/maindoc/UBL-DespatchAdvice-2.1.xsd', bundle)
    resolver = helpers['LocalSchemasOnly'](bundle)
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False)
    parser.resolvers.add(resolver)
    schema = etree.XMLSchema(etree.parse(str(schema_path), parser))
    document = helpers['xml_root'](p['xml'].encode('utf-8'))
    ns = {'cbc': 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
          'cac': 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
          'ext': 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
          'ds': 'http://www.w3.org/2000/09/xmldsig#'}
    require(document.tag == '{urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2}DespatchAdvice', 'WRONG_PREVIEW_ROOT')
    require(document.findtext('cbc:ID', namespaces=ns) == 'TST0-1', 'WRONG_SYNTHETIC_PROPOSAL')
    require(document.findtext('cbc:DespatchAdviceTypeCode', namespaces=ns) == '09', 'WRONG_GUIDE_TYPE')
    require(document.findtext('cac:Shipment/cbc:HandlingCode', namespaces=ns) == '04', 'WRONG_REASON')
    require(document.findtext('cac:Shipment/cac:ShipmentStage/cbc:TransportModeCode', namespaces=ns) == '02', 'WRONG_TRANSPORT_MODE')
    require(document.findtext('cbc:IssueTime', namespaces=ns) == '10:30:00', 'WRONG_LIMA_TIME')
    require(not document.xpath('//ds:Signature | //cac:Signature', namespaces=ns), 'SIGNATURE_FORBIDDEN')
    require('NO AUTORIZA TRASLADO' in document.findtext('cbc:Note', default='', namespaces=ns), 'LOCAL_WARNING_REQUIRED')
    require(document.findtext('cac:DespatchLine/cac:Item/cbc:Description', namespaces=ns)
            == 'ARTICULO FICTICIO & <ENSAYO>', 'XML_ESCAPING_MISMATCH')

    def result(name, value, expected):
        valid = schema.validate(value)
        errors = [{'line': e.line, 'type': e.type_name, 'path': e.path, 'message': e.message[:1500]}
                  for e in list(schema.error_log)[:20]]
        return {'case': name, 'expectedValid': expected, 'xsdValid': valid,
                'passed': valid == expected, 'errors': errors}

    results = [result('preview-from-rebuilt-dist', document, True)]
    missing = copy.deepcopy(document)
    identifier = missing.find('cbc:ID', ns)
    require(identifier is not None, 'MISSING_ID_CONTROL_NOT_APPLIED')
    missing.remove(identifier)
    results.append(result('negative-missing-root-ID', missing, False))
    reordered = copy.deepcopy(document)
    identifier = reordered.find('cbc:ID', ns)
    date = reordered.find('cbc:IssueDate', ns)
    require(identifier is not None and date is not None, 'ORDER_CONTROL_NOT_APPLIED')
    reordered.remove(identifier)
    reordered.insert(list(reordered).index(date) + 1, identifier)
    results.append(result('negative-ID-after-IssueDate', reordered, False))
    # If the preview already fails (e.g. empty ext:ExtensionContent), require
    # additional root-order errors so the negative controls cannot pass vacuously.
    for control in results[1:]:
        control['mutationDetected'] = any('IssueDate' in e['message'] for e in control['errors'])
        control['passed'] = control['passed'] and control['mutationDetected']

    try:
        helpers['xml_root'](b'<!DOCTYPE x [<!ENTITY e SYSTEM "file:///blocked">]><x>&e;</x>')
    except ValueError:
        pass
    else:
        raise ValueError('DTD_ENTITY_WAS_ACCEPTED')
    # Exercise the resolver directly: no HTTP request or outside-file read occurs.
    for target in ('https://example.invalid/blocked.xsd', str(archive.resolve(strict=True))):
        try:
            helpers['LocalSchemasOnly'](bundle).resolve(target, None, None)
        except (ValueError, OSError):
            pass
        else:
            raise ValueError('EXTERNAL_SCHEMA_WAS_ACCEPTED')

    empty = document.xpath('//ext:ExtensionContent[not(*) and not(normalize-space())]', namespaces=ns)
    return {'result': 'PASS' if all(r['passed'] for r in results) else 'FAIL',
            'scope': 'ISOLATED_SYNTHETIC_GRE09_PRIVATE04_STRUCTURE_ONLY',
            'archiveSha256': p['archiveSha256'], 'schema': '2.1/maindoc/UBL-DespatchAdvice-2.1.xsd',
            'schemaRequests': resolver.requests, 'emptyPreviewExtensionContent': bool(empty),
            'negativeChecks': ['missing root ID', 'incorrect root order', 'DTD/entity',
                               'HTTP schema blocked by resolver', 'schema outside extracted bundle'],
            'policy': p['policy'], 'results': results,
            'limitation': 'XSD only; no SUNAT rules, numbering, signing, transmission or acceptance'}

try:
    payload = sys.stdin.buffer.read(2 * 1024 * 1024 + 1)
    require(len(payload) <= 2 * 1024 * 1024, 'INPUT_SIZE_LIMIT')
    report = validate(json.loads(payload))
except Exception as error:
    report = {'result': 'FAIL', 'stage': 'OFFLINE_XSD', 'error': type(error).__name__, 'message': str(error)[:3000]}
print(json.dumps(report, ensure_ascii=True))
sys.exit(0 if report['result'] == 'PASS' else 1)
`;

function pythonRuntime() {
  // Isolated mode ignores Python environment customization. Child processes receive
  // an empty environment, so credentials and application configuration are not forwarded.
  const probe = 'import json,sys; from lxml import etree; print(json.dumps({"executable":sys.executable,"lxml":list(etree.LXML_VERSION)}))';
  const failures = [];
  for (const [command, prefix] of [['python', []], ['python3', []], ['py', ['-3']]]) {
    const child = spawnSync(command, [...prefix, '-I', '-B', '-c', probe], {
      env: {}, encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true,
    });
    if (!child.error && child.status === 0) {
      const found = JSON.parse(child.stdout);
      assert.ok(isAbsolute(found.executable), 'PYTHON_EXECUTABLE_MUST_BE_ABSOLUTE');
      return found;
    }
    failures.push({ command, code: child.error?.code ?? child.status,
      detail: (child.stderr || '').trim().slice(0, 500) });
  }
  throw new Error('PYTHON_LXML_REQUIRED: install/enable Python 3 with lxml; test was NOT skipped. ' + JSON.stringify(failures));
}

function assertPolicy(value) {
  for (const [key, expected] of Object.entries(POLICY)) assert.equal(value[key], expected, key);
}

function main() {
  assert.deepEqual(process.argv.slice(2), ['--isolated-synthetic-only'], 'ISOLATED_SYNTHETIC_ONLY_REQUIRED');
  const archive = join(REPO, 'services/sunat-service/assets/sunat/xsd-20220228.zip');
  assert.ok(statSync(archive).size <= 4 * 1024 * 1024, 'ARCHIVE_SIZE_LIMIT');
  assert.equal(createHash('sha256').update(readFileSync(archive)).digest('hex'), ZIP_SHA256, 'ARCHIVE_SHA256_MISMATCH');
  const runtime = pythonRuntime();
  // Import only compiled pure preparation functions, never TS fixtures or services.
  const { prepareGuide09, validateGuide09Plan, renderGuide09PreparationXml, GUIDE09_PREPARATION_PROFILE } =
    require(join(REPO, 'packages/sunat-core/dist/fiscal-guide-preparation.js'));
  const { fiscalSnapshotSha256 } = require(join(REPO, 'packages/sunat-core/dist/fiscal-note.js'));
  assert.equal(GUIDE09_PREPARATION_PROFILE, PROFILE);
  const issuer = { ruc: '20000000001', legalName: 'EMPRESA FICTICIA DE ENSAYO' };
  const body = {
    issueDate: '2026-10-21T15:30:00.000Z', transferDate: '2026-10-21', reasonCode: '04',
    origin: { ubigeo: '150101', address: 'ORIGEN FICTICIO', establishmentCode: '0001' },
    destination: { ubigeo: '150102', address: 'DESTINO FICTICIO', establishmentCode: '0002' },
    sender: { ...issuer }, recipient: { ...issuer }, grossWeight: '1.250', weightUnit: 'KGM',
    transport: { mode: '02', vehicle: { plate: 'ABC123', registration: 'FICTICIO01' },
      driver: { identityType: '1', identityNumber: '00000001', firstName: 'CONDUCTOR FICTICIO',
        lastName: 'DE ENSAYO', license: 'Q000000001' } },
    items: [{ code: 'FICTICIO-1', description: 'ARTICULO FICTICIO & <ENSAYO>', quantity: '2.000001', unitCode: 'NIU' }],
    references: [], regulatedGoods: false,
  };
  const input = { schemaVersion: 'factuez.guide09-preparation-input.v1',
    draftId: '00000000-0000-4000-8000-000000000001', draftRevision: '"v1"',
    draftBodySha256: fiscalSnapshotSha256(body), issuer, body };
  const before = JSON.stringify(input);
  const plan = prepareGuide09(input);
  assertPolicy(plan);
  assert.deepEqual(validateGuide09Plan(plan), plan);
  const preview = renderGuide09PreparationXml(plan, { series: 'TST0', number: '1' });
  assertPolicy(preview);
  assert.equal(preview.proposedFullNumber, 'TST0-1');
  assert.equal(preview.planSha256, plan.planSha256);
  assert.equal(preview.xmlSha256, createHash('sha256').update(preview.xml, 'utf8').digest('hex'));
  assert.equal(JSON.stringify(input), before, 'INPUT_MUTATED');
  assert.deepEqual(renderGuide09PreparationXml(plan, { series: 'TST0', number: '1' }), preview);
  const altered = structuredClone(plan);
  altered.transmissionAuthorized = true;
  assert.throws(() => renderGuide09PreparationXml(altered, { series: 'TST0', number: '1' }),
    error => error?.code === 'GUIDE_PREPARATION_PLAN_MISMATCH');

  const tempParent = realpathSync(tmpdir());
  const ownRoot = mkdtempSync(join(tempParent, 'factuez-guide09-xsd-'));
  let report;
  try {
    const child = spawnSync(runtime.executable, ['-I', '-B', '-c', PYTHON], {
      input: JSON.stringify({ ownRoot, archive, archiveSha256: ZIP_SHA256,
        validator: join(__dirname, 'validate-official-xsd.py'), xml: preview.xml, policy: POLICY }),
      env: {}, encoding: 'utf8', timeout: 45000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    if (child.error) throw new Error('PYTHON_XSD_FAILED: ' + child.error.code);
    if (child.signal || !child.stdout.trim()) throw new Error('PYTHON_XSD_FAILED: ' + (child.stderr || child.signal || child.status));
    report = JSON.parse(child.stdout);
    assert.ok([0, 1].includes(child.status), 'PYTHON_XSD_UNEXPECTED_EXIT');
    assert.equal(child.status, report.result === 'PASS' ? 0 : 1, 'PYTHON_REPORT_EXIT_MISMATCH');
    report.runtime = { python: runtime.executable, lxml: runtime.lxml };
  } finally {
    // Only the exact mkdtemp directory owned by this invocation can be removed.
    assert.equal(dirname(ownRoot), tempParent, 'CLEANUP_OUTSIDE_TEMP_PARENT');
    assert.match(basename(ownRoot), /^factuez-guide09-xsd-[A-Za-z0-9]{6}$/);
    assert.ok(lstatSync(ownRoot).isDirectory() && !lstatSync(ownRoot).isSymbolicLink(), 'CLEANUP_ROOT_REPLACED');
    assert.equal(realpathSync(ownRoot), ownRoot, 'CLEANUP_ROOT_REDIRECTED');
    rmSync(ownRoot, { recursive: true, force: false });
  }
  report.cleanup = 'OWN_TEMP_REMOVED';
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== 'PASS') process.exitCode = 1;
}

try { main(); }
catch (error) {
  console.error(JSON.stringify({ result: 'FAIL', message: error.message }));
  process.exitCode = 1;
}
