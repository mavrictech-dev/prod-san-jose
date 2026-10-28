import {Controller,Inject,Module,Param,Patch,Post,Req,Res,UseFilters,type DynamicModule} from '@nestjs/common';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {b2bPrivatePeer,type B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope,receivedScopeQuery,receivedAnchor,receivedFail,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bReceivedHttpErrorFilter} from './received';
type Action='IMPORT'|'ATTACH'|'ASSIGN'|'REGISTER';
export interface ReceptionCommandPort{execute(access:{token:string;kind:'SERVICE'|'USER'},action:Action,input:unknown):Promise<unknown>}
export class HttpReceptionCommands implements ReceptionCommandPort{
  constructor(private readonly http:Pick<B2bPrivateHttp,'post'>){}
  execute(access:{token:string;kind:'SERVICE'|'USER'},action:Action,input:unknown){return this.http.post('/internal/b2b/received-command',{kind:access.kind,action,input},access.token);}
}
export class B2bReceivedCommands {
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:ReceptionCommandPort){}
  async execute(access:{token:string;kind:'SERVICE'|'USER'},action:Action,scopeInput:unknown,key:string,payload:unknown){
    const scope=receivedScope(scopeInput),frame=new B2bOwnerReadFrame(this.identity,access.kind);
    if(!/^[A-Za-z0-9_-]{16,128}$/.test(key)||!['IMPORT','ATTACH','ASSIGN','REGISTER'].includes(action))receivedFail();
    const fresh=async()=>receivedAnchor(await frame.principal(access.token,['b2b:received:write']),scope);await fresh();
    const p:any=correctionEvidenceFreeze(payload),r:any=correctionEvidenceFreeze(await this.owner.execute(access,action,{scope,key,payload:p}));
    if(!r||!b2bUuid(r.documentId)||r.fiscalAcceptance!=='NOT_VERIFIED'||
      Object.keys(r).sort().join(',')!==(action==='ASSIGN'?'branchId,documentId,fiscalAcceptance,outcome':'documentId,fiscalAcceptance,outcome')||
      !(action==='IMPORT'?['IMPORTED','DUPLICATE']:action==='ATTACH'?['ATTACHED']:action==='ASSIGN'?['ASSIGNED']:['REGISTERED']).includes(r.outcome)||
      action!=='IMPORT'&&r.documentId!==p.documentId||action==='ASSIGN'&&r.branchId!==p.targetBranchId)receivedFail(503,'INVALID_RECEIVED_OWNER_RESPONSE');
    await fresh();return {schemaVersion:'factuez.b2b.received-command.v1',scope,action,result:r};
  }
}
const CORE=Symbol('B2b reception commands'),PEERS=Symbol('Reception command peers');
@Controller('b2b/v1/received-documents')
@UseFilters(B2bReceivedHttpErrorFilter)
export class B2bReceivedCommandsController {
  constructor(@Inject(CORE)private readonly core:B2bReceivedCommands,@Inject(PEERS)private readonly peers:readonly string[]){}
  private request(req:any,res:any){
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');b2bPrivatePeer(req,this.peers);
    const names=(req.rawHeaders??[]).filter((_v:any,i:number)=>i%2===0).map((n:string)=>n.toLowerCase()),auth=req.headers.authorization,kind=req.headers['x-factuez-actor-kind'],key=req.headers['idempotency-key'];
    if(new Set(names).size!==names.length||typeof auth!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(auth)||!['SERVICE','USER'].includes(kind)||typeof key!=='string')receivedFail(401,'INVALID_TOKEN');
    const q=new URLSearchParams((req.originalUrl??req.url).split('?').slice(1).join('?')),keys=[...q.keys()];
    if(new Set(keys).size!==4||keys.length!==4||keys.some(k=>!['environment','companyId','recipientRuc','branchId'].includes(k)))receivedFail();
    const scope=receivedScopeQuery(Object.fromEntries(q.entries()));
    const payload:any=correctionEvidenceFreeze(req.body);
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.hasOwn(payload,'documentId'))receivedFail();
    return {access:{token:auth.slice(7),kind:kind as 'SERVICE'|'USER'},key,scope,payload};
  }
  @Post()import(@Req()req:any,@Res({passthrough:true})res:any){const r=this.request(req,res);return this.core.execute(r.access,'IMPORT',r.scope,r.key,r.payload);}
  @Post(':id/artifacts')attach(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string){const r=this.request(req,res);return this.core.execute(r.access,'ATTACH',r.scope,r.key,{...r.payload,documentId:id});}
  @Patch(':id/assignment')assign(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string){const r=this.request(req,res);return this.core.execute(r.access,'ASSIGN',r.scope,r.key,{...r.payload,documentId:id});}
  @Patch(':id/registration')register(@Req()req:any,@Res({passthrough:true})res:any,@Param('id')id:string){const r=this.request(req,res);return this.core.execute(r.access,'REGISTER',r.scope,r.key,{...r.payload,documentId:id});}
}
@Module({})
export class B2bReceivedCommandsModule {
  static isolated(core:B2bReceivedCommands,peers:readonly string[]):DynamicModule{
    if(!core||typeof core.execute!=='function'||!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('EXPLICIT_RECEPTION_COMMAND_OWNER_REQUIRED');
    return {module:B2bReceivedCommandsModule,controllers:[B2bReceivedCommandsController],providers:[B2bReceivedHttpErrorFilter,{provide:CORE,useValue:core},{provide:PEERS,useValue:Object.freeze([...peers])}]};
  }
}
