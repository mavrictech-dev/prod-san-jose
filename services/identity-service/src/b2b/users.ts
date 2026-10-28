import { PermissionCodes, type AccessTokenClaims } from '@factuez/contracts';
import { PrismaService } from '../infrastructure/prisma.service';
import type { UserPermissionsService } from '../application/user-permissions.service';
import type { AuthService } from '../application/auth.service';
import { fail, type AdminAuthority } from './model';
import type { LinkedUsers, OidcLink } from './oidc';

/** No username/email auto-linking. A missing explicit link denies access. */
export class PostgresLinkedUsers implements LinkedUsers {
  constructor(private readonly db: PrismaService, private readonly extra: Pick<UserPermissionsService,'effective'>) {}
  async link(issuer:string,subject:string,oidcClientId:string) {
    const rows = await this.db.$queryRawUnsafe<OidcLink[]>(`SELECT "clientId","clientRevision","userId","userAuthRevision","enabled" FROM "B2bUserLink" WHERE "issuer"=$1 AND "subject"=$2 AND "oidcClientId"=$3`,issuer,subject,oidcClientId);
    return rows[0] ?? null;
  }
  async current(userId:string) {
    const user = await this.db.user.findUnique({where:{id:userId},select:{active:true,authVersion:true,
      roles:{select:{role:{select:{code:true,active:true,permissions:{select:{permission:{select:{code:true}}}}}}}},
      branches:{select:{branchId:true}},emissionPoints:{select:{emissionPointId:true}},series:{select:{series:true}}}});
    if(!user?.active)return {active:false,authVersion:-1,permissions:[],scope:{kind:'ASSIGNED' as const,branchIds:[],emissionPointIds:[],series:[]}};
    const roles = user.roles.map(row=>row.role).filter(role=>role.active);
    const permissions = [...new Set([...roles.flatMap(role=>role.permissions.map(row=>PermissionCodes[row.permission.code])),...await this.extra.effective(userId)])];
    return {active:roles.length>0,authVersion:user.authVersion,permissions,
      scope:roles.some(role=>role.code==='ADMIN') ? {kind:'GLOBAL' as const} : {kind:'ASSIGNED' as const,
        branchIds:user.branches.map(row=>row.branchId),emissionPointIds:user.emissionPoints.map(row=>row.emissionPointId),series:user.series.map(row=>row.series)}};
  }
}
export interface VerifiedStepUp { verify(userId:string,purpose:'b2b-client-admin'):Promise<boolean> }
/** The regular PWA password login alone is NOT a step-up proof. */
export class HumanB2bAdministrator implements AdminAuthority {
  constructor(private readonly auth:Pick<AuthService,'verifyAccessToken'|'assertActive'>,private readonly stepUp:VerifiedStepUp|null) {}
  async verify(token:string) {
    let actor:AccessTokenClaims;
    try{actor=this.auth.verifyAccessToken(token);await this.auth.assertActive(actor);}catch{return fail(401,'INVALID_TOKEN');}
    if(actor.scope.kind!=='GLOBAL'||!actor.roles.includes('ADMIN')||!['setup.manage','user.manage','role.manage'].every(permission=>actor.permissions.includes(permission as any)))return fail(403,'FORBIDDEN');
    if(!this.stepUp||!await this.stepUp.verify(actor.sub,'b2b-client-admin'))return fail(403,'STEP_UP_REQUIRED');
    return {id:actor.sub,stepUpVerified:true as const};
  }
}
