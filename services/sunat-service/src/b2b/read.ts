import { createHash,randomUUID } from 'node:crypto';
import { B2bSecurityError,b2bBindingsContain,validB2bBinding,type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { b2bIssuerId,b2bQuery,b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame,type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { snapshotHash } from '@factuez/service-access/dist/integration';
import { SunatRead,type BillingOwner,type StoredArtifact,type SunatReadRepository } from '../integration/read';
import type { CurrentPdfService } from '../application/current-pdf.service';
import { OwnerChanges,type OwnerJournalReader } from '@factuez/service-access/dist/integration-owner-changes';
export interface B2bBillingPort {execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown):Promise<any>}
export class HttpB2bBillingPort implements B2bBillingPort {
  constructor(private readonly http:B2bPrivateHttp){}
  execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){return this.http.post('/internal/b2b/read',{kind,action,args},token);}
}
export interface B2bDownloadAudit {record(event:{id:string;principal:B2bPrincipal;issuerRuc:string;ownerId:string;artifactId:string|null;representation:'ORIGINAL'|'CURRENT_LOCAL';sha256:string;byteLength:number}):Promise<void>}
export class B2bSunatReads {
  constructor(private readonly repository:SunatReadRepository,private readonly identity:B2bIdentityPort,private readonly billing:B2bBillingPort,
    private readonly storage:{read(id:string,artifact:StoredArtifact):Promise<Buffer>},private readonly pdf:Pick<CurrentPdfService,'b2bDocument'>,
    private readonly audit:B2bDownloadAudit,private readonly journals:OwnerJournalReader|null=null){}
  async execute(token:string,kind:'SERVICE'|'USER',action:string,args:unknown){
    if(action==='extract:journal'||action==='extract:change-ready'){
      if(!this.journals)throw new B2bSecurityError(503,'CHANGE_FEED_NOT_READY');
      const changes=new OwnerChanges(this.journals,new B2bOwnerReadFrame(this.identity,kind));return action==='extract:journal'?changes.read(token,args):changes.ready(token,args);
    }
    const q=b2bQuery(args,action==='pdf'?['issuerId','environment','id','format']:['issuerId','environment','id'],action==='pdf'?['issuerId','environment','id','format']:['issuerId','environment','id']);
    if(!b2bUuid(q.id)||!['artifacts','batch-artifacts','content','pdf','batch'].includes(action))throw new B2bSecurityError(400,'INVALID_QUERY');
    const issuerId=b2bIssuerId(q.issuerId),frame=new B2bOwnerReadFrame(this.identity,kind);
    const p=await frame.principal(token,action==='batch'?['b2b:documents:read']:['b2b:documents:read','b2b:artifacts:read']);
    const selected=p.bindings.filter(binding=>binding.issuerId===issuerId);
    if(!selected.length||new Set(selected.map(binding=>binding.issuerRuc)).size!==1)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');
    const ruc=selected[0].issuerRuc;
    const owner:BillingOwner={
      document:async(t,r,id)=>{if(r!==ruc)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');return this.billing.execute(t,kind,'document',{issuerId:String(issuerId),environment:'BETA',id});},
      batch:async(t,r,id)=>{if(r!==ruc)throw new B2bSecurityError(404,'RESOURCE_NOT_FOUND');return this.billing.execute(t,kind,'batch',{issuerId:String(issuerId),environment:'BETA',id});},
    };
    const repository:SunatReadRepository={document:(r,id)=>this.repository.document(r,id),batch:(r,id)=>this.repository.batch(r,id),artifact:(r,id)=>this.repository.artifact(r,id),sharedCdr:(r,a,id)=>this.repository.sharedCdr(r,a,id),
      audit:async event=>{
        const principal=await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);
        const actual=await this.repository.artifact(ruc,event.artifactId);if(!actual)throw new B2bSecurityError(409,'ARTIFACT_UNAVAILABLE');
        await this.audit.record({id:randomUUID(),principal,issuerRuc:ruc,ownerId:actual.owner.id,artifactId:event.artifactId,representation:'ORIGINAL',sha256:event.sha256,byteLength:event.byteLength});
      }};
    const read=new SunatRead(repository,frame,owner,this.storage);
    if(action==='batch')return read.batch(token,ruc,q.id);
    if(action==='artifacts'||action==='batch-artifacts')return read.artifacts(token,ruc,q.id,action==='artifacts'?'DOCUMENT':'BATCH');
    if(action==='content')return read.content(token,ruc,q.id);
    if(!['a4','ticket'].includes(q.format))throw new B2bSecurityError(400,'INVALID_FORMAT');
    const supplied=await this.billing.execute(token,kind,'print-snapshot',{issuerId:String(issuerId),environment:'BETA',id:q.id});
    if(!validB2bBinding(supplied?.context)||!b2bBindingsContain(p.bindings,supplied.context)||supplied.document?.id!==q.id||supplied.snapshot?.documentId!==q.id)throw new B2bSecurityError(409,'EVIDENCE_INCONSISTENT');
    const row=await this.repository.document(ruc,q.id);
    if(!row||row.environment!=='BETA'||row.documentId!==q.id||row.issuerRuc!==ruc||row.documentType!==supplied.document.type||row.series!==supplied.document.series||!/^\d{1,18}$/.test(supplied.document.number)||row.number!==BigInt(supplied.document.number)||snapshotHash(row.immutablePayload)!==supplied.snapshotSha256||snapshotHash(supplied.snapshot)!==supplied.snapshotSha256)throw new B2bSecurityError(409,'EVIDENCE_INCONSISTENT');
    // Only the existing local preparation path is representable without verified fiscal proof.
    if(!('status' in row)||!['QUEUED','BUILDING'].includes(String(row.status)))throw new B2bSecurityError(409,'FISCAL_PDF_PROFILE_NOT_AVAILABLE');
    const bytes=await this.pdf.b2bDocument(supplied.snapshot,q.format as 'a4'|'ticket',supplied.presentation,{companyId:issuerId,branchId:supplied.context.branchId});
    if(!bytes.length||bytes.length>10*1024*1024)throw new B2bSecurityError(413,'REPRESENTATION_TOO_LARGE');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    await frame.principal(token,['b2b:documents:read','b2b:artifacts:read']);
    const fresh=await this.repository.document(ruc,q.id);if(!fresh||snapshotHash(fresh.immutablePayload)!==supplied.snapshotSha256||!('status' in fresh)||!['QUEUED','BUILDING'].includes(String(fresh.status)))throw new B2bSecurityError(409,'EVIDENCE_INCONSISTENT');
    await this.audit.record({id:randomUUID(),principal:p,issuerRuc:ruc,ownerId:q.id,artifactId:null,representation:'CURRENT_LOCAL',sha256,byteLength:bytes.length});
    return {bytes,sha256,fileName:`${ruc}-${row.documentType}-${row.series}-${row.number}-${q.format}-CURRENT-PRUEBA.pdf`,mediaType:'application/pdf'};
  }
}
