import {Body,Controller,Get,Header,Headers,HttpCode,Param,Post,Query,Req,UseGuards} from '@nestjs/common';
import {PermissionCodes} from '@factuez/contracts';
import {nativeB2bPrivatePeer,nativeB2bScopes} from '@factuez/service-access/dist/native-b2b-rpc';
import {grants,deny,productionScopes} from '@factuez/service-access/dist/b2b-production-contract';
import {NativeB2bBillingAuthority,nativeIssueScope} from './native-b2b-authority';
import {NativeB2bReads} from './native-b2b-read';
import {PrismaService} from './infrastructure/prisma.service';
import {JwtPermissionGuard,RequiredPermissions,type AuthenticatedRequest} from './auth/jwt-permission.guard';
const empty=(body:unknown)=>{if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length)deny(400,'INVALID_BODY');};
@Controller('b2b/v1')
export class NativeB2bReadController {
 constructor(private readonly authority:NativeB2bBillingAuthority,private readonly reads:NativeB2bReads){}
 @Get('issuers') @Header('Cache-Control','private, no-store') async issuers(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('issuers',await this.authority.actor(a),q);}
 @Get('branches') @Header('Cache-Control','private, no-store') async branches(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('branches',await this.authority.actor(a),q);}
 @Get('points') @Header('Cache-Control','private, no-store') async points(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('points',await this.authority.actor(a),q);}
 @Get('series') @Header('Cache-Control','private, no-store') async series(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('series',await this.authority.actor(a),q);}
 @Get('products') @Header('Cache-Control','private, no-store') async products(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('products',await this.authority.actor(a),q);}
 @Get('product-categories') @Header('Cache-Control','private, no-store') async categories(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('product-categories',await this.authority.actor(a),q);}
 @Get('product-units') @Header('Cache-Control','private, no-store') async units(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.masters('product-units',await this.authority.actor(a),q);}
 @Get('customers') @Header('Cache-Control','private, no-store') async customers(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.customers(await this.authority.actor(a),q);}
 @Get('reference') @Header('Cache-Control','private, no-store') async reference(@Headers('authorization') a:string){return this.reads.reference(await this.authority.actor(a));}
 @Get('documents') @Header('Cache-Control','private, no-store') async documents(@Headers('authorization') a:string,@Query() q:unknown){return this.reads.documents(await this.authority.actor(a),q);}
 @Get('documents/:id') @Header('Cache-Control','private, no-store') async document(@Headers('authorization') a:string,@Param('id') id:string){return (await this.reads.document(await this.authority.actor(a),id)).document;}
}
@Controller('internal/native-b2b/billing')
export class NativeB2bBillingPrivateController {
 constructor(private readonly authority:NativeB2bBillingAuthority,private readonly reads:NativeB2bReads,private readonly db:PrismaService){}
 @Post('health') @HttpCode(200) health(@Req() req:any,@Body() body:unknown){nativeB2bPrivatePeer(req);empty(body);return {profile:'NATIVE_B2B',owner:'billing',state:'PRIVATE_CHANNEL_AVAILABLE'};}
 @Post('validate-grants') @HttpCode(200) validate(@Req() req:any,@Body() body:any){nativeB2bPrivatePeer(req,'identity');if(!body||Object.keys(body).join(',')!=='grants')deny(400,'INVALID_BODY');return this.authority.validateGrants(grants(body.grants));}
 @Post('admin-catalogue') @HttpCode(200)
 @UseGuards(JwtPermissionGuard) @RequiredPermissions(PermissionCodes.SETUP_MANAGE,PermissionCodes.USER_MANAGE,PermissionCodes.ROLE_MANAGE)
 async admin(@Req() req:AuthenticatedRequest&{socket:any},@Body() body:unknown){
  nativeB2bPrivatePeer(req,'identity');empty(body);
  if(req.user?.scope.kind!=='GLOBAL'||!req.user.roles.includes('ADMIN'))deny(403,'ADMIN_SCOPE_REQUIRED');
  const companies=await this.db.companySettings.findMany({where:{active:true,environment:'PRODUCTION'},select:{id:true,ruc:true,legalName:true,environment:true},orderBy:{id:'asc'}});
  const ids=companies.map(c=>c.id),branches=await this.db.branch.findMany({where:{companyId:{in:ids},active:true},select:{id:true,companyId:true,code:true,name:true},orderBy:{id:'asc'}});
  const points=await this.db.emissionPoint.findMany({where:{companyId:{in:ids},branchId:{in:branches.map(b=>b.id)},active:true},select:{id:true,companyId:true,branchId:true,code:true,name:true},orderBy:{id:'asc'}});
  const series=await this.db.seriesCounter.findMany({where:{companyId:{in:ids},emissionPointId:{in:points.map(p=>p.id)},active:true,environment:'PRODUCTION'},select:{id:true,companyId:true,emissionPointId:true,series:true,documentType:true},orderBy:{id:'asc'}});
  return {environment:'PRODUCTION',companies,branches,points,series,scopes:nativeB2bScopes};
 }
 @Post('resolve') @HttpCode(200) async resolve(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){
  nativeB2bPrivatePeer(req,'fiscal');if(!body||Object.keys(body).sort().join(',')!=='binding,code'||!['01','03','07','08','09','31'].includes(body.code))deny(400,'INVALID_BODY');
  const actor=await this.authority.actor(a);return this.authority.resolve(actor,nativeIssueScope(body.code),body.binding);
 }
 @Post('catalogue') @HttpCode(200) async catalogue(@Req() req:any,@Headers('authorization') a:string,@Body() body:unknown){nativeB2bPrivatePeer(req,'fiscal');empty(body);return this.reads.catalogue(await this.authority.actor(a));}
 @Post('document') @HttpCode(200) async document(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){nativeB2bPrivatePeer(req,'fiscal');if(!body||Object.keys(body).join(',')!=='documentId')deny(400,'INVALID_BODY');return (await this.reads.document(await this.authority.actor(a),body.documentId)).document;}
 @Post('print-snapshot') @HttpCode(200) async print(@Req() req:any,@Headers('authorization') a:string,@Body() body:any){nativeB2bPrivatePeer(req,'fiscal');if(!body||Object.keys(body).some(k=>!['companyId','branchId'].includes(k)))deny(400,'INVALID_BODY');return this.reads.print(await this.authority.actor(a),body.companyId,body.branchId);}
}
