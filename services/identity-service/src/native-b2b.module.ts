import {Body,Controller,Get,Header,Headers,HttpCode,Injectable,Param,Patch,Post,Query,Req,UseGuards,type OnModuleInit,type OnModuleDestroy} from '@nestjs/common';
import {PermissionCodes} from '@factuez/contracts';
import {NativeB2bPrismaStore} from '@factuez/service-access/dist/native-b2b-store';
import {NativeB2bRpc,nativeB2bConfig,nativeB2bPrivatePeer,nativeServiceBearer,nativeB2bScopes} from '@factuez/service-access/dist/native-b2b-rpc';
import {deny,type ProductionGrant} from '@factuez/service-access/dist/b2b-production-contract';
import {ProductionIdentity} from './b2b/production-identity';
import {PrismaService} from './infrastructure/prisma.service';
import {AuthService} from './application/auth.service';
import {IdentityPermissionGuard,RequiredPermissions} from './auth/identity-permission.guard';
@Injectable()
export class NativeB2bIdentityRuntime implements OnModuleInit,OnModuleDestroy {
 private identity?:ProductionIdentity;private rpc?:NativeB2bRpc;
 constructor(private readonly db:PrismaService,private readonly auth:AuthService){}
 async onModuleInit(){
  if(process.env.NATIVE_B2B_ENABLED!=='true')return;
  nativeB2bConfig();const [probe]=await this.db.$queryRawUnsafe<Array<{ready:boolean}>>("SELECT to_regclass('b2b_production_record') IS NOT NULL AS ready");
  if(!probe?.ready)throw Error('NATIVE_B2B_IDENTITY_SCHEMA_REQUIRED');
  this.rpc=NativeB2bRpc.configured();
  this.identity=new ProductionIdentity(new NativeB2bPrismaStore(this.db),{verify:credential=>this.admin(credential)},
   {validate:async grants=>{await this.rpc!.post('billing','/internal/native-b2b/billing/validate-grants',{grants});}});
 }
 onModuleDestroy(){this.rpc?.close();}
 required(){nativeB2bConfig();if(!this.identity)deny(503,'NATIVE_B2B_DISABLED');return this.identity;}
 async admin(credential:string){
  if(typeof credential!=='string'||!/^Bearer [A-Za-z0-9_.-]{1,8192}$/.test(credential))deny(401,'ADMIN_SESSION_REQUIRED');
  const user=this.auth.verifyAccessToken(credential.slice(7));await this.auth.assertActive(user);
  if(user.scope.kind!=='GLOBAL'||!user.roles.includes('ADMIN')||![PermissionCodes.SETUP_MANAGE,PermissionCodes.USER_MANAGE,PermissionCodes.ROLE_MANAGE].every(code=>user.permissions.includes(code)))deny(403,'ADMIN_SCOPE_REQUIRED');
  return {id:user.sub};
 }
 async reference(credential:string){this.required();await this.admin(credential);return this.rpc!.post('billing','/internal/native-b2b/billing/admin-catalogue',{},credential);}
 async list(credential:string,after?:string){this.required();await this.admin(credential);if(after!==undefined&&!/^[a-f0-9-]{36}$/.test(after))deny(400,'INVALID_CURSOR');
  const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT id,value->>'label' AS label,(value->>'enabled')::boolean AS enabled,(value->>'revision')::integer AS revision,jsonb_array_length(value->'grants') AS "grantCount" FROM b2b_production_record WHERE namespace='client' AND ($1::text IS NULL OR id>$1) ORDER BY id LIMIT 51`,after??null);
  return {environment:'PRODUCTION',items:rows.slice(0,50).map(row=>({...row,kind:'SERVICE'})),nextAfter:rows.length>50?rows[49].id:null};
 }
 async read(credential:string,id:string){await this.admin(credential);return this.required().currentClient(id);}
 private supportedGrants(value:unknown){if(!Array.isArray(value)||value.some(g=>!nativeB2bScopes.includes(g?.scope)))deny(400,'INVALID_SCOPE');}
 async register(credential:string,input:{label:string;grants:ProductionGrant[]}){this.supportedGrants(input?.grants);return this.required().register(credential,input);}
 async update(credential:string,id:string,input:any){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['revision','enabled','grants','rotateSecret'].includes(k)))deny(400,'INVALID_CLIENT');
  const prior=await this.read(credential,id);
  if(input.enabled!==false)this.supportedGrants(input.grants===undefined?prior.grants:input.grants);
  return this.required().update(credential,id,{revision:input.revision,enabled:input.enabled===undefined?prior.enabled:input.enabled,grants:input.grants===undefined?prior.grants:input.grants,rotateSecret:input.rotateSecret===undefined?false:input.rotateSecret});
 }
}
@Controller('api/v1/b2b/production-applications')
@UseGuards(IdentityPermissionGuard)
@RequiredPermissions(PermissionCodes.SETUP_MANAGE,PermissionCodes.USER_MANAGE,PermissionCodes.ROLE_MANAGE)
export class NativeB2bApplicationsController {
 constructor(private readonly runtime:NativeB2bIdentityRuntime){}
 @Get('reference') @Header('Cache-Control','private, no-store') reference(@Headers('authorization') a:string){return this.runtime.reference(a);}
 @Get() @Header('Cache-Control','private, no-store') list(@Headers('authorization') a:string,@Query('after') after?:string){return this.runtime.list(a,after);}
 @Post() @Header('Cache-Control','private, no-store') create(@Headers('authorization') a:string,@Body() body:{label:string;grants:ProductionGrant[]}){return this.runtime.register(a,body);}
 @Get(':id') @Header('Cache-Control','private, no-store') read(@Headers('authorization') a:string,@Param('id') id:string){return this.runtime.read(a,id);}
 @Patch(':id') @Header('Cache-Control','private, no-store') update(@Headers('authorization') a:string,@Param('id') id:string,@Body() body:unknown){return this.runtime.update(a,id,body);}
}
@Controller('b2b/oauth')
export class NativeB2bOAuthController {
 constructor(private readonly runtime:NativeB2bIdentityRuntime){}
 @Post('token') @HttpCode(200) @Header('Cache-Control','private, no-store') token(@Headers('authorization') a:string,@Body() body:unknown,@Req() request:any){
  if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(String(request.headers['content-type']??'')))deny(415,'INVALID_CONTENT_TYPE');
  return this.runtime.required().token(a,body,String(request.socket.remoteAddress??'local'));
 }
}
@Controller('internal/native-b2b/identity')
export class NativeB2bIdentityPrivateController {
 constructor(private readonly runtime:NativeB2bIdentityRuntime){}
 @Post('health') @HttpCode(200) health(@Req() request:any,@Body() body:any){nativeB2bPrivatePeer(request);if(!body||Object.keys(body).length)deny(400,'INVALID_BODY');this.runtime.required();return {profile:'NATIVE_B2B',owner:'identity',state:'PRIVATE_CHANNEL_AVAILABLE'};}
 @Post('introspect') @HttpCode(200) introspect(@Headers('authorization') a:string,@Body() body:unknown,@Req() request:any){
  nativeB2bPrivatePeer(request);if(!body||Object.keys(body).length)deny(400,'INVALID_BODY');return this.runtime.required().introspect(nativeServiceBearer(a));
 }
 @Post('current') @HttpCode(200) current(@Body() body:any,@Req() request:any){
  nativeB2bPrivatePeer(request);if(!body||Object.keys(body).join(',')!=='clientId')deny(400,'INVALID_BODY');return this.runtime.required().currentClient(body.clientId);
 }
}
