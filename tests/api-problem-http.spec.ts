import 'reflect-metadata';
import {it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {ApiProblemFilter} from '../packages/service-access/src/api-problem.filter';
import {ProductionError} from '../packages/service-access/src/b2b-production-contract';
import {issuanceInputIssues} from '../services/billing-service/src/application/issue-input-validation';
import {IssueDocumentService} from '../services/billing-service/src/application/issue-document.service';
const native=createRequire(new URL('../services/billing-service/package.json',import.meta.url));
const {BadRequestException,Body,Controller,Get,Module,Post}=native('@nestjs/common'),{NestFactory}=native('@nestjs/core');
class TestController {
 invalid(body:unknown){const errors=issuanceInputIssues(body);throw new BadRequestException({code:'FIELD_VALIDATION_FAILED',message:errors.map(e=>e.message).join(' '),errors});}
 fail(){throw Error('postgresql://private:secret@internal/database');}
 scope(){throw new ProductionError(403,'INSUFFICIENT_SCOPE');}
}
Controller('problem-test')(TestController);
Post()(TestController.prototype,'invalid',Object.getOwnPropertyDescriptor(TestController.prototype,'invalid')!);Body()(TestController.prototype,'invalid',0);
Get('unexpected')(TestController.prototype,'fail',Object.getOwnPropertyDescriptor(TestController.prototype,'fail')!);
Get('scope')(TestController.prototype,'scope',Object.getOwnPropertyDescriptor(TestController.prototype,'scope')!);
class TestModule{};Module({controllers:[TestController]})(TestModule);
it('returns correctable fields and safe diagnostic IDs through real HTTP, without secret leakage',async()=>{
 const app=await NestFactory.create(TestModule,{logger:false});app.useGlobalFilters(new ApiProblemFilter());await app.listen(0,'127.0.0.1');
 try{
  const base=await app.getUrl();
  const bad=await fetch(base+'/problem-test',{method:'POST',headers:{'content-type':'application/json','x-correlation-id':'10000000-0000-4000-8000-000000000001'},body:JSON.stringify({documentType:'INVOICE',emissionPointId:'bad',series:'18',customer:{identityType:'1',identityNumber:'123',legalName:''},lines:[{description:'Diesel',unitCode:'?',quantity:'0',unitPriceWithTax:'21',taxAffectationCode:'18',igvRate:'18'}]})});
  expect(bad.status).toBe(400);const body=await bad.json();
  expect(body.requestId).toBe('10000000-0000-4000-8000-000000000001');
  expect(body.fieldErrors['lines[0].taxAffectationCode']).toContain('no es un porcentaje');
  expect(body.fieldErrors['lines[0].unitCode']).toContain('unidad');
  expect(body.fieldErrors['customer.identityNumber']).toContain('11 dígitos');
  expect(body.fieldErrors.emissionPointId).toContain('punto');expect(body.errors.length).toBeGreaterThan(4);
  const unknown=await fetch(base+'/problem-test/unexpected');expect(unknown.status).toBe(500);const safe=await unknown.text();expect(safe).not.toMatch(/secret|postgresql|internal\/database/);expect(JSON.parse(safe).requestId).toMatch(/^[a-f0-9-]{36}$/);
  const denied=await fetch(base+'/problem-test/scope');expect(denied.status).toBe(403);expect((await denied.json()).message).toContain('no tiene el permiso');
 }finally{await app.close();}
});
it('rejects invalid field input before opening a transaction or reserving a number',async()=>{
 const transaction=vi.fn();const issue=new IssueDocumentService({$transaction:transaction} as never);
 await expect(issue.execute({} as never,{userId:'10000000-0000-4000-8000-000000000001',scope:{kind:'GLOBAL'},idempotencyKey:'test',correlationId:'test'})).rejects.toMatchObject({status:400,response:{code:'FIELD_VALIDATION_FAILED'}});
 expect(transaction).not.toHaveBeenCalled();
});
