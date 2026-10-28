import {Controller,Get,Inject,Module,Param,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bIssuerId,b2bQuery} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {BATCH_ARTIFACT_KINDS,batchArtifactScope,batchArtifactView,batchArtifactFile,
  type BatchArtifactScope,type BatchArtifactKind,type BatchArtifactFile} from '@factuez/service-access/dist/b2b-batch-artifact-wire';
import {B2bBatchOperationsHttpErrorFilter} from './batch-operations';
export interface B2bBatchArtifactOwner{
  view(token:string,kind:'SERVICE'|'USER',scope:BatchArtifactScope,prepare:boolean):Promise<unknown>;
  content(token:string,kind:'SERVICE'|'USER',scope:BatchArtifactScope,artifact:BatchArtifactKind):Promise<BatchArtifactFile>;
}
export class HttpB2bBatchArtifactOwner implements B2bBatchArtifactOwner{
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'|'batchArtifactFile'>){}
  view(token:string,kind:'SERVICE'|'USER',scope:BatchArtifactScope,prepare:boolean){return this.http.post('/internal/b2b/batch-artifacts',{kind,scope,action:prepare?'PREPARE':'READ'},token);}
  content(token:string,kind:'SERVICE'|'USER',scope:BatchArtifactScope,artifact:BatchArtifactKind){return this.http.batchArtifactFile({kind,scope,action:'CONTENT',artifact},token);}
}
function invalid():never{throw new B2bSecurityError(400,'INVALID_BATCH_ARTIFACT_REQUEST');}
export class B2bBatchArtifacts{
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:B2bBatchArtifactOwner){}
  private async frame(token:string,kind:'SERVICE'|'USER',input:unknown,prepare:boolean){
    const scope=batchArtifactScope(input),frame=new B2bOwnerReadFrame(this.identity,kind);
    const required=prepare?['b2b:batches:write'] as const:['b2b:batches:read','b2b:artifacts:read'] as const;
    const check=async()=>{const p=await frame.principal(token,[...required]);if(!p.bindings.some(b=>b.issuerId===scope.companyId&&b.issuerRuc===scope.issuerRuc&&b.environment===scope.environment&&b.branchId===scope.branchId))
      throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');};await check();return {scope,check};
  }
  async view(token:string,kind:'SERVICE'|'USER',input:unknown,prepare:boolean){
    const f=await this.frame(token,kind,input,prepare),result=batchArtifactView(await this.owner.view(token,kind,f.scope,prepare),f.scope,prepare);await f.check();return result;
  }
  async content(token:string,kind:'SERVICE'|'USER',input:unknown,artifact:BatchArtifactKind){
    if(!BATCH_ARTIFACT_KINDS.includes(artifact))invalid();const f=await this.frame(token,kind,input,false);
    const before=batchArtifactView(await this.owner.view(token,kind,f.scope,false),f.scope,false);
    const file=batchArtifactFile(await this.owner.content(token,kind,f.scope,artifact),before,artifact);
    const after=batchArtifactView(await this.owner.view(token,kind,f.scope,false),f.scope,false);
    if(hash(before)!==hash(after))throw new B2bSecurityError(409,'BATCH_ARTIFACT_CHANGED');await f.check();return file;
  }
}
const CORE=Symbol('B2B batch artifacts'),PEERS=Symbol('B2B batch artifact peers'),QUERY=['environment','issuerRuc','companyId','branchId'] as const;
@Controller('b2b/v1')
@UseFilters(B2bBatchOperationsHttpErrorFilter)
export class B2bBatchArtifactController{
  constructor(@Inject(CORE)private readonly core:B2bBatchArtifacts,@Inject(PEERS)private readonly peers:readonly string[]){}
  private access(req:any,res:any){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const names:string[]=(req.rawHeaders??[]).filter((_v:string,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),a=req.headers.authorization,k=req.headers['x-factuez-actor-kind'];
    if(typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a)||!['SERVICE','USER'].includes(k)||
      names.filter(n=>n==='authorization').length!==1||names.filter(n=>n==='x-factuez-actor-kind').length!==1)throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(new Set(names).size!==names.length||names.some(n=>['authorization','xfactuezactorkind'].includes(n.replace(/[-_]/g,''))&&!['authorization','x-factuez-actor-kind'].includes(n)))invalid();
    return {token:a.slice(7),kind:k as 'SERVICE'|'USER'};
  }
  private query(req:any,batchId:string){
    if(req.headers['transfer-encoding']!==undefined||req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'||req.body!==undefined)invalid();
    const raw=new URLSearchParams((req.originalUrl??req.url).split('?').slice(1).join('?')),names=[...raw.keys()];
    if(names.length!==4||new Set(names).size!==4||names.some(n=>!QUERY.includes(n as any)))invalid();
    const q=b2bQuery(correctionEvidenceFreeze(req.query),QUERY,QUERY);
    return batchArtifactScope({...q,companyId:b2bIssuerId(q.companyId),batchId});
  }
  @Post('batches/:id/local-artifacts')
  async prepare(@Req()req:any,@Res()res:any,@Param('id')id:string){
    const a=this.access(req,res);if(req.url.includes('?')||Object.keys(req.query??{}).length)invalid();
    const b:any=correctionEvidenceFreeze(req.body);if(!b||Object.keys(b).join(',')!=='scope')invalid();
    const scope=batchArtifactScope(b.scope);if(scope.batchId!==id)invalid();
    const result=await this.core.view(a.token,a.kind,scope,true);res.setHeader('X-Idempotent-Replay',String(result.replayed));return res.status(200).json(result);
  }
  @Get('batches/:id/local-artifacts')
  async read(@Req()req:any,@Res()res:any,@Param('id')id:string){const a=this.access(req,res);return res.status(200).json(await this.core.view(a.token,a.kind,this.query(req,id),false));}
  @Get('batches/:id/local-artifacts/:artifact')
  async content(@Req()req:any,@Res()res:any,@Param('id')id:string,@Param('artifact')artifact:BatchArtifactKind){
    const a=this.access(req,res),file=await this.core.content(a.token,a.kind,this.query(req,id),artifact);
    res.setHeader('Content-Type',file.mediaType);res.setHeader('Content-Length',String(file.bytes.length));res.setHeader('Content-Disposition',`attachment; filename="${file.fileName}"`);
    res.setHeader('X-Content-Sha256',file.sha256);res.setHeader('X-FactuEz-Source','LOCAL_EMULATOR');return res.status(200).send(file.bytes);
  }
}
@Module({})
export class B2bBatchArtifactModule{
  static isolated(core:B2bBatchArtifacts,peers:readonly string[]):DynamicModule{
    if(!core||typeof core.view!=='function'||typeof core.content!=='function'||!Array.isArray(peers)||!peers.length||peers.length>100||new Set(peers).size!==peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))
      throw new Error('EXPLICIT_BATCH_ARTIFACT_FACADE_AND_PEERS_REQUIRED');
    return {module:B2bBatchArtifactModule,controllers:[B2bBatchArtifactController],providers:[B2bBatchOperationsHttpErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
  }
}
