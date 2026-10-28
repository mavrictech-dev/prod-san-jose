import {B2bPrivateHttp,B2bBindingCatalogueHttp} from '@factuez/service-access/dist/b2b';
import {B2bRuntimeFiles} from '@factuez/service-access/dist/b2b-runtime-files';
import {b2bReadonlyScopes} from '@factuez/service-access/dist/b2b-readonly-owner';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {AuthService} from '../application/auth.service';
import type {PasswordService} from '../application/password.service';
import {B2bTokenCodec} from './token';
import {B2bIdentity} from './service';
import {OnpremVerifiedAdminAuthority} from './onprem-admin-authority';
import {OnpremReadonlyPgStore} from './onprem-admin-store';
import {OnpremAdminApplications} from './onprem-admin-service';
export interface OnpremRuntimeDeps {db:PrismaService;auth:AuthService;passwords:PasswordService}
export function onpremAdminConfig(env:NodeJS.ProcessEnv){
 if(env.B2B_ONPREM_ADMIN_ENABLED!=='true')return null;
 if(env.B2B_PRIVATE_ACCESS!=='true'||!env.B2B_ONPREM_ADMIN_CONFIG_ROOT)throw Error('ONPREM_PRIVATE_ACCESS_AND_CONFIG_REQUIRED');
 const files=new B2bRuntimeFiles(env.B2B_ONPREM_ADMIN_CONFIG_ROOT),c=files.metadata('onprem-admin.json');
 if(Object.keys(c).sort().join(',')!=='approvedForLocalSetup,billingOrigin,environment,origins,profile,schemaVersion,tokenIssuer'||
  c.schemaVersion!=='factuez.b2b.onprem-admin.v1'||c.profile!=='ONPREM'||c.environment!=='BETA'||c.approvedForLocalSetup!==true||
  !Array.isArray(c.origins)||!c.origins.length||c.origins.length>8||new Set(c.origins).size!==c.origins.length)throw Error('ONPREM_CONFIG_INVALID');
 const browserOrigins=(env.AUTH_BROWSER_ORIGINS??'').split(',').map(s=>s.trim()).filter(Boolean);
 for(const origin of c.origins){
  try{const u=new URL(origin);if(u.protocol!=='https:'||u.origin!==origin||!browserOrigins.includes(origin))throw Error();}
  catch{throw Error('ONPREM_EXISTING_BROWSER_HTTPS_ORIGIN_REQUIRED');}
 }
 return {files,config:c};
}
const checks=[
 'SELECT "id","label","kind","enabled","revision","environment","secretHash","oidcClientId","scopes","bindings" FROM "B2bClient" WHERE false',
 'SELECT "id","requestId","clientId","actorId","action","outcome","revision","peerHash","at" FROM "B2bAudit" WHERE false',
 'SELECT "keyHash","window","count" FROM "B2bRateBucket" WHERE false',
 'SELECT "id","passwordHash","authVersion","active" FROM "User" WHERE false',
 'SELECT "userId","roleId" FROM "UserRoleAssignment" WHERE false',
 'SELECT "id","code","active" FROM "Role" WHERE false',
 'SELECT "id","code" FROM "Permission" WHERE false',
 'SELECT "roleId","permissionId" FROM "RolePermission" WHERE false',
] as const;
/** Uses the native Identity Prisma instance, existing AuthService and password
 * verifier. No Prisma construction, schema write, login, client seed or listener. */
export async function createOnpremAdminRuntime(loaded:NonNullable<ReturnType<typeof onpremAdminConfig>>,deps:OnpremRuntimeDeps){
 const {files,config:c}=loaded,{db,auth,passwords}=deps;
 for(const sql of checks)await db.$queryRawUnsafe(sql);
 const ca=files.publicPem('ca.pem'),transport={ca,cert:files.publicPem('resource.crt'),key:files.privatePem('resource.key')};
 const catalogue=new B2bBindingCatalogueHttp(new B2bPrivateHttp(c.billingOrigin,transport));
 const store=new OnpremReadonlyPgStore(db,catalogue);
 const authority=new OnpremVerifiedAdminAuthority({auth,passwords,db,store},c.origins);
 const codec=new B2bTokenCodec(files.privatePem('signing-key.pem'),c.tokenIssuer,()=>Math.floor(Date.now()/1000),{
  human:files.publicPem('human-public.pem'),integration:files.publicPem('integration-public.pem'),tls:transport.cert,
 });
 const core=new B2bIdentity(store,codec,files.secretBytes('pepper.bin'),authority,catalogue,null,Date.now,[...b2bReadonlyScopes]);
 return {authority,applications:new OnpremAdminApplications(core,authority),close:()=>authority.close()};
}
export type OnpremAdminRuntime=Awaited<ReturnType<typeof createOnpremAdminRuntime>>;
