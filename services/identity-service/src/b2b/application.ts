import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { B2bErrorFilter,B2bIdentityModule,b2bPrivateHeaders,type B2bPeers } from './http';
import type { B2bIdentity } from './service';
import type { DynamicModule } from '@nestjs/common';
/** Explicit assembly only. Not imported by the current AppModule/main. No default secrets/listener. */
export async function createB2bIdentityApplication(core:B2bIdentity,peers:B2bPeers,tls:{ca:Buffer;cert:Buffer;key:Buffer},corrections?:DynamicModule){
  const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
  const identityModule=B2bIdentityModule.isolated(core,peers);
  const app=await NestFactory.create<NestExpressApplication>(corrections?{...identityModule,imports:[corrections]}:identityModule,{
    logger:false,bodyParser:false,httpsOptions,
  });
  let active=0;
  app.use((req:any,res:any,next:()=>void)=>{
    b2bPrivateHeaders(res);
    if(active>=16){res.setHeader('Retry-After','60');return res.status(429).json({error:'temporarily_unavailable'});}
    if(req.url.length>8192||req.headers['transfer-encoding']||Number(req.headers['content-length']??0)>256*1024)return res.status(413).end();
    active++;let released=false;const release=()=>{if(!released){active--;released=true;}};res.once('finish',release);res.once('close',release);next();
  });
  app.useBodyParser('json',{limit:'256kb'});app.useBodyParser('urlencoded',{extended:false,limit:'4kb',parameterLimit:5});
  app.useGlobalFilters(new B2bErrorFilter());return app;
}
