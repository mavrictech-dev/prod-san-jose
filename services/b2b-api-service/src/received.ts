import {Catch,Controller,Get,HttpException,Inject,Module,Param,Req,Res,UseFilters,type DynamicModule,type ArgumentsHost} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bQuery,b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope,receivedScopeQuery,receivedSelection,receivedAnchor,receivedDetail,receivedManifest,receivedPage,receivedFile,receivedFail,
  type ReceivedScope,type ReceivedAction,type ReceivedSelection} from '@factuez/service-access/dist/b2b-received-wire';
type Kind='SERVICE'|'USER';
export interface B2bReceivedOwner{
  execute(token:string,kind:Kind,action:Exclude<ReceivedAction,'CONTENT'>,args:unknown):Promise<unknown>;
  content(token:string,kind:Kind,args:unknown):Promise<{bytes:Buffer;sha256:string;fileName:string;mediaType:string}>;
}
export class HttpB2bReceivedOwner implements B2bReceivedOwner{
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'|'receivedFile'>){}
  execute(token:string,kind:Kind,action:Exclude<ReceivedAction,'CONTENT'>,args:unknown){return this.http.post('/internal/b2b/received-read',{kind,action,args},token);}
  content(token:string,kind:Kind,args:unknown){return this.http.receivedFile({kind,action:'CONTENT',args},token);}
}
export class B2bReceivedReads{
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:B2bReceivedOwner){}
  private async frame(token:string,kind:Kind,scope:ReceivedScope,files=false){
    if(!['SERVICE','USER'].includes(kind)||typeof token!=='string'||!/^[-A-Za-z0-9._~]{1,8192}$/.test(token))receivedFail(401,'INVALID_TOKEN');
    const f=new B2bOwnerReadFrame(this.identity,kind),required=files?['b2b:received:read','b2b:received:artifacts:read'] as const:['b2b:received:read'] as const;
    const check=async()=>{receivedAnchor(await f.principal(token,[...required]),scope);};await check();return check;
  }
  async list(token:string,kind:Kind,input:unknown){
    const q=receivedSelection(input),fresh=await this.frame(token,kind,q.scope),value=receivedPage(await this.owner.execute(token,kind,'LIST',q),q);await fresh();return value;
  }
  async detail(token:string,kind:Kind,input:unknown,id:string){
    const scope=receivedScope(input);if(!b2bUuid(id))receivedFail();const fresh=await this.frame(token,kind,scope);
    const result=receivedDetail(await this.owner.execute(token,kind,'DETAIL',{scope,id}),scope,id);await fresh();return result;
  }
  async artifacts(token:string,kind:Kind,input:unknown,id:string){
    const scope=receivedScope(input);if(!b2bUuid(id))receivedFail();const fresh=await this.frame(token,kind,scope,true);
    const result=receivedManifest(await this.owner.execute(token,kind,'ARTIFACTS',{scope,id}),scope,id);await fresh();return result;
  }
  async content(token:string,kind:Kind,input:unknown,id:string,artifactId:string){
    const scope=receivedScope(input);if(!b2bUuid(id)||!b2bUuid(artifactId))receivedFail();const fresh=await this.frame(token,kind,scope,true);
    const before=receivedManifest(await this.owner.execute(token,kind,'ARTIFACTS',{scope,id}),scope,id),artifact=before.items.find(a=>a.id===artifactId);
    if(!artifact)receivedFail(404,'RESOURCE_NOT_FOUND');
    const file=receivedFile(await this.owner.content(token,kind,{scope,id,artifactId}),artifact!);
    const after=receivedManifest(await this.owner.execute(token,kind,'ARTIFACTS',{scope,id}),scope,id);
    if(hash(before)!==hash(after))receivedFail(409,'RECEIVED_ARTIFACTS_CHANGED');await fresh();return file;
  }
}
const CORE=Symbol('B2B received reads'),PEERS=Symbol('B2B received peers'),SCOPE=['environment','companyId','recipientRuc','branchId'] as const;
@Catch()
export class B2bReceivedHttpErrorFilter{
  catch(error:unknown,host:ArgumentsHost){
    const codes:Record<number,string>={400:'INVALID_RECEIVED_REQUEST',401:'INVALID_TOKEN',403:'RECEIVED_ACCESS_DENIED',404:'RESOURCE_NOT_FOUND',409:'RECEIVED_INTEGRITY_CONFLICT',413:'NARROW_QUERY',429:'RATE_LIMITED',503:'RECEIVED_OWNER_UNAVAILABLE'};
    const candidate=error instanceof B2bSecurityError?error.status:error instanceof HttpException?error.getStatus():503;
    const status=Object.hasOwn(codes,candidate)?candidate:503,res=host.switchToHttp().getResponse();
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    return res.status(status).json({schemaVersion:'factuez.b2b.v1',code:codes[status],message:codes[status],retryable:status===503||status===429});
  }
}
@Controller('b2b/v1')
@UseFilters(B2bReceivedHttpErrorFilter)
export class B2bReceivedController{
  constructor(@Inject(CORE)private readonly core:B2bReceivedReads,@Inject(PEERS)private readonly peers:readonly string[]){}
  private access(req:any,res:any){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const names:string[]=(req.rawHeaders??[]).filter((_v:string,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=req.headers.authorization,k=req.headers['x-factuez-actor-kind'];
    if(typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k)||
      names.filter(n=>n==='authorization').length!==1||names.filter(n=>n==='x-factuez-actor-kind').length!==1)throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(new Set(names).size!==names.length||req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'||req.body!==undefined||
      names.some(n=>['authorization','xfactuezactorkind'].includes(n.replace(/[-_]/g,''))&&!['authorization','x-factuez-actor-kind'].includes(n)))receivedFail();
    return {token:a.slice(7),kind:k as Kind};
  }
  private query(req:any,list=false){
    const allowed=[...SCOPE,...(list?['from','to','type','after','limit']:[])],required=[...SCOPE,...(list?['from','to']:[])];
    const raw=new URLSearchParams((req.originalUrl??req.url).split('?').slice(1).join('?')),keys=[...raw.keys()];
    if(new Set(keys).size!==keys.length||keys.some(k=>!allowed.includes(k)))receivedFail();
    const q=b2bQuery(correctionEvidenceFreeze(req.query),allowed,required),scope=receivedScopeQuery(q);
    if(!list)return scope;
    if(q.limit!==undefined&&!/^[1-9][0-9]{0,2}$/.test(q.limit))receivedFail();
    return receivedSelection({scope,from:q.from,to:q.to,limit:q.limit===undefined?25:Number(q.limit),...(q.type?{type:q.type}:{}),...(q.after?{after:q.after}:{})});
  }
  @Get('received-documents')
  list(@Req()req:any,@Res({passthrough:true})res:any){const a=this.access(req,res);return this.core.list(a.token,a.kind,this.query(req,true));}
  @Get('received-documents/:id')
  detail(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string){const a=this.access(req,res);return this.core.detail(a.token,a.kind,this.query(req),id);}
  @Get('received-documents/:id/artifacts')
  artifacts(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string){const a=this.access(req,res);return this.core.artifacts(a.token,a.kind,this.query(req),id);}
  @Get('received-documents/:id/artifacts/:artifactId/content')
  async content(@Req()req:any,@Res()res:any,@Param('id')id:string,@Param('artifactId')artifactId:string){
    const a=this.access(req,res),file=await this.core.content(a.token,a.kind,this.query(req),id,artifactId);
    const extension=file.mediaType==='application/pdf'?'pdf':file.mediaType==='application/zip'?'zip':'xml';
    res.setHeader('Content-Type',file.mediaType);res.setHeader('Content-Length',String(file.bytes.length));res.setHeader('X-Content-Sha256',file.sha256);
    res.setHeader('Content-Disposition',`attachment; filename="documento.${extension}"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`);
    res.setHeader('Content-Security-Policy',"sandbox; default-src 'none'");res.setHeader('X-FactuEz-Source','RECEIVED_ORIGINAL');return res.status(200).send(file.bytes);
  }
}
@Module({})
export class B2bReceivedModule{
  static isolated(core:B2bReceivedReads,peers:readonly string[]):DynamicModule{
    if(!core||['list','detail','artifacts','content'].some(k=>typeof (core as any)[k]!=='function')||!Array.isArray(peers)||!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_B2B_RECEPTION_AND_PEERS_REQUIRED');
    return {module:B2bReceivedModule,controllers:[B2bReceivedController],providers:[B2bReceivedHttpErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
  }
}
