import 'reflect-metadata';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {Catch,HttpException,type ExceptionFilter,type ArgumentsHost} from '@nestjs/common';
import type {DynamicModule} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {WebhookOwnerModule,type WebhookPeers} from './http';
import type {Webhooks} from './core';
@Catch()
class HookErrorFilter implements ExceptionFilter {
  catch(e:unknown,host:ArgumentsHost){const r=host.switchToHttp().getResponse(),status=e instanceof B2bSecurityError?e.status:e instanceof HttpException&&[400,404,413].includes(e.getStatus())?e.getStatus():503,
    code=e instanceof B2bSecurityError?e.code:status<500?'INVALID_REQUEST':'WEBHOOK_UNAVAILABLE';r.setHeader('Cache-Control','private, no-store');r.status(status).json({schemaVersion:'factuez.b2b.v1',requestId:randomUUID(),code,message:code,retryable:status===503||status===429});}
}
/** Explicit candidate factory only. No listener, worker, migration or environment auto-start. */
export async function createWebhookApplication(core:Webhooks,peers:WebhookPeers,tls:{ca:Buffer;cert:Buffer;key:Buffer},runtimeModule?:DynamicModule){
  const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
  const owner=WebhookOwnerModule.isolated(core,peers);
  const app=await NestFactory.create<NestExpressApplication>(runtimeModule?{...owner,imports:[runtimeModule]}:owner,{logger:false,bodyParser:false,httpsOptions});
  let active=0;app.use((req:any,res:any,next:()=>void)=>{res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(req.method!=='POST'||!['/internal/b2b/webhooks','/internal/b2b/webhook-events',...(runtimeModule?['/internal/b2b/runtime-status']:[])].includes(req.url)||req.headers['transfer-encoding']||!/^application\/json(?:;|$)/.test(req.headers['content-type']??'')||Number(req.headers['content-length']??0)>32768)return res.status(400).end();
    if(active>=16)return res.status(429).end();active++;let done=false;const release=()=>{if(!done){done=true;active--;}};res.once('finish',release);res.once('close',release);next();});
  app.useBodyParser('json',{limit:32768,strict:true});app.useGlobalFilters(new HookErrorFilter());return app;
}
