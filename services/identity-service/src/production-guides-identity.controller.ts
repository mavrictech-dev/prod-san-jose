import {Body,Controller,Post,Req,ForbiddenException} from '@nestjs/common';
import {loadNativeGreConfig,nativeGrePeer} from '@factuez/service-access';
import {PostgresLinkedUsers} from './b2b/users';
import {PrismaService} from './infrastructure/prisma.service';
import {UserPermissionsService} from './application/user-permissions.service';
@Controller('internal/production-guides/identity')
export class ProductionGuidesIdentityController {
 constructor(private readonly db:PrismaService,private readonly permissions:UserPermissionsService){}
 @Post('current') current(@Body() body:unknown,@Req() request:any){const config=loadNativeGreConfig();if(!config)throw new ForbiddenException();try{nativeGrePeer(request,config.peers);}catch{throw new ForbiddenException('GRE_PRIVATE_PEER_REQUIRED');}
 const b=body as any;if(!b||Object.keys(b).join(',')!=='userId'||typeof b.userId!=='string'||!/^[0-9a-f-]{36}$/i.test(b.userId))throw new ForbiddenException();return new PostgresLinkedUsers(this.db,this.permissions).current(b.userId);}
}
