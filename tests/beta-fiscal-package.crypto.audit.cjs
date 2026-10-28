'use strict';

// Sólo fixtures efímeros. No importar bootstrap, workers, repositorios ni transportes.
// La guarda precede incluso a la carga de dependencias y al acceso al filesystem.
if (process.argv.length !== 3 || process.argv[2] !== '--local-fixtures') {
  console.error('Uso exclusivo: node tests/beta-fiscal-package.crypto.audit.cjs --local-fixtures');
  process.exit(2);
}

const assert = require('node:assert/strict');
const { readFileSync, existsSync } = require('node:fs');
const { resolve, dirname, join, relative, isAbsolute } = require('node:path');
const { Module, createRequire } = require('node:module');
const { generateKeyPairSync, randomBytes, createHash, X509Certificate } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const REPO = resolve(__dirname, '..');
const serviceRequire = createRequire(join(REPO, 'services/sunat-service/package.json'));
const RUC = '20615878481';
const ARCHIVE_SHA256 = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const SAC = 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1';
const C14N = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const ROOTS = Object.freeze({
  Invoice: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
  CreditNote: 'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2',
  DebitNote: 'urn:oasis:names:specification:ubl:schema:xsd:DebitNote-2',
  SummaryDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1',
  VoidedDocuments: 'urn:sunat:names:specification:ubl:peru:schema:xsd:VoidedDocuments-1',
});
let stage = 'DEPENDENCIES';
const sha = input => createHash('sha256').update(input).digest('hex');

// Defensa adicional: ninguna dependencia del circuito puede abrir conexiones o
// iniciar procesos. Se conserva execFileSync únicamente para Python/XSD por stdin.
const originalLoad = Module._load;
Module._load = function (name, parent, main) {
  const bare = name.replace(/^node:/, '');
  if (['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'child_process'].includes(bare) ||
      /^(?:@prisma\/|@nestjs\/(?:core|platform-)|pg(?:\/|$)|redis(?:\/|$)|ioredis(?:\/|$)|bullmq(?:\/|$)|soap(?:\/|$)|nodemailer(?:\/|$))/.test(bare)) {
    throw new Error('Dependencia de transporte o persistencia prohibida en auditoría');
  }
  return originalLoad.call(this, name, parent, main);
};
globalThis.fetch = () => { throw new Error('Red prohibida en auditoría'); };
globalThis.WebSocket = class { constructor() { throw new Error('Red prohibida en auditoría'); } };

const forge = serviceRequire('node-forge');
const { DOMParser } = serviceRequire('@xmldom/xmldom');
const { SignedXml } = serviceRequire('xml-crypto');
const { unzipSync, zipSync } = serviceRequire('fflate');
const ts = serviceRequire('typescript');

function inside(root, candidate) {
  const name = relative(root, candidate);
  return name !== '' && !name.startsWith('..') && !isAbsolute(name);
}

// Compilación sólo en memoria: no requiere build, no escribe dist ni instala nada.
// El allowlist evita resolver accidentalmente services/application o bootstrap.
const sourceCache = new Map();
const cryptoSources = new Set([
  'beta-fiscal-package-pipeline.ts', 'xml-signer.service.ts',
  'certificate-inspector.ts', 'certificate-identity.ts',
].map(name => join(REPO, 'services/sunat-service/src/infrastructure/crypto', name)));
const validatorSources = new Set(['beta-package-validator.ts', 'safe-xml.ts', 'notes-transport-qa-validator.ts']
  .map(name => join(REPO, 'services/sunat-service/src/infrastructure/sunat', name)));
function loadSource(file) {
  file = resolve(file);
  assert.ok(cryptoSources.has(file) || validatorSources.has(file) || inside(join(REPO, 'packages/sunat-core/src'), file) ||
    inside(join(REPO, 'packages/contracts/src'), file), 'Import fuera del circuito puro permitido');
  assert.ok(file.endsWith('.ts') && existsSync(file), 'Falta un módulo fuente requerido');
  if (sourceCache.has(file)) return sourceCache.get(file).exports;
  const source = readFileSync(file, 'utf8');
  const compiled = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS,
      esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true },
  });
  assert.ok(!(compiled.diagnostics ?? []).some(item => item.category === ts.DiagnosticCategory.Error), 'Fuente no transpila');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.auditSourceSha256 = sha(source);
  loaded.paths = Module._nodeModulePaths(dirname(file));
  sourceCache.set(file, loaded);
  const local = createRequire(file);
  loaded.require = name => {
    if (name.startsWith('.')) {
      const target = resolve(dirname(file), name);
      return loadSource(target.endsWith('.ts') ? target : target.replace(/\.js$/, '') + '.ts');
    }
    if (name === '@factuez/sunat-core') return loadSource(join(REPO, 'packages/sunat-core/src/index.ts'));
    if (name.startsWith('@factuez/sunat-core/')) {
      const suffix = name.slice('@factuez/sunat-core/'.length).replace(/^(?:src|dist)\//, '').replace(/\.(?:js|ts)$/, '');
      return loadSource(join(REPO, 'packages/sunat-core/src', suffix + '.ts'));
    }
    if (name === '@factuez/contracts') return loadSource(join(REPO, 'packages/contracts/src/index.ts'));
    assert.ok(['node:crypto', 'crypto', '@nestjs/common', 'node-forge', '@xmldom/xmldom',
      'xml-crypto', 'fflate', 'reflect-metadata'].includes(name), 'Dependencia no incluida en el circuito puro');
    return local(name);
  };
  loaded._compile(compiled.outputText, file);
  return loaded.exports;
}

