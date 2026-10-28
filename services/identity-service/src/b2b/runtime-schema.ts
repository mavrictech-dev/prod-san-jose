import type {Sql} from '../integration/postgres-store';
/** Fixed projections only: check required names without reading rows, counts or catalog data. */
export const b2bIdentityRuntimeSchemaChecks=Object.freeze([
 'SELECT "id","label","environment","kind","enabled","revision","secretHash","oidcClientId","scopes","bindings" FROM "B2bClient" WHERE false',
 'SELECT "id","requestId","clientId","actorId","action","outcome","revision","peerHash","at" FROM "B2bAudit" WHERE false',
 'SELECT "keyHash","window","count" FROM "B2bRateBucket" WHERE false',
 'SELECT "issuer","subject","oidcClientId","clientId","clientRevision","userId","userAuthRevision","enabled" FROM "B2bUserLink" WHERE false',
 'SELECT "id","userId","issuer","subject","oidcClientId","enabled","userAuthRevision","revision","createdAt","updatedAt" FROM "B2bAdminOidcLink" WHERE false',
 'SELECT "clientId","revision" FROM "B2bCorrectionGrantHead" WHERE false',
 'SELECT "clientId","revision","clientRevision","environment","bindings","actorId","at" FROM "B2bCorrectionGrantRevision" WHERE false',
 'SELECT "clientId","revision" FROM "B2bGuideGrantHead" WHERE false',
 'SELECT "clientId","revision","clientRevision","environment","bindings","actorId","at" FROM "B2bGuideGrantRevision" WHERE false',
 'SELECT "clientId","revision" FROM "B2bGuideIssueGrantHead" WHERE false',
 'SELECT "clientId","revision","clientRevision","environment","bindings","actorId","at" FROM "B2bGuideIssueGrantRevision" WHERE false',
 'SELECT "id","username","fullName","passwordHash","active","authVersion","lastLoginAt","createdAt","updatedAt" FROM "User" WHERE false',
 'SELECT "id","code","name","description","isSystem","active","createdAt","updatedAt" FROM "Role" WHERE false',
 'SELECT "id","code","name","description","createdAt" FROM "Permission" WHERE false',
 'SELECT "roleId","permissionId","grantedAt" FROM "RolePermission" WHERE false',
 'SELECT "userId","roleId","assignedByUserId","assignedAt" FROM "UserRoleAssignment" WHERE false',
 'SELECT "userId","branchId" FROM "UserBranch" WHERE false',
 'SELECT "userId","emissionPointId","assignedByUserId","assignedAt" FROM "UserEmissionPoint" WHERE false',
 'SELECT "userId","series" FROM "UserSeries" WHERE false',
 'SELECT "userId","permission","assignedBy","assignedAt" FROM "UserExtraPermission" WHERE false',
 'SELECT "id","userId","tokenHash","userAgent","ipAddress","expiresAt","revokedAt","createdAt" FROM "RefreshSession" WHERE false',
 'SELECT "id","userId","action","entityType","entityId","correlationId","ipAddress","metadata","createdAt" FROM "AuditLog" WHERE false',
]);
export async function checkB2bIdentityRuntimeSchema(db:Pick<Sql,'$queryRawUnsafe'>){
 try{for(const sql of b2bIdentityRuntimeSchemaChecks){const rows=await db.$queryRawUnsafe<unknown[]>(sql);if(!Array.isArray(rows)||rows.length)throw Error();}}
 catch{throw Error('B2B_IDENTITY_RUNTIME_STORAGE_NOT_READY');}
}
