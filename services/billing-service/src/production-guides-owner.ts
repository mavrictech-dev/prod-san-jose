import {nativeServicePrincipalId} from '@factuez/service-access/dist/native-b2b-rpc';
import {inputField} from './native-input-errors';
import {NativeB2bBillingAuthority,type NativeServiceContext} from './native-b2b-authority';
import type {ProductionGuidesServiceActor as ServiceActor,ProductionGuidesScope} from '@factuez/contracts/production-guides';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { allowsResource, reviewGuideDeclarations, validateGuideSettingsWrite, type AccessScope } from '@factuez/contracts';
import type { ProductionGuidesIssued as Issued, ProductionGuidesGrant as Grant, ProductionGuidesSnapshot as Snapshot, ProductionGuidesSigner, ProductionGuidesVerifier, ProductionGuidesReadPort, ProductionGuidesStatusEvent, ProductionGuidesArtifactKind } from '@factuez/contracts/production-guides';
const PRODUCTION_GUIDES_ISSUED = 'billing.production-guides.issued.v1' as const;
import { productionGuidesHash as hash, productionGuidesExact as exact, productionGuidesUuid as uuid, validateProductionGuidesSnapshot, validateProductionGuidesResult, PRODUCTION_GUIDES_XSD_SHA256 } from '@factuez/sunat-core/dist/production-guides';
export interface ProductionGuidesRaw { $queryRawUnsafe<T=unknown>(sql:string,...args:any[]):Promise<T>; $executeRawUnsafe(sql:string,...args:any[]):Promise<number> }
export interface ProductionGuidesBillingDb extends ProductionGuidesRaw { $transaction<T>(work:(tx:ProductionGuidesRaw)=>Promise<T>,options?:any):Promise<T> }
export type ProductionGuidesActor=({userId:string;service?:never;principalId?:never}|{userId?:never;service:ServiceActor;principalId:string})&{scope:AccessScope};
export type ProductionGuidesBillingOptions={enabled:()=>boolean; signer:ProductionGuidesSigner; ownerVerifier:ProductionGuidesVerifier; statusVerifier:ProductionGuidesVerifier;
 authority?:NativeB2bBillingAuthority;
 serviceCurrent?:(actor:ServiceActor,scope:ProductionGuidesScope)=>Promise<{scope:AccessScope;active:boolean;canIssue:boolean}>;
 actorCurrent:(userId:string)=>Promise<{scope:AccessScope;active:boolean;canIssue:boolean}>;
 sunat:ProductionGuidesReadPort & {admit(snapshot:Snapshot,grant:Grant):Promise<void>;grantEvidence(scope:import('@factuez/contracts/production-guides').ProductionGuidesScope,profiles:Grant['profiles'],credentialRevision:number):Promise<Pick<Grant,'credentialRevision'|'certificateFingerprint'|'rulesSha256'|'xsdSha256'>>}; readiness?:(scope:{companyId:number;issuerRuc:string})=>Promise<any>; now?:()=>string};
