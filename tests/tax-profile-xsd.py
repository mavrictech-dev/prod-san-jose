"""Offline profile evidence; schema validity does not certify SUNAT acceptance."""
import sys,json,zipfile,hashlib,io,posixpath
from pathlib import Path
from urllib.parse import unquote
from lxml import etree
raw=(Path(__file__).resolve().parents[1]/'services/sunat-service/assets/sunat/xsd-20220228.zip').read_bytes()
assert hashlib.sha256(raw).hexdigest()=='5cac9d9353521340fbc15d23f465a4946b004535b9ff411541c87da01694dbd5'
archive=zipfile.ZipFile(io.BytesIO(raw))
class Local(etree.Resolver):
 def resolve(self,url,pubid,context):
  name=posixpath.normpath(unquote(url.removeprefix('file:///')))
  if not name.startswith('Archivos XSD/') or not name.endswith('.xsd'):raise ValueError('External schema denied')
  return self.resolve_string(archive.read(name),context,base_url=name)
parser=etree.XMLParser(no_network=True,resolve_entities=False,load_dtd=False);parser.resolvers.add(Local())
schemas={}
validated=0
for entry in json.load(sys.stdin):
 root=entry['root']
 if root not in ['Invoice','CreditNote','DebitNote','SummaryDocuments']:raise ValueError('Unsupported root')
 if root not in schemas:
  suffix='UBL-'+root+'-2.1.xsd' if root!='SummaryDocuments' else 'UBL-SummaryDocuments-1.1.xsd'
  candidates=[n for n in archive.namelist() if n.endswith('/'+suffix)]
  if not candidates and root=='SummaryDocuments':candidates=[n for n in archive.namelist() if n.endswith('.xsd') and 'SummaryDocuments' in n and '/maindoc/' in n]
  assert len(candidates)==1,candidates
  name=candidates[0];schemas[root]=etree.XMLSchema(etree.fromstring(archive.read(name),parser,base_url=name))
 if '<!DOCTYPE' in entry['xml'] or '<!ENTITY' in entry['xml']:raise ValueError('DTD denied')
 schemas[root].assertValid(etree.fromstring(entry['xml'].encode(),etree.XMLParser(no_network=True,resolve_entities=False)))
 validated+=1
print(json.dumps({'validated':validated}))
