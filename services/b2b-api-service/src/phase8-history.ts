import {Controller,Get,Inject,Module,Param,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError,validB2bBinding,b2bBindingsContain,type B2bBinding} from '@factuez/contracts/b2b-security';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {B2bReadErrorFilter} from './http';
type Access={token:string;kind:'SERVICE'|'USER'};type Action='LIST'|'DETAIL'|'CONTENT';
export interface B2bHistoryOwnerPort{execute(access:Access,action:Action,input:any):Promise<unknown>;content(access:Access,input:any):Promise<{bytes:Buffer;sha256:string;fileName:string;mediaType:string}>}
export class HttpB2bHistoryOwner implements B2bHistoryOwnerPort{
 constructor(private readonly http:Pick<B2bPrivateHttp,'post'|'historyFile'>){}
 execute(access:Access,action:Action,input:unknown){return this.http.post('/internal/b2b/history-read',{kind:access.kind,action,input},access.token);}
 content(access:Access,input:unknown){return this.http.historyFile({kind:access.kind,action:'CONTENT',input},access.token);}
}
export class B2bPhase8History{
 constructor(private readonly identity:B2bIdentityPort,private readonly owner:B2bHistoryOwnerPort){}
 async execute(access:Access,action:Action,input:unknown){
  const q:any=correctionEvidenceFreeze(input);if(!validB2bBinding(q?.binding))throw new B2bSecurityError(400,'INVALID_BINDING');
  const frame=new B2bOwnerReadFrame(this.identity,access.kind),scopes=action==='CONTENT'?['b2b:history:read','b2b:artifacts:read'] as const:['b2b:history:read'] as const;
  const fresh=async()=>{const p=await frame.principal(access.token,[...scopes]);if(!b2bBindingsContain(p.bindings,q.binding))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');};await fresh();
  const r=action==='CONTENT'?await this.owner.content(access,q):correctionEvidenceFreeze(await this.owner.execute(access,action,q));
  if(action!=='CONTENT'&&(!(r as any)||(r as any).schemaVersion!=='factuez.b2b.history.v1'||(r as any).datasetClass!=='SYNTHETIC'||(r as any).environment!=='BETA'||(r as any).fiscalAuthority!==false||(r as any).cdrAuthenticityVerified!==false||(r as any).candidateOnly!==true||(r as any).readOnly!==true))throw new B2bSecurityError(503,'INVALID_HISTORY_RESPONSE');
  await fresh();return r;
 }
}
const CORE=Symbol('Phase8 history'),PEERS=Symbol('History peers');
@Controller('b2b/v1/history')
@UseFilters(B2bReadErrorFilter)
export class B2bPhase8HistoryController{
 constructor(@Inject(CORE)private readonly core:B2bPhase8History,@Inject(PEERS)private readonly peers:readonly string[]){}
 private request(r:any,s:any,list=false){
  s.setHeader('Cache-Control','private, no-store');s.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(r,this.peers);
  const ns=(r.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=r.headers.authorization,k=r.headers['x-factuez-actor-kind'];
  if(new Set(ns).size!==ns.length||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k))throw new B2bSecurityError(401,'INVALID_TOKEN');
  const q=new URLSearchParams((r.originalUrl??r.url).split('?').slice(1).join('?')),keys=[...q.keys()],base=['issuerId','issuerRuc','environment','branchId','pointId','seriesId','documentType'];
  if(r.body!==undefined||new Set(keys).size!==keys.length||base.some(n=>!q.has(n))||keys.some(n=>![...base,...(list?['take','afterRecordId']:[])].includes(n))||!/^[1-9][0-9]{0,9}$/.test(q.get('issuerId')??''))throw new B2bSecurityError(400,'INVALID_QUERY');
  const binding={...Object.fromEntries(base.map(n=>[n,q.get(n)])),issuerId:Number(q.get('issuerId'))} as B2bBinding;
  if(!validB2bBinding(binding))throw new B2bSecurityError(400,'INVALID_BINDING');
  const input:any={binding};if(q.has('take')){if(!/^[1-9][0-9]{0,2}$/.test(q.get('take')!))throw new B2bSecurityError(400,'INVALID_QUERY');input.take=Number(q.get('take'));}if(q.has('afterRecordId'))input.afterRecordId=q.get('afterRecordId');
  return {access:{token:a.slice(7),kind:k as Access['kind']},input};
 }
 @Get('documents')list(@Req()r:any,@Res({passthrough:true})s:any){const q=this.request(r,s,true);return this.core.execute(q.access,'LIST',q.input);}
 @Get('documents/:recordId')detail(@Req()r:any,@Res({passthrough:true})s:any,@Param('recordId')recordId:string){const q=this.request(r,s);return this.core.execute(q.access,'DETAIL',{...q.input,recordId});}
 @Get('documents/:recordId/artifacts/:artifactKind')async content(@Req()r:any,@Res()s:any,@Param('recordId')recordId:string,@Param('artifactKind')artifactKind:string){const q=this.request(r,s);const f:any=await this.core.execute(q.access,'CONTENT',{...q.input,recordId,artifactKind});
  const ext=f.mediaType==='application/pdf'?'pdf':f.mediaType==='application/zip'?'zip':'xml';
  s.setHeader('Content-Type',f.mediaType);s.setHeader('Content-Length',String(f.bytes.length));s.setHeader('X-Content-Sha256',f.sha256);s.setHeader('Content-Disposition',`attachment; filename="history.${ext}"; filename*=UTF-8''${encodeURIComponent(f.fileName).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);s.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");return s.status(200).send(f.bytes);}
}
@Module({})
export class B2bPhase8HistoryModule{static isolated(core:B2bPhase8History,peers:readonly string[]):DynamicModule{if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_HISTORY_OWNER_REQUIRED');return {module:B2bPhase8HistoryModule,controllers:[B2bPhase8HistoryController],providers:[B2bReadErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:[...peers]}]};}}
