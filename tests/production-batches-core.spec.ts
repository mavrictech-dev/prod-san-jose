import { describe,it,expect } from 'vitest';
import { buildProductionBatchesUbl,assertProductionBatchesSnapshot } from '../packages/sunat-core/src/production-batches';
import { ProductionBatchesAuthenticator } from '../packages/sunat-core/src/production-batches-proof';
import { buildFiscalBatchSnapshot } from '../packages/sunat-core/src/fiscal-batch';
import { batch,entries,receipt,acceptance,declaration,asOf,uuid } from './production-batches-fixture';
describe('native production batches',()=>{
 it('supports 1..100 immutable RC03 entries and exact decimal totals per line',()=>{
  const b=batch(entries(100)),xml=buildProductionBatchesUbl(b);
  expect(xml.match(/<sac:SummaryDocumentsLine>/g)).toHaveLength(100);
  expect(xml).toContain('<cbc:ConditionCode>1</cbc:ConditionCode>');
  expect(xml).toContain('currencyID="PEN">236.00');
  expect(b.entries[0].snapshot.environment).toBe('PRODUCTION');
  expect(()=>batch(entries(101))).toThrow();expect(()=>batch([])).toThrow();
 });
 it('does not promote BETA originals or acceptance evidence',()=>{
  const es=entries();es[0].snapshot.environment='BETA';expect(()=>batch(es)).toThrow();
  expect(()=>buildFiscalBatchSnapshot({kind:'RC',entries:entries().map(e=>({document:{snapshot:e.snapshot},conditionCode:'1'}))},
   {documentId:uuid(9000),identifier:'RC-20261028-1',issueDate:'2026-10-28',referenceDate:'2026-10-27'},asOf)).toThrow();
 });
 it.each(['company','ruc','currency','date','duplicate','customer-amount'] as const)('rejects heterogeneous or invalid %s',field=>{
  const es=entries();
  if(field==='company')es[1].snapshot.companyId=2;
  if(field==='ruc')es[1].snapshot.issuer.identityNumber='20131312955';
  if(field==='currency')es[1].snapshot.currencyCode='USD';
  if(field==='date')es[1].snapshot.issueDate='2026-10-26T16:00:00Z';
  if(field==='duplicate')es[1]=structuredClone(es[0]);
  if(field==='customer-amount')es[1].snapshot.totals.payableAmount='0.00';
  expect(()=>batch(es)).toThrow();
 });
 it('requires a server-owned pending route for RC1; already-transmitted cannot enter',()=>{
  const es=entries();delete es[0].pendingRoute;expect(()=>batch(es)).toThrow();
  es[0].pendingRoute={documentId:uuid(1),token:uuid(42),transmissionStarted:true as false};expect(()=>batch(es)).toThrow();
 });
 it('requires exact previously accepted RC for RC2/3 and retains all void amounts',()=>{
  const s=receipt(1),a=acceptance(s);
  const b=batch([{snapshot:s,conditionCode:'3',previous:{snapshot:structuredClone(s),acceptance:a},declaration:declaration(s)}]);
  const xml=buildProductionBatchesUbl(b);expect(xml).toContain('>236.00</sac:TotalAmount>');expect(xml).toContain('<cbc:ConditionCode>3');
  b.entries[0].previous!.acceptance.source='DOCUMENT';expect(()=>assertProductionBatchesSnapshot(b,asOf)).toThrow();
 });
 it('validates RA accepted document + audited non-delivery and deadline',()=>{
  const s=receipt(1,'01'),b=batch([{snapshot:s,acceptance:acceptance(s),declaration:declaration(s)}],'RA');
  expect(buildProductionBatchesUbl(b)).toContain('<sac:VoidReasonDescription>');
  b.entries[0].acceptance!.acceptedAt='2026-10-19T17:00:00Z';expect(()=>assertProductionBatchesSnapshot(b,asOf)).toThrow();
  const fresh=batch([{snapshot:s,acceptance:acceptance(s),declaration:declaration(s)}],'RA');fresh.entries[0].declaration!.snapshotSha256='f'.repeat(64);
  expect(()=>assertProductionBatchesSnapshot(fresh,asOf)).toThrow();
 });
 it('binds owner and status HMAC to separate audiences and exact bodies',()=>{
  const a=new ProductionBatchesAuthenticator(Buffer.alloc(32,7),'billing-owner'),b=new ProductionBatchesAuthenticator(Buffer.alloc(32,7),'sunat-status'),body={batch:batch()};
  a.verify(body,a.sign(body));expect(()=>b.verify(body,a.sign(body))).toThrow();
  expect(()=>a.verify({...body,extra:true},a.sign(body))).toThrow();
  expect(()=>a.verify(body,{...a.sign(body),signature:'0'.repeat(64)})).toThrow();
 });
});
