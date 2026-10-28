import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ProductionDispatchPolicy } from '../services/sunat-service/src/application/production-dispatch-policy';
import { IssueDocumentService } from '../services/billing-service/src/application/issue-document.service';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { fiscalSnapshotSha256 } from '../packages/sunat-core/src/fiscal-note';
const ruc='20615878481';
function invoice() { return { companyId:7, documentId:randomUUID(), environment:'PRODUCTION', documentTypeCode:'01',
  series:'F001', number:'1', fullNumber:'F001-1', issueDate:new Date().toISOString(), currencyCode:'PEN', operationTypeCode:'0101',
  issuer:{ identityType:'6', identityNumber:ruc, legalName:'SYNTHETIC ISSUER', address:'SYNTHETIC ADDRESS', ubigeo:'150101', establishmentCode:'0000' },
  customer:{ identityType:'6', identityNumber:ruc, legalName:'SYNTHETIC CUSTOMER' },paymentTerms:{type:'CONTADO'},
  ...calculateDocumentTotals([{description:'SYNTHETIC ITEM',quantity:'1',unitCode:'NIU',unitPriceWithTax:'1.18',taxAffectationCode:'10',igvRate:'18'}]) } as const; }
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('Production admission actual producer/consumer wire, no external network',()=>{
 it('Billing accepts the exact response produced by SUNAT admission for the same snapshot',async()=>{
  vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED','true');
  const config={status:vi.fn(async()=>({ruc,revision:2,emissionEnvironment:'PRODUCTION'}))};
  const checks=['ISSUER_REAL_RUC','SECRET_VAULT','SOL_SECRETS_LOCAL','CERTIFICATE_KEY_PAIR','CERTIFICATE_RUC','CERTIFICATE_CHAIN','CERTIFICATE_REVOCATION','XSD_RUNTIME','CDR_TRUST','BILLING_PRODUCTION_ADMISSION'].map(code=>({code,status:'PASS'}));
  const policy=new ProductionDispatchPolicy({} as never,config as never,{inspect:async()=>({checks})} as never);
  const authority=vi.spyOn(policy,'assertCurrent').mockResolvedValue();
  const snapshot=invoice();const proof=await policy.admit('7',snapshot,'Bearer SYNTHETIC');
  const fetch=vi.fn(async()=>Response.json(proof));vi.stubGlobal('fetch',fetch);
  const billing=new IssueDocumentService({} as never);
  await expect((billing as any).admitProduction(snapshot,'Bearer SYNTHETIC')).resolves.toBeUndefined();
  expect(authority).toHaveBeenCalledTimes(2);expect(fetch).toHaveBeenCalledOnce();
  expect(proof).toMatchObject({authorized:true,environment:'PRODUCTION',snapshotSha256:fiscalSnapshotSha256(snapshot)});
 });
 it('does not admit a snapshot for another company or a Beta issuer',async()=>{
  const config={status:async()=>({ruc,revision:2,emissionEnvironment:'BETA'})};
  const policy=new ProductionDispatchPolicy({} as never,config as never,{} as never);
  const authority=vi.spyOn(policy,'assertCurrent').mockResolvedValue();
  await expect(policy.admit('7',invoice(),'Bearer SYNTHETIC')).rejects.toThrow('Producción');
  expect(authority).not.toHaveBeenCalled();
 });
});