function certificateFixture(subjectRuc = RUC, selfSigned = false, options = {}) {
  const keys = () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    return { privateKey: forge.pki.privateKeyFromPem(pair.privateKey), publicKey: forge.pki.publicKeyFromPem(pair.publicKey) };
  };
  const make = (pair, subject, issuer, ca) => {
    const certificate = forge.pki.createCertificate();
    certificate.publicKey = pair.publicKey;
    certificate.serialNumber = randomBytes(16).toString('hex').replace(/^./, '1');
    certificate.validity.notBefore = new Date(Date.now() - 3_600_000);
    certificate.validity.notAfter = new Date(Date.now() + 86_400_000);
    certificate.setSubject(subject);
    certificate.setIssuer(issuer ?? subject);
    certificate.setExtensions([{ name: 'basicConstraints', cA: ca, critical: true },
      { name: 'keyUsage', digitalSignature: !ca && options.digitalSignature !== false, keyCertSign: ca, cRLSign: ca, critical: true }]);
    return certificate;
  };
  const caPair = keys(), pair = keys();
  const ca = make(caPair, [{ name: 'commonName', value: 'CA FIXTURE LOCAL SIN CONFIANZA PUBLICA' }], undefined, true);
  ca.sign(caPair.privateKey, forge.md.sha256.create());
  const certificate = make(pair, [{ name: 'commonName', value: 'FIXTURE SIN IDENTIDAD NI VALOR FISCAL' },
    { type: '2.5.4.97', value: 'NTRPE-' + subjectRuc }], selfSigned ? undefined : ca.subject.attributes, false);
  if (options.expired) {
    certificate.validity.notBefore = new Date(Date.now() - 172_800_000);
    certificate.validity.notAfter = new Date(Date.now() - 3_600_000);
  }
  certificate.sign(selfSigned ? pair.privateKey : caPair.privateKey, forge.md.sha256.create());
  const pem = forge.pki.certificateToPem(certificate);
  const pinned = new X509Certificate(pem);
  assert.equal(pinned.ca, false);
  assert.ok(pinned.verify(selfSigned ? pinned.publicKey : new X509Certificate(forge.pki.certificateToPem(ca)).publicKey));
  const password = randomBytes(32).toString('hex');
  const p12 = Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(pair.privateKey,
    selfSigned ? certificate : [certificate, ca], password, { algorithm: 'aes256' })).getBytes(), 'binary');
  return { p12, password, pem, fingerprint: sha(pinned.raw) };
}

function parseXml(xml, rootName) {
  assert.ok(Object.hasOwn(ROOTS, rootName), 'Raíz fuera de la matriz');
  assert.ok(typeof xml === 'string' && Buffer.byteLength(xml) <= 2 * 1024 * 1024 && !/<!|<\?(?!xml\s)/i.test(xml), 'XML inseguro');
  const doc = new DOMParser({ onError: () => { throw new Error('XML mal formado'); } }).parseFromString(xml, 'application/xml');
  const root = doc.documentElement;
  assert.equal(root.localName, rootName, 'Nombre de raíz distinto');
  assert.equal(root.namespaceURI, ROOTS[rootName], 'Namespace de raíz distinto');
  assert.equal(doc.getElementsByTagNameNS(ROOTS[rootName], rootName).length, 1, 'Raíz duplicada');
  const ids = new Set(), pending = [{ node: root, depth: 1 }];
  let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    assert.ok(++count <= 30000 && depth <= 40, 'Complejidad XML excedida');
    assert.ok(!node.hasAttributeNS('http://www.w3.org/XML/1998/namespace', 'base') &&
      !node.hasAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'schemaLocation') &&
      !node.hasAttributeNS('http://www.w3.org/2001/XMLSchema-instance', 'noNamespaceSchemaLocation') &&
      node.namespaceURI !== 'http://www.w3.org/2001/XInclude', 'Referencia XML externa');
    for (let index = 0; index < node.attributes.length; index++) {
      const attr = node.attributes.item(index);
      if (['id', 'Id', 'ID'].includes(attr.localName)) {
        assert.ok(attr.value && !ids.has(attr.value), 'ID XML vacío o duplicado'); ids.add(attr.value);
      }
    }
    for (let child = node.firstChild; child; child = child.nextSibling)
      if (child.nodeType === 1) pending.push({ node: child, depth: depth + 1 });
  }
  return { doc, root };
}

function verifySignature(xml, pem, unsignedXml, rootName) {
  const { doc, root } = parseXml(xml, rootName);
  const extensions = doc.getElementsByTagNameNS(EXT, 'ExtensionContent');
  assert.equal(extensions.length, 1, 'Una extensión requerida');
  const extension = extensions[0];
  assert.equal(extension.parentNode.localName, 'UBLExtension');
  assert.equal(extension.parentNode.parentNode.localName, 'UBLExtensions');
  assert.equal(extension.parentNode.parentNode.parentNode, root);
  const signatures = doc.getElementsByTagNameNS(DS, 'Signature');
  assert.equal(signatures.length, 1, 'Una sola firma requerida');
  const signature = signatures[0];
  assert.equal(signature.parentNode, extension, 'Firma fuera de la extensión');
  const one = name => {
    const found = signature.getElementsByTagNameNS(DS, name);
    assert.equal(found.length, 1, 'Cardinalidad XMLDSig inválida: ' + name); return found[0];
  };
  assert.equal(one('Reference').getAttribute('URI'), '', 'Referencia debe autenticar la raíz completa');
  assert.equal(one('CanonicalizationMethod').getAttribute('Algorithm'), C14N);
  assert.equal(one('SignatureMethod').getAttribute('Algorithm'), RSA256);
  assert.equal(one('DigestMethod').getAttribute('Algorithm'), SHA256);
  const transforms = signature.getElementsByTagNameNS(DS, 'Transform');
  assert.equal(transforms.length, 2);
  assert.equal(transforms[0].getAttribute('Algorithm'), DS + 'enveloped-signature');
  assert.equal(transforms[1].getAttribute('Algorithm'), C14N);
  const embedded = one('X509Certificate').textContent ?? '';
  assert.match(embedded, /^[A-Za-z0-9+/=\s]+$/);
  assert.ok(new X509Certificate(Buffer.from(embedded.replace(/\s/g, ''), 'base64')).raw.equals(new X509Certificate(pem).raw), 'Certificado embebido distinto del fixture fijado');
  const verifier = new SignedXml({ publicCert: pem, getCertFromKeyInfo: () => null });
  verifier.loadSignature(signature);
  assert.equal(verifier.checkSignature(xml), true, 'Firma criptográfica inválida');
  const authenticated = verifier.getSignedReferences();
  assert.equal(authenticated.length, 1, 'Una referencia autenticada requerida');
  const trusted = parseXml(authenticated[0], rootName), expected = parseXml(unsignedXml, rootName);
  assert.equal(trusted.doc.getElementsByTagNameNS(DS, 'Signature').length, 0);
  assert.equal(expected.doc.getElementsByTagNameNS(DS, 'Signature').length, 0);
  const canonical = value => new SignedXml().getCanonXml([C14N], value);
  assert.equal(canonical(trusted.root), canonical(expected.root), 'XML autenticado distinto del snapshot');
  const digest = one('DigestValue').textContent ?? '';
  assert.match(digest, /^[A-Za-z0-9+/]{43}=$/);
  return digest;
}

