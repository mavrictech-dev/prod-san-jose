import 'reflect-metadata';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {lstat,realpath} from 'node:fs/promises';
import {isAbsolute,resolve} from 'node:path';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {B2bPrivateHttp,B2bIdentityHttp} from '@factuez/service-access/dist/b2b';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule} from '@factuez/service-access/dist/b2b-runtime-status';
import {readonlyOwnerOptions,readonlyTls,installReadonlyOwnerBoundary,type ReadonlyOwnerOptions,type ReadonlyTls} from '@factuez/service-access/dist/b2b-readonly-owner';
import type {PrismaService} from '../infrastructure/prisma.service';
import {ArtifactStore} from '../infrastructure/artifact-store';
import {B2bSunatReads,HttpB2bBillingPort} from './read';
import {PrismaB2bSunatRead} from './repository';
import {PostgresB2bDownloadAudit} from './audit';
import {B2bSunatReadModule} from './http';
import {Catch,HttpException,type ArgumentsHost} from '@nestjs/common';
@Module({})class FiscalReadonlyOwner{}
@Catch()class ReadonlyFiscalErrors{
 catch(e:unknown,host:ArgumentsHost){
  const status=e instanceof B2bSecurityError?e.status:e instanceof HttpException&&[400,404,413].includes(e.getStatus())?e.getStatus():503;
  host.switchToHttp().getResponse().status(status).json({code:e instanceof B2bSecurityError?e.code:'FISCAL_READONLY_UNAVAILABLE'});
 }
}
const checks=[
 'SELECT "documentId","issuerRuc","environment","documentType","series","number","immutablePayload","status" FROM "FiscalDocument" WHERE false',
 'SELECT "id","summaryId","issuerRuc","environment","identifier","immutablePayload" FROM "FiscalBatch" WHERE false',
 'SELECT "id","documentId","kind","storageKey","mediaType","sizeBytes","sha256","createdAt" FROM "DocumentArtifact" WHERE false',
 'SELECT "id","batchId","kind","storageKey","mediaType","sizeBytes","sha256","createdAt" FROM "BatchArtifact" WHERE false',
 'SELECT "documentId","batchId","submissionId" FROM "CdrLog" WHERE false',
 'SELECT "id","batchId" FROM "SunatSubmission" WHERE false',
 'SELECT "id","clientId","clientRevision","actorKind","subjectId","userAuthRevision","issuerRuc","ownerId","artifactId","representation","sha256","byteLength","at" FROM "B2bArtifactAudit" WHERE false',
] as const;
/** Existing persistent Fiscal readers + owner-local original files and audit.
 * No signing, certificate vault, submissions, PDF adapter or fiscal activation. */
export async function createFiscalReadonlyOwner(options:ReadonlyOwnerOptions&{identityOrigin:string;identityTls:ReadonlyTls;billingOrigin:string;billingTls:ReadonlyTls;artifactsRoot:string},prisma:PrismaService){
 if(options?.enabled!==true)return null;
 readonlyOwnerOptions(options);const tls=readonlyTls(options.tls);
 const identity=new B2bIdentityHttp(new B2bPrivateHttp(options.identityOrigin,readonlyTls(options.identityTls)));
 const billing=new HttpB2bBillingPort(new B2bPrivateHttp(options.billingOrigin,readonlyTls(options.billingTls)));
 if(!prisma||typeof prisma.$queryRawUnsafe!=='function'||!isAbsolute(options.artifactsRoot)||resolve(options.artifactsRoot)===resolve(options.artifactsRoot,'..'))throw Error('FISCAL_READONLY_OWNED_STORAGE_REQUIRED');
 let gate:ReturnType<typeof installReadonlyOwnerBoundary>|undefined;
 const check=async()=>{
  if(gate&&!gate.isOpen())throw Error('FISCAL_READONLY_CLOSING');
  for(const query of checks)await prisma.$queryRawUnsafe(query);
  const s=await lstat(options.artifactsRoot);if(!s.isDirectory()||s.isSymbolicLink()||await realpath(options.artifactsRoot)!==resolve(options.artifactsRoot))throw Error('FISCAL_READONLY_ORIGINALS_ROOT_UNAVAILABLE');
 };
 await check();
 const reads=new B2bSunatReads(new PrismaB2bSunatRead(prisma),identity,billing,new ArtifactStore(options.artifactsRoot),
  {b2bDocument:async()=>{throw new B2bSecurityError(501,'PDF_NOT_PUBLISHED_IN_READONLY_PROFILE');}},new PostgresB2bDownloadAudit(prisma));
 const status=new B2bOwnerRuntimeStatus('fiscal',options.deploymentId,['READ'],check);
 const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>({module:FiscalReadonlyOwner,imports:[
  B2bSunatReadModule.isolated(reads,options.callers),B2bOwnerRuntimeStatusModule.isolated(status,options.callers),
 ]},{logger:false,bodyParser:false,httpsOptions});
 gate=installReadonlyOwnerBoundary(app,options.callers,['/internal/b2b/fiscal-read']);
 app.useBodyParser('json',{limit:262144,strict:true});app.useGlobalFilters(new ReadonlyFiscalErrors());
 let started=false,closed:Promise<void>|undefined;
 return {app,status,async start(){if(started)throw Error('FISCAL_READONLY_ALREADY_STARTED');started=true;await status.inspect();await app.listen(options.listen.port,options.listen.host);},
  close:()=>closed??=(async()=>{await gate!.closeAdmission();await app.close();})()};
}
