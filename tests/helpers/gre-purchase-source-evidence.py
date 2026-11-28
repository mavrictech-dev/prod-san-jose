"""Copy the repository's pinned official sources and identify exact relevant locations."""
import hashlib
import json
import shutil
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

root = Path(__file__).resolve().parents[2]
assets = root / 'services/sunat-service/assets/sunat'
out = root / 'output/gre-series-administration-lifecycle-20261127/t099/official'
out.mkdir(parents=True, exist_ok=True)
sources = json.loads((assets / 'gre-official-sources.json').read_text())
pins = {
    'gre-rules-20261106.xlsx': '5e1aed6df969afafca284e1cda228d36336ebf1ac31ea84f877f8170f584ec01',
    'gre-xsl-20261001.zip': 'bcaa31e7195295372e905374f6b4adcd1b40bf4ba05b989132e34c03d484aeb7',
    'gre-xsd-20220713.zip': '011225702980d1f8874f7aa0940a0de782aa79dd0cc1931c90f2b8142490bcea',
}
manifest = []
for file, pin in pins.items():
    raw = (assets / file).read_bytes()
    assert hashlib.sha256(raw).hexdigest() == pin
    shutil.copyfile(assets / file, out / file)
    manifest.append({'file': file, 'repositoryPath': str((assets / file).relative_to(root)), 'sha256': pin,
                     'url': next(s['url'] for s in sources if s['sha256'] == pin), 'bytes': len(raw)})

ns = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(assets / 'gre-rules-20261106.xlsx') as z:
    strings = [''.join(t.itertext()) for t in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', ns)]
    rows = []
    for row in ET.fromstring(z.read('xl/worksheets/sheet2.xml')).findall('.//m:row', ns):
        number = int(row.attrib['r'])
        if number not in [142, 147] and not 414 <= number <= 425 and not 441 <= number <= 453:
            continue
        cells = {}
        for c in row.findall('m:c', ns):
            v = c.find('m:v', ns)
            value = v.text if v is not None else ''
            cells[c.attrib['r']] = strings[int(value)] if c.attrib.get('t') == 's' else value
        rows.append({'row': number, 'cells': cells})
    (out / 'workbook-selected-rows.json').write_text(json.dumps({'entry': 'xl/worksheets/sheet2.xml', 'rows': rows}, ensure_ascii=False, indent=2), encoding='utf-8')
with zipfile.ZipFile(assets / 'gre-xsl-20261001.zip') as z:
    entry = 'Archivos_XSL/ValidaExprRegGreRemitente-2.0.1.xsl'
    raw = z.read(entry)
    (out / 'ValidaExprRegGreRemitente-2.0.1.xsl').write_bytes(raw)
    lines = raw.decode('utf-8-sig').splitlines()
    selected = [{'line': n, 'text': text} for n, text in enumerate(lines, 1)
                if 1940 <= n <= 2005 or 2100 <= n <= 2175]
    (out / 'xsl-selected-lines.json').write_text(json.dumps({'entry': entry, 'entrySha256': hashlib.sha256(raw).hexdigest(), 'lines': selected}, ensure_ascii=False, indent=2), encoding='utf-8')
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
print(json.dumps({'officialSources': len(manifest), 'output': str(out.relative_to(root))}))
