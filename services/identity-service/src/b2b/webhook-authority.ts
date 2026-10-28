import {randomUUID} from 'node:crypto';
import {Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {b2bBindingsContain,validB2bBinding,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {fail,plain,uuid,type Store,type BindingCatalogue} from './model';
import {b2bPrivateContext,b2bPrivateHeaders,B2bErrorFilter} from './http';
import type {LinkedUsers} from './oidc';
import type {PrismaService} from '../infrastructure/prisma.service';
export type QueuedActor=Pick<B2bPrincipal,'kind'|'clientId'|'revision'|'subjectId'|'userAuthRevision'>;
export interface QueuedUsers {current(actor:QueuedActor):Promise<Awaited<ReturnType<LinkedUsers['current']>>|null>}
export class PostgresQueuedUsers implements QueuedUsers {
  constructor(private readonly db:PrismaService,private readonly users:Pick<LinkedUsers,'current'>){}
  async current(a:QueuedActor){const rows=await this.db.$queryRawUnsafe<{ok:boolean}[]>(`SELECT EXISTS (SELECT 1 FROM "B2bUserLink" WHERE "clientId"=$1::uuid AND "clientRevision"=$2 AND "userId"=$3::uuid AND "userAuthRevision"=$4 AND "enabled"=true) AS ok`,a.clientId,a.revision,a.subjectId,a.userAuthRevision);
    return rows[0]?.ok?this.users.current(a.subjectId!):null;}
}
/** mTLS worker authority, not token minting/exchange. Never trusts a public actor header. */
export class B2bWebhookAuthority {
  constructor(private readonly store:Store,private readonly catalogue:BindingCatalogue,private readonly users:QueuedUsers|null=null){}
  async check(body:unknown,peer:string){
    if(!plain(body)||Object.keys(body).sort().join(',')!=='actor,binding'||!plain(body.actor)||Object.keys(body.actor).sort().join(',')!=='clientId,kind,revision,subjectId,userAuthRevision'||!validB2bBinding(body.binding))return fail(400,'INVALID_REQUEST');
    const a=body.actor as QueuedActor;if(!uuid(a.clientId)||!Number.isSafeInteger(a.revision)||a.revision<1||
      (a.kind==='SERVICE'?a.subjectId!==null||a.userAuthRevision!==null:a.kind!=='USER'||!uuid(a.subjectId)||!Number.isSafeInteger(a.userAuthRevision)||Number(a.userAuthRevision)<0))return fail(400,'INVALID_REQUEST');
    try{return await this.store.transaction(async tx=>{
      const c=await tx.get(a.clientId);let allowed=!!c?.enabled&&c.kind===a.kind&&c.revision===a.revision&&['b2b:webhooks:read','b2b:documents:read'].every(s=>c.scopes.includes(s as any))&&b2bBindingsContain(c.bindings,body.binding);
      if(allowed&&a.kind==='USER'){const u=await this.users?.current(a);allowed=!!u?.active&&u.authVersion===a.userAuthRevision&&u.permissions.includes('document.view')&&
        (u.scope.kind==='GLOBAL'||u.scope.branchIds.includes(body.binding.branchId)&&u.scope.emissionPointIds.includes(body.binding.pointId)&&u.scope.series.includes(body.binding.seriesId));}
      if(allowed){try{await this.catalogue.validate([body.binding]);}catch{return fail(503,'CONTEXT_AUTHORITY_UNAVAILABLE');}}
      await tx.audit({id:randomUUID(),requestId:randomUUID(),clientId:a.clientId,actorId:a.subjectId,action:'AUTHORIZE_WEBHOOK_DELIVERY',outcome:allowed?'OK':'DENIED',revision:c?.revision??null,peerHash:peer,at:new Date().toISOString()});return {allowed};
    });}catch(e){if(e instanceof Error&&'status'in e)throw e;return fail(503,'IDENTITY_UNAVAILABLE');}
  }
}
const CORE=Symbol('Webhook authority'),PEERS=Symbol('Webhook worker peers');
@Controller('internal/b2b')
export class B2bWebhookAuthorityController {
  constructor(@Inject(CORE)private readonly core:B2bWebhookAuthority,@Inject(PEERS)private readonly peers:string[]){}
  @Post('authorize-webhook')async check(@Req()req:any,@Res()res:any,@Body()body:unknown){b2bPrivateHeaders(res);const ctx=b2bPrivateContext(req,this.peers);res.status(200).json(await this.core.check(body,ctx.peer.split(':')[0]));}
}
@Module({})
export class B2bWebhookAuthorityModule {
  static isolated(core:B2bWebhookAuthority,peers:string[]):DynamicModule{if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit worker mTLS peers required');return {module:B2bWebhookAuthorityModule,controllers:[B2bWebhookAuthorityController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
export {B2bErrorFilter};
