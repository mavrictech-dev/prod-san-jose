import 'reflect-metadata';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {IssuanceQueryService} from '../services/billing-service/src/application/issuance-query.service';
import {fiscalContextMessage} from '../apps/web-pwa/features/workspace/gre-environment';
afterEach(()=>vi.unstubAllEnvs());
describe('GRE visibility and explicit service/sales environments',()=>{
 it.each([
  {gre:'false',workers:'false',invoice:'false',visible:false},
  {gre:'true',workers:'false',invoice:'false',visible:false},
  {gre:'false',workers:'true',invoice:'false',visible:false},
  {gre:'true',workers:'true',invoice:'false',visible:true},
  {gre:'false',workers:'false',invoice:'true',visible:true},
 ])('catalogue visibility preserves sales admission and all scope constraints: %j',async flags=>{
  vi.stubEnv('NATIVE_GRE_ENABLED',flags.gre);vi.stubEnv('NATIVE_GRE_WORKERS_ENABLED',flags.workers);vi.stubEnv('BILLING_PRODUCTION_ISSUANCE_ENABLED',flags.invoice);
  const data={companySettings:{findMany:vi.fn(async()=>[])},branch:{findMany:vi.fn(async()=>[])},emissionPoint:{findMany:vi.fn(async()=>[])},fuelProduct:{findMany:vi.fn(async()=>[])}};
  const q=new IssuanceQueryService(data as any),scope={kind:'ASSIGNED' as const,branchIds:['00000000-0000-4000-8000-000000000001'],emissionPointIds:['00000000-0000-4000-8000-000000000002'],series:['00000000-0000-4000-8000-000000000003']};
  const result=await q.catalog(scope),environment=flags.visible?{in:['BETA','PRODUCTION']}:'BETA';
  expect((data.companySettings.findMany.mock.calls[0] as any)[0].where).toEqual({active:true,environment,branches:{some:{id:{in:scope.branchIds}}}});
  expect((data.branch.findMany.mock.calls[0] as any)[0].where).toEqual({active:true,company:{active:true,environment},id:{in:scope.branchIds}});
  expect((data.emissionPoint.findMany.mock.calls[0] as any)[0]).toMatchObject({where:{active:true,branch:{active:true},company:{active:true,environment},id:{in:scope.emissionPointIds},branchId:{in:scope.branchIds}},include:{counters:{where:{active:true,id:{in:scope.series}}}}});
  expect(result.capabilities.productionInvoiceAdmission).toBe(flags.invoice==='true');expect(result.capabilities.fiscalTransmission).toBe(false);
  expect(q.pointWhere(scope,undefined,false)).toEqual({id:{in:scope.emissionPointIds},branchId:{in:scope.branchIds}});expect(q.pointWhere({kind:'GLOBAL'},undefined,false)).toEqual({});
  expect(()=>q.pointWhere(scope,'00000000-0000-4000-8000-000000000999')).toThrow();
 });
 it.each(['BETA','PRODUCTION'])('native GRE explicitly declares production while sales stay %s',sales=>{
  const banner=fiscalContextMessage('/guides',sales);expect(banner).toContain('GRE nativa · PRODUCTION');expect(banner).toContain('envío real');expect(banner).toContain('Ventas: '+sales);expect(banner).not.toContain('Sin validez tributaria');
 });
 it('keeps the laboratory and sales beta disclaimers separate',()=>{
  expect(fiscalContextMessage('/guides/laboratory','PRODUCTION')).toContain('Pruebas locales sin validez tributaria ni envío real');
  expect(fiscalContextMessage('/pos','BETA')).toBe('Ambiente de pruebas Beta · Sin validez tributaria.');
  expect(fiscalContextMessage('/sunat-settings','BETA')).toBe(fiscalContextMessage('/pos','BETA'));
 });
});
