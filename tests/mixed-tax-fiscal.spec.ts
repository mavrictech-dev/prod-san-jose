import 'reflect-metadata';
import {describe,it,expect,vi,afterEach} from 'vitest';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PRODUCTION_NOTES_MIXED_PROFILE,type FiscalDocumentSnapshot} from '../packages/contracts/src';
import {calculateDocumentTotals} from '../packages/sunat-core/src/tax';
import {buildInvoiceUbl} from '../packages/sunat-core/src/ubl';
import {buildReceiptSummary} from '../packages/sunat-core/src/receipt-summary-ubl';
import {buildProductionNotesExtendedSnapshot,buildProductionNotesAnyUbl} from '../packages/sunat-core/src/production-notes-profile';
import {fiscalSnapshotSha256} from '../packages/sunat-core/src/fiscal-note';
import {ProductionDispatchPolicy,PRODUCTION_MIXED_TAX_PROFILE,PRODUCTION_RECEIPT_PROFILE} from '../services/sunat-service/src/application/production-dispatch-policy';
import {createGuideSidecarPki} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {XmlSignerService,verifyLocalSignedInvoice} from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import {renderProductionInvoicePdf} from '../packages/pdf-renderer/src';
import {buildProductionNotesRc} from '../services/sunat-service/src/application/production-notes-rc';
afterEach(()=>{vi.unstubAllEnvs();});
function original(code='mixed',receipt=false):FiscalDocumentSnapshot{
 const entries=code==='mixed'?[['10','18','118'],['20','0','50'],['30','0','25']]:[[code,code==='10'?'18':'0','118']];
 return {documentId:randomUUID(),companyId:1,branchId:randomUUID(),environment:'PRODUCTION',documentTypeCode:receipt?'03':'01',series:receipt?'B001':'F001',number:'1',fullNumber:receipt?'B001-1':'F001-1',issueDate:'2026-11-23T09:00:00-05:00',currencyCode:'PEN',operationTypeCode:'0101',paymentTerms:{type:'CONTADO'},issuer:{identityType:'6',identityNumber:'20100070970',legalName:'SYNTHETIC ISSUER',address:'SYNTHETIC ADDRESS',ubigeo:'150101',establishmentCode:'0000'},customer:{identityType:'6',identityNumber:'20131312955',legalName:'SYNTHETIC CUSTOMER'},...calculateDocumentTotals(entries.map(([taxAffectationCode,igvRate,unitPriceWithTax])=>({description:'SYNTHETIC',quantity:'1',unitPriceWithTax,unitCode:'NIU',taxAffectationCode,igvRate})))};
}
function acceptance(o:FiscalDocumentSnapshot){return {profile:o.documentTypeCode==='01'?'PRODUCTION-01-ARCHIVE-v1' as const:'PRODUCTION-03-RC-ARCHIVE-v1' as const,documentId:o.documentId,snapshotSha256:fiscalSnapshotSha256(o),signedXmlSha256:'a'.repeat(64),cdrXmlSha256:'b'.repeat(64),cdrZipSha256:'c'.repeat(64),acceptedAt:'2026-11-23T10:00:00-05:00',checkedAt:new Date().toISOString(),...(o.documentTypeCode==='03'?{receiptSummary:{identifier:'RC-20261123-1',summaryXmlSha256:'d'.repeat(64),summaryZipSha256:'e'.repeat(64),individualXmlSha256:'a'.repeat(64),individualZipSha256:'f'.repeat(64),cdrXmlSha256:'b'.repeat(64),cdrZipSha256:'c'.repeat(64)}}:{})};}
describe('validated real issuer tax10/20/30 profile, offline only',()=>{
 it('requires a new explicit production grant and retains custom-rate rejection',async()=>{
  vi.stubEnv('SUNAT_PRODUCTION_WORKFLOW_ENABLED','true');let profile=PRODUCTION_RECEIPT_PROFILE;
  const prisma={fiscalDispatchAuthorization:{findUnique:async()=>({enabled:true,profile,registrationAttestedAt:new Date(),credentialRevision:1,certificateFingerprint:'a'.repeat(64)})},sunatCredentials:{findUnique:async()=>({revision:1,certificateFingerprint:'a'.repeat(64),certificateSelfSigned:false,certificateExpiresAt:new Date('2099-01-01')})}};
  const policy=new ProductionDispatchPolicy(prisma as any,{} as any,{} as any);await expect(policy.assertCurrent(original())).rejects.toThrow('10/20/30');profile=PRODUCTION_MIXED_TAX_PROFILE;await expect(policy.assertCurrent(original())).resolves.toMatchObject({profile});
  const bad=original();bad.lines[0].igvRate='16';await expect(policy.assertCurrent(bad)).rejects.toThrow();
 });
 it('preserves the frozen treatment in full credit and price adjustments, including receipt RC',()=>{
  const o=original(),before=JSON.stringify(o),proof=acceptance(o),id={documentId:randomUUID(),series:'FC01',number:'1',issueDate:'2026-11-23T11:00:00-05:00'};
  const credit=buildProductionNotesExtendedSnapshot(o,proof,{documentTypeCode:'07',reasonCode:'01',reasonDescription:'SYNTHETIC FULL'},id);expect(credit.profile).toBe(PRODUCTION_NOTES_MIXED_PROFILE);expect(credit.lines.map(l=>[l.taxAffectationCode,l.igvRate])).toEqual(o.lines.map(l=>[l.taxAffectationCode,l.igvRate]));expect(credit.totals).toMatchObject(o.totals);expect(buildProductionNotesAnyUbl(credit)).toContain('9997');
  const debit=buildProductionNotesExtendedSnapshot(o,proof,{documentTypeCode:'08',reasonCode:'02',reasonDescription:'SYNTHETIC PRICE',lines:[{originalLineNumber:2,unitPriceAdjustmentWithTax:'5'}]},{...id,documentId:randomUUID()});expect(debit.totals).toMatchObject({taxableAmount:'0.00',exemptAmount:'5.00',igvAmount:'0.00',payableAmount:'5.00'});expect(JSON.stringify(o)).toBe(before);
  const receipt=original('mixed',true),note=buildProductionNotesExtendedSnapshot(receipt,acceptance(receipt),{documentTypeCode:'07',reasonCode:'01',reasonDescription:'SYNTHETIC FULL'},{...id,series:'BC01',documentId:randomUUID()});const rc=buildProductionNotesRc(note,'RC-20261123-2',{original:receipt,creditHistory:[]});expect(rc).toContain('<cbc:InstructionID>02</cbc:InstructionID>');expect(rc).toContain('9997');expect(rc).toContain('9998');
 });
 it('signs and verifies invoice, receipt RC, credit and debit XML against pinned official XSD; renders PDF',async()=>{
  const pki=createGuideSidecarPki('20100070970'),signer=new XmlSignerService(),xmls:Array<{root:string;xml:string}>=[];
  try{
   for(const code of ['10','20','30','mixed']){const o=original(code),xml=buildInvoiceUbl(o,{mode:'REAL_PREPARATION'}),signed=signer.sign(xml,pki.issuer.pkcs12,pki.password);expect(verifyLocalSignedInvoice(signed.xml,pki.issuer.certificatePem,xml)).toBe(signed.digestValue);xmls.push({root:'Invoice',xml:signed.xml});const pdf=await renderProductionInvoicePdf(o,'a4',{environment:'PRODUCTION',status:'PENDING',digestValue:signed.digestValue,qrPayload:[o.issuer.identityNumber,'01',o.series,o.number,o.totals.igvAmount,o.totals.payableAmount,'2026-11-23',o.customer.identityType,o.customer.identityNumber,signed.digestValue].join('|')+'|'});expect(pdf.subarray(0,5).toString()).toBe('%PDF-');}
   const receipt=original('mixed',true);xmls.push({root:'SummaryDocuments',xml:signer.sign(buildReceiptSummary(receipt,'RC-20261123-1','REAL_PREPARATION'),pki.issuer.pkcs12,pki.password,'SummaryDocuments').xml});
   const o=original();for(const type of ['07','08'] as const){const a=type==='07'?{documentTypeCode:type,reasonCode:'01' as const,reasonDescription:'FULL'}:{documentTypeCode:type,reasonCode:'02' as const,reasonDescription:'PRICE',lines:[{originalLineNumber:2,unitPriceAdjustmentWithTax:'2'}]};const n=buildProductionNotesExtendedSnapshot(o,acceptance(o),a,{documentId:randomUUID(),series:'FC01',number:'1',issueDate:'2026-11-23T11:00:00-05:00'}),root=type==='07'?'CreditNote':'DebitNote';xmls.push({root,xml:signer.sign(buildProductionNotesAnyUbl(n),pki.issuer.pkcs12,pki.password,root).xml});}
   const result=spawnSync('python',['tests/tax-profile-xsd.py'],{input:JSON.stringify(xmls),encoding:'utf8',windowsHide:true,timeout:30000});expect(result.status,result.stderr).toBe(0);expect(JSON.parse(result.stdout).validated).toBe(7);
  }finally{pki.issuer.pkcs12.fill(0);}
 },60000);
});