// Python usa el ZIP fijado por stdin y un resolver de bytes en memoria. La URL
// file:///__factuez_fixture_xsd__/ es virtual; nunca se consulta ese filesystem.
const XSD_AUDIT = String.raw`
import base64, hashlib, io, json, posixpath, re, sys, zipfile
from urllib.parse import unquote, urlparse
from lxml import etree

EXPECTED = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5'
BASE = '/__factuez_fixture_xsd__/'
payload = json.load(sys.stdin)
archive = base64.b64decode(payload['archive'], validate=True)
assert len(archive) == 609363 and hashlib.sha256(archive).hexdigest() == EXPECTED
schemas = {}
with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
    names = bundle.namelist()
    assert len(names) == len(set(names))
    entries = [entry for entry in bundle.infolist() if entry.filename.endswith('.xsd')]
    assert 0 < len(entries) <= 128
    assert sum(entry.file_size for entry in entries) <= 32 * 1024 * 1024
    for entry in entries:
        assert 0 < entry.file_size <= 5 * 1024 * 1024
        assert re.fullmatch(r'Archivos XSD/(2\.0|2\.1)/[A-Za-z0-9_./-]+\.xsd', entry.filename)
        assert posixpath.normpath(entry.filename) == entry.filename
        schemas[entry.filename] = bundle.read(entry)

class MemorySchemas(etree.Resolver):
    def resolve(self, url, public_id, context):
        parsed = urlparse(url)
        if parsed.scheme != 'file' or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError('Import XSD externo bloqueado')
        path = unquote(parsed.path)
        if not path.startswith(BASE):
            raise ValueError('Import XSD fuera del paquete')
        name = posixpath.normpath(path[len(BASE):])
        if name not in schemas:
            raise ValueError('Import XSD desconocido')
        return self.resolve_string(schemas[name], context, base_url='file://' + BASE + name)

def schema_parser():
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False)
    parser.resolvers.add(MemorySchemas())
    return parser

def xml_root(xml):
    data = xml.encode('utf-8')
    if not data or len(data) > 2 * 1024 * 1024 or re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', data, re.I):
        raise ValueError('XML inseguro')
    root = etree.fromstring(data, etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False))
    if len(list(root.iter())) > 30000:
        raise ValueError('Complejidad XML excedida')
    for node in root.iter():
        if node.tag == '{http://www.w3.org/2001/XInclude}include' or any(key in node.attrib for key in (
            '{http://www.w3.org/XML/1998/namespace}base',
            '{http://www.w3.org/2001/XMLSchema-instance}schemaLocation',
            '{http://www.w3.org/2001/XMLSchema-instance}noNamespaceSchemaLocation')):
            raise ValueError('Referencia XML externa')
    return root

entries = {
    'Invoice': '2.1/maindoc/UBL-Invoice-2.1.xsd',
    'CreditNote': '2.1/maindoc/UBL-CreditNote-2.1.xsd',
    'DebitNote': '2.1/maindoc/UBL-DebitNote-2.1.xsd',
    'SummaryDocuments': '2.0/maindoc/UBLPE-SummaryDocuments-1.0.xsd',
    'VoidedDocuments': '2.0/maindoc/UBLPE-VoidedDocuments-1.0.xsd',
}
compiled = {}
for kind, entry in entries.items():
    name = 'Archivos XSD/' + entry
    compiled[kind] = etree.XMLSchema(etree.fromstring(schemas[name], schema_parser(), base_url='file://' + BASE + name))

results = []
for case in payload['cases']:
    root = xml_root(case['xml'])
    assert root.tag == '{' + case['namespace'] + '}' + case['rootName']
    schema = compiled[case['rootName']]
    valid = schema.validate(root)
    errors = [{'line': error.line, 'type': error.type_name, 'message': error.message[:500]} for error in list(schema.error_log)[:10]]
    incomplete = xml_root(case['xml'])
    ids = incomplete.findall('{urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2}ID')
    assert len(ids) == 1
    incomplete.remove(ids[0])
    assert not schema.validate(incomplete), 'XSD admitió documento sin ID raíz'
    wrong = xml_root(case['xml'])
    wrong.tag = '{urn:fixture:incorrect}' + case['rootName']
    assert not schema.validate(wrong), 'XSD admitió namespace incorrecto'
    results.append({'case': case['id'], 'rootName': case['rootName'], 'xmlSha256': hashlib.sha256(case['xml'].encode()).hexdigest(),
                    'xsdValid': valid, 'errors': errors, 'negativeChecks': ['missing-root-ID', 'wrong-root-namespace']})

for xml in ('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///fixture-never-read">]><x>&e;</x>',
            '<x xml:base="https://fixture.invalid/"/>',
            '<x xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="x https://fixture.invalid/x.xsd"/>',
            '<xi:include xmlns:xi="http://www.w3.org/2001/XInclude" href="file:///fixture-never-read"/>'):
    try:
        xml_root(xml)
    except ValueError:
        pass
    else:
        raise AssertionError('Se admitió XML con referencias externas')
for target in ('https://fixture.invalid/schema.xsd', 'file:///fixture-outside-bundle.xsd'):
    malicious = ('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="' + target + '"/></xs:schema>').encode()
    try:
        etree.XMLSchema(etree.fromstring(malicious, schema_parser(), base_url='file://' + BASE + 'malicious.xsd'))
    except (ValueError, etree.XMLSchemaParseError):
        pass
    else:
        raise AssertionError('Se admitió import XSD externo')
print(json.dumps({'archiveSha256': EXPECTED, 'schemaEngine': 'lxml/libxml2', 'schemasInMemory': True,
                  'externalReferencesBlocked': True, 'results': results}))
`;

