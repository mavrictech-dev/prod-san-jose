import 'reflect-metadata';
import {Catch,HttpException,Module,type ArgumentsHost} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {B2bOwnerDrain} from '@factuez/service-access/dist/b2b-owner-drain';
import {B2bMaintenanceNode} from '@factuez/service-access/dist/b2b-maintenance-node';
import {B2bOwnerRuntimeStatus,B2bOwnerRuntimeStatusModule,b2bOwnerRuntimeCapabilities} from '@factuez/service-access/dist/b2b-runtime-status';
import type {ExportPool} from '../postgres-store';
import {B2bExtraction,type B2bExtractionOwner} from './core';
import {B2bExtractionOwnerModule} from './http';
import {b2bExtractionPersistence,checkB2bExtractionStorage} from './persistence';
import {B2bExtractionWorker} from './worker';
@Module({}) class ExportOwnerRuntimeModule {}
@Catch() class ExportOwnerRuntimeFilter {
 catch(error:unknown,host:ArgumentsHost){
  const proposed=error instanceof B2bSecurityError?error.status:error instanceof HttpException?error.getStatus():503;
  const status=[400,401,403,404,409,410,413,422,429].includes(proposed)?proposed:503;
  const res=host.switchToHttp().getResponse();res.setHeader('Cache-Control','private, no-store');res.status(status).json({code:status===503?'EXPORT_OWNER_UNAVAILABLE':'EXPORT_OWNER_REQUEST_DENIED'});
 }
}
export interface B2bExportRuntimeOptions {
 enabled?:boolean;deploymentId:string;instanceId:string;pool:ExportPool;vaultKey:Buffer;identity:B2bIdentityPort;billing:B2bExtractionOwner;fiscal:B2bExtractionOwner;
 peers:string[];operatorPeers:string[];tls:{ca:Buffer;cert:Buffer;key:Buffer};host:'127.0.0.1'|'0.0.0.0';port:number;maintenancePort:number;workerEnabled:boolean;
}
/** Actual persistent B2B engine, never an attachment to the legacy export queue.
 * No CREATE/ALTER, local fallback or network transmission at construction. */
export async function createB2bExportRuntime(o:B2bExportRuntimeOptions){
 if(o.enabled!==true)return null;
 const validPeers=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=64&&new Set(v).size===v.length&&v.every(p=>typeof p==='string'&&/^[a-f0-9]{64}$/.test(p));
 if(!validPeers(o.peers)||!validPeers(o.operatorPeers)||o.operatorPeers.some(p=>o.peers.includes(p))||!['127.0.0.1','0.0.0.0'].includes(o.host)||
  ![o.port,o.maintenancePort].every(p=>Number.isInteger(p)&&p>=1024&&p<=65535)||o.port===o.maintenancePort||typeof o.workerEnabled!=='boolean')throw Error('EXPORT_OWNER_EXPLICIT_CONFIGURATION_REQUIRED');
 const persistence=await b2bExtractionPersistence(o.pool,o.vaultKey),core=new B2bExtraction(persistence,o.identity,o.billing,o.fiscal),worker=new B2bExtractionWorker(core);
 const status=new B2bOwnerRuntimeStatus('exports',o.deploymentId,b2bOwnerRuntimeCapabilities.exports,async()=>{await checkB2bExtractionStorage(o.pool);});
 const module={module:ExportOwnerRuntimeModule,imports:[B2bExtractionOwnerModule.isolated(core,o.peers),B2bOwnerRuntimeStatusModule.isolated(status,o.peers)]};
 const httpsOptions={...o.tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
 const app=await NestFactory.create<NestExpressApplication>(module,{logger:false,bodyParser:false,httpsOptions});
 const drain=new B2bOwnerDrain({enabled:true,maxConcurrent:4});drain.install(app);
 app.use((req:any,res:any,next:()=>void)=>{
  res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  const names=req.rawHeaders.filter((_v:any,i:number)=>i%2===0).map((v:string)=>v.toLowerCase());
  if(req.method!=='POST'||!['/internal/b2b/exports','/internal/b2b/runtime-status'].includes(req.url)||new Set(names).size!==names.length||req.headers['transfer-encoding']||
   !/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||!/^[1-9]\d{0,4}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>16384)return res.status(400).end();next();
 });app.useBodyParser('json',{limit:16384,strict:true});app.useGlobalFilters(new ExportOwnerRuntimeFilter());
 const wait=async(kind:'COMMANDS'|'MUTATIONS'|'ALL')=>{if((await drain.drain(kind)).state!=='DRAINED')throw Error('EXPORT_OWNER_WORK_PENDING');};
 const maintenance=new B2bMaintenanceNode({enabled:true,deploymentId:o.deploymentId,instance:{service:'EXPORTS',instanceId:o.instanceId,bootId:status.bootId},hooks:{
  ADMISSION:async()=>{drain.pauseCommands();await wait('COMMANDS');},PRODUCERS:async()=>{},
  WORKERS:async()=>{await worker.close();await wait('MUTATIONS');},
  STORAGE:async()=>{drain.closeAdmission();await wait('ALL');await app.close();await o.pool.end();},
 }});
 let started=false;
 return {core,worker,status,drain,maintenance,app,async start(){
  if(started||maintenance.snapshot().state!=='READY')throw Error('EXPORT_OWNER_NOT_STARTABLE');started=true;
  try{await status.inspect();await maintenance.listen({host:o.host,port:o.maintenancePort,tls:o.tls,operatorPeers:o.operatorPeers});await app.listen(o.port,o.host);if(o.workerEnabled)worker.start();}
  catch{await worker.close();await app.close();await maintenance.closeListener();throw Error('EXPORT_OWNER_STARTUP_BLOCKED');}
 }};
}
