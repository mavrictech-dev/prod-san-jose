import {Body,Controller,Get,Inject,Module,Param,Patch,Post,Query,Req,Res,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError,b2bBindingsContain,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {b2bIssuerId,b2bQuery,b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {B2bPrivateHttp,b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {b2bReadHeaders} from './http';
type Kind='SALES_NOTE'|'CORRECTION_REQUEST';
export interface CommercialOwner {execute(token:string,actor:'SERVICE'|'USER',resourceKind:Kind,action:string,args:unknown):Promise<any>}
export class HttpB2bCommercialOwner implements CommercialOwner {
  constructor(private readonly http:B2bPrivateHttp){}
  execute(token:string,kind:'SERVICE'|'USER',resourceKind:Kind,action:string,args:unknown){return this.http.post('/internal/b2b/commercial',{kind,resourceKind,action,args},token);}
}
export class B2bCommercialCommands {
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:CommercialOwner,readonly conversionConfigured=false){}
  async call(token:string,actor:'SERVICE'|'USER',kind:Kind,action:string,id:string|null,query:unknown,body?:unknown,key?:string,ifMatch?:string){
    const listing=action==='LIST',q=b2bQuery(query,listing?['issuerId','environment','limit','after']:['issuerId','environment'],['issuerId','environment']),issuerId=b2bIssuerId(q.issuerId);
    if(!['SALES_NOTE','CORRECTION_REQUEST'].includes(kind)||!['CREATE','READ','LIST','PATCH','COMPLETE','CONVERT','CANCEL','OPERATION','READINESS'].includes(action)||!['SERVICE','USER'].includes(actor)||(id!==null&&!b2bUuid(id))||action==='READINESS'&&kind!=='CORRECTION_REQUEST')throw new B2bSecurityError(400,'INVALID_REQUEST');
    const writing=!['READ','LIST','OPERATION','READINESS'].includes(action),required:B2bIdentityScope[]=action==='OPERATION'?['b2b:operations:read']:
      kind==='SALES_NOTE'?[writing?'b2b:sales-notes:write':'b2b:sales-notes:read']:[writing?'b2b:corrections:write':'b2b:corrections:read','b2b:documents:read'];
    if(action==='CONVERT')required.push('b2b:documents:issue');
    const frame=new B2bOwnerReadFrame(this.identity,actor),p=await frame.principal(token,required);
    if(!p.bindings.some(b=>b.issuerId===issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    if(action==='CONVERT'&&!this.conversionConfigured)throw new B2bSecurityError(409,'PROFILE_NOT_ENABLED');
    if(listing&&(q.limit!==undefined&&!/^[1-9]\d{0,2}$/.test(q.limit)||q.after!==undefined&&!b2bUuid(q.after)))throw new B2bSecurityError(400,'INVALID_QUERY');
    const args=listing?{issuerId:q.issuerId,limit:q.limit?Number(q.limit):50,after:q.after??null}:!writing?{issuerId:q.issuerId,id}:{issuerId:q.issuerId,id,key,...(ifMatch?{ifMatch}:{}),body};
    const value=await this.owner.execute(token,actor,kind,action,args),views=listing?value?.items:[value?.response??value];
    if(!Array.isArray(views)||views.length>100||views.some(v=>!v?.context||v.context.issuerId!==issuerId||!b2bBindingsContain(p.bindings,v.context)))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
    if(listing&&(!value.page||value.page.limit!==args.limit||typeof value.page.hasMore!=='boolean'||value.page.nextAfter!==null&&!b2bUuid(value.page.nextAfter)))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
    await frame.principal(token,required);return value;
  }
}
const CORE=Symbol('B2B commercial facade'),PEERS=Symbol('B2B commercial facade peers');
@Controller('b2b/v1')
export class B2bCommercialController {
  constructor(@Inject(CORE)private readonly core:B2bCommercialCommands,@Inject(PEERS)private readonly peers:string[]){}
  private async run(kind:Kind,action:string,req:any,res:any,id:string|null,q:unknown,b?:unknown){
    b2bReadHeaders(res);b2bPrivatePeer(req,this.peers);const authorization=req.headers.authorization,actor=req.headers['x-factuez-actor-kind']??'SERVICE';
    if(!['SERVICE','USER'].includes(actor)||typeof authorization!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const v=await this.core.call(authorization.slice(7),actor,kind,action,id,q,b,req.headers['idempotency-key'],req.headers['if-match']);
    if(v.operation){res.setHeader('X-Operation-Id',v.operation.operationId);res.setHeader('X-Idempotent-Replay',String(v.replayed));res.setHeader('ETag',v.response.revision);res.status(action==='CONVERT'?202:action==='CREATE'&&!v.replayed?201:200);return v.response;}
    if(action==='READ')res.setHeader('ETag',v.revision);return v;
  }
  @Get('sales-notes')list(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.run('SALES_NOTE','LIST',r,s,null,q);}
  @Post('sales-notes')create(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown,@Body()b:unknown){return this.run('SALES_NOTE','CREATE',r,s,null,q,b);}
  @Get('sales-notes/:id')read(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('SALES_NOTE','READ',r,s,id,q);}
  @Patch('sales-notes/:id')patch(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('SALES_NOTE','PATCH',r,s,id,q,b);}
  @Post('sales-notes/:id/complete')complete(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('SALES_NOTE','COMPLETE',r,s,id,q,b);}
  @Post('sales-notes/:id/convert')convert(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('SALES_NOTE','CONVERT',r,s,id,q,b);}
  @Post('sales-notes/:id/cancel')cancel(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('SALES_NOTE','CANCEL',r,s,id,q,b);}
  @Get('correction-requests')corrections(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.run('CORRECTION_REQUEST','LIST',r,s,null,q);}
  @Post('correction-requests')request(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown,@Body()b:unknown){return this.run('CORRECTION_REQUEST','CREATE',r,s,null,q,b);}
  @Get('correction-requests/:id')correction(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('CORRECTION_REQUEST','READ',r,s,id,q);}
  @Get('correction-requests/:id/readiness')readiness(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('CORRECTION_REQUEST','READINESS',r,s,id,q);}
  @Post('correction-requests/:id/cancel')cancelCorrection(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('CORRECTION_REQUEST','CANCEL',r,s,id,q,b);}
  @Get('commercial-operations/:id')operation(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('SALES_NOTE','OPERATION',r,s,id,q);}
}
@Module({})
export class B2bCommercialModule {
  static isolated(core:B2bCommercialCommands,peers:string[]):DynamicModule {
    if(!peers.length||peers.length>100||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit commercial facade peers required');
    return {module:B2bCommercialModule,controllers:[B2bCommercialController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};
  }
}
