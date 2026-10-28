import { Body,Controller,Get,Inject,Module,Param,Post,Query,Req,Res,type DynamicModule } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { B2bExports } from './extraction';
import { b2bReadHeaders } from './http';
const CORE=Symbol('B2B export facade'),PEERS=Symbol('B2B export peers');
@Controller('b2b/v1')
export class B2bExtractionController {
  constructor(@Inject(CORE)private readonly core:B2bExports,@Inject(PEERS)private readonly peers:string[]){}
  private call(r:any,s:any,action:string,id:string|null,query:unknown,body:unknown=null){
    b2bReadHeaders(s);b2bPrivatePeer(r,this.peers);const a=r.headers.authorization,kind=r.headers['x-factuez-actor-kind']??'SERVICE';
    if(!['SERVICE','USER'].includes(kind)||typeof a!=='string'||!/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(a))throw new B2bSecurityError(401,'INVALID_TOKEN');
    return this.core.call(a.slice(7),kind,action,{id,query,body,key:r.headers['idempotency-key']??null});
  }
  @Get('document-cuts')documents(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.call(r,s,'documents',null,q);}
  @Get('document-cuts/:snapshotId/documents/:id')detail(@Req()r:any,@Res({passthrough:true})s:any,@Param('snapshotId')snapshotId:string,@Param('id')id:string,@Query()q:any){
    if(q&&Object.hasOwn(q,'snapshotId'))throw new B2bSecurityError(400,'INVALID_QUERY');return this.call(r,s,'detail',id,{...q,snapshotId});}
  @Get('changes')changes(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown){return this.call(r,s,'changes',null,q);}
  @Post('exports')create(@Req()r:any,@Res({passthrough:true})s:any,@Query()q:unknown,@Body()b:unknown){s.status(202);return this.call(r,s,'create',null,q,b);}
  @Get('exports/:id')status(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.call(r,s,'status',id,q);}
  @Get('exports/:id/manifest')manifest(@Req()r:any,@Res({passthrough:true})s:any,@Param('id')id:string,@Query()q:unknown){return this.call(r,s,'manifest',id,q);}
  @Get('exports/:id/content')async content(@Req()r:any,@Res()s:any,@Param('id')id:string,@Query()q:unknown){const f=await this.call(r,s,'content',id,q);s.setHeader('Content-Type',f.mediaType);s.setHeader('Content-Length',f.bytes.length);s.setHeader('X-Content-SHA256',f.sha256);s.setHeader('Content-Disposition',`attachment; filename="${f.fileName}"`);s.status(200).end(f.bytes);}
}
@Module({})
export class B2bExtractionModule {
  static isolated(core:B2bExports,peers:string[]):DynamicModule{if(!peers.length||peers.some(p=>!/^[a-f0-9]{64}$/.test(p)))throw new Error('Explicit B2B export peers required');
    return {module:B2bExtractionModule,controllers:[B2bExtractionController],providers:[{provide:CORE,useValue:core},{provide:PEERS,useValue:peers}]};}
}
