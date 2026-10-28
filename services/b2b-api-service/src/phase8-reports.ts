import {Controller,Get,Inject,Module,Param,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {assertPhase8ReportView} from '@factuez/contracts/b2b-report-view';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {B2bReadErrorFilter} from './http';
type Access={token:string;kind:'SERVICE'|'USER'};type Action='DASHBOARD'|'CREATE'|'READ'|'CONTENT';
export interface Phase8ReportsPort{execute(access:Access,action:Action,input:any):Promise<unknown>;content(access:Access,input:{id:string}):Promise<{bytes:Buffer;sha256:string;mediaType:string;fileName:string}>}
export class HttpPhase8Reports implements Phase8ReportsPort{
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'|'reportFile'>){}
 private async response<T>(result:Promise<T>):Promise<T>{
  try{return await result;}catch(error){
   // Fixed report RPC only. Never expose arbitrary remote error text or bodies.
   if(error instanceof B2bSecurityError&&error.status===410)throw new B2bSecurityError(410,'ARTIFACT_NOT_AVAILABLE');
   throw error;
  }
 }
 execute(access:Access,action:Action,input:unknown){return this.response(this.http.post('/internal/b2b/phase8-reports',{kind:access.kind,action,input},access.token));}
 content(access:Access,input:{id:string}){return this.response(this.http.reportFile({kind:access.kind,action:'CONTENT',input},access.token));}
}
export class B2bPhase8Reports{
 constructor(private readonly identity:B2bIdentityPort,private readonly owner:Phase8ReportsPort){}
 async execute(access:Access,action:Action,input:unknown){
  const frame=new B2bOwnerReadFrame(this.identity,access.kind),required=action==='CONTENT'||action==='CREATE'?['b2b:reports:read','b2b:documents:read','b2b:reports:export'] as const:['b2b:reports:read','b2b:documents:read'] as const;
  const q:any=correctionEvidenceFreeze(input);await frame.principal(access.token,[...required]);
  if(['READ','CONTENT'].includes(action)&&(!q||Object.keys(q).join(',')!=='id'||!b2bUuid(q.id)))throw new B2bSecurityError(400,'INVALID_REQUEST');
  const r=action==='CONTENT'?await this.owner.content(access,q):correctionEvidenceFreeze(await this.owner.execute(access,action,q));
  if(action!=='CONTENT')try{
   const filters=['DASHBOARD','CREATE'].includes(action)?{...q.filters,issuerId:Number(q.filters.issuerId),types:(q.filters.types===undefined?['01','03']:typeof q.filters.types==='string'?q.filters.types.split(','):[...q.filters.types]).sort()}:undefined;
   assertPhase8ReportView(r,action==='DASHBOARD'?'dashboard':action==='CREATE'?'create':'read',action==='READ'?{id:q.id}:action==='CREATE'?{format:q.format,filters}:{filters});
  }catch{throw new B2bSecurityError(503,'INVALID_REPORT_RESPONSE');}
  await frame.principal(access.token,[...required]);return r;
 }
}
const CORE=Symbol('Phase8 reports'),PEERS=Symbol('Report peers');
@Controller('b2b/v1')
@UseFilters(B2bReadErrorFilter)
export class B2bPhase8ReportsController{
 constructor(@Inject(CORE)private readonly core:B2bPhase8Reports,@Inject(PEERS)private readonly peers:readonly string[]){}
 private access(r:any,s:any){s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,k=r.headers['x-factuez-actor-kind'];
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k))throw new B2bSecurityError(401,'INVALID_TOKEN');return {token:a.slice(7),kind:k as Access['kind']};}
 private query(r:any,dashboard=false){const q=new URLSearchParams((r.originalUrl??r.url).split('?').slice(1).join('?')),keys=[...q.keys()];
  if(new Set(keys).size!==keys.length||keys.some(k=>!(dashboard?['issuerId','issuerRuc','environment','from','to','types','branchId','pointId','seriesId']:['environment']).includes(k))||q.get('environment')!=='BETA')throw new B2bSecurityError(400,'INVALID_QUERY');return Object.fromEntries(q);}
 @Get('dashboard')dashboard(@Req()r:any,@Res({passthrough:true})s:any){const a=this.access(r,s);if(r.body!==undefined)throw new B2bSecurityError(400,'INVALID_REQUEST');return this.core.execute(a,'DASHBOARD',{filters:this.query(r,true)});}
 @Post('report-jobs')create(@Req()r:any,@Res({passthrough:true})s:any){const a=this.access(r,s);this.query(r);const b:any=correctionEvidenceFreeze(r.body);if(!b||Object.keys(b).sort().join(',')!=='filters,format'||typeof r.headers['idempotency-key']!=='string')throw new B2bSecurityError(400,'INVALID_REQUEST');return this.core.execute(a,'CREATE',{...b,idempotencyKey:r.headers['idempotency-key']});}
 @Get('report-jobs/:id')read(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string){const a=this.access(r,s);this.query(r);if(r.body!==undefined)throw new B2bSecurityError(400,'INVALID_REQUEST');return this.core.execute(a,'READ',{id});}
 @Get('report-jobs/:id/content')async content(@Req()r:any,@Res()s:any,@Param('id')id:string){const a=this.access(r,s);this.query(r);if(r.body!==undefined)throw new B2bSecurityError(400,'INVALID_REQUEST');const f:any=await this.core.execute(a,'CONTENT',{id});
  if(!Buffer.isBuffer(f.bytes)||!/^[a-f0-9]{64}$/.test(f.sha256)||!/^b2b-report-[a-f0-9-]{36}\.(csv|xlsx|pdf)$/.test(f.fileName))throw new B2bSecurityError(503,'INVALID_REPORT_RESPONSE');
  s.setHeader('Content-Type',f.mediaType);s.setHeader('Content-Length',String(f.bytes.length));s.setHeader('X-Content-Sha256',f.sha256);s.setHeader('Content-Disposition',`attachment; filename="${f.fileName}"`);s.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");return s.status(200).send(f.bytes);}
}
@Module({})
export class B2bPhase8ReportsModule{static isolated(core:B2bPhase8Reports,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_REPORT_OWNER_REQUIRED');return {module:B2bPhase8ReportsModule,controllers:[B2bPhase8ReportsController],providers:[B2bReadErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
