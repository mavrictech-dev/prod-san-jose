import {validB2bPrincipal,validB2bBinding,b2bBindingsContain,type B2bBinding,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {historicalSha256,historyJson} from '@factuez/history-core';
import {historyActor} from '../access';
import type {B2bHistoryArchivePermissionPort,B2bHistoryArchiveDecision} from './types';
import {denyHistory} from './reader';
import {historyRuntimeAttestation,type HistoryRuntimeDatabase} from './runtime-schema';
import type {B2bHistoryRuntimeConfig} from './runtime-config';
export const historyRuntimeEnrollmentQuery=`SELECT g."enrollmentId",g."revision",g."active",g."environment",g."datasetClass",g."permission",g."clientId",g."actorKind",g."subjectId",g."clientRevision",g."userAuthRevision",g."binding",g."bindingSha256",g."actorId",g."actorRevision",
 a."revision" AS "currentActorRevision",a."active" AS "actorActive",a."actor"
 FROM "B2bHistoryArchiveGrant" g JOIN "B2bHistoryArchiveActor" a ON a."actorId"=g."actorId"
 WHERE g."clientId"=$1::uuid AND g."actorKind"=$2 AND g."subjectId" IS NOT DISTINCT FROM $3::uuid AND g."bindingSha256"=$4`;
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function revision(v:unknown):string {const s=typeof v==='bigint'?v.toString():typeof v==='number'&&Number.isSafeInteger(v)?String(v):v;if(typeof s!=='string'||!/^[1-9][0-9]{0,17}$/.test(s))throw Error();return s;}
/** Read-only independent enrollment. Actors are persisted by another authority;
 * no actorId derived from SERVICE/clientId, permissions inferred or SQL writes. */
export class PostgresB2bHistoryArchivePermission implements B2bHistoryArchivePermissionPort {
 constructor(private readonly db:HistoryRuntimeDatabase,private readonly config:B2bHistoryRuntimeConfig){}
 async authorizeCurrent(input:{principal:B2bPrincipal;binding:B2bBinding}):Promise<B2bHistoryArchiveDecision|null>{
  try{
   const {principal:p,binding:b}=historyJson(input);
   if(!validB2bPrincipal(p)||!validB2bBinding(b)||!/^00000000[0-9]{3}$/.test(b.issuerRuc)||!p.scopes.includes('b2b:history:read')||!b2bBindingsContain(p.bindings,b))return null;
   return await this.db.$transaction(async tx=>{
    await historyRuntimeAttestation(tx,this.config);
    const rows=await tx.$queryRawUnsafe<any[]>(historyRuntimeEnrollmentQuery,p.clientId,p.kind,p.subjectId,historicalSha256(b));
    if(rows.length!==1)return null;const g=rows[0];
    if(g.active!==true||g.actorActive!==true||g.environment!=='BETA'||g.datasetClass!=='SYNTHETIC'||g.permission!=='history.view'||g.clientId!==p.clientId||g.actorKind!==p.kind||g.subjectId!==p.subjectId||g.clientRevision!==p.revision||g.userAuthRevision!==p.userAuthRevision||g.bindingSha256!==historicalSha256(b)||historicalSha256(g.binding)!==historicalSha256(b)||!uuid(g.enrollmentId)||!uuid(g.actorId)||revision(g.actorRevision)!==revision(g.currentActorRevision))return null;
    const actor=historyActor(g.actor,'history.view'),s=actor.scope;
    if(actor.userId!==g.actorId||p.kind==='USER'&&actor.userId!==p.subjectId||actor.roles.includes('ADMIN')||actor.permissions.length!==1||actor.permissions[0]!=='history.view'||s.kind!=='ASSIGNED'||s.branchIds.length!==1||s.branchIds[0]!==b.branchId||s.emissionPointIds.length!==1||s.emissionPointIds[0]!==b.pointId||s.seriesCounterIds.length!==1||s.seriesCounterIds[0]!==b.seriesId)return null;
    return {environment:'BETA',datasetClass:'SYNTHETIC',permission:'history.view',enrollmentId:g.enrollmentId,revision:`${revision(g.revision)}:${revision(g.currentActorRevision)}`,binding:historyJson(b),actor};
   },{isolationLevel:'Serializable',maxWait:2000,timeout:20000});
  }catch{return denyHistory(503,'HISTORY_ARCHIVE_ENROLLMENT_UNAVAILABLE');}
 }
}
/** CANDIDATE ONLY, never called by main, factory or readiness. The future
 * enrollment admin must verify independent authority and audit every mutation. */
export const b2bHistoryEnrollmentCandidateSql=`
DO $$ BEGIN
 IF current_database() !~ '^factuez_history_qa_[a-f0-9]{10}(_restore)?$' THEN RAISE EXCEPTION 'HISTORY_SANDBOX_REQUIRED'; END IF;
END $$;
CREATE TABLE "B2bHistoryArchiveActor" (
 "actorId" uuid PRIMARY KEY,"revision" bigint NOT NULL CHECK ("revision">0),"active" boolean NOT NULL DEFAULT false,
 "actor" jsonb NOT NULL CHECK (("actor"->>'userId'="actorId"::text AND "actor"->'scope'->>'kind'='ASSIGNED'
  AND "actor"->'permissions'='["history.view"]'::jsonb AND NOT ("actor"->'roles' ? 'ADMIN')) IS TRUE)
);
CREATE TABLE "B2bHistoryArchiveGrant" (
 "enrollmentId" uuid PRIMARY KEY,"revision" bigint NOT NULL CHECK ("revision">0),"active" boolean NOT NULL DEFAULT false,
 "environment" text NOT NULL CHECK ("environment"='BETA'),"datasetClass" text NOT NULL CHECK ("datasetClass"='SYNTHETIC'),"permission" text NOT NULL CHECK ("permission"='history.view'),
 "clientId" uuid NOT NULL,"actorKind" text NOT NULL CHECK ("actorKind" IN ('SERVICE','USER')),"subjectId" uuid,
 "clientRevision" integer NOT NULL CHECK ("clientRevision">0),"userAuthRevision" integer,
 "binding" jsonb NOT NULL CHECK (("binding"->>'issuerRuc' ~ '^00000000[0-9]{3}$' AND "binding"->>'environment'='BETA') IS TRUE),
 "bindingSha256" text NOT NULL CHECK ("bindingSha256" ~ '^[a-f0-9]{64}$'),
 "actorId" uuid NOT NULL REFERENCES "B2bHistoryArchiveActor"("actorId"),"actorRevision" bigint NOT NULL CHECK ("actorRevision">0),
 CHECK (("actorKind"='SERVICE' AND "subjectId" IS NULL AND "userAuthRevision" IS NULL) OR ("actorKind"='USER' AND "subjectId" IS NOT NULL AND "subjectId"="actorId" AND "userAuthRevision" IS NOT NULL AND "userAuthRevision">=0)),
 UNIQUE NULLS NOT DISTINCT ("clientId","actorKind","subjectId","bindingSha256")
);
CREATE FUNCTION history_b2b_enrollment_cas() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."revision"<>OLD."revision"+1 THEN RAISE EXCEPTION 'HISTORY_ENROLLMENT_CAS_REQUIRED'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER history_b2b_actor_cas BEFORE UPDATE ON "B2bHistoryArchiveActor" FOR EACH ROW EXECUTE FUNCTION history_b2b_enrollment_cas();
CREATE TRIGGER history_b2b_grant_cas BEFORE UPDATE ON "B2bHistoryArchiveGrant" FOR EACH ROW EXECUTE FUNCTION history_b2b_enrollment_cas();
REVOKE ALL ON "B2bHistoryArchiveActor","B2bHistoryArchiveGrant" FROM PUBLIC,history_reader_qa;
GRANT SELECT ON "B2bHistoryArchiveActor","B2bHistoryArchiveGrant" TO history_reader_qa;
`;