const latest=`SELECT "payload" FROM "ProductionGuidesGrant" WHERE "seriesCounterId"=$1::uuid AND "actorId"=$2::uuid ORDER BY "version" DESC LIMIT 1`;
/** Native company/branch/point/counter ownership is reloaded on every command/read. */
export class ProductionGuidesOwner {
 constructor(private readonly db:ProductionGuidesBillingDb,private readonly options?:ProductionGuidesBillingOptions){}
 private actorId(actor:ProductionGuidesActor){if(actor.service&&actor.principalId!==nativeServicePrincipalId(actor.service.clientId))throw new ForbiddenException('INVALID_ISSUANCE_ACTOR');return actor.service?actor.principalId:actor.userId;}
 private async live(id:string,service:ServiceActor|undefined,scope:ProductionGuidesScope){
  if(service){if(id!==nativeServicePrincipalId(service.clientId)||!this.options?.serviceCurrent)throw new ForbiddenException('SERVICE_GRANT_REQUIRED');return this.options.serviceCurrent(service,scope);}
  return this.enabled().actorCurrent(id);
 }
 async issueB2B(input:unknown,operationId:string,context:NativeServiceContext){
  const options=this.enabled();if(!options.authority||operationId!==context.operationId)throw new ForbiddenException('INVALID_ISSUANCE_ACTOR');
  const code=(input as any)?.profile==='GRE31_PUBLIC_SINGLE09_V1'?'31':'09',v=await options.authority.verifyContext(context,code);
  if((input as any)?.seriesCounterId!==v.binding.seriesId)throw new ForbiddenException('PAYLOAD_BINDING_MISMATCH');
  return this.issue(input,operationId,{principalId:v.principalId,service:{kind:'SERVICE',clientId:v.actor.clientId,revision:v.actor.revision,environment:'PRODUCTION'},scope:context.scope},context);
 }
 private clock(){return this.options?.now?.()??new Date().toISOString();}
 private enabled(){if(!this.options?.enabled())throw new ServiceUnavailableException('Guías productivas deshabilitadas');return this.options;}
 private async native(tx:ProductionGuidesRaw,id:string,actor:ProductionGuidesActor,write=false){
  uuid(id);uuid(this.actorId(actor));
  const rows=await tx.$queryRawUnsafe<any[]>(`SELECT s."id" AS "seriesCounterId",s."series",s."nextNumber",p."id" AS "pointId",b."id" AS "branchId",b."establishmentCode",c."id" AS "companyId",c."ruc" AS "issuerRuc",c."legalName",c."configVersion",b."masterRevision" AS "branchRevision",p."masterRevision" AS "pointRevision",s."masterRevision" AS "seriesRevision"
   FROM "SeriesCounter" s JOIN "EmissionPoint" p ON p."id"=s."emissionPointId" AND p."companyId"=s."companyId" JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=p."companyId" JOIN "CompanySettings" c ON c."id"=s."companyId"
   WHERE s."id"=$1::uuid AND s."active" AND p."active" AND b."active" AND c."active" AND c."environment"='PRODUCTION' AND s."environment"='PRODUCTION' AND s."documentType"='DESPATCH_ADVICE' ${write?'FOR UPDATE OF s FOR SHARE OF p,b,c':''}`,id);
  const n=rows[0];if(!n||!n.establishmentCode||!allowsResource(actor.scope,n.branchId,n.pointId,n.seriesCounterId))throw new ForbiddenException('Guía fuera de sede, establecimiento o alcance');return n;
 }
 private async grant(tx:ProductionGuidesRaw,counter:string,actor:string){return (await tx.$queryRawUnsafe<{payload:Grant}[]>(latest,counter,actor))[0]?.payload;}
 private scope(n:any){return {companyId:n.companyId,issuerRuc:n.issuerRuc,branchId:n.branchId,pointId:n.pointId,seriesCounterId:n.seriesCounterId,establishmentCode:n.establishmentCode};}
 async catalogueSource(scope:{companyId:number;issuerRuc:string}){
  if(!Number.isSafeInteger(scope.companyId)||!/^\d{11}$/.test(scope.issuerRuc))throw new BadRequestException();
  const owner=(await this.db.$queryRawUnsafe<any[]>('SELECT id FROM "CompanySettings" WHERE id=$1 AND ruc=$2 AND active',scope.companyId,scope.issuerRuc))[0];if(!owner)throw new NotFoundException();
  const goods=await this.db.$queryRawUnsafe<any[]>('SELECT p.sku AS code,p.description,p."unitCode",p."greGoodsFamily" FROM "FuelProduct" p JOIN "ProductCategory" c ON c.id=p."categoryId" JOIN "ProductUnit" u ON u.code=p."unitCode" WHERE p.active AND c.active AND u.active ORDER BY p.sku');return {goods};
 }
 private checkGrant(g:Grant|undefined,n:any,actor:string,profile:string){
  if(!g||!g.enabled||g.actorId!==actor||hash(this.scope(n))!==hash(Object.fromEntries(Object.keys(this.scope(n)).map(k=>[k,(g as any)[k]])))||!g.profiles.includes(profile as any)||Date.parse(g.expiresAt)<=Date.parse(this.clock()))throw new ForbiddenException('Concesión GRE vigente requerida');
  return g;
 }
 /** Additive native counter administration: DESPATCH_ADVICE uses T for09 and V for31. No client-set correlativo. */
 async createSeries(raw:unknown,actor:ProductionGuidesActor){
  this.enabled();exact(raw,['pointId','series','expectedPointRevision']);const v=raw as any;uuid(v.pointId);uuid(this.actorId(actor));
  if(typeof v.series!=='string'||!/^[TV][A-Z0-9]{3}$/.test(v.series)||!Number.isSafeInteger(v.expectedPointRevision))throw new BadRequestException('Serie GRE invalida');
  return this.db.$transaction(async tx=>{
   const n=(await tx.$queryRawUnsafe<any[]>(`SELECT p."id",p."companyId",p."branchId",p."masterRevision" FROM "EmissionPoint" p JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=p."companyId" JOIN "CompanySettings" c ON c."id"=p."companyId" WHERE p."id"=$1::uuid AND p."active" AND b."active" AND c."active" AND c."environment"='PRODUCTION' AND b."establishmentCode"~'^[0-9]{4}$' FOR SHARE OF p,b,c`,v.pointId))[0];
   if(!n||!allowsResource(actor.scope,n.branchId,n.id))throw new ForbiddenException('Punto fuera del alcance');
   if(n.masterRevision!==v.expectedPointRevision)throw new ConflictException('Punto cambio');
   const id=randomUUID();await tx.$executeRawUnsafe('INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series","environment","updatedAt") VALUES ($1::uuid,$2,$3::uuid,\'DESPATCH_ADVICE\',$4,\'PRODUCTION\',now())',id,n.companyId,n.id,v.series);
   return {id,companyId:n.companyId,pointId:n.id,documentType:'DESPATCH_ADVICE',guideType:v.series[0]==='V'?'31':'09',series:v.series,nextNumber:'1'};
  });
 }
 private async point(pointId:string,actor:ProductionGuidesActor){
  uuid(pointId);uuid(this.actorId(actor));const n=(await this.db.$queryRawUnsafe<any[]>(`SELECT p."id",p."companyId",p."branchId",p."masterRevision",b."establishmentCode",c."ruc",c."environment" FROM "EmissionPoint" p JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=p."companyId" JOIN "CompanySettings" c ON c."id"=p."companyId" WHERE p."id"=$1::uuid AND p."active" AND b."active" AND c."active"`,pointId))[0];
  if(!n||!allowsResource(actor.scope,n.branchId,n.id))throw new ForbiddenException('Punto fuera del alcance');return n;
 }
 async capabilities(pointId:string,actor:ProductionGuidesActor){
  const n=await this.point(pointId,actor),blockers:string[]=[];
  const schema=(await this.db.$queryRawUnsafe<any[]>(`SELECT to_regclass('"ProductionGuidesReservation"') IS NOT NULL AS ready`))[0]?.ready;
  if(!schema)blockers.push('Migración GRE Billing pendiente');if(n.environment!=='PRODUCTION')blockers.push('El emisor debe estar configurado en Producción; el laboratorio BETA está separado');
  if(!/^[0-9]{4}$/.test(n.establishmentCode??''))blockers.push('Código de establecimiento SUNAT de la sede pendiente');
  if(!this.options)blockers.push('Runtime privado GRE no configurado: mTLS, firma propietaria e Identity pendientes');
  if(!this.options?.enabled())blockers.push('Transmisión y workers requieren activación explícita del servidor');
  let fiscal:any=null;if(this.options?.readiness)try{fiscal=await this.options.readiness({companyId:n.companyId,issuerRuc:n.ruc});blockers.push(...fiscal.blockers);}catch{blockers.push('Runtime SUNAT privado no disponible');}
  const series=schema?(await this.series(pointId,actor)).series:[];
  if(!series.length)blockers.push('Configure una serie T para 09 o V para 31');
  if(!series.some(s=>s.grant?.enabled&&Date.parse(s.grant.expiresAt)>Date.parse(this.clock())))blockers.push('Concesión vigente por actor/serie/perfil pendiente');
  const declarations=await this.declarationReview(n.companyId,fiscal?.catalogue??null);
  return {implemented:true,installed:!!this.options,enabled:this.options?.enabled()===true,ready:blockers.length===0,blockers,companyId:n.companyId,issuerRuc:n.ruc,branchId:n.branchId,pointId,pointRevision:n.masterRevision,establishmentCode:n.establishmentCode,environment:n.environment,profiles:['GRE09_PRIVATE04_V1','GRE09_PUBLIC01_V1','GRE31_PUBLIC_SINGLE09_V1','GRE09_HYDROCARBON_PRIVATE04_V1','GRE09_HYDROCARBON_PUBLIC01_V1'],series,fiscal,declarations,b2b:{installed:!!this.options?.authority,contract:'SERVICE PRODUCTION con alcance y concesión vigente por aplicación, revisión, serie y perfil'}};
 }
 private async declarationReview(companyId:number,catalogue:Parameters<typeof reviewGuideDeclarations>[1]){
  const ready=(await this.db.$queryRawUnsafe<any[]>(`SELECT to_regclass('"GuideOperationalSettings"') IS NOT NULL AS ready`))[0]?.ready;
  if(!ready)return {status:'STORAGE_PENDING',revision:0,fiscalTransmission:false,blockers:['Almacenamiento de declaraciones pendiente; el catálogo nativo conserva la autoridad.']};
  const row=(await this.db.$queryRawUnsafe<any[]>('SELECT "settings","revision" FROM "GuideOperationalSettings" WHERE "companyId"=$1',companyId))[0];
  if(!row)return {status:'NOT_CONFIGURED',revision:0,fiscalTransmission:false,blockers:['Declaraciones del emisor pendientes; configure y contraste con el catálogo revisado.']};
  const valid=validateGuideSettingsWrite({expectedRevision:row.revision,settings:row.settings});
  if(!valid.ok)return {status:'REVIEW_PENDING',revision:row.revision,fiscalTransmission:false,blockers:['Declaraciones guardadas requieren revisión.']};
  return {...reviewGuideDeclarations(valid.value.settings,catalogue),revision:row.revision};
 }
 async list(pointId:string,cursor:string|undefined,actor:ProductionGuidesActor){
  const n=await this.point(pointId,actor);if(cursor)uuid(cursor);
  const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT r."documentId",r."operationId",r."state",r."revision",d."fullNumber",d."issueDate",d."customerLegalName",d."seriesCounterId" FROM "ProductionGuidesReservation" r JOIN "Document" d ON d."id"=r."documentId" WHERE d."emissionPointId"=$1::uuid AND ($2::uuid IS NULL OR r."documentId">$2::uuid) AND ($3::boolean OR d."seriesCounterId"=ANY($4::uuid[])) ORDER BY r."documentId" LIMIT 51`,pointId,cursor??null,actor.scope.kind==='GLOBAL',actor.scope.kind==='ASSIGNED'?actor.scope.series:[]);
  const visible=rows.filter(r=>allowsResource(actor.scope,n.branchId,pointId,r.seriesCounterId));
  return {items:visible.slice(0,50),nextCursor:rows.length>50?rows[49].documentId:null};
 }
 async carrierReference(seriesId:string,ref:{issuerRuc:string;series:string;number:string},actor:ProductionGuidesActor){
  const options=this.enabled(),n=await this.native(this.db,seriesId,actor);
  if(!n.series.startsWith('V')||!/^\d{11}$/.test(ref.issuerRuc)||!/^T[A-Z0-9]{3}$/.test(ref.series)||!/^[1-9][0-9]{0,7}$/.test(ref.number))throw new BadRequestException('Referencia GRE 09 inválida');
  const row=(await this.db.$queryRawUnsafe<any[]>(`SELECT r."event" FROM "ProductionGuidesReservation" r JOIN "Document" d ON d."id"=r."documentId" JOIN "CompanySettings" c ON c."id"=d."companyId" WHERE c."ruc"=$1 AND d."series"=$2 AND d."number"=$3::bigint`,ref.issuerRuc,ref.series,ref.number))[0];
  const e=row?.event as Issued|undefined;if(!e)throw new NotFoundException('Referencia no disponible');const s=validateProductionGuidesSnapshot(e.snapshot),b=s.body as any;
  if(s.profile!=='GRE09_PUBLIC01_V1'||b.carrier.ruc!==n.issuerRuc||b.carrier.legalName!==n.legalName)throw new NotFoundException('Referencia no disponible para este transportista');
  const status=await options.sunat.status(e);if(!status.officialCdrVerified||status.source!=='SUNAT_OFFICIAL'||!['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS'].includes(status.state))throw new ConflictException('La referencia requiere CDR oficial verificado');
  const projection={schemaVersion:'factuez.carrier-reference09-owner.v1',documentId:s.documentId,documentType:'09',issuer:s.issuer,series:s.series,number:s.number,...Object.fromEntries(['issueDate','transferDate','sender','recipient','origin','destination','carrier','grossWeight','weightUnit','items','transportMode','regulatedGoods'].map(k=>[k,b[k]]))};
  return {projection,reference09:{documentId:s.documentId,issuerRuc:s.issuer.ruc,series:s.series,number:s.number,snapshotSha256:hash(projection)}};
 }
 async operation(id:string,actor:ProductionGuidesActor){uuid(id);const row=(await this.db.$queryRawUnsafe<any[]>('SELECT "documentId" FROM "ProductionGuidesReservation" WHERE "operationId"=$1::uuid',id))[0];if(!row)throw new NotFoundException('Reserva no encontrada; revise el listado antes de reintentar');await this.load(row.documentId,actor);return {documentId:row.documentId};}
 async series(pointId:string,actor:ProductionGuidesActor,grantActor=this.actorId(actor)){
  uuid(grantActor);
  uuid(pointId);uuid(this.actorId(actor));const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT s."id",s."series",s."nextNumber",p."id" AS "pointId",p."branchId",b."establishmentCode",p."masterRevision" AS "pointRevision",c."ruc" FROM "SeriesCounter" s JOIN "EmissionPoint" p ON p."id"=s."emissionPointId" JOIN "Branch" b ON b."id"=p."branchId" JOIN "CompanySettings" c ON c."id"=s."companyId" WHERE p."id"=$1::uuid AND s."environment"='PRODUCTION' AND s."documentType"='DESPATCH_ADVICE' AND s."series"~'^[TV][A-Z0-9]{3}$' AND s."active" AND p."active" AND b."active" AND c."active" AND c."environment"='PRODUCTION' ORDER BY s."series"`,pointId);
  return {serverEnabled:this.options?.enabled()===true,series:await Promise.all(rows.filter(n=>allowsResource(actor.scope,n.branchId,n.pointId,n.id)).map(async n=>({id:n.id,series:n.series,guideType:n.series[0]==='V'?'31':'09',nextNumber:String(n.nextNumber),pointRevision:n.pointRevision,establishmentCode:n.establishmentCode,issuerRuc:n.ruc,grant:await this.grant(this.db,n.id,grantActor)??null})))};
 }
 /** Append-only CAS. Exposed only through SUNAT_CONFIGURE + native scope guard. No default grant. */
 async configure(seriesId:string,raw:unknown,actor:ProductionGuidesActor){
  const options=this.enabled();if(actor.service||actor.scope.kind!=='GLOBAL')throw new ForbiddenException('ADMIN_GLOBAL_SESSION_REQUIRED');
  exact(raw,['expectedVersion','actorId','enabled','profiles','expectedCredentialRevision','expiresAt',...((raw as any)?.actorKind==='SERVICE'?['actorKind','expectedClientRevision']:[])]);const value=structuredClone(raw) as any;
  let service:ServiceActor|undefined;
  if(value.actorKind==='SERVICE'){uuid(value.actorId);if(!Number.isSafeInteger(value.expectedClientRevision)||value.expectedClientRevision<1)throw new BadRequestException('INVALID_CLIENT');service={kind:'SERVICE',clientId:value.actorId,revision:value.expectedClientRevision,environment:'PRODUCTION'};value.actorId=nativeServicePrincipalId(value.actorId);}
  uuid(value.actorId);if(!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<0||typeof value.enabled!=='boolean'||!Array.isArray(value.profiles)||!value.profiles.length||new Set(value.profiles).size!==value.profiles.length||value.profiles.some((p:string)=>!['GRE09_PRIVATE04_V1','GRE09_PUBLIC01_V1','GRE31_PUBLIC_SINGLE09_V1','GRE09_HYDROCARBON_PRIVATE04_V1','GRE09_HYDROCARBON_PUBLIC01_V1'].includes(p))||!Number.isSafeInteger(value.expectedCredentialRevision)||value.expectedCredentialRevision<1||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.parse(this.clock()))throw new BadRequestException('Concesión inválida');
  return this.db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-grant:'+seriesId+':'+value.actorId);
   const n=await this.native(tx,seriesId,actor,true), prior=await this.grant(tx,seriesId,value.actorId);
   if((prior?.version??0)!==value.expectedVersion)throw new ConflictException('Concesión cambió');
   const live=value.enabled?await this.live(value.actorId,service,this.scope(n)):undefined;
   if(value.enabled&&(!live?.active||!live.canIssue||!allowsResource(live.scope,n.branchId,n.pointId,n.seriesCounterId)))throw new ForbiddenException('Actor de concesión sin alcance vigente');
   const pins=value.enabled?await options.sunat.grantEvidence(this.scope(n),value.profiles,value.expectedCredentialRevision):prior;
   if(!pins||pins.credentialRevision!==value.expectedCredentialRevision||pins.xsdSha256!==PRODUCTION_GUIDES_XSD_SHA256||![pins.certificateFingerprint,pins.rulesSha256,pins.xsdSha256].every(h=>/^[a-f0-9]{64}$/.test(h)))throw new ConflictException('Evidencia de configuración no disponible');
   const g:Grant={...this.scope(n),...(service?{createdByActor:service}:{}),actorId:value.actorId,version:value.expectedVersion+1,enabled:value.enabled,profiles:value.profiles,expiresAt:value.expiresAt,credentialRevision:pins.credentialRevision,certificateFingerprint:pins.certificateFingerprint,rulesSha256:pins.rulesSha256,xsdSha256:pins.xsdSha256};
   await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesGrant" ("seriesCounterId","actorId","version","payload","configuredBy") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid)',seriesId,g.actorId,g.version,JSON.stringify(g),this.actorId(actor));return g;
  },{timeout:60000});
 }

 async issue(raw:unknown,operationId:string,actor:ProductionGuidesActor,serviceContext?:NativeServiceContext){
  const options=this.enabled();uuid(operationId);inputField('request','GRE_INPUT_INVALID',()=>exact(raw,['seriesCounterId','profile','body']));const input=structuredClone(raw) as any;inputField('seriesCounterId','GRE_INPUT_INVALID',()=>uuid(input.seriesCounterId));
  const requestSha256=hash({actorId:this.actorId(actor),input});
  return this.db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-operation:'+operationId);
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-grant:'+input.seriesCounterId+':'+this.actorId(actor));
   const n=await this.native(tx,input.seriesCounterId,actor,true);
   const prior=(await tx.$queryRawUnsafe<any[]>('SELECT * FROM "ProductionGuidesReservation" WHERE "operationId"=$1::uuid',operationId))[0];
   if(prior){if(prior.actorId!==this.actorId(actor)||prior.requestSha256!==requestSha256)throw new ConflictException('Idempotencia usada con otro actor o contenido');return {documentId:prior.documentId,eventId:prior.eventId,deduplicated:true};}
   const g=this.checkGrant(await this.grant(tx,n.seriesCounterId,this.actorId(actor)),n,this.actorId(actor),input.profile);
   if(hash(g.createdByActor??null)!==hash(actor.service??null))throw new ForbiddenException('SERVICE_GRANT_REVISION_MISMATCH');
   if(actor.service){const live=await this.live(this.actorId(actor),actor.service,this.scope(n));if(!live.active||!live.canIssue)throw new ForbiddenException('REVOKED_TOKEN');}
   if(BigInt(n.nextNumber)<1n||BigInt(n.nextNumber)>99999999n)throw new ConflictException('Correlativo agotado');
   const snapshot=inputField('body','GRE_INPUT_INVALID',()=>validateProductionGuidesSnapshot({schemaVersion:'factuez.production-guides.v1',documentId:randomUUID(),operationId,actorId:this.actorId(actor),
    ...(actor.service?{createdByActor:actor.service}:{}),scope:this.scope(n),issuer:{ruc:n.issuerRuc,legalName:n.legalName},documentType:input.profile==='GRE31_PUBLIC_SINGLE09_V1'?'31':'09',profile:input.profile,series:n.series,number:String(n.nextNumber),body:input.body,grantVersion:g.version,createdAt:this.clock(),environment:'PRODUCTION'}));
   // Current authoritative product master closes old catalogue misclassification before reservation.
   const master=await tx.$queryRawUnsafe<any[]>('SELECT sku AS code,description,"unitCode","greGoodsFamily" FROM "FuelProduct" WHERE sku=ANY($1::text[]) AND active FOR SHARE',(snapshot.body as any).items.map((i:any)=>i.code));
   const fuel=input.profile.startsWith('GRE09_HYDROCARBON_');
   if(fuel&&(snapshot.body as any).items.some((i:any)=>!master.some(m=>m.code===i.code&&m.description===i.description&&m.unitCode===i.unitCode&&m.greGoodsFamily===(snapshot.body as any).hydrocarbon.family)))throw new BadRequestException('El combustible o su unidad/clasificación cambió; revise el maestro y catálogo GRE');
   if(!fuel&&master.some(m=>!['UNCLASSIFIED','NON_REGULATED'].includes(m.greGoodsFamily)))throw new BadRequestException('Los combustibles requieren un perfil GRE de hidrocarburos y una concesión nueva');
   // Pre-number-commit gate: no signing here; SUNAT checks immutable data, production reference, config/trust/rules availability.
   await options.sunat.admit(snapshot,g);
   if(serviceContext)await options.authority!.verifyContext(serviceContext,snapshot.documentType);
   const payload={eventId:randomUUID(),eventType:PRODUCTION_GUIDES_ISSUED,snapshot,snapshotSha256:hash(snapshot)};
   const event:Issued={...payload,seal:options.signer.sign(payload,'ISSUED')};const b=snapshot.body as any;
   await tx.$executeRawUnsafe(`INSERT INTO "Document" ("id","companyId","seriesCounterId","type","status","series","number","fullNumber","issueDate","emissionPointId","createdByUserId","customerIdentityType","customerIdentityNumber","customerLegalName","taxableAmount","igvAmount","payableAmount","immutableSnapshot","originSystem","originId","updatedAt") VALUES ($1::uuid,$2,$3::uuid,'DESPATCH_ADVICE','ISSUED',$4,$5::bigint,$6,$7::timestamptz,$8::uuid,$9::uuid,'6',$10,$11,0,0,0,$12::jsonb,'PRODUCTION_GUIDES',$13,now())`,snapshot.documentId,n.companyId,n.seriesCounterId,snapshot.series,snapshot.number,`${snapshot.series}-${snapshot.number}`,b.issueDate,n.pointId,actor.service?null:this.actorId(actor),b.recipient.ruc,b.recipient.legalName,JSON.stringify(snapshot),operationId);
   if(actor.service)await tx.$executeRawUnsafe('UPDATE "Document" SET "createdByActor"=$2::jsonb WHERE "id"=$1::uuid',snapshot.documentId,JSON.stringify({...actor.service,subjectId:null,userAuthRevision:null}));
   await tx.$executeRawUnsafe('UPDATE "SeriesCounter" SET "nextNumber"="nextNumber"+1,"updatedAt"=now() WHERE "id"=$1::uuid',n.seriesCounterId);
   await tx.$executeRawUnsafe('INSERT INTO "OutboxEvent" ("id","eventType","aggregateId","payload") VALUES ($1::uuid,$2,$3,$4::jsonb)',event.eventId,event.eventType,snapshot.documentId,JSON.stringify(event));
   await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesReservation" ("documentId","operationId","actorId","requestSha256","snapshotSha256","eventId","event") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb)',snapshot.documentId,operationId,this.actorId(actor),requestSha256,event.snapshotSha256,event.eventId,JSON.stringify(event));
   return {documentId:snapshot.documentId,eventId:event.eventId,deduplicated:false};
  },{maxWait:5000,timeout:30000});
 }
 private async load(id:string,actor:ProductionGuidesActor){
  uuid(id);const row=(await this.db.$queryRawUnsafe<any[]>('SELECT * FROM "ProductionGuidesReservation" WHERE "documentId"=$1::uuid',id))[0];if(!row)throw new NotFoundException();
  const event=row.event as Issued,s=validateProductionGuidesSnapshot(event.snapshot);const n=await this.native(this.db,s.scope.seriesCounterId,actor);
  if(event.snapshotSha256!==hash(s)||hash(s.scope)!==hash(this.scope(n))||s.issuer.legalName!==n.legalName)throw new ConflictException('Propietario cambió');return event;
 }
 async current(event:Issued):Promise<Grant>{
  const options=this.enabled();const {seal,...payload}=event;if(!options.ownerVerifier.verify(payload,seal,'ISSUED'))throw new ForbiddenException('Firma propietaria inválida');
  // Worker is authorized by a signed reservation plus the exact actor-specific, current production grant.
  const stored=(await this.db.$queryRawUnsafe<any[]>('SELECT "event" FROM "ProductionGuidesReservation" WHERE "documentId"=$1::uuid',event.snapshot.documentId))[0]?.event;
  if(!stored||hash(stored)!==hash(event))throw new ForbiddenException('Reserva no vinculada');
  const s=validateProductionGuidesSnapshot(event.snapshot), actor=await this.live(s.actorId,s.createdByActor,s.scope);
  if(!actor.active||!actor.canIssue)throw new ForbiddenException('Actor de reserva revocado');
  const n=await this.native(this.db,s.scope.seriesCounterId,{...(s.createdByActor?{service:s.createdByActor,principalId:s.actorId}:{userId:s.actorId}),scope:actor.scope} as ProductionGuidesActor);
  const g=this.checkGrant(await this.grant(this.db,s.scope.seriesCounterId,s.actorId),n,s.actorId,s.profile);
  if(hash(g.createdByActor??null)!==hash(s.createdByActor??null)||g.version!==s.grantVersion||hash(s.scope)!==hash(this.scope(n))||n.series!==s.series||n.legalName!==s.issuer.legalName)throw new ForbiddenException('Reserva o concesión revocada');return g;
 }
 async currentGrant(claim:Grant):Promise<Grant>{
  const options=this.enabled();uuid(claim.actorId);uuid(claim.seriesCounterId);const live=await this.live(claim.actorId,claim.createdByActor,claim);
  if(!live.active||!live.canIssue)throw new ForbiddenException('Actor revocado');
  const n=await this.native(this.db,claim.seriesCounterId,{...(claim.createdByActor?{service:claim.createdByActor,principalId:claim.actorId}:{userId:claim.actorId}),scope:live.scope} as ProductionGuidesActor);
  const g=this.checkGrant(await this.grant(this.db,claim.seriesCounterId,claim.actorId),n,claim.actorId,claim.profiles[0]);
  if(hash(g)!==hash(claim))throw new ForbiddenException('Concesión revocada o sustituida');return g;
 }
 async referenceOwner(requester:Snapshot):Promise<Issued>{
  const options=this.enabled(),s=validateProductionGuidesSnapshot(requester);if(s.documentType!=='31')throw new ForbiddenException();
  const live=await this.live(s.actorId,s.createdByActor,s.scope);if(!live.active||!live.canIssue)throw new ForbiddenException();
  const n=await this.native(this.db,s.scope.seriesCounterId,{...(s.createdByActor?{service:s.createdByActor,principalId:s.actorId}:{userId:s.actorId}),scope:live.scope} as ProductionGuidesActor);this.checkGrant(await this.grant(this.db,n.seriesCounterId,s.actorId),n,s.actorId,s.profile);
  const ref=(s.body as any).reference09;uuid(ref.documentId);
  const row=(await this.db.$queryRawUnsafe<any[]>('SELECT "event" FROM "ProductionGuidesReservation" WHERE "documentId"=$1::uuid',ref.documentId))[0];
  const e=row?.event as Issued|undefined;if(!e)throw new NotFoundException();const source=validateProductionGuidesSnapshot(e.snapshot),body=source.body as any;
  // Cross-RUC disclosure is limited to the immutable 09 naming this exact contracted carrier.
  if(source.profile!=='GRE09_PUBLIC01_V1'||source.documentType!=='09'||source.issuer.ruc!==ref.issuerRuc||source.series!==ref.series||source.number!==ref.number||hash(body.carrier)!==hash(s.issuer))throw new ForbiddenException('Referencia no contrata al transportista');
  return e;
 }
 async event(id:string,actor:ProductionGuidesActor){return this.load(id,actor);}
 async status(id:string,actor:ProductionGuidesActor){const e=await this.load(id,actor);return this.enabled().sunat.status(e);}
 async artifact(id:string,kind:ProductionGuidesArtifactKind,actor:ProductionGuidesActor){if(!['signed-xml','submission-zip','cdr-xml','cdr-zip'].includes(kind))throw new BadRequestException();const e=await this.load(id,actor);return this.enabled().sunat.artifact(e,kind);}
 async pdf(id:string,actor:ProductionGuidesActor){const e=await this.load(id,actor);return this.enabled().sunat.pdf(e);}
 async applyStatus(event:ProductionGuidesStatusEvent){
  event=structuredClone(event);exact(event,['eventId','eventType','result','seal']);
  const options=this.enabled(),{seal,...payload}=event;
  if(event.eventType!=='sunat.production-guides.status.v1'||!options.statusVerifier.verify(payload,seal,'STATUS'))throw new ForbiddenException('Evento de estado inválido');
  const result=validateProductionGuidesResult(event.result);uuid(event.eventId);uuid(result.documentId);
  if(!Number.isSafeInteger(result.revision)||result.revision<1||!['RESERVED','PREPARED','POSTING','UNKNOWN','TICKET','ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','FAILED_NO_CDR'].includes(result.state)||result.authorizedForTransfer!==false||result.source!=='SUNAT_OFFICIAL'&&result.officialCdrVerified)throw new BadRequestException('Estado inválido');
  return this.db.$transaction(async tx=>{
   const row=(await tx.$queryRawUnsafe<any[]>('SELECT * FROM "ProductionGuidesReservation" WHERE "documentId"=$1::uuid FOR UPDATE',result.documentId))[0];
   if(!row||row.snapshotSha256!==result.snapshotSha256)throw new ConflictException('Estado fuera de snapshot');
   const prior=(await tx.$queryRawUnsafe<any[]>('SELECT "event" FROM "ProductionGuidesOwnerStatus" WHERE "eventId"=$1::uuid OR ("documentId"=$2::uuid AND "revision"=$3)',event.eventId,result.documentId,result.revision))[0];
   if(prior){if(hash(prior.event)!==hash(event))throw new ConflictException('Evento de estado divergente');return;}
   if(result.revision!==row.revision+1)throw new ConflictException('Secuencia de estado incompleta');
   const transitions:Record<string,string[]>={RESERVED:['PREPARED'],PREPARED:['UNKNOWN'],UNKNOWN:['TICKET'],TICKET:['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED','FAILED_NO_CDR']};
   if(!transitions[row.state]?.includes(result.state)||['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED'].includes(result.state)&&(!result.cdrZipSha256||!result.xmlSha256||!result.zipSha256)||result.officialCdrVerified&&result.source!=='SUNAT_OFFICIAL')throw new ConflictException('Transicion de estado invalida');

   await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesOwnerStatus" ("eventId","documentId","revision","event") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb)',event.eventId,result.documentId,result.revision,JSON.stringify(event));
   await tx.$executeRawUnsafe('UPDATE "ProductionGuidesReservation" SET "state"=$2,"revision"=$3 WHERE "documentId"=$1::uuid',result.documentId,result.state,result.revision);
   const mapped=['ACCEPTED','ACCEPTED_WITH_OBSERVATIONS','REJECTED'].includes(result.state)?result.state:result.state==='UNKNOWN'?'PERMANENT_ERROR':null;
   if(mapped)await tx.$executeRawUnsafe('UPDATE "Document" SET "sunatStatus"=$2::"SunatStatus","updatedAt"=now() WHERE "id"=$1::uuid',result.documentId,mapped);
  });
 }
}
