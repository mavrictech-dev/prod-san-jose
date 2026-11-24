"""Offline SUNAT GRE XSL 2.0.1 + SFS 2.6 commons. No network or customer data.

The SFS commons declares func:function but omits func from extension-element-prefixes.
That declaration and two SFS matches(node,pattern,'!') calls are adapted in memory
to EXSLT regexp:test(string(node),pattern) for libxslt. All rule predicates and
patterns remain official; this portability adapter is not SUNAT acceptance.
"""
import hashlib, io, json, posixpath, sys, zipfile
from pathlib import Path
from lxml import etree

ROOT = Path(__file__).resolve().parent
PINS = {
    'gre-xsl-20261001.zip': 'bcaa31e7195295372e905374f6b4adcd1b40bf4ba05b989132e34c03d484aeb7',
    'gre-sfs26-commons.zip': '49a63e59375700c729930e10a69228b9604b1cd792d713de8068e543a68b4a5c',
    'gre-xsd-20220713.zip': '011225702980d1f8874f7aa0940a0de782aa79dd0cc1931c90f2b8142490bcea',
    'xsd-20220228.zip': '5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5',
}

def archive(name):
    raw = (ROOT / name).read_bytes()
    if hashlib.sha256(raw).hexdigest() != PINS[name]:
        raise ValueError('GRE_XSL_PIN_MISMATCH')
    return zipfile.ZipFile(io.BytesIO(raw))

def validate(xml, filename, check=False):
    rules, commons = archive('gre-xsl-20261001.zip'), archive('gre-sfs26-commons.zip')
    top_xsd, dependency_xsd = archive('gre-xsd-20220713.zip'), archive('xsd-20220228.zip')
    class Local(etree.Resolver):
        def resolve(self, url, pubid, context):
            if url.startswith('/official/2.1/common/') and url.endswith('.xsd') and '..' not in url:
                data = dependency_xsd.read('Archivos XSD' + url.removeprefix('/official'))
                return self.resolve_string(data, context, base_url=url)
            marker = '/commons/'
            if marker not in url:
                raise ValueError('GRE_EXTERNAL_RESOURCE_DENIED')
            name = url.split(marker, 1)[1]
            if posixpath.normpath(name) != name or name.startswith('/') or not name.endswith(('.xml', '.xsl')):
                raise ValueError('GRE_EXTERNAL_RESOURCE_DENIED')
            data = commons.read(name)
            if name == 'error/validate_utils.xsl':
                assert data.count(b'extension-element-prefixes="dp"') == 1
                data = data.replace(b'extension-element-prefixes="dp"', b'extension-element-prefixes="dp func"')
                assert data.count(b"matches($node, $regexp,'!')") == 2
                data = data.replace(b"matches($node, $regexp,'!')", b'regexp:test(string($node), $regexp)')
            return self.resolve_string(data, context, base_url='/official/commons/' + name)
    parser = etree.XMLParser(no_network=True, resolve_entities=False, load_dtd=False)
    parser.resolvers.add(Local())
    raw = xml.encode('utf8')
    if b'<!DOCTYPE' in raw or b'<!ENTITY' in raw or len(raw) > 4 * 1024 * 1024:
        raise ValueError('GRE_XML_UNSAFE')
    doc = None if check else etree.fromstring(raw, parser)
    current_schema = etree.XMLSchema(etree.fromstring(top_xsd.read('UBL-DespatchAdvice-2.1.xsd'), parser, base_url='/official/2.1/maindoc/UBL-DespatchAdvice-2.1.xsd'))
    if doc is not None:
        current_schema.assertValid(doc)
    kind = 'Remitente' if '-09-' in filename else 'Transportista' if '-31-' in filename else None
    if kind is None:
        raise ValueError('GRE_FILENAME_INVALID')
    name = 'Archivos_XSL/ValidaExprRegGre' + kind + '-2.0.1.xsl'
    style = etree.fromstring(rules.read(name), parser, base_url='/official/' + name)
    # The published remitente declares the same variable twice in the same
    # template; libxslt rejects the redundant declaration. Both XPath values
    # must be identical before removing only the second declaration.
    variables = style.xpath('//xsl:template[@match="/*"]/xsl:variable[@name="motivoTraslado"]', namespaces={'xsl': 'http://www.w3.org/1999/XSL/Transform'})
    if kind == 'Remitente':
        assert len(variables) == 2 and variables[0].attrib == variables[1].attrib
        variables[1].getparent().remove(variables[1])
    transform = etree.XSLT(style, access_control=etree.XSLTAccessControl(read_file=True, read_network=False, write_file=False, create_dir=False))
    try:
        if doc is not None:
            transform(doc, nombreArchivoEnviado=etree.XSLT.strparam(filename))
    except etree.XSLTApplyError as exc:
        raise ValueError('GRE_OFFICIAL_XSL_REJECTED: ' + str(exc) + ' | ' + ' | '.join(str(e) for e in transform.error_log)) from exc
    # Observations are never silently promoted to a clean local validation.
    warnings = [entry.message for entry in transform.error_log if entry.message.strip()]
    return {'validated': True, 'configurationOnly': check, 'warnings': warnings, 'xsdSha256': PINS['gre-xsd-20220713.zip'], 'xslSha256': PINS['gre-xsl-20261001.zip'],
            'commonsSha256': PINS['gre-sfs26-commons.zip'], 'xmlSha256': hashlib.sha256(raw).hexdigest()}

if __name__ == '__main__':
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
    try:
        data = json.load(sys.stdin)
        print(json.dumps(validate(data['xml'], data['filename'], data.get('check', False))))
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
