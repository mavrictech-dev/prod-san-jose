import {randomUUID,createHash} from 'node:crypto';
import {parseReceivedXml,validateReceivedCdr,ReceivedCoreError} from '@factuez/received-core';
import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {correctionEvidenceFreeze,correctionEvidenceHash as digest} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedAnchor,receivedScope,receivedFail,type ReceivedScope} from '@factuez/service-access/dist/b2b-received-wire';
import type {ReceivedDatabase,ReceivedSql} from './store';
import {safeArtifactName} from '../validation';

export type ReceptionWriteAction='IMPORT'|'ATTACH'|'ASSIGN'|'REGISTER';
export interface ReceptionWriteAuthority {
  /** A live, independently enrolled policy; never approval from caller scopes. */
  authorize(principal:B2bPrincipal,scope:ReceivedScope,action:ReceptionWriteAction):Promise<{policyId:string;revision:number}>;
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
function exact(v:any,keys:string[]){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))receivedFail();}
function detached(v:unknown):any{try{return correctionEvidenceFreeze(v);}catch{receivedFail();}}
function upload(v:any){
  exact(v,['fileName','contentBase64']);let fileName:string;
  try{fileName=safeArtifactName(v.fileName);}catch{receivedFail();}
  if(/[\x80-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(fileName!)||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(fileName!))receivedFail();
  if(typeof v.contentBase64!=='string'||v.contentBase64.length%4!==0)receivedFail();
  if(v.contentBase64.length>87384)receivedFail(413,'NARROW_QUERY');
  const bytes=Buffer.from(v.contentBase64,'base64');
  if(bytes.length>65536)receivedFail(413,'NARROW_QUERY');
  if(!bytes.length||bytes.toString('base64')!==v.contentBase64)receivedFail();
  return {bytes,fileName:fileName!};
}
const instant=(v:unknown)=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
const reference=(v:unknown)=>v===null||typeof v==='string'&&v.length>0&&v.length<=120&&v===v.trim()&&!/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v);
function retryable(e:unknown){
  const v=e as {code?:string;meta?:{code?:string;driverAdapterError?:{cause?:{originalCode?:string}}}};
  return ['P2034','P2002','40001','23505','40P01'].includes(v?.code??'')||
    [v?.meta?.code,v?.meta?.driverAdapterError?.cause?.originalCode].some(code=>['40001','23505','40P01'].includes(code??''));
}
/** Real reception-owned atomic mutations. Originals and item decimals remain
 * exact; SERVICE audit never fabricates a human or writes emission state. */
