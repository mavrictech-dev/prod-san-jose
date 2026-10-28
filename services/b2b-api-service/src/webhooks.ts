import {Body,Controller,Get,Inject,Module,Param,Patch,Post,Query,Req,Res,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError,b2bBindingsContain,type B2bIdentityScope} from '@factuez/contracts/b2b-security';
import {b2bIssuerId,b2bQuery,b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {B2bPrivateHttp,b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {b2bReadHeaders} from './http';
export interface WebhookOwner {call(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<any>}
export class HttpWebhookOwner implements WebhookOwner {
  constructor(private readonly http:B2bPrivateHttp){}
  call(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){return this.http.post('/internal/b2b/webhooks',{kind,action,args},token);}
}
export class B2bWebhooks {
  constructor(private readonly identity:B2bIdentityPort,private readonly owner:WebhookOwner){}
  async call(token:string,kind:'SERVICE'|'USER',action:string,id:string|undefined,query:unknown,body:unknown,key?:string,ifMatch?:string){
    const list=['LIST','DELIVERIES'].includes(action),read=list||['GET','DELIVERY'].includes(action),q=b2bQuery(query,['issuerId','environment',...(list?['after']:[])],['issuerId','environment']);
    const issuerId=b2bIssuerId(q.issuerId);if(id!==undefined&&!b2bUuid(id)||q.after!==undefined&&!b2bUuid(q.after))throw new B2bSecurityError(400,'INVALID_REQUEST');
    const required:B2bIdentityScope[]=['b2b:documents:read',read?'b2b:webhooks:read':'b2b:webhooks:manage'];const frame=new B2bOwnerReadFrame(this.identity,kind),p=await frame.principal(token,required);
    if(!p.bindings.some(b=>b.issuerId===issuerId))throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const value=await this.owner.call(token,kind,action,{issuerId:String(issuerId),...(id?{id}:{}),...(q.after?{after:q.after}:{}),...(!read?{body,key,...(ifMatch?{ifMatch}:{})}:{})});
    const items=list?value?.items:[value];if(!Array.isArray(items)||items.length>100||items.some((v:any)=>!b2bUuid(v.id)||v.context?.issuerId!==issuerId||!b2bBindingsContain(p.bindings,v.context)))throw new B2bSecurityError(409,'INCONSISTENT_OWNER_RESPONSE');
    await frame.principal(token,required);return value;
  }
}
const CORE=Symbol('B2B webhook facade'),PEERS=Symbol('B2B webhook edge peers');
@Controller('b2b/v1')
export class B2bWebhookController {
  constructor(@Inject(CORE)private readonly core:B2bWebhooks,@Inject(PEERS)private readonly peers:string[]){}
  private async run(action:string,req:any,res:any,id:string|undefined,q:unknown,body?:unknown){b2bReadHeaders(res);b2bPrivatePeer(req,this.peers);
    const token=req.headers.authorization,kind=req.headers['x-factuez-actor-kind']??'SERVICE';if(!['SERVICE','USER'].includes(kind)||typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(token))throw new B2bSecurityError(401,'INVALID_TOKEN');
    const value=await this.core.call(token.slice(7),kind,action,id,q,body,req.headers['idempotency-key'],req.headers['if-match']);if(value.revision)res.setHeader('ETag',value.revision);res.status(action==='CREATE'?201:action==='REPLAY'?202:200);return value;}
  @Get('webhook-subscriptions')list(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.run('LIST',r,s,undefined,q);}
  @Post('webhook-subscriptions')create(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown,@Body()b:unknown){return this.run('CREATE',r,s,undefined,q,b);}
  @Get('webhook-subscriptions/:id')get(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('GET',r,s,id,q);}
  @Patch('webhook-subscriptions/:id')patch(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('PATCH',r,s,id,q,b);}
  @Post('webhook-subscriptions/:id/verify')verify(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('VERIFY',r,s,id,q,b);}
  @Post('webhook-subscriptions/:id/rotate-secret')rotate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('ROTATE',r,s,id,q,b);}
  @Get('webhook-deliveries')deliveries(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.run('DELIVERIES',r,s,undefined,q);}
  @Get('webhook-deliveries/:id')delivery(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('DELIVERY',r,s,id,q);}
  @Post('webhook-deliveries/:id/replay')replay(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('REPLAY',r,s,id,q,b);}
}
@Module({})
export class B2bWebhookModule {
  static isolated(core:B2bWebhooks,peers:string[]):DynamicModule{if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit webhook edge peers required');return {module:B2bWebhookModule,controllers:[B2bWebhookController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
