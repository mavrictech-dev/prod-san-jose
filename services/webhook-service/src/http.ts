import {Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {Webhooks} from './core';
const CORE=Symbol('Webhooks owner'),PEERS=Symbol('Webhook private peers');
export interface WebhookPeers {facade:string[];billingPublisher:string[]}
@Controller('internal/b2b')
export class WebhookOwnerController {
  constructor(@Inject(CORE)private readonly core:Webhooks,@Inject(PEERS)private readonly peers:WebhookPeers){}
  @Post('webhooks')async call(@Req()req:any,@Res()res:any,@Body()body:any){b2bPrivatePeer(req,this.peers.facade);res.setHeader('Cache-Control','private, no-store');
    const token=req.headers.authorization;if(typeof token!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(token))throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(!body||Object.keys(body).sort().join(',')!=='action,args,kind'||!['SERVICE','USER'].includes(body.kind))throw new B2bSecurityError(400,'INVALID_REQUEST');
    res.status(200).json(await this.core.call(token.slice(7),body.kind,body.action,body.args));}
  @Post('webhook-events')async ingest(@Req()req:any,@Res()res:any,@Body()body:unknown){b2bPrivatePeer(req,this.peers.billingPublisher);res.setHeader('Cache-Control','private, no-store');res.status(200).json(await this.core.ingest(body));}
}
@Module({})
export class WebhookOwnerModule {
  static isolated(core:Webhooks,peers:WebhookPeers):DynamicModule{if(Object.values(peers).some((v:string[])=>!v.length||v.some(p=>!/^[a-f0-9]{64}$/.test(p))))throw new Error('Explicit webhook mTLS peers required');return {module:WebhookOwnerModule,controllers:[WebhookOwnerController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