export class B2bReceptionCommands {
  constructor(private readonly db:ReceivedDatabase,private readonly identity:B2bIdentityPort,private readonly authority:ReceptionWriteAuthority){}
  async execute(access:{token:string;kind:'SERVICE'|'USER'},action:ReceptionWriteAction,input:unknown){
    try{return await this.run(access,action,input);}catch(e){
      if(e instanceof ReceivedCoreError)receivedFail(400,'INVALID_RECEIVED_XML');
      if(e instanceof B2bSecurityError)throw e;
      if(retryable(e))receivedFail(409,'RECEIVED_COMMAND_CONFLICT');
      receivedFail(503,'RECEIVED_OWNER_UNAVAILABLE');
    }
  }
  private async run(access:{token:string;kind:'SERVICE'|'USER'},action:ReceptionWriteAction,input:unknown){
    if(!['IMPORT','ATTACH','ASSIGN','REGISTER'].includes(action))receivedFail();
    const a=detached(access);exact(a,['token','kind']);
    if(!['SERVICE','USER'].includes(a.kind)||typeof a.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(a.token))receivedFail(401,'INVALID_TOKEN');
    const v=detached(input);exact(v,['scope','key','payload']);const scope=receivedScope(v.scope);
    if(typeof v.key!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(v.key))receivedFail();
    // Validate file size/shape before any Identity or database operation.
    if(action==='IMPORT')upload(v.payload);
    else if(action==='ATTACH'){exact(v.payload,['documentId','kind','file']);upload(v.payload.file);}
    else if(action==='ASSIGN')exact(v.payload,['documentId','targetBranchId','expectedXmlSha256']);
    else exact(v.payload,['documentId','registeredAt','erpReference','expectedErpReference']);
    const frame=new B2bOwnerReadFrame(this.identity,a.kind);
    const current=async()=>{const p=await frame.principal(a.token,['b2b:received:write']);receivedAnchor(p,scope);return p;};
    const p=await current();
    const scopes=[scope];
    if(action==='ASSIGN'){
      if(!b2bUuid(v.payload.targetBranchId)||v.payload.targetBranchId===scope.branchId||typeof v.payload.expectedXmlSha256!=='string'||!/^[a-f0-9]{64}$/.test(v.payload.expectedXmlSha256))receivedFail(409,'RECEIVED_ASSIGNMENT_CONFLICT');
      const target={...scope,branchId:v.payload.targetBranchId};receivedAnchor(p,target);scopes.push(target);
    }
    const decisions=async()=>{
      const approved=[];
      for(const s of scopes){
        const d=detached(await this.authority.authorize(p,s,action));exact(d,['policyId','revision']);
        if(!b2bUuid(d.policyId)||!Number.isSafeInteger(d.revision)||d.revision<1||d.revision>2147483647)receivedFail(403,'RECEIVED_ACCESS_DENIED');
        approved.push(d);
      }return approved;
    };
    const approved=await decisions(),stamp=digest(approved);
    const recheck=async()=>{await current();if(digest(await decisions())!==stamp)receivedFail(403,'RECEIVED_ACCESS_DENIED');};
    const key=digest({scope,kind:p.kind,clientId:p.clientId,subjectId:p.subjectId,key:v.key}),requestHash=digest({action,scope,payload:v.payload});
    for(let attempt=0;;attempt++){
      try{
        const result=await this.db.$transaction(async tx=>{
          await tx.$queryRawUnsafe('SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended($1,0))',key);
          await recheck();
          const prior=await tx.$queryRawUnsafe<any[]>('SELECT "requestHash","result" FROM "B2bReceivedCommand" WHERE "key"=$1',key);
          if(prior.length){if(prior[0].requestHash!==requestHash)receivedFail(409,'IDEMPOTENCY_CONFLICT');await recheck();return detached(prior[0].result);}
          const outcome=await this.apply(tx,scope,action,v.payload);
          await recheck();
          if(await tx.$executeRawUnsafe(`INSERT INTO "B2bReceivedCommand" ("key","requestHash","clientId","subjectId","actorKind","scope","action","result","clientRevision","userAuthRevision","authority") VALUES($1,$2,$3::uuid,$4::uuid,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$11::jsonb)`,
            key,requestHash,p.clientId,p.subjectId,p.kind,JSON.stringify(scope),action,JSON.stringify(outcome),p.revision,p.userAuthRevision,JSON.stringify(scopes.map((s,i)=>({scope:s,...approved[i]}))))!==1)receivedFail(503,'RECEIVED_OWNER_UNAVAILABLE');
          await recheck();return outcome;
        },{isolationLevel:'Serializable',timeout:30000,maxWait:3000});
        await recheck();return result;
      }catch(e){if(attempt>=2||!retryable(e))throw e;await recheck();}
    }
  }
  private async document(tx:ReceivedSql,s:ReceivedScope,id:unknown){
    if(!b2bUuid(id))receivedFail();const rows=await tx.$queryRawUnsafe<any[]>(`SELECT "id","projection","xmlSha256","registeredAt","erpReference" FROM "ReceivedDocument" WHERE "id"=$1::uuid AND "companyId"=$2 AND "recipientRuc"=$3 AND "branchId"=$4::uuid FOR UPDATE`,id,s.companyId,s.recipientRuc,s.branchId);
    if(rows.length!==1)receivedFail(404,'RESOURCE_NOT_FOUND');return rows[0];
  }
  private async apply(tx:ReceivedSql,s:ReceivedScope,action:ReceptionWriteAction,b:any){
    if(action==='IMPORT'){
      const file=upload(b);if(!/\.xml$/i.test(file.fileName))receivedFail();const x=parseReceivedXml(file.bytes);
      if(x.recipient.identityType!=='6'||x.recipient.identityNumber!==s.recipientRuc||x.supplier.identityType!=='6'||!/^\d{11}$/.test(x.supplier.identityNumber??'')||x.series.length>4||x.number.length>8)receivedFail(409,'RECEIVED_XML_CONTEXT_MISMATCH');
      const existing=await tx.$queryRawUnsafe<any[]>(`SELECT "id","xmlSha256","companyId","branchId" FROM "ReceivedDocument" WHERE "recipientRuc"=$1 AND "supplierRuc"=$2 AND "documentType"=$3 AND "series"=$4 AND "number"=$5 FOR UPDATE`,s.recipientRuc,x.supplier.identityNumber,x.documentType,x.series,BigInt(x.number).toString());
      if(existing.length){const a=existing[0];if(a.companyId!==s.companyId||a.branchId!==s.branchId||a.xmlSha256!==x.xmlSha256)receivedFail(409,'RECEIVED_ORIGINAL_CONFLICT');return {documentId:a.id,outcome:'DUPLICATE',fiscalAcceptance:'NOT_VERIFIED'};}
      const id=randomUUID();
      await tx.$executeRawUnsafe(`INSERT INTO "ReceivedDocument" ("id","companyId","recipientRuc","branchId","supplierRuc","supplierName","documentType","fullNumber","series","number","issueDate","currencyCode","payableAmount","projection","xmlSha256") VALUES($1::uuid,$2,$3,$4::uuid,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14::jsonb,$15)`,
        id,s.companyId,s.recipientRuc,s.branchId,x.supplier.identityNumber,x.supplier.legalName,x.documentType,x.fullNumber,x.series,BigInt(x.number).toString(),x.issueDate,x.currencyCode,x.totals.payableAmount,JSON.stringify(x),x.xmlSha256);
      for(const [ordinal,item]of x.items.entries())await tx.$executeRawUnsafe(`INSERT INTO "ReceivedItemRecord" ("id","documentId","ordinal","supplierCode","sunatCode","description","quantity","unitCode","unitValue","unitPrice","amount","detail") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,randomUUID(),id,ordinal,item.supplierCode,item.sunatCode,item.description,item.quantity,item.unitCode,item.unitValue,item.unitPrice,item.lineExtensionAmount,JSON.stringify(item));
      await this.artifact(tx,id,'XML',file);return {documentId:id,outcome:'IMPORTED',fiscalAcceptance:'NOT_VERIFIED'};
    }
    if(action==='ATTACH'){
      if(!['CDR','PROVIDER_PDF'].includes(b.kind))receivedFail();
      const d=await this.document(tx,s,b.documentId),file=upload(b.file);
      if(b.kind==='CDR'){
        if(!/\.xml$/i.test(file.fileName))receivedFail();
        try{validateReceivedCdr(file.bytes,d.projection);}catch(e){if(e instanceof ReceivedCoreError)receivedFail(409,'RECEIVED_CDR_MISMATCH');throw e;}
      }else if(!/\.pdf$/i.test(file.fileName)||file.bytes.subarray(0,5).toString()!=='%PDF-')receivedFail();
      await this.artifact(tx,d.id,b.kind,file);return {documentId:d.id,outcome:'ATTACHED',fiscalAcceptance:'NOT_VERIFIED'};
    }
    if(action==='ASSIGN'){
      const d=await this.document(tx,s,b.documentId);
      if(d.xmlSha256!==b.expectedXmlSha256)receivedFail(409,'RECEIVED_ASSIGNMENT_CONFLICT');
      await tx.$executeRawUnsafe('UPDATE "ReceivedDocument" SET "branchId"=$2::uuid WHERE "id"=$1::uuid',d.id,b.targetBranchId);
      return {documentId:d.id,outcome:'ASSIGNED',branchId:b.targetBranchId,fiscalAcceptance:'NOT_VERIFIED'};
    }
    if(!reference(b.expectedErpReference)||!reference(b.erpReference)||b.registeredAt!==null&&!instant(b.registeredAt))receivedFail(409,'RECEIVED_REGISTRATION_CONFLICT');
    const d=await this.document(tx,s,b.documentId);
    if(d.erpReference!==b.expectedErpReference)receivedFail(409,'RECEIVED_REGISTRATION_CONFLICT');
    // The row lock and explicit SQL predicate both enforce the CAS.
    if(await tx.$executeRawUnsafe('UPDATE "ReceivedDocument" SET "registeredAt"=$2::timestamp,"erpReference"=$3 WHERE "id"=$1::uuid AND "erpReference" IS NOT DISTINCT FROM $4::text',d.id,b.registeredAt,b.erpReference,b.expectedErpReference)!==1)receivedFail(409,'RECEIVED_REGISTRATION_CONFLICT');
    return {documentId:d.id,outcome:'REGISTERED',fiscalAcceptance:'NOT_VERIFIED'};
  }
  private async artifact(tx:ReceivedSql,id:string,kind:string,file:{fileName:string;bytes:Buffer}){
    await tx.$executeRawUnsafe(`INSERT INTO "ReceivedArtifact" ("id","documentId","kind","fileName","sha256","byteLength","bytes") VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT ("documentId","kind","sha256") DO NOTHING`,randomUUID(),id,kind,file.fileName,sha(file.bytes),file.bytes.length,file.bytes);
  }
}



