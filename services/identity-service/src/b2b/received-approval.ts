import type {PrismaService} from '../infrastructure/prisma.service';
import type {UserPermissionsService} from '../application/user-permissions.service';
import type {BindingCatalogue} from './model';
import type {ProviderIntrospection} from './oidc';
import {PostgresLinkedUsers} from './users';
import {PostgresQueuedUsers} from './webhook-authority';
import {PostgresB2bLiveHumanIdentity} from './runtime-host-authority';
import {ReceivedApprovalAuthority} from './received-approval-core';
import {PostgresReceivedApprovalStore} from './received-approval-store';
import {ReceivedApprovalModule,type ReceivedApprovalPeers} from './received-approval-http';
/** Owner-only opt-in assembly for the parent: no listeners, secret reads, DDL or new public grant endpoint. */
export function createReceivedApprovalServer(options?:{enabled?:boolean;db:PrismaService;permissions:UserPermissionsService;catalogue:BindingCatalogue;provider:ProviderIntrospection;issuer:string;clientId:string;acceptedAcr:readonly string[];peers:ReceivedApprovalPeers}){
 if(options?.enabled!==true)return null;
 const u=new URL(options.issuer);
 if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!/^[A-Za-z0-9_-]{1,120}$/.test(options.clientId)||!Array.isArray(options.acceptedAcr)||!options.acceptedAcr.length||options.acceptedAcr.length>32||new Set(options.acceptedAcr).size!==options.acceptedAcr.length||options.acceptedAcr.some(v=>typeof v!=='string'||!v||v.length>255)||
  typeof options.db?.$transaction!=='function'||typeof options.db.$queryRawUnsafe!=='function'||typeof options.db.user?.findUnique!=='function'||typeof options.provider?.introspect!=='function'||typeof options.catalogue?.validate!=='function'||typeof options.permissions?.effective!=='function')throw Error('EXPLICIT_RECEIVED_APPROVAL_DEPENDENCIES_REQUIRED');
 const users=new PostgresLinkedUsers(options.db,options.permissions),store=new PostgresReceivedApprovalStore(options.db);
 const core=new ReceivedApprovalAuthority({store,users,queuedUsers:new PostgresQueuedUsers(options.db,users),live:new PostgresB2bLiveHumanIdentity(options.db,options.permissions,options.issuer),
  provider:options.provider,catalogue:options.catalogue,issuer:options.issuer,clientId:options.clientId,acceptedAcr:options.acceptedAcr},{enabled:true});
 return {core,store,module:ReceivedApprovalModule.isolated(core,{enabled:true,peers:options.peers})};
}
