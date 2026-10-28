import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { prepareProductionBatchesXml } from '../services/sunat-service/src/application/production-batches-crypto';
import { buildProductionBatchesUbl } from '../packages/sunat-core/src/production-batches';
import { buildInvoiceUbl } from '../packages/sunat-core/src/ubl';
import { verifyLocalSignedInvoice } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { productionTransportXml } from '../services/sunat-service/src/infrastructure/sunat/production-transport-zip';
import { verifyProductionBatchesCdr } from '../services/sunat-service/src/infrastructure/production-batches-cdr';
import { createGuideSidecarPki,guideSidecarCdrXml,zipSync } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { batch,receipt,acceptance,declaration } from './production-batches-fixture';
let pki:ReturnType<typeof createGuideSidecarPki>;
beforeAll(()=>{pki=createGuideSidecarPki();},30000);
afterAll(()=>{for(const s of [pki.issuer,pki.sunat,pki.otherIssuer])s.pkcs12.fill(0);});
const validateXsd=(xml:string,kind:'SummaryDocuments'|'VoidedDocuments'|'Invoice')=>{
 const path=kind==='Invoice'?'2.1/maindoc/UBL-Invoice-2.1.xsd':'2.0/maindoc/UBLPE-'+kind+'-1.0.xsd';
 const code=["from pathlib import Path","from runpy import run_path","import sys","from lxml import etree","h=run_path('tests/validate-official-xsd.py')","root=Path('tmp/sunat-schema/ubl21-browser/Archivos XSD').resolve(strict=True)","schema=etree.XMLSchema(etree.parse(str(root/sys.argv[1]),h['parser'](root)))","schema.assertValid(h['xml_root'](sys.stdin.buffer.read()))"].join('\n');
 const result=spawnSync('python',['-c',code,path],{input:xml,encoding:'utf8',timeout:15000,cwd:resolve('.')});
 expect(result.stderr).toBe('');expect(result.status).toBe(0);
};
describe('native production batch XMLDSig and official offline XSD',()=>{
 it('signs RC plus immutable individual XML originals, all exact and XSD-valid',()=>{
  const b=batch(),result=prepareProductionBatchesXml(b,pki.issuer.pkcs12,pki.password);
  expect(verifyLocalSignedInvoice(result.xml,pki.issuer.certificatePem,buildProductionBatchesUbl(b),'SummaryDocuments')).toBe(result.digestValue);
  expect(productionTransportXml(result.zip,result.fileName+'.xml').xml.toString()).toBe(result.xml);
  validateXsd(result.xml,'SummaryDocuments');expect(result.originals).toHaveLength(2);
  for(const original of result.originals){
   const s=b.entries.find(e=>e.snapshot.documentId===original.documentId)!.snapshot;
   expect(verifyLocalSignedInvoice(original.xml,pki.issuer.certificatePem,buildInvoiceUbl(s,{mode:'REAL_PREPARATION'}),'Invoice')).toBe(original.digestValue);
   validateXsd(original.xml,'Invoice');
   expect(()=>verifyLocalSignedInvoice(original.xml.replace('236.00','236.01'),pki.issuer.certificatePem,buildInvoiceUbl(s,{mode:'REAL_PREPARATION'}),'Invoice')).toThrow();
  }
 });
 it('signs RA from accepted 01 and validates official VoidedDocuments XSD',()=>{
  const s=receipt(1,'01'),b=batch([{snapshot:s,acceptance:acceptance(s),declaration:declaration(s)}],'RA'),result=prepareProductionBatchesXml(b,pki.issuer.pkcs12,pki.password);
  expect(result.originals).toHaveLength(0);
  expect(verifyLocalSignedInvoice(result.xml,pki.issuer.certificatePem,buildProductionBatchesUbl(b),'VoidedDocuments')).toBe(result.digestValue);
  validateXsd(result.xml,'VoidedDocuments');
 });
 it('verifies every CDR member using actual ephemeral chain/signatures; a tampered member never accepts',async()=>{
  const b=batch(),files:Record<string,Uint8Array>={},prefix='R-'+b.issuerRuc+'-';
  for(const [name,ref,type]of [[prefix+b.identifier+'.xml',b.identifier,'RC'],...b.entries.map(e=>[prefix+'03-'+e.snapshot.fullNumber+'.xml',e.snapshot.fullNumber,'03'])]){
   const unsigned=guideSidecarCdrXml({issuerRuc:b.issuerRuc,fullNumber:ref,documentType:type} as any);
   files[name]=Buffer.from(pki.signCdr(unsigned));
  }
  const good=await verifyProductionBatchesCdr(Buffer.from(zipSync(files)),b,pki.cdrVerifier);expect(good.status).toBe('ACCEPTED');
  const member=prefix+'03-'+b.entries[0].snapshot.fullNumber+'.xml';
  files[member]=Buffer.from(Buffer.from(files[member]).toString().replace('FICTITIOUS LOCAL RECEIPT','ALTERED RESULT'));
  await expect(verifyProductionBatchesCdr(Buffer.from(zipSync(files)),b,pki.cdrVerifier)).rejects.toThrow();
 });
});
