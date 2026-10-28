import 'reflect-metadata';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {B2bPrivateHttp,B2bIdentityHttp} from '@factuez/service-access/dist/b2b';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {readonlyOwnerOptions,readonlyPeers,readonlyTls,installReadonlyOwnerBoundary,type ReadonlyOwnerOptions,type ReadonlyTls} from '@factuez/service-access/dist/b2b-readonly-owner';
import type {PrismaService} from '../infrastructure/prisma.service';
import {B2bBillingReads,PrismaB2bReadRepository} from './read';
import {B2bBillingReadModule} from './read-http';
import {B2bContextService,PrismaB2bContextRepository} from './context';
import {B2bContextModule,B2bContextFilter} from './http';
@Module({})class BillingReadonlyOwner{}
const checks=[
 'SELECT "id","companyId","seriesCounterId","emissionPointId","type","status","series","number","fullNumber","issueDate","immutableSnapshot","updatedAt","sunatStatus","sunatResponseCode","originSystem","originId","payableAmount" FROM "Document" WHERE false',
 'SELECT "id","ruc","environment","active","legalName" FROM "CompanySettings" WHERE false',
 'SELECT "id","companyId","active","code","name" FROM "Branch" WHERE false',
 'SELECT "id","companyId","branchId","active","code","name" FROM "EmissionPoint" WHERE false',
 'SELECT "id","companyId","emissionPointId","documentType","series","active" FROM "SeriesCounter" WHERE false',
 'SELECT "id","sku","description","unitCode","taxAffectationCode","defaultUnitPrice","active" FROM "FuelProduct" WHERE false',
 'SELECT "id","companyId","identifier" FROM "DailySummary" WHERE false',
 'SELECT "documentId","dailySummaryId","conditionCode","lineNumber" FROM "DailySummaryItem" WHERE false',
] as const;
/** Minimal actual Billing owner: its own Prisma, current Identity, no issue
 * service/host adapters, numbering, workers, AppModule or cross-owner SQL. */
export async function createBillingReadonlyOwner(options:ReadonlyOwnerOptions&{identityOrigin:string;identityTls:ReadonlyTls;registrar:string[]},prisma:PrismaService){
 if(options?.enabled!==true)return null;
 readonlyOwnerOptions(options);const callers=readonlyPeers(options.callers),registrar=readonlyPeers(options.registrar),tls=readonlyTls(options.tls);
 const identity=new B2bIdentityHttp(new B2bPrivateHttp(options.identityOrigin,readonlyTls(options.identityTls)));
 if(!prisma||typeof prisma.$queryRawUnsafe!=='function'||typeof prisma.$transaction!=='function')throw Error('BILLING_READONLY_OWNER_PRISMA_REQUIRED');
 let gate:ReturnType<typeof installReadonlyOwnerBoundary>|undefined;
 const check=async()=>{
  if(gate&&!gate.isOpen())throw Error('BILLING_READONLY_CLOSING');
  for(const query of checks)await prisma.$queryRawUnsafe(query);
 };
 await check();
 const reads=new B2bBillingReads(new PrismaB2bReadRepository(prisma),identity);
 const context=new B2bContextService(new PrismaB2bContextRepository(prisma),identity);
 const status=new B2bOwnerRuntimeStatus('billing',options.deploymentId,['READ'],check);
 const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>({module:BillingReadonlyOwner,imports:[
  B2bBillingReadModule.isolated(reads,callers),B2bContextModule.isolated(context,{context:callers,registrar}),
  B2bOwnerRuntimeStatusModule.isolated(status,callers),
 ]},{logger:false,bodyParser:false,httpsOptions});
 gate=installReadonlyOwnerBoundary(app,[...new Set([...callers,...registrar])],['/internal/b2b/read','/internal/b2b/context','/internal/b2b/validate-bindings']);
 app.useBodyParser('json',{limit:262144,strict:true});app.useGlobalFilters(new B2bContextFilter());
 let started=false,closed:Promise<void>|undefined;
 return {app,status,async start(){if(started)throw Error('BILLING_READONLY_ALREADY_STARTED');started=true;await status.inspect();await app.listen(options.listen.port,options.listen.host);},
  close:()=>closed??=(async()=>{await gate!.closeAdmission();await app.close();})()};
}
