import { Body,Controller,Get,Inject,Module,Param,Patch,Post,Query,Req,Res,type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bCommands } from './commands';
import { b2bReadHeaders } from './http';
const CORE=Symbol('B2B draft facade'),PEERS=Symbol('B2B draft facade peers');
@Controller('b2b/v1')
export class B2bDraftController {
  constructor(@Inject(CORE)private readonly core:B2bCommands,@Inject(PEERS)private readonly peers:string[]){}
  private context(req:any,res:any){b2bReadHeaders(res);b2bPrivatePeer(req,this.peers);const token=req.headers.authorization,kind=req.headers['x-factuez-actor-kind']??'SERVICE';
    if(!['SERVICE','USER'].includes(kind)||typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(token))throw new B2bSecurityError(401,'INVALID_TOKEN');return {token:token.slice(7),kind:kind as 'SERVICE'|'USER'};}
  private async run(action:any,req:any,res:any,id:string|null,q:unknown,body?:unknown){const c=this.context(req,res),result=await this.core.call(c.token,c.kind,action,id,q,body,req.headers['idempotency-key'],req.headers['if-match']);
    if(['CREATE','PATCH','CANCEL','VALIDATE','ISSUE'].includes(action)){res.setHeader('X-Operation-Id',result.operation.operationId);res.setHeader('X-Command-Id',result.operation.commandId);res.setHeader('X-Idempotent-Replay',String(result.replayed));res.setHeader('ETag',result.response.revision);res.status(action==='ISSUE'?202:action==='CREATE'&&!result.replayed?201:200);return result.response;}
    if(action==='READ')res.setHeader('ETag',result.revision);return result;}
  @Post('document-drafts')create(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown,@Body()b:unknown){return this.run('CREATE',r,s,null,q,b);}
  @Get('document-drafts/:id')read(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('READ',r,s,id,q);}
  @Patch('document-drafts/:id')patch(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('PATCH',r,s,id,q,b);}
  @Post('document-drafts/:id/validate')validate(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('VALIDATE',r,s,id,q,b);}
  @Post('document-drafts/:id/cancel')cancel(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('CANCEL',r,s,id,q,b);}
  @Post('document-drafts/:id/issue')issue(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('ISSUE',r,s,id,q,b);}
  @Get('operations/lookup')lookup(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.run('OPERATION',r,s,null,q);}
  @Get('operations/:id')operation(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.run('OPERATION',r,s,id,q);}
}
@Module({})
export class B2bDraftModule {
  static isolated(core:B2bCommands,peers:string[]):DynamicModule{if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit B2B draft peers required');
    return {module:B2bDraftModule,controllers:[B2bDraftController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
