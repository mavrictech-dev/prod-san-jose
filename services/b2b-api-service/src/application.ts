import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { B2bReadModule,B2bReadErrorFilter,b2bReadHeaders } from './http';
import type { B2bReads } from './read';
export async function createB2bReadApplication(core:B2bReads,peers:string[],tls:{ca:Buffer;cert:Buffer;key:Buffer}){
  const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
  const app=await NestFactory.create<NestExpressApplication>(B2bReadModule.isolated(core,peers),{logger:false,bodyParser:false,httpsOptions});
  let active=0;app.use((req:any,res:any,next:()=>void)=>{
    b2bReadHeaders(res);if(req.method!=='GET'||req.url.length>8192||req.headers['transfer-encoding']||(req.headers['content-length']!==undefined&&req.headers['content-length']!=='0'))return res.status(400).json({code:'READ_ONLY_LISTENER'});
    if(active>=16){res.setHeader('Retry-After','60');return res.status(429).json({code:'RATE_LIMITED'});}
    active++;let released=false;const release=()=>{if(!released){released=true;active--;}};res.once('finish',release);res.once('close',release);next();
  });app.useGlobalFilters(new B2bReadErrorFilter());return app;
}
