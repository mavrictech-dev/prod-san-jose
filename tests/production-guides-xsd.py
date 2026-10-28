# Offline validation of real signed bytes against the repository's pinned official XSD archive.
import sys, json, zipfile, hashlib, io, posixpath
from lxml import etree
from pathlib import Path
from urllib.parse import unquote
archive=Path(__file__).resolve().parents[1]/'services/sunat-service/assets/sunat/xsd-20220228.zip'
raw=archive.read_bytes()
assert hashlib.sha256(raw).hexdigest()=='5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5'
z=zipfile.ZipFile(io.BytesIO(raw))
class Local(etree.Resolver):
 def resolve(self,url,pubid,context):
  name=posixpath.normpath(unquote(url.removeprefix('file:///')))
  if not name.startswith('Archivos XSD/') or not name.endswith('.xsd'):raise ValueError('External XSD denied')
  return self.resolve_string(z.read(name),context,base_url=name)
p=etree.XMLParser(no_network=True,resolve_entities=False,load_dtd=False);p.resolvers.add(Local())
entry='Archivos XSD/2.1/maindoc/UBL-DespatchAdvice-2.1.xsd'
schema=etree.XMLSchema(etree.fromstring(z.read(entry),p,base_url=entry))
value=json.load(sys.stdin)
for xml in value['xmls']:
 if '<!DOCTYPE' in xml or '<!ENTITY' in xml:raise ValueError('DTD denied')
 schema.assertValid(etree.fromstring(xml.encode(),etree.XMLParser(no_network=True,resolve_entities=False,load_dtd=False)))
print(json.dumps({'validated':len(value['xmls'])}))
