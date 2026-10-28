import {createHash} from 'node:crypto';
import {parseReceivedXml,validateReceivedCdr,unpackReceivedFiles} from '@factuez/received-core';
import {B2bSecurityError,type B2bPrincipal} from '@factuez/contracts/b2b-security';
import {b2bUuid} from '@factuez/contracts/b2b-read-query';
import {B2bOwnerReadFrame,type B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import {correctionEvidenceFreeze,correctionEvidenceHash as hash} from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import {receivedScope,receivedSelection,receivedAnchor,receivedSubject,receivedRow,receivedArtifacts,receivedDetail,receivedFile,receivedFail,
  type ReceivedScope,type ReceivedAction,type ReceivedSubject} from '@factuez/service-access/dist/b2b-received-wire';
import {receptionGrantKey,type ReceptionGrant,type ReceivedReadStore,type ReceivedReadTransaction} from './store';
const sha=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
type Access={token:string;kind:'SERVICE'|'USER'};
export interface ReceptionGrantAdministrator {
  /** Trusted live owner-side step-up. Must bind exact policy digest and reject
   * missing/expired/revoked/non-admin proof; no caller accepted/admin booleans. */
  authorize(opaqueHandle:string,policySha256:string):Promise<{adminId:string;authRevision:number;policySha256:string}>;
}
function row(record:any,scope:ReceivedScope){
  const day=record.issueDate instanceof Date?record.issueDate.toISOString().slice(0,10):String(record.issueDate).slice(0,10);
  const at=(v:any)=>v instanceof Date?v.toISOString():v;
  const p=record.projection;
  if(!p||p.xmlSha256!==record.xmlSha256||p.recipient?.identityType!=='6'||p.recipient?.identityNumber!==scope.recipientRuc||
    p.supplier?.identityNumber!==record.supplierRuc||p.supplier?.legalName!==record.supplierName||p.documentType!==record.documentType||
    p.fullNumber!==record.fullNumber||p.issueDate!==day||p.currencyCode!==record.currencyCode||p.totals?.payableAmount!==record.payableAmount)
    receivedFail(409,'RECEIVED_PROJECTION_CHANGED');
  return receivedRow({id:record.id,companyId:record.companyId,recipientRuc:record.recipientRuc,branchId:record.branchId,
    supplierRuc:record.supplierRuc,supplierName:record.supplierName,documentType:record.documentType,fullNumber:record.fullNumber,
    issueDate:day,currencyCode:record.currencyCode,payableAmount:record.payableAmount,receivedAt:at(record.receivedAt),
    itemCount:record.projection?.items?.length,sunatStatus:'NOT_CHECKED',lastVerifiedAt:null,registeredAt:at(record.registeredAt),
    erpReference:record.erpReference,warnings:record.projection?.warnings},scope);
}
function metadata(records:any[]){return receivedArtifacts(records.map(r=>({id:r.id,kind:r.kind,fileName:r.fileName,
  mediaType:/\.pdf$/i.test(r.fileName)?'application/pdf':/\.zip$/i.test(r.fileName)?'application/zip':'application/xml',
  sha256:r.sha256,byteLength:r.byteLength,representation:'PROVIDER_ORIGINAL',signatureTrust:'NOT_VERIFIED'})));}
/** Independent incoming-document owner. Never forges AccessTokenClaims, passes
 * SERVICE as a human, reads Billing/Identity SQL, or calls the PWA controllers. */
export class B2bReceptionReads{
  constructor(private readonly store:ReceivedReadStore,private readonly identity:B2bIdentityPort,
    private readonly admin:ReceptionGrantAdministrator|null=null){}
  private async frame(access:Access,scope:ReceivedScope,artifact:boolean){
    if(!access||!['SERVICE','USER'].includes(access.kind)||typeof access.token!=='string'||!/^[A-Za-z0-9._~-]{1,8192}$/.test(access.token))receivedFail(401,'INVALID_TOKEN');
    const frame=new B2bOwnerReadFrame(this.identity,access.kind),required=artifact?['b2b:received:read','b2b:received:artifacts:read'] as const:['b2b:received:read'] as const;
    const current=async()=>{const p=await frame.principal(access.token,[...required]);receivedAnchor(p,scope);return p;};
    return {principal:await current(),current};
  }
  private async grants(tx:ReceivedReadTransaction,p:B2bPrincipal,s:ReceivedScope,artifact:boolean){
    const read=await tx.grant(p,s,'READ');const extra=artifact?await tx.grant(p,s,'ARTIFACT'):null;return hash({read,extra});
  }
  async execute(access:Access,action:ReceivedAction,input:unknown){
    if(!['LIST','DETAIL','ARTIFACTS','CONTENT'].includes(action))receivedFail();
    const args:any=correctionEvidenceFreeze(input),scope=receivedScope(args?.scope);
    if(action!=='LIST'){
      const keys=action==='CONTENT'?['scope','id','artifactId']:['scope','id'];
      if(Object.keys(args).sort().join(',')!==keys.sort().join(',')||!b2bUuid(args.id)||action==='CONTENT'&&!b2bUuid(args.artifactId))receivedFail();
    }
    const query=action==='LIST'?receivedSelection(args):null,download=action==='ARTIFACTS'||action==='CONTENT';
    const f=await this.frame(access,scope,download);
    const result=await this.store.transaction(async tx=>{
      const before=await this.grants(tx,f.principal,scope,download);let result:unknown;
      if(query){
        const records=await tx.list(query);if(records.length>query.limit+1)receivedFail(413,'NARROW_QUERY');
        const items=records.slice(0,query.limit).map(r=>row(r,scope));
        if(items.some(r=>r.issueDate<query.from||r.issueDate>query.to||query.type&&r.documentType!==query.type||query.after&&r.id<=query.after)||
          items.some((r,i)=>i>0&&r.id<=items[i-1].id))receivedFail(409,'INCONSISTENT_RECEIVED_SOURCE');
        result={schemaVersion:'factuez.b2b.received-page.v1',scope,items,page:{limit:query.limit,hasMore:records.length>query.limit,
          nextAfter:records.length>query.limit?items.at(-1)!.id:null,consistency:'LIVE_KEYSET_NOT_SNAPSHOT'},fiscalAcceptance:'NOT_VERIFIED',source:'RECEIVED_XML'};
      }else{
        const record=await tx.document(scope,args.id);if(!record)receivedFail(404,'RESOURCE_NOT_FOUND');
        const document=row(record,scope),artifacts=metadata(await tx.artifacts(scope,args.id));
        const original=artifacts.filter(a=>a.kind==='XML'&&a.sha256===record.xmlSha256);
        if(original.length!==1)receivedFail(409,'RECEIVED_ORIGINAL_MISSING');
        const xml=await tx.artifact(scope,args.id,original[0].id);if(!xml||!(xml.bytes instanceof Uint8Array))receivedFail(409,'RECEIVED_ORIGINAL_MISSING');
        const bytes=Buffer.from(xml.bytes);receivedFile({bytes,sha256:xml.sha256,fileName:xml.fileName,mediaType:'application/xml'},original[0]);
        const projection=parseReceivedXml(bytes);
        if(hash(projection)!==hash(record.projection))receivedFail(409,'RECEIVED_PROJECTION_CHANGED');
        const detail=receivedDetail({schemaVersion:'factuez.b2b.received-detail.v1',scope,document,projection,artifacts,fiscalAcceptance:'NOT_VERIFIED',source:'RECEIVED_XML'},scope,args.id);
        if(action==='DETAIL')result=detail;
        else if(action==='ARTIFACTS')result={schemaVersion:'factuez.b2b.received-artifacts.v1',scope,documentId:args.id,items:detail.artifacts,fiscalAcceptance:'NOT_VERIFIED'};
        else{
          const a=artifacts.find(a=>a.id===args.artifactId);if(!a)receivedFail(404,'RESOURCE_NOT_FOUND');
          const raw=await tx.artifact(scope,args.id,a.id);if(!raw||!(raw.bytes instanceof Uint8Array))receivedFail(404,'RESOURCE_NOT_FOUND');
          const file=receivedFile({bytes:Buffer.from(raw.bytes),sha256:raw.sha256,fileName:raw.fileName,mediaType:a.mediaType},a);
          if(a.kind==='CDR'){
            const files=/\.zip$/i.test(a.fileName)?unpackReceivedFiles([{fileName:a.fileName,bytes:file.bytes}]):[{bytes:file.bytes,kind:'CDR'}];
            if(files.length!==1||files[0].kind!=='CDR')receivedFail(409,'RECEIVED_CDR_MISMATCH');validateReceivedCdr(files[0].bytes,projection);
          }
          if(a.kind==='PROVIDER_PDF'&&file.bytes.subarray(0,5).toString()!=='%PDF-')receivedFail(409,'RECEIVED_INTEGRITY_FAILED');
          result=file;
        }
      }
      if(hash({read:await tx.grant(f.principal,scope,'READ'),extra:download?await tx.grant(f.principal,scope,'ARTIFACT'):null})!==before)receivedFail(401,'ACCESS_CHANGED');
      await tx.audit(f.principal,scope,action,args.id??null,args.artifactId??null);await f.current();return result;
    });
    await f.current();return result;
  }
  /** Private owner administration only; there is intentionally no public grant
   * mutation route in this delivery. UI/delegated enrollment follows separately. */
  async setGrant(handle:string,input:unknown,expectedRevision:number){
    if(!this.admin)receivedFail(503,'RECEIVED_STEP_UP_NOT_CONFIGURED');
    const v:any=correctionEvidenceFreeze(input),scope=receivedScope(v?.scope),who=v?.subject as ReceivedSubject;
    if(!v||Object.keys(v).sort().join(',')!=='active,clientRevision,permission,scope,subject,userAuthRevision'||!who||Object.keys(who).sort().join(',')!=='clientId,kind,subjectId'||
      !b2bUuid(who.clientId)||!['SERVICE','USER'].includes(who.kind)||who.kind==='SERVICE'&&(who.subjectId!==null||v.userAuthRevision!==null)||
      who.kind==='USER'&&(!b2bUuid(who.subjectId)||!Number.isSafeInteger(v.userAuthRevision)||v.userAuthRevision<0||v.userAuthRevision>2147483647)||!['READ','ARTIFACT'].includes(v.permission)||
      typeof v.active!=='boolean'||!Number.isSafeInteger(v.clientRevision)||v.clientRevision<1||v.clientRevision>2147483647||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=2147483647)receivedFail();
    const digest=hash({policy:v,expectedRevision}),admin=this.admin!,authorize=async()=>{
      const p=await admin.authorize(handle,digest);
      if(!p||!b2bUuid(p.adminId)||p.policySha256!==digest||!Number.isSafeInteger(p.authRevision)||p.authRevision<0)receivedFail(403,'STEP_UP_REQUIRED');return p;
    };
    const first=await authorize(),key=receptionGrantKey(scope,who,v.permission),policy:ReceptionGrant={...v,scope,revision:expectedRevision+1};
    return this.store.transaction(async tx=>{
      const before=await tx.policy(key);if((before?.revision??0)!==expectedRevision)receivedFail(409,'RECEIVED_POLICY_CONFLICT');
      if(hash(await authorize())!==hash(first))receivedFail(403,'STEP_UP_CHANGED');
      await tx.savePolicy(key,policy,expectedRevision,first.adminId);
      if(hash(await authorize())!==hash(first))receivedFail(403,'STEP_UP_CHANGED');return {revision:policy.revision,active:policy.active};
    });
  }
}
