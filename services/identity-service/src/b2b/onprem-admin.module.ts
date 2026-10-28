import 'reflect-metadata';
import {Body,Catch,Controller,Get,HttpException,Injectable,Module,Param,Patch,Post,Query,Req,Res,UseFilters,UseGuards,
 type ArgumentsHost,type OnModuleInit,type OnApplicationShutdown,type CanActivate,type ExecutionContext} from '@nestjs/common';
import {ModuleRef,Reflector} from '@nestjs/core';
import {PermissionCodes} from '@factuez/contracts';
import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {AuthService} from '../application/auth.service';
import {PasswordService} from '../application/password.service';
import {PrismaService} from '../infrastructure/prisma.service';
import {IdentityPermissionGuard,RequiredPermissions} from '../auth/identity-permission.guard';
import {plain,fail} from './model';
import {onpremAdminConfig,createOnpremAdminRuntime,type OnpremAdminRuntime} from './onprem-admin-runtime';
import {onpremSessionCookie,onpremSessionPath,type OnpremRequest} from './onprem-admin-authority';

@Injectable()
export class OnpremAdminHost implements OnModuleInit,OnApplicationShutdown{
 runtime:OnpremAdminRuntime|null=null;
 constructor(private readonly ref:ModuleRef){}
 async onModuleInit(){
  const loaded=onpremAdminConfig(process.env);if(!loaded)return;
  this.runtime=await createOnpremAdminRuntime(loaded,{db:this.ref.get(PrismaService,{strict:false}),
   auth:this.ref.get(AuthService,{strict:false}),passwords:this.ref.get(PasswordService,{strict:false})});
 }
 required(){if(!this.runtime)return fail(503,'ONPREM_ADMIN_DISABLED');return this.runtime;}
 onApplicationShutdown(){this.runtime?.close();}
}
@Catch()
class OnpremAdminErrors{
 catch(e:unknown,host:ArgumentsHost){
  const status=e instanceof B2bSecurityError?e.status:e instanceof HttpException&&[400,401,403,404,413,429].includes(e.getStatus())?e.getStatus():503;
  const res=host.switchToHttp().getResponse();headers(res);
  if(status===429)res.setHeader('Retry-After','60');
  res.status(status).json({code:e instanceof B2bSecurityError?e.code:status===401?'INVALID_TOKEN':status===403?'ONPREM_ACCESS_DENIED':'ONPREM_ADMIN_UNAVAILABLE'});
 }
}
function headers(res:any){
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Pragma','no-cache');
 res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Vary','Cookie, Origin, Authorization');
}
@Injectable()
export class OnpremCurrentIdentityGuard implements CanActivate {
 constructor(private readonly ref:ModuleRef,private readonly reflector:Reflector){}
 canActivate(context:ExecutionContext){
  // Invoke the unchanged native guard with the AppModule-owned AuthService.
  return new IdentityPermissionGuard(this.reflector,this.ref.get(AuthService,{strict:false})).canActivate(context);
 }
}
@Controller('api/v1/b2b-admin')
@UseGuards(OnpremCurrentIdentityGuard)
@RequiredPermissions(PermissionCodes.SETUP_MANAGE,PermissionCodes.USER_MANAGE,PermissionCodes.ROLE_MANAGE)
@UseFilters(OnpremAdminErrors)
export class OnpremAdminController{
 constructor(private readonly host:OnpremAdminHost){}
 private cookie(res:any,value:string,expiresAt:number){
  res.setHeader('Set-Cookie',onpremSessionCookie+'='+value+'; Path='+onpremSessionPath+
   '; HttpOnly; Secure; SameSite=Strict; Max-Age='+Math.max(0,Math.floor((expiresAt-Date.now())/1000)));
 }
 private empty(body:unknown){if(!plain(body)||Object.keys(body).length)return fail(400,'INVALID_REQUEST');}
 @Post('status')async status(@Req()req:OnpremRequest,@Res()res:any,@Body()body:unknown){
  headers(res);this.empty(body);
  if(!this.host.runtime)return res.status(200).json({profile:'ONPREM',enabled:false,environment:'BETA',authenticated:false});
  const result=await this.host.runtime.authority.status(req);
  if(result.cookie)this.cookie(res,result.cookie,Date.parse(result.state.expiresAt));
  return res.status(200).json(result.state);
 }
 @Post('reauthenticate')async reauth(@Req()req:OnpremRequest,@Res()res:any,@Body()body:unknown){
  headers(res);res.status(200).json(await this.host.required().authority.reauthenticate(req,body));
 }
 @Post('logout')async logout(@Req()req:OnpremRequest,@Res()res:any,@Body()body:unknown){
  headers(res);this.empty(body);const result=await this.host.required().authority.logout(req);this.cookie(res,'',0);res.status(200).json(result);
 }
 private async run(action:'LIST'|'READ'|'CREATE'|'UPDATE'|'ROTATE',req:OnpremRequest,res:any,id:string|undefined,query:unknown,body?:unknown){
  headers(res);
  const value=await this.host.required().applications.run(req,action,id,query,body);
  res.status(action==='CREATE'?201:200).json(value);
 }
 @Post('applications/query')queryList(@Req()r:OnpremRequest,@Res()s:any,@Body()q:unknown){return this.run('LIST',r,s,undefined,q);}
 @Post('applications/:id/read')queryRead(@Req()r:OnpremRequest,@Res()s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){this.empty(b);return this.run('READ',r,s,id,q);}
 @Get('applications')list(@Req()r:OnpremRequest,@Res()s:any,@Query()q:unknown){return this.run('LIST',r,s,undefined,q);}
 @Get('applications/:id')read(@Req()r:OnpremRequest,@Res()s:any,@Param('id')id:string,@Query()q:unknown){return this.run('READ',r,s,id,q);}
 @Post('applications')create(@Req()r:OnpremRequest,@Res()s:any,@Query()q:unknown,@Body()b:unknown){return this.run('CREATE',r,s,undefined,q,b);}
 @Patch('applications/:id')update(@Req()r:OnpremRequest,@Res()s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('UPDATE',r,s,id,q,b);}
 @Post('applications/:id/rotate-secret')rotate(@Req()r:OnpremRequest,@Res()s:any,@Param('id')id:string,@Query()q:unknown,@Body()b:unknown){return this.run('ROTATE',r,s,id,q,b);}
}
@Module({controllers:[OnpremAdminController],providers:[OnpremAdminHost,OnpremCurrentIdentityGuard]})
export class OnpremB2bAdminModule{}