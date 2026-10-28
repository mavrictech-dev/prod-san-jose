"""Auditoría offline reproducible; no cambia los flags de validación del servicio."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlparse
from lxml import etree

REPO = Path(__file__).resolve().parent.parent
EXPECTED_ZIP_SHA256 = '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5'
INVOICE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2'
SUMMARY_NS = 'urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1'


def bounded(path, root, limit=5 * 1024 * 1024):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(root.resolve(strict=True)) or not resolved.is_file() or resolved.stat().st_size > limit:
        raise ValueError('Archivo fuera del paquete o demasiado grande')
    return resolved


class LocalSchemasOnly(etree.Resolver):
    def __init__(self, root):
        self.root = root.resolve(strict=True)
        self.requests = 0

    def resolve(self, url, public_id, context):
        self.requests += 1
        if self.requests > 256:
            raise ValueError('Demasiadas dependencias de schema')
        # En Windows libxml entrega tanto D:/... como file:///D:/....
        if re.match(r'^[A-Za-z]:[/\\]', url):
            path = Path(unquote(url))
        else:
            parsed = urlparse(url)
            if parsed.scheme not in ('', 'file') or parsed.netloc:
                raise ValueError('Importación externa de schema bloqueada')
            name = unquote(parsed.path)
            if re.match(r'^/[A-Za-z]:/', name):
                name = name[1:]
            path = Path(name)
            if not path.is_absolute():
                path = self.root / path
        return self.resolve_filename(str(bounded(path, self.root)), context)


def parser(root=None):
    result = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False)
    if root:
        result.resolvers.add(LocalSchemasOnly(root))
    return result


def xml_root(data):
    if len(data) > 2 * 1024 * 1024 or re.search(br'<!\s*(?:DOCTYPE|ENTITY)\b', data, re.I):
        raise ValueError('XML inseguro o demasiado grande')
    root = etree.fromstring(data, parser())
    if len(list(root.iter())) > 30000:
        raise ValueError('Demasiados nodos XML')
    return root


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--bundle', type=Path, required=True, help='Paquete oficial extraído (Archivos XSD)')
    args.add_argument('--archive', type=Path, required=True, help='ZIP original con SHA-256 fijado')
    options = args.parse_args()
    assert hashlib.sha256(options.archive.read_bytes()).hexdigest() == EXPECTED_ZIP_SHA256, 'Paquete oficial distinto al fijado'
    bundle = options.bundle.resolve(strict=True)
    schemas = {}
    for kind, relative in [('Invoice', '2.1/maindoc/UBL-Invoice-2.1.xsd'), ('SummaryDocuments', '2.0/maindoc/UBLPE-SummaryDocuments-1.0.xsd')]:
        path = bounded(bundle / relative, bundle)
        schemas[kind] = etree.XMLSchema(etree.parse(str(path), parser(bundle)))
    directory = REPO / 'tmp/circuit-qa/schema'
    manifest = json.loads((directory / 'manifest.json').read_text('utf-8'))
    assert manifest['fiscalTransmission'] is False and re.fullmatch(r'00\d{9}', manifest['ruc'])
    report = {'source': 'SUNAT — paquete XSD oficial', 'archiveSha256': EXPECTED_ZIP_SHA256, 'mode': 'OFFLINE_AUDIT_ONLY', 'workerEvidenceRead': False, 'sunatRulesValidated': False, 'fiscalTransmission': False, 'results': []}
    for entry in manifest['entries']:
        path = bounded(directory / entry['file'], directory, 2 * 1024 * 1024)
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == entry['sha256']
        root = xml_root(data)
        kind = entry['kind']
        assert root.tag == f'{{{INVOICE_NS if kind == "Invoice" else SUMMARY_NS}}}{kind}'
        schema = schemas[kind]
        valid = schema.validate(root)
        errors = [{'line': e.line, 'type': e.type_name, 'message': e.message[:1000]} for e in list(schema.error_log)[:20]]
        report['results'].append({**entry, 'xsdValid': valid, 'errors': errors})
        print(f'{entry["file"]}: XSD {"CORRECTO" if valid else "INVÁLIDO"}')
        for error in errors:
            print(f'  {error["type"]}: {error["message"]}')
        wrong_namespace = etree.fromstring(data, parser())
        wrong_namespace.tag = '{urn:invalid:qa}' + kind
        assert schema.validate(wrong_namespace) is False
    # Rechazo de DTD y resolver que nunca permite HTTP ni salida del paquete.
    try:
        xml_root(b'<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>&x;</Invoice>')
        raise AssertionError('DTD fue admitido')
    except ValueError:
        pass
    for target in ('https://example.invalid/schema.xsd', str(REPO / 'package.json')):
        malicious = f'<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="{target}"/></xs:schema>'.encode()
        try:
            etree.XMLSchema(etree.fromstring(malicious, parser(bundle), base_url=bundle.as_uri() + '/'))
            raise AssertionError('Importación externa fue admitida')
        except (ValueError, etree.XMLSchemaParseError, OSError):
            pass
    report['negativeChecks'] = ['Wrong XML namespace', 'DTD/entity', 'HTTP XSD import', 'XSD import outside package']
    (directory / 'xsd-report.json').write_text(json.dumps(report, indent=2, ensure_ascii=False), 'utf-8')
    print('Auditoría offline terminada; no homologa reglas de negocio, PKI, CDR ni SUNAT.')
    return 0 if all(r['xsdValid'] for r in report['results']) else 1


if __name__ == '__main__':
    raise SystemExit(main())
