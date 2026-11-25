import {Injectable,type OnModuleDestroy} from '@nestjs/common';
import type {AccessScope} from '@factuez/contracts';
import {NativeB2bRpc,nativeB2bConfig,nativeServiceBearer,nativeServicePrincipalId} from '@factuez/service-access/dist/native-b2b-rpc';
import {authorize,canonical,deny,type ProductionActor,type ProductionBinding,type ProductionScope,type ProductionGrant} from '@factuez/service-access/dist/b2b-production-contract';
import {PrismaService} from './infrastructure/prisma.service';
export type NativeBinding=ProductionBinding&{companyId:number;issuerRuc:string;legalName:string;tradeName:string|null;taxAddress:string;ubigeo:string;branchName:string;branchCode:string;pointName:string;pointCode:string;seriesId:string;documentType:'01'|'03'|'07'|'08'|'09'|'31';nextNumber:string};
export type NativeServiceContext={userId:null;createdByActor:{kind:'SERVICE';clientId:string;revision:number;subjectId:null;userAuthRevision:null;environment:'PRODUCTION'};scope:AccessScope;productionBinding:{environment:'PRODUCTION';issuerId:number;issuerRuc:string;branchId:string;pointId:string;seriesId:string;series:string;documentType:string};operationId:string;idempotencyKey:string;correlationId:string;authorization:string};
export type NativeReadAuthority={actor:ProductionActor;scope:AccessScope;bindings:NativeBinding[]};
export const nativeIssueScope=(code:string):ProductionScope=>((code==='01'||code==='03'?'production:documents:issue:':code==='07'||code==='08'?'production:notes:issue:':'production:guides:issue:')+code) as ProductionScope;
const sql=`SELECT DISTINCT c.id AS "companyId",c.ruc,c.ruc AS "issuerRuc",c."legalName",c."tradeName",c."taxAddress",c.ubigeo,
 b.id AS "branchId",b.name AS "branchName",b.code AS "branchCode",p.id AS "pointId",p.name AS "pointName",p.code AS "pointCode",s.id AS "seriesId",s.series,s."nextNumber"::text AS "nextNumber",
 CASE s."documentType"::text WHEN 'INVOICE' THEN '01' WHEN 'SALES_RECEIPT' THEN '03' WHEN 'CREDIT_NOTE' THEN '07' WHEN 'DEBIT_NOTE' THEN '08' WHEN 'DESPATCH_ADVICE' THEN CASE WHEN s.series~'^V' THEN '31' ELSE '09' END END AS "documentType"
 FROM jsonb_to_recordset($1::jsonb) AS g(ruc text,"branchId" text,"pointId" text,series text)
 JOIN "CompanySettings" c ON c.ruc=g.ruc JOIN "Branch" b ON b.id=g."branchId"::uuid AND b."companyId"=c.id
 JOIN "EmissionPoint" p ON p.id=g."pointId"::uuid AND p."branchId"=b.id AND p."companyId"=c.id
 JOIN "SeriesCounter" s ON s.series=g.series AND s."companyId"=c.id AND s."emissionPointId"=p.id
 WHERE s.environment='PRODUCTION' AND ($2::boolean OR (c.environment='PRODUCTION' AND c.active AND b.active AND p.active AND s.active))
 AND s."documentType"::text IN ('INVOICE','SALES_RECEIPT','CREDIT_NOTE','DEBIT_NOTE','DESPATCH_ADVICE')`;
