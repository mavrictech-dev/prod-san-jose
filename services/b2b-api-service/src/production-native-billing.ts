import {createHash} from 'node:crypto';
import {deny,type ProductionBinding,type ProductionGrant,type ProductionActor} from '@factuez/service-access/dist/b2b-production-contract';
import {type ProductionNativeCommand,type ProductionNativeProvider} from './production-owner-adapter';
export type ProductionDocumentCode='01'|'03'|'07'|'08'|'09'|'31';
export interface ProductionBillingSql {$queryRawUnsafe<T=unknown>(sql:string,...values:unknown[]):Promise<T>}
export interface ProductionResolvedBinding {environment:'PRODUCTION';issuerId:number;issuerRuc:string;branchId:string;pointId:string;seriesId:string;series:string;documentType:ProductionDocumentCode}
export interface ProductionCreatedByActor {kind:'SERVICE';clientId:string;revision:number;subjectId:null;userAuthRevision:null;environment:'PRODUCTION'}
export interface ProductionAssignedScope {kind:'ASSIGNED';branchIds:string[];emissionPointIds:string[];series:string[]}
/** Dedicated native context. `b2b` BETA and human `userId`/JWT contexts are never reused. */
export interface ProductionNativeOwnerContext {
 userId:null;createdByActor:ProductionCreatedByActor;scope:ProductionAssignedScope;
 productionBinding:ProductionResolvedBinding;operationId:string;idempotencyKey:string;correlationId:string;
 authorization:string;
}
export interface ProductionIssuePort {executeB2B(input:unknown,context:ProductionNativeOwnerContext):Promise<unknown>}
export interface ProductionNotesPort {issueB2B(originalId:string,input:unknown,operationId:string,context:ProductionNativeOwnerContext):Promise<unknown>}
export interface ProductionGuidesPort {issueB2B(input:unknown,operationId:string,context:ProductionNativeOwnerContext):Promise<unknown>}
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(s);
const types:Record<ProductionDocumentCode,string>={'01':'INVOICE','03':'SALES_RECEIPT','07':'CREDIT_NOTE','08':'DEBIT_NOTE','09':'DESPATCH_ADVICE','31':'DESPATCH_ADVICE'};
/** Same native company/branch/point/series tables as billing. Only PRODUCTION, active rows. */
export class ProductionNativeCatalogue {
 constructor(private readonly db:ProductionBillingSql){}
 async resolve(b:ProductionBinding,code:ProductionDocumentCode):Promise<ProductionResolvedBinding>{if(!uuid(b.branchId)||!uuid(b.pointId))deny(400,'NATIVE_UUID_BINDING_REQUIRED');const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT c."id" AS "issuerId",c."ruc" AS "issuerRuc",b."id" AS "branchId",p."id" AS "pointId",s."id" AS "seriesId",s."series"
 FROM "CompanySettings" c JOIN "Branch" b ON b."companyId"=c."id" JOIN "EmissionPoint" p ON p."companyId"=c."id" AND p."branchId"=b."id" JOIN "SeriesCounter" s ON s."companyId"=c."id" AND s."emissionPointId"=p."id"
 WHERE c."environment"='PRODUCTION' AND c."active" AND b."active" AND p."active" AND s."active" AND c."ruc"=$1 AND b."id"=$2::uuid AND p."id"=$3::uuid AND s."series"=$4 AND s."documentType"=$5::"DocumentType" LIMIT 2`,b.ruc,b.branchId,b.pointId,b.series,types[code]);if(rows.length!==1)deny(403,'NATIVE_BINDING_DENIED');const row=rows[0];return {environment:'PRODUCTION',issuerId:row.issuerId,issuerRuc:row.issuerRuc,branchId:row.branchId,pointId:row.pointId,seriesId:row.seriesId,series:row.series,documentType:code};}
 async validate(g:ProductionGrant[]){for(const grant of g){const code=/:(01|03|07|08|09|31)$/.exec(grant.scope)?.[1] as ProductionDocumentCode|undefined;if(code)await this.resolve(grant.binding,code);else{let found=false;for(const c of Object.keys(types) as ProductionDocumentCode[]){try{await this.resolve(grant.binding,c);found=true;break;}catch(e){if(!(e&&typeof e==='object'&&'code' in e&&e.code==='NATIVE_BINDING_DENIED'))throw e;}}if(!found)deny(403,'NATIVE_BINDING_DENIED');}}}
 async resolveRead(b:ProductionBinding){for(const c of Object.keys(types) as ProductionDocumentCode[]){try{return await this.resolve(b,c);}catch(e){if(!(e&&typeof e==='object'&&'code' in e&&e.code==='NATIVE_BINDING_DENIED'))throw e;}}return deny(403,'NATIVE_BINDING_DENIED');}
}
/** UUIDv5, fixed namespace; compatible with native UUID operation/reservation columns. */
export function productionOperationUuid(key:string){const namespace=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex'),b=createHash('sha1').update(namespace).update('factuez:production:'+key).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);}
function context(c:ProductionNativeCommand,b:ProductionResolvedBinding):ProductionNativeOwnerContext {return {userId:null,createdByActor:{kind:'SERVICE',clientId:c.actor.clientId,revision:c.actor.revision,subjectId:null,userAuthRevision:null,environment:'PRODUCTION'},scope:{kind:'ASSIGNED',branchIds:[b.branchId],emissionPointIds:[b.pointId],series:[b.seriesId]},productionBinding:b,operationId:c.operationId,idempotencyKey:'b2b-production:'+c.actor.clientId+':'+c.operationId,correlationId:c.operationId,authorization:c.authorization};}
function object(v:unknown){if(!v||typeof v!=='object'||Array.isArray(v))deny(400,'INVALID_NATIVE_PAYLOAD');return v as Record<string,any>;}
/** Required native ports: construction fails if any producer still lacks its SERVICE entrypoint. */
export function createProductionNativeBillingProviders(db:ProductionBillingSql,ports:{issue:ProductionIssuePort;notes:ProductionNotesPort;guides:ProductionGuidesPort}){
 if(typeof ports.issue?.executeB2B!=='function'||typeof ports.notes?.issueB2B!=='function'||typeof ports.guides?.issueB2B!=='function')throw Error('NATIVE_SERVICE_PORTS_REQUIRED_ISSUE_NOTES_GUIDES');
 const catalogue=new ProductionNativeCatalogue(db);const provider=(code:ProductionDocumentCode):ProductionNativeProvider=>({authorize:async c=>{await catalogue.resolve(c.binding,code);},execute:async c=>{const b=await catalogue.resolve(c.binding,code),ctx=context(c,b),v=object(c.payload);
 if(code==='01'||code==='03'){if(v.documentType!==(code==='01'?'INVOICE':'SALES_RECEIPT')||v.emissionPointId!==b.pointId||v.series!==b.series)deny(403,'PAYLOAD_BINDING_MISMATCH');return ports.issue.executeB2B(v,ctx);}
 if(code==='07'||code==='08'){if(Object.keys(v).sort().join(',')!=='input,originalId'||!uuid(v.originalId))deny(400,'INVALID_NOTE_PAYLOAD');const input=object(v.input);if(input.seriesCounterId!==b.seriesId||object(input.adjustment).documentTypeCode!==code)deny(403,'PAYLOAD_BINDING_MISMATCH');
 const originals=await db.$queryRawUnsafe<any[]>(`SELECT d."id" FROM "Document" d JOIN "CompanySettings" c ON c."id"=d."companyId" JOIN "EmissionPoint" p ON p."id"=d."emissionPointId" WHERE d."id"=$1::uuid AND d."companyId"=$2 AND c."environment"='PRODUCTION' AND c."ruc"=$3 AND p."branchId"=$4::uuid AND p."id"=$5::uuid LIMIT 1`,v.originalId,b.issuerId,b.issuerRuc,b.branchId,b.pointId);if(originals.length!==1)deny(403,'NOTE_ORIGINAL_BINDING_MISMATCH');return ports.notes.issueB2B(v.originalId,input,c.operationId,ctx);}
 if(v.seriesCounterId!==b.seriesId||typeof v.profile!=='string'||(code==='31'?v.profile!=='GRE31_PUBLIC_SINGLE09_V1':!v.profile.startsWith('GRE09_')))deny(403,'PAYLOAD_BINDING_MISMATCH');return ports.guides.issueB2B(v,c.operationId,ctx);
 }});
 const read:ProductionNativeProvider={authorize:async c=>{await catalogue.resolveRead(c.binding);},execute:async c=>{const b=await catalogue.resolveRead(c.binding),v=object(c.payload);if(Object.keys(v).some(k=>!['documentId','after','limit'].includes(k))||v.documentId!==undefined&&!uuid(v.documentId)||v.after!==undefined&&!uuid(v.after)||v.limit!==undefined&&(!Number.isSafeInteger(v.limit)||v.limit<1||v.limit>100))deny(400,'INVALID_READ_QUERY');const rows=await db.$queryRawUnsafe<any[]>(`SELECT d."id",d."fullNumber",d."type",d."status",d."sunatStatus",d."issueDate",d."updatedAt" FROM "Document" d JOIN "CompanySettings" c ON c."id"=d."companyId" JOIN "EmissionPoint" p ON p."id"=d."emissionPointId" WHERE c."environment"='PRODUCTION' AND c."id"=$1 AND c."ruc"=$2 AND p."branchId"=$3::uuid AND p."id"=$4::uuid AND d."seriesCounterId"=$5::uuid AND ($6::uuid IS NULL OR d."id"=$6::uuid) AND ($7::uuid IS NULL OR d."id">$7::uuid) ORDER BY d."id" LIMIT $8`,b.issuerId,b.issuerRuc,b.branchId,b.pointId,b.seriesId,v.documentId??null,v.after??null,(v.limit??25)+1);const limit=v.limit??25;return {environment:'PRODUCTION',items:rows.slice(0,limit),nextAfter:rows.length>limit?rows[limit-1].id:null};}};
 return {catalogue,providers:{read,issue01:provider('01'),issue03:provider('03'),note07:provider('07'),note08:provider('08'),guide09:provider('09'),guide31:provider('31')}};
}
