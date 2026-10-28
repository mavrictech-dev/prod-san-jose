import {vi} from 'vitest';
import {createHash} from 'node:crypto';
import {parseReceivedXml} from '../../packages/received-core/src/index';
import {B2bSecurityError,type B2bPrincipal} from '../../packages/contracts/src/b2b-security';
import {receivedSubject} from '../../packages/service-access/src/b2b-received-wire';
import {B2bReceptionReads} from '../../services/received-documents-service/src/b2b/read';
import {receptionGrantKey,type ReceivedReadStore,type ReceptionGrant} from '../../services/received-documents-service/src/b2b/store';
import {B2bReceivedReads} from '../../services/b2b-api-service/src/received';
import {receivedXml,receivedCdr} from '../received-fixture.mjs';
export const receivedId=(n:number)=>`fea80000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export const receivedHash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
/** Purely fictitious originals/Identity/policy admin/store; real parser, owner,
 * explicit grants and public facade. PostgreSQL is covered by a separate runner. */
export function b2bReceivedFixture(){
  const scope={environment:'BETA' as const,companyId:1,recipientRuc:'00000000101',branchId:receivedId(1)};
  const token='synthetic-received-b2b-token',principal:B2bPrincipal={kind:'SERVICE',clientId:receivedId(2),revision:1,subjectId:null,userAuthRevision:null,
    environment:'BETA',scopes:['b2b:received:read','b2b:received:artifacts:read'],bindings:[{issuerId:scope.companyId,issuerRuc:scope.recipientRuc,environment:'BETA',branchId:scope.branchId,pointId:receivedId(3),seriesId:receivedId(4),documentType:'01'}]};
  const xml=Buffer.from(receivedXml()),p=parseReceivedXml(xml),id=receivedId(5);
  const row={id,companyId:scope.companyId,recipientRuc:scope.recipientRuc,branchId:scope.branchId,supplierRuc:p.supplier.identityNumber!,supplierName:p.supplier.legalName,
    documentType:p.documentType,fullNumber:p.fullNumber,issueDate:new Date(p.issueDate),currencyCode:p.currencyCode,payableAmount:p.totals.payableAmount,
    projection:p,xmlSha256:p.xmlSha256,receivedAt:new Date('2026-10-23T12:00:00Z'),registeredAt:null,erpReference:null};
  const artifact=(n:number,kind:string,fileName:string,bytes:Buffer)=>({id:receivedId(n),kind,fileName,bytes,sha256:receivedHash(bytes),byteLength:bytes.length});
  const originals=[artifact(6,'XML','original.xml',xml),artifact(7,'CDR','R-original.xml',Buffer.from(receivedCdr())),artifact(8,'PROVIDER_PDF','Factura San José.pdf',Buffer.from('%PDF-1.4 FICTICIO'))];
  const state={rows:[row],originals,grants:new Map<string,ReceptionGrant>(),audits:[] as any[]};
  const control={revoked:false,failAudit:false,foreignRow:false};
  const identity={authenticate:vi.fn(async(_token:string,required:string[],kind:'SERVICE'|'USER')=>{
    if(control.revoked||kind!==principal.kind||required.some(s=>!principal.scopes.includes(s as any)))throw new B2bSecurityError(403,'DENIED');return structuredClone(principal);
  })};
  const store:ReceivedReadStore={transaction:async(work)=>{
    const grants=structuredClone(state.grants),audits=structuredClone(state.audits);
    const response=await work({
      grant:async(who,s,permission)=>{const g=grants.get(receptionGrantKey(s,receivedSubject(who),permission));
        if(!g?.active||g.clientRevision!==who.revision||g.userAuthRevision!==who.userAuthRevision)throw new B2bSecurityError(403,'GRANT_REQUIRED');return structuredClone(g);},
      list:async q=>state.rows.filter(r=>control.foreignRow||r.companyId===q.scope.companyId&&r.recipientRuc===q.scope.recipientRuc&&r.branchId===q.scope.branchId&&r.issueDate.toISOString().slice(0,10)>=q.from&&r.issueDate.toISOString().slice(0,10)<=q.to&&(!q.after||r.id>q.after)).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,q.limit+1).map(r=>structuredClone(r)),
      document:async(s,key)=>{const r=state.rows.find(r=>r.id===key&&r.companyId===s.companyId&&r.recipientRuc===s.recipientRuc&&r.branchId===s.branchId);return r?structuredClone(r):null;},
      artifacts:async()=>state.originals.map(({bytes,...r})=>structuredClone(r)),
      artifact:async(_s,_key,key)=>{const a=state.originals.find(a=>a.id===key);return a?{...a,bytes:Buffer.from(a.bytes)}:null;},
      audit:async(p,s,action,id,artifactId)=>{if(control.failAudit)throw new Error('PRIVATE_AUDIT_SECRET');audits.push({subject:receivedSubject(p),scope:s,action,id,artifactId});},
      policy:async key=>grants.get(key)??null,
      savePolicy:async(key,value,expected)=>{if((grants.get(key)?.revision??0)!==expected)throw new B2bSecurityError(409,'CONFLICT');grants.set(key,structuredClone(value));},
    });state.grants=grants;state.audits=audits;return response;
  }};
  const admin={authorize:vi.fn(async(_handle:string,policySha256:string)=>({adminId:receivedId(90),authRevision:1,policySha256}))};
  const owner=new B2bReceptionReads(store,identity,admin);
  const port={execute:vi.fn((t:string,k:'SERVICE'|'USER',a:any,args:any)=>owner.execute({token:t,kind:k},a,args)),
    content:vi.fn((t:string,k:'SERVICE'|'USER',args:any)=>owner.execute({token:t,kind:k},'CONTENT',args) as Promise<any>)};
  const facade=new B2bReceivedReads(identity,port),query={scope,from:'2026-01-01',to:'2026-01-02',limit:25};
  const grant=(permission:'READ'|'ARTIFACT',active=true,expected=0)=>owner.setGrant('synthetic-owner-stepup',{
    scope,subject:receivedSubject(principal),permission,clientRevision:principal.revision,userAuthRevision:principal.userAuthRevision,active},expected);
  return {scope,token,principal,id,xml,p,row,state,control,identity,store,admin,owner,port,facade,query,grant};
}