function validateXsd(cases) {
  const archive = readFileSync(join(REPO, 'services/sunat-service/assets/sunat/xsd-20220228.zip'));
  assert.equal(archive.length, 609363, 'Tamaño de ZIP XSD inesperado');
  assert.equal(sha(archive), ARCHIVE_SHA256, 'Hash del ZIP XSD inesperado');
  const bundled = 'C:/Users/maxmo/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
  const executable = existsSync(bundled) ? bundled : process.platform === 'win32' ? 'python.exe' : 'python3';
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH } : { PATH: process.env.PATH };
  const output = execFileSync(executable, ['-I', '-B', '-c', XSD_AUDIT], {
    cwd: REPO, shell: false, windowsHide: true, env,
    input: JSON.stringify({ archive: archive.toString('base64'), cases }),
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function direct(parent, namespace, name) {
  const found = [];
  for (let node = parent.firstChild; node; node = node.nextSibling)
    if (node.nodeType === 1 && node.namespaceURI === namespace && node.localName === name) found.push(node);
  return found;
}
function element(parent, namespace, name) {
  const found = direct(parent, namespace, name);
  assert.equal(found.length, 1, 'Nodo esperado único: ' + name); return found[0];
}
const textOf = (parent, namespace, name) => element(parent, namespace, name).textContent;

function buildFixtures() {
  const core = loadSource(join(REPO, 'packages/sunat-core/src/fiscal-note.ts'));
  const batchCore = loadSource(join(REPO, 'packages/sunat-core/src/fiscal-batch.ts'));
  const { calculateDocumentTotals } = loadSource(join(REPO, 'packages/sunat-core/src/tax.ts'));
  for (const name of ['buildFiscalNoteSnapshot', 'validateFiscalNoteSnapshot', 'buildFiscalNoteUbl', 'fiscalSnapshotSha256'])
    assert.equal(typeof core[name], 'function', 'Falta API de nota: ' + name);
  for (const name of ['buildFiscalBatchSnapshot', 'validateFiscalBatchSnapshot', 'buildFiscalBatchUbl'])
    assert.equal(typeof batchCore[name], 'function', 'Falta API de lote: ' + name);
  const asOf = '2026-10-02T18:00:00Z';
  let sequence = 0;
  const id = () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0');
  const issuer = { identityType: '6', identityNumber: RUC, legalName: 'EMISOR FIXTURE SIN IDENTIDAD',
    address: 'DIRECCION FIXTURE', ubigeo: '150101', establishmentCode: '0001' };
  const original = (type, number, issueDate = '2026-10-01T16:00:00Z', price = '11.80') => ({
    documentId: id(), environment: 'BETA', documentTypeCode: type, series: type === '01' ? 'FX01' : 'BX01',
    number, fullNumber: `${type === '01' ? 'FX01' : 'BX01'}-${number}`, issueDate,
    currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' }, issuer: { ...issuer },
    customer: type === '01' ? { identityType: '6', identityNumber: RUC, legalName: 'CLIENTE FIXTURE SIN IDENTIDAD' }
      : { identityType: '0', identityNumber: '0', legalName: 'CLIENTE FIXTURE SIN IDENTIDAD' },
    ...calculateDocumentTotals([{ description: 'ITEM FIXTURE & <ESCAPE>', unitCode: 'NIU', quantity: '2',
      unitPriceWithTax: price, taxAffectationCode: '10', igvRate: '18' }]),
  });
  const acceptance = (snapshot, acceptedAt) => ({ environment: 'BETA', issuerRuc: RUC,
    documentId: snapshot.documentId, documentTypeCode: snapshot.documentTypeCode, fullNumber: snapshot.fullNumber,
    snapshotSha256: core.fiscalSnapshotSha256(snapshot), cdrSha256: sha('CDR FICTICIO SIN FIRMA: ' + snapshot.documentId),
    status: 'ACCEPTED', responseCode: '0', acceptedAt,
    source: snapshot.series.startsWith('B') ? { kind: 'CDR_SUMMARY',
      identifier: 'RC-' + core.fiscalLimaDate(snapshot.issueDate).replaceAll('-', '') + '-99',
      referenceDate: core.fiscalLimaDate(snapshot.issueDate), lineNumber: 1, conditionCode: '1' } : { kind: 'CDR_DOCUMENT' },
  });
  const notDelivered = snapshot => ({ status: 'NOT_DELIVERED', documentId: snapshot.documentId,
    documentTypeCode: snapshot.documentTypeCode, fullNumber: snapshot.fullNumber, issuerRuc: RUC,
    snapshotSha256: core.fiscalSnapshotSha256(snapshot), evidenceId: id(), assertedAt: '2026-10-02T15:00:00Z' });
  const context = snapshot => ({ original: snapshot, acceptance: acceptance(snapshot, '2026-10-01T17:00:00Z'),
    asOf, creditHistory: { complete: true, entries: [] } });
  const note = (ctx, type, reason, number) => {
    const input = { documentTypeCode: type, reasonCode: reason, reasonDescription: 'SUSTENTO FIXTURE & <SIN EFECTO FISCAL>' };
    if (type === '08' && reason === '02') input.lines = [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.18' }];
    if (type === '07' && reason === '07') input.lines = [{ originalLineNumber: 1, quantity: '1' }];
    if (type === '08' && reason === '01') {
      input.interestNature = 'MORATORIO'; input.interestBasis = 'SUPUESTO FIXTURE DECLARADO; SIN DEUDA NI CALCULO DE DIAS';
      input.lines = [{ originalLineNumber: 1, interestAmount: '2.00' }];
    }
    const snapshot = core.buildFiscalNoteSnapshot(ctx, input, { documentId: id(), series: ctx.original.documentTypeCode === '01' ? 'FN01' : 'BN01',
      number, issueDate: '2026-10-02T10:00:00Z' });
    core.validateFiscalNoteSnapshot(snapshot, ctx);
    assert.equal(snapshot.issuer.identityNumber, RUC, 'No debe cambiar identidad de entrada');
    return { snapshot, noteContext: ctx };
  };
  const ctxF = context(original('01', '1')), ctxB = context(original('03', '1'));
  const creditF = note(ctxF, '07', '01', '1'), debitF = note(ctxF, '08', '02', '2');
  const moraF = note(ctxF, '08', '01', '3');
  const creditB = note(ctxB, '07', '07', '1'), debitB = note(ctxB, '08', '02', '2'), moraB = note(ctxB, '08', '01', '3');

  const inspectNote = (root, value) => {
    assert.equal(textOf(root, CBC, 'ID'), value.fullNumber);
    assert.equal(textOf(root, CBC, 'UBLVersionID'), '2.1');
    assert.equal(textOf(root, CBC, 'CustomizationID'), '2.0');
    const reference = element(element(root, CAC, 'BillingReference'), CAC, 'InvoiceDocumentReference');
    assert.equal(textOf(reference, CBC, 'ID'), value.reference.fullNumber);
    assert.equal(textOf(reference, CBC, 'DocumentTypeCode'), value.reference.documentTypeCode);
    const discrepancy = element(root, CAC, 'DiscrepancyResponse');
    assert.equal(textOf(discrepancy, CBC, 'ReferenceID'), value.reference.fullNumber);
    assert.equal(textOf(discrepancy, CBC, 'ResponseCode'), value.reasonCode);
    assert.equal(textOf(discrepancy, CBC, 'Description'), value.reasonDescription);
    const lines = direct(root, CAC, (value.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote') + 'Line');
    assert.equal(lines.length, value.lines.length);
    for (const [index, line] of lines.entries()) {
      assert.equal(textOf(element(line, CAC, 'Item'), CBC, 'Description'), value.lines[index].description);
      const tax = element(element(element(line, CAC, 'TaxTotal'), CAC, 'TaxSubtotal'), CAC, 'TaxCategory');
      assert.equal(textOf(tax, CBC, 'TaxExemptionReasonCode'), value.lines[index].taxAffectationCode);
      assert.equal(textOf(element(tax, CAC, 'TaxScheme'), CBC, 'ID'), value.documentTypeCode === '08' && value.reasonCode === '01' ? '9998' : '1000');
    }
  };
  // El UBL de nota B se firma sólo para verificar builder/crypto/XSD. El circuito
  // del paquete Beta debe rechazarlo como NOTE/sendBill; su envío corresponde a RC.
  const xmlFixtures = [creditB, debitB, moraB].map(item => ({
    id: `XML-ONLY-B-${item.snapshot.documentTypeCode}-${item.snapshot.reasonCode}`,
    preparation: 'BUILDER_FIXTURE_SIGNER_ONLY', adapterPermitted: false,
    rootName: item.snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote',
    fileName: `${RUC}-${item.snapshot.documentTypeCode}-${item.snapshot.fullNumber}.zip`,
    reference: item.snapshot.fullNumber, referenceText: item.snapshot.reference.fullNumber,
    unsignedXml: core.buildFiscalNoteUbl(item.snapshot, item.noteContext), documentId: item.snapshot.documentId,
    inspect: parsed => inspectNote(parsed.root, item.snapshot),
  }));

  const fixtures = [creditF, debitF, moraF].map(item => ({
    id: `NOTE-F-${item.snapshot.documentTypeCode}-${item.snapshot.reasonCode}`,
    preparation: 'BETA_FISCAL_PIPELINE', adapterPermitted: true,
    envelope: { kind: 'NOTE', note: item.snapshot, context: item.noteContext },
    rootName: item.snapshot.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote',
    fileName: `${RUC}-${item.snapshot.documentTypeCode}-${item.snapshot.fullNumber}.zip`,
    reference: item.snapshot.fullNumber, referenceText: item.snapshot.reference.fullNumber,
    unsignedXml: core.buildFiscalNoteUbl(item.snapshot, item.noteContext),
    method: 'sendBill', documentId: item.snapshot.documentId,
    inspect: parsed => inspectNote(parsed.root, item.snapshot),
  }));

  const high = original('03', '2', '2026-10-02T10:00:00Z');
  const prior = original('03', '3', '2026-10-02T10:00:00Z');
  const changed = { ...structuredClone(prior), ...calculateDocumentTotals([{ description: 'MODIFICACION FIXTURE', unitCode: 'NIU',
    quantity: '2', unitPriceWithTax: '23.60', taxAffectationCode: '10', igvRate: '18' }]) };
  const down = original('03', '4', '2026-10-02T10:00:00Z');
  const rcEntries = [{ document: { snapshot: high }, conditionCode: '1' },
    { document: { snapshot: changed }, conditionCode: '2', previous: { document: { snapshot: prior }, acceptance: acceptance(prior, '2026-10-02T14:00:00Z') } },
    { document: { snapshot: down }, conditionCode: '3', previous: { document: { snapshot: down }, acceptance: acceptance(down, '2026-10-02T14:00:00Z') }, notDelivered: notDelivered(down) },
    ...[creditB, debitB, moraB].map(document => ({ document, conditionCode: '1' }))];
  const invoice = original('01', '2', '2026-10-02T10:00:00Z');
  const raEntries = [{ snapshot: invoice }, creditF, debitF].map(document => ({ document,
    acceptance: acceptance(document.snapshot, '2026-10-02T14:00:00Z'), notDelivered: notDelivered(document.snapshot),
    reasonDescription: 'BAJA FIXTURE SIN ENTREGA NI EFECTO FISCAL' }));
  for (const [kind, entries] of [['RC', rcEntries], ['RA', raEntries]]) {
    const batch = batchCore.buildFiscalBatchSnapshot({ kind, entries }, { documentId: id(), identifier: `${kind}-20261002-1`,
      issueDate: '2026-10-02', referenceDate: '2026-10-02' }, asOf);
    batchCore.validateFiscalBatchSnapshot(batch, asOf);
    fixtures.push({ id: kind === 'RC' ? 'RC-MULTI-03-07-08-ALTA-MODIFICACION-BAJA' : 'RA-MULTI-01-07-08-NOT-DELIVERED',
      preparation: 'BETA_FISCAL_PIPELINE', adapterPermitted: true,
      envelope: { kind: 'BATCH', batch, asOf }, rootName: kind === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments',
      fileName: `${RUC}-${batch.identifier}.zip`, reference: batch.identifier, referenceText: batch.identifier,
      unsignedXml: batchCore.buildFiscalBatchUbl(batch, asOf), method: 'sendSummary', documentId: batch.documentId,
      inspect: ({ root }) => {
        assert.equal(textOf(root, CBC, 'ID'), batch.identifier);
        assert.equal(textOf(root, CBC, 'ReferenceDate'), batch.referenceDate);
        assert.equal(textOf(root, CBC, 'UBLVersionID'), '2.0');
        assert.equal(textOf(root, CBC, 'CustomizationID'), kind === 'RC' ? '1.1' : '1.0');
        const lines = direct(root, SAC, kind === 'RC' ? 'SummaryDocumentsLine' : 'VoidedDocumentsLine');
        assert.equal(lines.length, entries.length);
        for (const [index, line] of lines.entries()) {
          const entry = entries[index], value = entry.document.snapshot;
          assert.equal(textOf(line, CBC, 'LineID'), String(index + 1));
          assert.equal(textOf(line, CBC, 'DocumentTypeCode'), value.documentTypeCode);
          if (kind === 'RA') {
            assert.equal(textOf(line, SAC, 'DocumentSerialID'), value.series);
            assert.equal(textOf(line, SAC, 'DocumentNumberID'), value.number);
            assert.equal(textOf(line, SAC, 'VoidReasonDescription'), entry.reasonDescription);
          } else {
            assert.equal(textOf(line, CBC, 'ID'), value.fullNumber);
            assert.equal(textOf(element(line, CAC, 'Status'), CBC, 'ConditionCode'), entry.conditionCode);
            assert.equal(textOf(line, SAC, 'TotalAmount'), value.totals.payableAmount);
            if (['07', '08'].includes(value.documentTypeCode)) {
              const reference = element(element(line, CAC, 'BillingReference'), CAC, 'InvoiceDocumentReference');
              assert.equal(textOf(reference, CBC, 'DocumentTypeCode'), '03');
              assert.equal(textOf(reference, CBC, 'ID'), value.reference.fullNumber);
            }
            if (value.documentTypeCode === '08' && value.reasonCode === '01') {
              const payments = direct(line, SAC, 'BillingPayment');
              assert.equal(textOf(payments.find(p => textOf(p, CBC, 'InstructionID') === '03'), CBC, 'PaidAmount'), value.totals.unaffectedAmount);
            }
          }
        }
      },
    });
  }
  const { buildInvoiceUbl } = loadSource(join(REPO, 'packages/sunat-core/src/ubl.ts'));
  const { assertFiscalSnapshot } = loadSource(join(REPO, 'packages/sunat-core/src/fiscal-rules.ts'));
  assertFiscalSnapshot(invoice, { mode: 'REAL_PREPARATION', now: new Date(asOf) });
  xmlFixtures.push({ id: 'INVOICE-01-OFFLINE-ADAPTER', preparation: 'BUILDER_FIXTURE_SIGNER_ONLY', adapterPermitted: true,
    rootName: 'Invoice', fileName: `${RUC}-01-${invoice.fullNumber}.zip`, reference: invoice.fullNumber,
    referenceText: invoice.fullNumber, unsignedXml: buildInvoiceUbl(invoice, { mode: 'REAL_PREPARATION' }),
    method: 'sendBill', documentId: invoice.documentId, inspect: ({ root }) => {
      assert.equal(textOf(root, CBC, 'ID'), invoice.fullNumber);
      assert.equal(textOf(root, CBC, 'InvoiceTypeCode'), '01');
      const payment = element(root, CAC, 'PaymentTerms');
      assert.equal(textOf(payment, CBC, 'ID'), 'FormaPago');
      assert.equal(textOf(payment, CBC, 'PaymentMeansID'), 'Contado');
    },
  });
  return { fixtures, xmlFixtures, forbiddenNoteB: { kind: 'NOTE', note: creditB.snapshot, context: creditB.noteContext } };
}

async function main() {
  stage = 'PURE_SOURCE_CONTRACT';
  const pipelinePath = join(REPO, 'services/sunat-service/src/infrastructure/crypto/beta-fiscal-package-pipeline.ts');
  const pipelineAvailable = existsSync(pipelinePath);
  const prepareBetaFiscalPackage = pipelineAvailable ? loadSource(pipelinePath).prepareBetaFiscalPackage : undefined;
  if (pipelineAvailable) assert.equal(typeof prepareBetaFiscalPackage, 'function', 'Falta export prepareBetaFiscalPackage');
  const { validateBetaPackage } = loadSource(join(REPO, 'services/sunat-service/src/infrastructure/sunat/beta-package-validator.ts'));
  assert.equal(typeof validateBetaPackage, 'function', 'Falta export validateBetaPackage');
  const { fixtures, xmlFixtures, forbiddenNoteB } = buildFixtures();
  const { XmlSignerService } = loadSource(join(REPO, 'services/sunat-service/src/infrastructure/crypto/xml-signer.service.ts'));
  stage = 'EPHEMERAL_CERTIFICATES';
  const materials = [];
  const results = [], xsdCases = [];
  try {
    const remember = value => { materials.push(value); return value; };
    const certificate = remember(certificateFixture()), unrelated = remember(certificateFixture());
    const selfSigned = remember(certificateFixture(RUC, true)), otherRuc = remember(certificateFixture('20615878480'));
    const expired = remember(certificateFixture(RUC, false, { expired: true }));
    const noSignatureUsage = remember(certificateFixture(RUC, false, { digitalSignature: false }));
    for (const fixture of [...(pipelineAvailable ? fixtures : []), ...xmlFixtures]) {
      stage = fixture.id;
      const before = JSON.stringify(fixture.envelope);
      let prepared;
      if (fixture.preparation === 'BETA_FISCAL_PIPELINE') {
        prepared = await prepareBetaFiscalPackage(fixture.envelope, certificate.p12, certificate.password);
      } else {
        const signed = new XmlSignerService().sign(fixture.unsignedXml, certificate.p12, certificate.password, fixture.rootName);
        prepared = { xml: signed.xml, signed, rootName: fixture.rootName, fileName: fixture.fileName, reference: fixture.reference,
          zip: Buffer.from(zipSync({ [fixture.fileName.replace(/\.zip$/, '.xml')]: Buffer.from(signed.xml) }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') })) };
      }
      assert.equal(JSON.stringify(fixture.envelope), before, 'El pipeline mutó el snapshot');
      assert.equal(prepared.rootName, fixture.rootName, 'Raíz de paquete distinta');
      assert.equal(prepared.fileName, fixture.fileName, 'Nombre de paquete distinto');
      assert.match(prepared.fileName, /\.zip$/, 'Nombre de paquete debe incluir extensión ZIP');
      if (fixture.preparation === 'BETA_FISCAL_PIPELINE') assert.equal(prepared.method, fixture.method, 'Método del pipeline distinto');
      assert.deepEqual(prepared.reference, fixture.reference, 'Referencia de paquete distinta');
      assert.equal(prepared.xml, prepared.signed.xml, 'XML externo distinto del resultado firmado');
      const digest = verifySignature(prepared.xml, certificate.pem, fixture.unsignedXml, fixture.rootName);
      assert.equal(prepared.signed.digestValue, digest, 'Digest reportado distinto');
      assert.equal(prepared.signed.certificateFingerprintSha256, certificate.fingerprint, 'Huella reportada distinta');
      assert.ok(Buffer.isBuffer(prepared.zip) || prepared.zip instanceof Uint8Array, 'ZIP debe ser bytes');
      const extracted = unzipSync(prepared.zip);
      const xmlName = fixture.fileName.replace(/\.zip$/, '.xml');
      assert.deepEqual(Object.keys(extracted), [xmlName], 'ZIP debe contener un único XML de nombre exacto');
      assert.ok(Buffer.from(extracted[xmlName]).equals(Buffer.from(prepared.xml, 'utf8')), 'ZIP distinto de los bytes firmados');
      const parsed = parseXml(prepared.xml, fixture.rootName);
      fixture.inspect(parsed);
      const adapterPackage = { documentId: fixture.documentId, fileName: fixture.fileName,
        zip: Buffer.from(prepared.zip), sha256: sha(prepared.zip) };
      const adapterNegativeChecks = [];
      if (fixture.adapterPermitted) {
        const adapterProof = validateBetaPackage(adapterPackage, RUC, fixture.method);
        assert.equal(adapterProof.xml, prepared.xml, 'Adaptador debe inspeccionar los mismos bytes');
        assert.equal(adapterProof.rootName, prepared.rootName);
        assert.equal(adapterProof.reference, prepared.reference);
        assert.equal(adapterProof.digest, digest);
        assert.equal(adapterProof.certificateFingerprint, certificate.fingerprint);
        assert.throws(() => validateBetaPackage(adapterPackage, RUC, fixture.method === 'sendBill' ? 'sendSummary' : 'sendBill'), 'Ruta de envío opuesta debe rechazarse');
        assert.throws(() => validateBetaPackage({ ...adapterPackage, sha256: '0'.repeat(64) }, RUC, fixture.method), 'Hash ZIP incorrecto debe rechazarse');
        assert.throws(() => validateBetaPackage(adapterPackage, '20615878480', fixture.method), 'RUC distinto debe rechazarse');
        const multiple = Buffer.from(zipSync({ [xmlName]: Buffer.from(prepared.xml), 'extra.xml': Buffer.from(prepared.xml) }));
        assert.throws(() => validateBetaPackage({ ...adapterPackage, zip: multiple, sha256: sha(multiple) }, RUC, fixture.method), 'ZIP ambiguo debe rechazarse');
        const changedContent = fixture.rootName === 'VoidedDocuments'
          ? prepared.xml.replace(/(<sac:VoidReasonDescription>)([^<]+)(<\/sac:VoidReasonDescription>)/,
            (_, open, value, close) => open + 'ALTERACION FIXTURE' + close)
          : prepared.xml.replace(/(<cbc:TaxAmount\b[^>]*>)([^<]+)(<\/cbc:TaxAmount>)/,
            (_, open, value, close) => open + '99999.99' + close);
        assert.notEqual(changedContent, prepared.xml, 'Debe alterarse contenido firmado conservando identidad');
        const changedZip = Buffer.from(zipSync({ [xmlName]: Buffer.from(changedContent) }));
        assert.throws(() => validateBetaPackage({ ...adapterPackage, zip: changedZip, sha256: sha(changedZip) }, RUC, fixture.method),
          /Firma XML inválida/, 'Adaptador debe detectar alteración aun con hash ZIP recalculado');
        adapterNegativeChecks.push('wrong-send-method', 'wrong-ZIP-hash', 'wrong-RUC', 'multiple-ZIP-entries', 'tampered-content-with-recomputed-ZIP-hash');
      } else {
        for (const method of ['sendBill', 'sendSummary'])
          assert.throws(() => validateBetaPackage(adapterPackage, RUC, method), 'Nota B individual debe rechazarse en ambos métodos');
        adapterNegativeChecks.push('individual-B-note-sendBill', 'individual-B-note-sendSummary');
      }
      const tampered = prepared.xml.replace(fixture.referenceText, fixture.referenceText + '9');
      assert.notEqual(tampered, prepared.xml, 'Fixture debe permitir alteración dirigida');
      assert.throws(() => verifySignature(tampered, certificate.pem, fixture.unsignedXml, fixture.rootName), 'Alteración debe invalidar firma');
      assert.throws(() => verifySignature(prepared.xml, unrelated.pem, fixture.unsignedXml, fixture.rootName), 'Certificado ajeno debe rechazarse');
      assert.throws(() => verifySignature('<!DOCTYPE fixture>' + prepared.xml, certificate.pem, fixture.unsignedXml, fixture.rootName), 'DTD debe rechazarse');
      results.push({ case: fixture.id, rootName: prepared.rootName, fileName: prepared.fileName,
        preparation: fixture.preparation, signatureVerified: true, authenticatedSnapshot: true, zipExact: true,
        adapterValidated: fixture.adapterPermitted, methodValidatedWithoutPost: fixture.method ?? null,
        xmlSha256: sha(prepared.xml), zipSha256: sha(prepared.zip),
        negativeChecks: ['tampered-XML', 'unrelated-certificate', 'DTD', ...adapterNegativeChecks] });
      xsdCases.push({ id: fixture.id, xml: prepared.xml, rootName: prepared.rootName, namespace: ROOTS[prepared.rootName] });
    }
    stage = 'PIPELINE_NEGATIVE_GATES';
    if (pipelineAvailable) {
      await assert.rejects(async () => prepareBetaFiscalPackage(fixtures[0].envelope, selfSigned.p12, selfSigned.password), 'Certificado autofirmado debe rechazarse');
      await assert.rejects(async () => prepareBetaFiscalPackage(fixtures[0].envelope, certificate.p12, certificate.password + 'incorrecta'), 'Contraseña incorrecta debe rechazarse');
      await assert.rejects(async () => prepareBetaFiscalPackage({ kind: 'INVALID' }, certificate.p12, certificate.password), 'Envelope desconocido debe rechazarse');
      await assert.rejects(async () => prepareBetaFiscalPackage(fixtures[0].envelope, otherRuc.p12, otherRuc.password), 'Certificado de otro RUC debe rechazarse');
      await assert.rejects(async () => prepareBetaFiscalPackage(fixtures[0].envelope, expired.p12, expired.password), 'Certificado vencido debe rechazarse');
      await assert.rejects(async () => prepareBetaFiscalPackage(fixtures[0].envelope, noSignatureUsage.p12, noSignatureUsage.password), 'Certificado sin digitalSignature debe rechazarse');
      await assert.rejects(async () => prepareBetaFiscalPackage(forbiddenNoteB, Buffer.alloc(0), ''), /Notas B requieren lote RC explícito/i, 'Nota B debe rechazarse antes de acceder a la clave');
      for (const fixture of fixtures) {
        const production = structuredClone(fixture.envelope);
        (production.kind === 'NOTE' ? production.note : production.batch).environment = 'PRODUCTION';
        await assert.rejects(async () => prepareBetaFiscalPackage(production, certificate.p12, certificate.password), 'Producción debe rechazarse');
      }
    }
    stage = 'OFFLINE_XSD';
    const xsd = validateXsd(xsdCases);
    assert.equal(xsd.results.length, results.length, 'Falta resultado XSD');
    for (const [index, proof] of xsd.results.entries()) {
      assert.equal(proof.case, results[index].case);
      assert.equal(proof.xmlSha256, results[index].xmlSha256, 'XSD debe validar los bytes firmados exactos');
      results[index].xsd = proof;
    }
    const passed = pipelineAvailable && results.length === fixtures.length + xmlFixtures.length && results.every(result => result.xsd.xsdValid);
    console.log(JSON.stringify({ status: passed ? 'PASS' : pipelineAvailable ? 'FAIL' : 'INCOMPLETE', mode: 'LOCAL_FIXTURES_ONLY',
      rucFixture: RUC, readsUserData: false, realCertificateUsed: false, keyMaterialPersisted: false,
      sourceTranspiledInMemory: true, typecheckPerformed: false, networkUsed: false, dockerUsed: false,
      databaseUsed: false, smtpUsed: false, fiscalTransmission: false, identityVerified: false,
      pkiTrustVerified: false, sunatAcceptanceVerified: false, fiscalRulesCoverageComplete: false,
      xsdArchiveSha256: ARCHIVE_SHA256, xsdSchemasInMemory: xsd.schemasInMemory,
      xsdExternalReferencesBlocked: xsd.externalReferencesBlocked,
      sourceSha256: [...sourceCache.values()].map(loaded => ({ file: relative(REPO, loaded.filename).replaceAll('\\', '/'),
        sha256: loaded.auditSourceSha256 })).sort((a, b) => a.file.localeCompare(b.file)),
      pendingCases: pipelineAvailable ? [] : fixtures.map(fixture => fixture.id),
      pipelineNegativeChecks: pipelineAvailable ? ['self-signed-certificate', 'wrong-password', 'unknown-envelope', 'certificate-RUC-mismatch',
        'expired-certificate', 'missing-digitalSignature', 'B-note-requires-RC-before-key', 'PRODUCTION'] : [], results }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally {
    for (const fixture of materials) { fixture.p12.fill(0); fixture.password = ''; }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'FAIL', mode: 'LOCAL_FIXTURES_ONLY', failedStage: stage,
    fiscalTransmission: false, identityVerified: false, fiscalRulesCoverageComplete: false,
    failedCheck: String(error.message ?? 'Fallo de dependencia local').split('\n')[0].slice(0, 180),
    message: 'Auditoría incompleta o rechazada; ningún caso pendiente se considera aprobado.' }));
  process.exitCode = 1;
});