@Injectable()
export class NativeB2bBillingAuthority implements OnModuleDestroy {
 private channel?:NativeB2bRpc;
 constructor(private readonly db:PrismaService){}
 rpc(){nativeB2bConfig();return this.channel??=NativeB2bRpc.configured();}
 onModuleDestroy(){this.channel?.close();}
 async actor(authorization:unknown){return this.rpc().introspect(nativeServiceBearer(authorization));}
 async fromGrants(grants:ProductionGrant[],historicalRead=false){
  if(grants.some(g=>![g.binding.branchId,g.binding.pointId].every(id=>/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id))))deny(400,'NATIVE_UUID_BINDING_REQUIRED');
  const unique=[...new Map(grants.map(g=>[canonical(g.binding),g.binding])).values()];
  if(!unique.length)return [];
  return this.db.$queryRawUnsafe<NativeBinding[]>(sql,JSON.stringify(unique),historicalRead);
 }
 async bindings(actor:ProductionActor,scope:ProductionScope){const selected=actor.grants.filter(g=>g.scope===scope);if(!selected.length)deny(403,'INSUFFICIENT_SCOPE');return this.fromGrants(selected,scope==='production:documents:read');}
 async validateGrants(grants:ProductionGrant[]){
  const rows=await this.fromGrants(grants);
  for(const g of grants){const row=rows.find(n=>n.ruc===g.binding.ruc&&n.branchId===g.binding.branchId&&n.pointId===g.binding.pointId&&n.series===g.binding.series);if(!row||/:(01|03|07|08|09|31)$/.test(g.scope)&&g.scope!==nativeIssueScope(row.documentType))deny(403,'NATIVE_BINDING_DENIED');}
  return {validated:true};
 }
 async resolve(actor:ProductionActor,scope:ProductionScope,b:ProductionBinding){authorize(actor,scope,b);const rows=await this.bindings(actor,scope);const row=rows.find(n=>n.ruc===b.ruc&&n.branchId===b.branchId&&n.pointId===b.pointId&&n.series===b.series);if(!row)deny(403,'NATIVE_BINDING_DENIED');return row;}
 async verifyContext(c:NativeServiceContext,code:string){
  if(!c||c.userId!==null||c.createdByActor?.kind!=='SERVICE'||c.createdByActor.environment!=='PRODUCTION'||c.createdByActor.subjectId!==null||c.createdByActor.userAuthRevision!==null||! /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.operationId)||c.productionBinding?.environment!=='PRODUCTION'||c.productionBinding.documentType!==code||c.idempotencyKey!=='b2b-production:'+c.createdByActor.clientId+':'+c.operationId)deny(403,'INVALID_ISSUANCE_ACTOR');
  const actor=await this.actor(c.authorization);if(actor.clientId!==c.createdByActor.clientId||actor.revision!==c.createdByActor.revision)deny(401,'REVOKED_TOKEN');
  const b={ruc:c.productionBinding.issuerRuc,branchId:c.productionBinding.branchId,pointId:c.productionBinding.pointId,series:c.productionBinding.series};
  const row=await this.resolve(actor,nativeIssueScope(code),b);
  if(row.companyId!==c.productionBinding.issuerId||row.seriesId!==c.productionBinding.seriesId||row.documentType!==code)deny(403,'PAYLOAD_BINDING_MISMATCH');
  return {actor,binding:row,principalId:nativeServicePrincipalId(actor.clientId)};
 }
 async readAuthority(actor:ProductionActor,scope:ProductionScope):Promise<NativeReadAuthority>{
  const bindings=await this.bindings(actor,scope);
  if(!bindings.length)deny(403,'NATIVE_BINDING_DENIED');
  return {actor,bindings,scope:{kind:'ASSIGNED',branchIds:[...new Set(bindings.map(n=>n.branchId))],emissionPointIds:[...new Set(bindings.map(n=>n.pointId))],series:[...new Set(bindings.map(n=>n.seriesId))]}};
 }
 serviceCatalogue(value:NativeReadAuthority){return {companies:[...new Map(value.bindings.map(n=>[n.companyId,{id:n.companyId,ruc:n.issuerRuc,legalName:n.legalName,environment:'PRODUCTION'}])).values()],branches:[],points:[],products:[],capabilities:{productionInvoiceAdmission:process.env.BILLING_PRODUCTION_ISSUANCE_ENABLED==='true'}};}
 async fiscal(path:string,payload:unknown,c:NativeServiceContext){return this.rpc().post('fiscal','/internal/native-b2b/fiscal/'+path,{binding:{ruc:c.productionBinding.issuerRuc,branchId:c.productionBinding.branchId,pointId:c.productionBinding.pointId,series:c.productionBinding.series},payload},c.authorization);}
}
