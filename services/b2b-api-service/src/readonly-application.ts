import 'reflect-metadata';
import {Body,Controller,Inject,Module,Post,Req,Res,type DynamicModule} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import type {NestExpressApplication} from '@nestjs/platform-express';
import {b2bPrivatePeer} from '@factuez/service-access/dist/b2b';
import {B2bOAuthHttp} from '@factuez/service-access/dist/b2b-oauth-http';
import {B2bReadModule,B2bReadErrorFilter,b2bReadHeaders} from './http';
import type {B2bReads} from './read';
import {B2bWebhookModule,type B2bWebhooks} from './webhooks';
import {B2bOperationalControl} from './operational-control';
const OAUTH=Symbol('Fixed OAuth Identity transport'),PEERS=Symbol('Readonly edge peers');
@Controller('b2b/oauth')
class ReadonlyOAuthController{
 constructor(@Inject(OAUTH)private readonly oauth:B2bOAuthHttp,@Inject(PEERS)private readonly peers:string[]){}
 @Post('token')async token(@Req()req:any,@Res()res:any,@Body()body:unknown){
  b2bPrivatePeer(req,this.peers);res.setHeader('Pragma','no-cache');
  const reply=await this.oauth.token(req.headers.authorization,body);
  if(reply.status===401)res.setHeader('WWW-Authenticate','Basic realm="FactuEz B2B"');
  if(reply.status===429)res.setHeader('Retry-After','60');
  return res.status(reply.status).json(reply.body);
 }
}
@Module({})
class ReadonlyApplication{
 static compose(read:B2bReads,webhooks:B2bWebhooks,oauth:B2bOAuthHttp,peers:string[]):DynamicModule{
  return {module:ReadonlyApplication,imports:[B2bReadModule.isolated(read,peers,false,false,false,true),B2bWebhookModule.isolated(webhooks,peers)],
   controllers:[ReadonlyOAuthController],providers:[{provide:OAUTH,useValue:oauth},{provide:PEERS,useValue:peers}]};
 }
}
/** Business reads plus explicit webhook commands only. No draft/write/admin
 * modules are imported. USER requests still go through live Identity SSO checks. */
export async function createB2bReadonlyApplication(options:{read:B2bReads;webhooks:B2bWebhooks;oauth:B2bOAuthHttp;peers:string[];
 tls:{ca:Buffer;cert:Buffer;key:Buffer};operations:B2bOperationalControl}){
 const {read,webhooks,oauth,peers,tls,operations}=options;
 if(!(oauth instanceof B2bOAuthHttp)||!(operations instanceof B2bOperationalControl)||!tls||![tls.ca,tls.cert,tls.key].every(b=>Buffer.isBuffer(b)&&b.length))throw Error('B2B_READONLY_EXPLICIT_MTLS_COMPOSITION_REQUIRED');
 const httpsOptions={...tls,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const,maxHeaderSize:8192};
 const app=await NestFactory.create<NestExpressApplication>(ReadonlyApplication.compose(read,webhooks,oauth,peers),{logger:false,bodyParser:false,
  httpsOptions});
 app.use((req:any,res:any,next:()=>void)=>{
  b2bReadHeaders(res);res.setHeader('X-FactuEz-Profile','READONLY_OAUTH_WEBHOOKS');
  if(req.url.length>8192||req.headers['transfer-encoding'])return res.status(400).json({code:'INVALID_REQUEST'});
  try{b2bPrivatePeer(req,peers);}catch{return res.status(403).json({code:'PRIVATE_PEER_REQUIRED'});}
  const path=req.url.split('?')[0],oauthPath=path==='/b2b/oauth/token';
  if(/^\/b2b\/v1\/documents\/[^/]+\/representations\//.test(path))return res.status(404).json({code:'PDF_NOT_PUBLISHED_IN_READONLY_PROFILE'});
  if(req.method==='GET'&&!oauthPath){
   if(req.headers['content-length']!==undefined&&req.headers['content-length']!=='0')return res.status(400).json({code:'INVALID_REQUEST'});
   return next();
  }
  const hook=req.method==='POST'&&(/^\/b2b\/v1\/webhook-subscriptions(?:\/[a-f0-9-]{36}\/(?:verify|rotate-secret))?$/.test(path)||/^\/b2b\/v1\/webhook-deliveries\/[a-f0-9-]{36}\/replay$/.test(path))||
   req.method==='PATCH'&&/^\/b2b\/v1\/webhook-subscriptions\/[a-f0-9-]{36}$/.test(path);
  if(!(oauthPath&&req.method==='POST')&&!hook)return res.status(405).json({code:'READONLY_PROFILE_OPERATION_DISABLED'});
  const type=String(req.headers['content-type']??''),max=oauthPath?8192:32768;
  if(oauthPath&&req.url!==path)return res.status(400).json({error:'invalid_request'});
  if(!/^[1-9][0-9]{0,5}$/.test(req.headers['content-length']??'')||Number(req.headers['content-length'])>max||
   !(oauthPath?/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i:/^application\/json(?:;|$)/).test(type))return res.status(413).json(oauthPath?{error:'invalid_request'}:{code:'INVALID_BODY'});
  next();
 });
 operations.install(app);
 app.useBodyParser('json',{limit:32768,strict:true});
 app.useBodyParser('urlencoded',{extended:false,limit:8192,parameterLimit:5});
 app.useGlobalFilters(new B2bReadErrorFilter());
 return app;
}
