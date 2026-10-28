import { BadRequestException, ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { allowsResource, type AccessScope } from '@factuez/contracts';
import type { ProductionGuidesIssued as Issued, ProductionGuidesGrant as Grant, ProductionGuidesSnapshot as Snapshot, ProductionGuidesSigner, ProductionGuidesVerifier, ProductionGuidesReadPort, ProductionGuidesStatusEvent, ProductionGuidesArtifactKind } from '@factuez/contracts/production-guides';
const PRODUCTION_GUIDES_ISSUED = 'billing.production-guides.issued.v1' as const;
import { productionGuidesHash as hash, productionGuidesExact as exact, productionGuidesUuid as uuid, validateProductionGuidesSnapshot, PRODUCTION_GUIDES_XSD_SHA256 } from '@factuez/sunat-core/dist/production-guides';
export interface ProductionGuidesRaw { $queryRawUnsafe<T=unknown>(sql:string,...args:any[]):Promise<T>; $executeRawUnsafe(sql:string,...args:any[]):Promise<number> }
export interface ProductionGuidesBillingDb extends ProductionGuidesRaw { $transaction<T>(work:(tx:ProductionGuidesRaw)=>Promise<T>,options?:any):Promise<T> }
export type ProductionGuidesActor={userId:string;scope:AccessScope};
export type ProductionGuidesBillingOptions={enabled:()=>boolean; signer:ProductionGuidesSigner; ownerVerifier:ProductionGuidesVerifier; statusVerifier:ProductionGuidesVerifier;
 actorCurrent:(userId:string)=>Promise<{scope:AccessScope;active:boolean;canIssue:boolean}>;
 sunat:ProductionGuidesReadPort & {admit(snapshot:Snapshot,grant:Grant):Promise<void>;grantEvidence(scope:import('@factuez/contracts/production-guides').ProductionGuidesScope,profiles:Grant['profiles'],credentialRevision:number):Promise<Pick<Grant,'credentialRevision'|'certificateFingerprint'|'rulesSha256'|'xsdSha256'>>}; now?:()=>string};
const latest=`SELECT "payload" FROM "ProductionGuidesGrant" WHERE "seriesCounterId"=$1::uuid AND "actorId"=$2::uuid ORDER BY "version" DESC LIMIT 1`;
/** Native company/branch/point/counter ownership is reloaded on every command/read. */
export class ProductionGuidesOwner {
 constructor(private readonly db:ProductionGuidesBillingDb,private readonly options?:ProductionGuidesBillingOptions){}
 private clock(){return this.options?.now?.()??new Date().toISOString();}
 private enabled(){if(!this.options?.enabled())throw new ServiceUnavailableException('Guías productivas deshabilitadas');return this.options;}
 private async native(tx:ProductionGuidesRaw,id:string,actor:ProductionGuidesActor,write=false){
  uuid(id);uuid(actor.userId);
  const rows=await tx.$queryRawUnsafe<any[]>(`SELECT s."id" AS "seriesCounterId",s."series",s."nextNumber",p."id" AS "pointId",b."id" AS "branchId",b."establishmentCode",c."id" AS "companyId",c."ruc" AS "issuerRuc",c."legalName",c."configVersion",b."masterRevision" AS "branchRevision",p."masterRevision" AS "pointRevision",s."masterRevision" AS "seriesRevision"
   FROM "SeriesCounter" s JOIN "EmissionPoint" p ON p."id"=s."emissionPointId" AND p."companyId"=s."companyId" JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=p."companyId" JOIN "CompanySettings" c ON c."id"=s."companyId"
   WHERE s."id"=$1::uuid AND s."active" AND p."active" AND b."active" AND c."active" AND c."environment"='PRODUCTION' AND s."documentType"='DESPATCH_ADVICE' ${write?'FOR UPDATE OF s FOR SHARE OF p,b,c':''}`,id);
  const n=rows[0];if(!n||!n.establishmentCode||!allowsResource(actor.scope,n.branchId,n.pointId,n.seriesCounterId))throw new ForbiddenException('Guía fuera de sede, establecimiento o alcance');return n;
 }
 private async grant(tx:ProductionGuidesRaw,counter:string,actor:string){return (await tx.$queryRawUnsafe<{payload:Grant}[]>(latest,counter,actor))[0]?.payload;}
 private scope(n:any){return {companyId:n.companyId,issuerRuc:n.issuerRuc,branchId:n.branchId,pointId:n.pointId,seriesCounterId:n.seriesCounterId,establishmentCode:n.establishmentCode};}
 private checkGrant(g:Grant|undefined,n:any,actor:string,profile:string){
  if(!g||!g.enabled||g.actorId!==actor||hash(this.scope(n))!==hash(Object.fromEntries(Object.keys(this.scope(n)).map(k=>[k,(g as any)[k]])))||!g.profiles.includes(profile as any)||Date.parse(g.expiresAt)<=Date.parse(this.clock()))throw new ForbiddenException('Concesión GRE vigente requerida');
  return g;
 }
 /** Additive native counter administration: DESPATCH_ADVICE uses T for09 and V for31. No client-set correlativo. */
 async createSeries(raw:unknown,actor:ProductionGuidesActor){
  this.enabled();exact(raw,['pointId','series','expectedPointRevision']);const v=raw as any;uuid(v.pointId);uuid(actor.userId);
  if(typeof v.series!=='string'||!/^[TV][A-Z0-9]{3}$/.test(v.series)||!Number.isSafeInteger(v.expectedPointRevision))throw new BadRequestException('Serie GRE invalida');
  return this.db.$transaction(async tx=>{
   const n=(await tx.$queryRawUnsafe<any[]>(`SELECT p."id",p."companyId",p."branchId",p."masterRevision" FROM "EmissionPoint" p JOIN "Branch" b ON b."id"=p."branchId" AND b."companyId"=p."companyId" JOIN "CompanySettings" c ON c."id"=p."companyId" WHERE p."id"=$1::uuid AND p."active" AND b."active" AND c."active" AND c."environment"='PRODUCTION' AND b."establishmentCode"~'^[0-9]{4}$' FOR SHARE OF p,b,c`,v.pointId))[0];
   if(!n||!allowsResource(actor.scope,n.branchId,n.id))throw new ForbiddenException('Punto fuera del alcance');
   if(n.masterRevision!==v.expectedPointRevision)throw new ConflictException('Punto cambio');
   const id=randomUUID();await tx.$executeRawUnsafe('INSERT INTO "SeriesCounter" ("id","companyId","emissionPointId","documentType","series","updatedAt") VALUES ($1::uuid,$2,$3::uuid,\'DESPATCH_ADVICE\',$4,now())',id,n.companyId,n.id,v.series);
   return {id,companyId:n.companyId,pointId:n.id,documentType:'DESPATCH_ADVICE',guideType:v.series[0]==='V'?'31':'09',series:v.series,nextNumber:'1'};
  });
 }
 async series(pointId:string,actor:ProductionGuidesActor){
  uuid(pointId);uuid(actor.userId);const rows=await this.db.$queryRawUnsafe<any[]>(`SELECT s."id",s."series",s."nextNumber",p."id" AS "pointId",p."branchId",b."establishmentCode",p."masterRevision" AS "pointRevision",c."ruc" FROM "SeriesCounter" s JOIN "EmissionPoint" p ON p."id"=s."emissionPointId" JOIN "Branch" b ON b."id"=p."branchId" JOIN "CompanySettings" c ON c."id"=s."companyId" WHERE p."id"=$1::uuid AND s."documentType"='DESPATCH_ADVICE' AND s."series"~'^[TV][A-Z0-9]{3}$' AND s."active" AND p."active" AND b."active" AND c."active" AND c."environment"='PRODUCTION' ORDER BY s."series"`,pointId);
  return {serverEnabled:this.options?.enabled()===true,series:await Promise.all(rows.filter(n=>allowsResource(actor.scope,n.branchId,n.pointId,n.id)).map(async n=>({id:n.id,series:n.series,guideType:n.series[0]==='V'?'31':'09',nextNumber:String(n.nextNumber),pointRevision:n.pointRevision,establishmentCode:n.establishmentCode,issuerRuc:n.ruc,grant:await this.grant(this.db,n.id,actor.userId)??null})))};
 }
 /** Append-only CAS. Exposed only through SUNAT_CONFIGURE + native scope guard. No default grant. */
 async configure(seriesId:string,raw:unknown,actor:ProductionGuidesActor){
  const options=this.enabled();exact(raw,['expectedVersion','actorId','enabled','profiles','expectedCredentialRevision','expiresAt']);const value=structuredClone(raw) as any;
  uuid(value.actorId);if(!Number.isSafeInteger(value.expectedVersion)||value.expectedVersion<0||typeof value.enabled!=='boolean'||!Array.isArray(value.profiles)||!value.profiles.length||new Set(value.profiles).size!==value.profiles.length||value.profiles.some((p:string)=>!['GRE09_PRIVATE04_V1','GRE09_PUBLIC01_V1','GRE31_PUBLIC_SINGLE09_V1'].includes(p))||!Number.isSafeInteger(value.expectedCredentialRevision)||value.expectedCredentialRevision<1||!Number.isFinite(Date.parse(value.expiresAt))||Date.parse(value.expiresAt)<=Date.parse(this.clock()))throw new BadRequestException('Concesión inválida');
  return this.db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-grant:'+seriesId+':'+value.actorId);
   const n=await this.native(tx,seriesId,actor,true), prior=await this.grant(tx,seriesId,value.actorId);
   if((prior?.version??0)!==value.expectedVersion)throw new ConflictException('Concesión cambió');
   const live=await options.actorCurrent(value.actorId);
   if(value.enabled&&(!live.active||!live.canIssue||!allowsResource(live.scope,n.branchId,n.pointId,n.seriesCounterId)))throw new ForbiddenException('Actor de concesión sin alcance vigente');
   const pins=value.enabled?await options.sunat.grantEvidence(this.scope(n),value.profiles,value.expectedCredentialRevision):prior;
   if(!pins||pins.credentialRevision!==value.expectedCredentialRevision||pins.xsdSha256!==PRODUCTION_GUIDES_XSD_SHA256||![pins.certificateFingerprint,pins.rulesSha256,pins.xsdSha256].every(h=>/^[a-f0-9]{64}$/.test(h)))throw new ConflictException('Evidencia de configuración no disponible');
   const g:Grant={...this.scope(n),actorId:value.actorId,version:value.expectedVersion+1,enabled:value.enabled,profiles:value.profiles,expiresAt:value.expiresAt,credentialRevision:pins.credentialRevision,certificateFingerprint:pins.certificateFingerprint,rulesSha256:pins.rulesSha256,xsdSha256:pins.xsdSha256};
   await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesGrant" ("seriesCounterId","actorId","version","payload","configuredBy") VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,$5::uuid)',seriesId,g.actorId,g.version,JSON.stringify(g),actor.userId);return g;
  },{timeout:60000});
 }

 async issue(raw:unknown,operationId:string,actor:ProductionGuidesActor){
  const options=this.enabled();uuid(operationId);exact(raw,['seriesCounterId','profile','body']);const input=structuredClone(raw) as any;uuid(input.seriesCounterId);
  const requestSha256=hash({actorId:actor.userId,input});
  return this.db.$transaction(async tx=>{
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-operation:'+operationId);
   await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1,0))','production-guides-grant:'+input.seriesCounterId+':'+actor.userId);
   const n=await this.native(tx,input.seriesCounterId,actor,true);
   const prior=(await tx.$queryRawUnsafe<any[]>('SELECT * FROM "ProductionGuidesReservation" WHERE "operationId"=$1::uuid',operationId))[0];
   if(prior){if(prior.actorId!==actor.userId||prior.requestSha256!==requestSha256)throw new ConflictException('Idempotencia usada con otro actor o contenido');return {documentId:prior.documentId,eventId:prior.eventId,deduplicated:true};}
   const g=this.checkGrant(await this.grant(tx,n.seriesCounterId,actor.userId),n,actor.userId,input.profile);
   if(BigInt(n.nextNumber)<1n||BigInt(n.nextNumber)>99999999n)throw new ConflictException('Correlativo agotado');
   const snapshot=validateProductionGuidesSnapshot({schemaVersion:'factuez.production-guides.v1',documentId:randomUUID(),operationId,actorId:actor.userId,
    scope:this.scope(n),issuer:{ruc:n.issuerRuc,legalName:n.legalName},documentType:input.profile==='GRE31_PUBLIC_SINGLE09_V1'?'31':'09',profile:input.profile,series:n.series,number:String(n.nextNumber),body:input.body,grantVersion:g.version,createdAt:this.clock(),environment:'PRODUCTION'});
   // Pre-number-commit gate: no signing here; SUNAT checks immutable data, production reference, config/trust/rules availability.
   await options.sunat.admit(snapshot,g);
   const payload={eventId:randomUUID(),eventType:PRODUCTION_GUIDES_ISSUED,snapshot,snapshotSha256:hash(snapshot)};
   const event:Issued={...payload,seal:options.signer.sign(payload,'ISSUED')};const b=snapshot.body as any;
   await tx.$executeRawUnsafe(`INSERT INTO "Document" ("id","companyId","seriesCounterId","type","status","series","number","fullNumber","issueDate","emissionPointId","createdByUserId","customerIdentityType","customerIdentityNumber","customerLegalName","taxableAmount","igvAmount","payableAmount","immutableSnapshot","originSystem","originId","updatedAt") VALUES ($1::uuid,$2,$3::uuid,'DESPATCH_ADVICE','ISSUED',$4,$5::bigint,$6,$7::timestamptz,$8::uuid,$9::uuid,'6',$10,$11,0,0,0,$12::jsonb,'PRODUCTION_GUIDES',$13,now())`,snapshot.documentId,n.companyId,n.seriesCounterId,snapshot.series,snapshot.number,`${snapshot.series}-${snapshot.number}`,b.issueDate,n.pointId,actor.userId,b.recipient.ruc,b.recipient.legalName,JSON.stringify(snapshot),operationId);
   await tx.$executeRawUnsafe('UPDATE "SeriesCounter" SET "nextNumber"="nextNumber"+1,"updatedAt"=now() WHERE "id"=$1::uuid',n.seriesCounterId);
   await tx.$executeRawUnsafe('INSERT INTO "OutboxEvent" ("id","eventType","aggregateId","payload") VALUES ($1::uuid,$2,$3,$4::jsonb)',event.eventId,event.eventType,snapshot.documentId,JSON.stringify(event));
   await tx.$executeRawUnsafe('INSERT INTO "ProductionGuidesReservation" ("documentId","operationId","actorId","requestSha256","snapshotSha256","eventId","event") VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::uuid,$7::jsonb)',snapshot.documentId,operationId,actor.userId,requestSha256,event.snapshotSha256,event.eventId,JSON.stringify(event));
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
  const s=validateProductionGuidesSnapshot(event.snapshot), actor=await options.actorCurrent(s.actorId);
  if(!actor.active||!actor.canIssue)throw new ForbiddenException('Actor de reserva revocado');
  const n=await this.native(this.db,s.scope.seriesCounterId,{userId:s.actorId,scope:actor.scope});
  const g=this.checkGrant(await this.grant(this.db,s.scope.seriesCounterId,s.actorId),n,s.actorId,s.profile);
  if(g.version!==s.grantVersion||hash(s.scope)!==hash(this.scope(n))||n.series!==s.series||n.legalName!==s.issuer.legalName)throw new ForbiddenException('Reserva o concesión revocada');return g;
 }
 async currentGrant(claim:Grant):Promise<Grant>{
  const options=this.enabled();uuid(claim.actorId);uuid(claim.seriesCounterId);const live=await options.actorCurrent(claim.actorId);
  if(!live.active||!live.canIssue)throw new ForbiddenException('Actor revocado');
  const n=await this.native(this.db,claim.seriesCounterId,{userId:claim.actorId,scope:live.scope});
  const g=this.checkGrant(await this.grant(this.db,claim.seriesCounterId,claim.actorId),n,claim.actorId,claim.profiles[0]);
  if(hash(g)!==hash(claim))throw new ForbiddenException('Concesión revocada o sustituida');return g;
 }
 async referenceOwner(requester:Snapshot):Promise<Issued>{
  const options=this.enabled(),s=validateProductionGuidesSnapshot(requester);if(s.documentType!=='31')throw new ForbiddenException();
  const live=await options.actorCurrent(s.actorId);if(!live.active||!live.canIssue)throw new ForbiddenException();
  const n=await this.native(this.db,s.scope.seriesCounterId,{userId:s.actorId,scope:live.scope});this.checkGrant(await this.grant(this.db,n.seriesCounterId,s.actorId),n,s.actorId,s.profile);
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
  const options=this.enabled(),{seal,...payload}=event;
  if(event.eventType!=='sunat.production-guides.status.v1'||!options.statusVerifier.verify(payload,seal,'STATUS'))throw new ForbiddenException('Evento de estado inválido');
  const result=event.result;uuid(event.eventId);uuid(result.documentId);
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
