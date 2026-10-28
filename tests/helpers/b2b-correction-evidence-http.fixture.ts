import 'reflect-metadata';
import {vi} from 'vitest';
import {request} from 'node:https';
import type {AddressInfo} from 'node:net';
import {NestFactory} from '../../services/billing-service/node_modules/@nestjs/core';
import {B2bSecurityError} from '../../packages/contracts/src/b2b-security';
import {B2bPrivateHttp} from '../../packages/service-access/src/b2b';
import {correctionEvidenceHash} from '../../packages/service-access/src/b2b-correction-evidence-wire';
import {buildFiscalSupplementCommand} from '../../packages/sunat-core/src/fiscal-supplement-command';
import {fiscalSnapshotSha256,buildFiscalNoteSnapshot,buildFiscalNoteUbl} from '../../packages/sunat-core/src/fiscal-note';
import {BillingCorrectionEvidenceAuthority} from '../../services/billing-service/src/b2b/correction-evidence-authority';
import {BillingCorrectionEvidenceModule} from '../../services/billing-service/src/b2b/correction-evidence-http';
import {HttpBetaCorrectionEvidence} from '../../services/billing-service/src/b2b/correction-evidence-client';
import {B2bContextFilter} from '../../services/billing-service/src/b2b/http';
import {SunatCorrectionEvidence,HttpCorrectionEvidenceAuthority} from '../../services/sunat-service/src/b2b/correction-evidence';
import {SunatCorrectionEvidenceModule} from '../../services/sunat-service/src/b2b/correction-evidence-http';
import {BetaCorrectionEvidence} from '../../services/sunat-service/src/application/beta-correction-evidence';
import {BetaVerifiedSupplementOutcome} from '../../services/sunat-service/src/application/beta-verified-supplement-outcome';
import {documentEvidenceFixture,AS_OF} from './beta-document-evidence.fixture';
import {outcomeFixture,id,hash,zipSync,structuralSignature} from './beta-owner-summary.fixture';
import {b2bCertificates,fingerprint} from '../b2b-tls.fixture';

export {AS_OF};
export const TOKEN='synthetic-local-only-token';
/** Real loopback mTLS and owner capabilities. Authority and catalogue are
 * explicit test doubles, NOT SSO. XML verification ports are structural,
 * NOT official PKI. No database, customer certificate or external service. */
export async function correctionEvidenceHttpFixture(tls:ReturnType<typeof b2bCertificates>){
  const original=documentEvidenceFixture();
  original.record.completedAt='2026-10-02T16:30:00.000Z';
  original.setCdr(Buffer.from(original.cdr.toString().replace('<cbc:IssueDate>2026-10-03</cbc:IssueDate>','<cbc:IssueDate>2026-10-02</cbc:IssueDate>')));
  const originalProof=await original.run(),outcome=outcomeFixture('07');
  const envelope=outcome.command.payload.envelope;
  if(envelope.kind!=='NOTE')throw new Error('SYNTHETIC_NOTE_REQUIRED');
  envelope.context.acceptance=structuredClone(originalProof.evidence);
  envelope.note=buildFiscalNoteSnapshot(envelope.context,envelope.note.adjustment,{documentId:envelope.note.documentId,series:envelope.note.series,number:envelope.note.number,issueDate:envelope.note.issueDate});
  const command=buildFiscalSupplementCommand(envelope,{eventId:outcome.command.eventId,correlationId:outcome.command.correlationId,occurredAt:outcome.command.occurredAt});
  outcome.record.commandSha256=fiscalSnapshotSha256(command);
  const noteXml=Buffer.from(structuralSignature(buildFiscalNoteUbl(envelope.note,envelope.context)));
  const requestZip=Buffer.from(zipSync({[outcome.identity.fileName.replace(/\.zip$/,'.xml')]:noteXml}));
  Object.assign(outcome.record.signedXml,{sha256:hash(noteXml),sizeBytes:noteXml.length});
  Object.assign(outcome.record.requestZip,{sha256:hash(requestZip),sizeBytes:requestZip.length});
  outcome.owner.read.mockImplementation(async(_owner,a)=>Buffer.from(a.id===outcome.record.signedXml.id?noteXml:a.id===outcome.record.requestZip.id?requestZip:outcome.response));
  const binding={reference:{issuerId:original.doc.companyId,issuerRuc:original.doc.issuer.identityNumber,branchId:original.doc.branchId!,pointId:id(20),seriesId:id(21),documentType:'01' as const,environment:'BETA' as const},noteSeriesId:id(22),noteType:'07' as const};
  const actor={userId:null,scope:{kind:'ASSIGNED' as const,branchIds:[binding.reference.branchId],emissionPointIds:[binding.reference.pointId],series:[binding.reference.seriesId,binding.noteSeriesId]},
    b2b:{kind:'SERVICE' as const,clientId:id(70),revision:1,subjectId:null,userAuthRevision:null}};
  const state={revision:1,revoked:false,scopeChanged:false};
  const authority={current:vi.fn(async(token:string,kind:string,pair:unknown)=>{
    if(token!==TOKEN||state.revoked)throw new B2bSecurityError(401,'INVALID_TOKEN');
    if(kind!=='SERVICE'||correctionEvidenceHash(pair)!==correctionEvidenceHash(binding))throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');
    return{actor:structuredClone(actor),grantRevision:state.revision,clientRevision:1,candidateOnly:true as const,fiscalExecutionEnabled:false as const};
  })};
  const scope={inspect:vi.fn(async(value:any,_actor:unknown)=>{
    if(correctionEvidenceHash(value.binding)!==correctionEvidenceHash(binding))throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');
    const expected=value.action==='ORIGINAL'?original.doc:command;
    if(correctionEvidenceHash(value.payload)!==correctionEvidenceHash(expected))throw new B2bSecurityError(404,'CORRECTION_EVIDENCE_SCOPE_DENIED');
    return correctionEvidenceHash({binding,payload:value.payload,revision:state.scopeChanged?2:1});
  })};
  const clock=()=>AS_OF;
  const billingCore=new BillingCorrectionEvidenceAuthority(authority as never,scope,clock);
  const httpsOptions={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true};
  const billing=await NestFactory.create(BillingCorrectionEvidenceModule.isolated(billingCore,[fingerprint(tls.resource)]),{logger:false,bodyParser:false,httpsOptions});
  billing.useBodyParser('json',{limit:'2mb'});billing.useGlobalFilters(new B2bContextFilter());
  await billing.listen(0,'127.0.0.1');
  const billingPort=(billing.getHttpServer().address() as AddressInfo).port;
  const billingRpc=new B2bPrivateHttp(`https://127.0.0.1:${billingPort}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
  const callback=new HttpCorrectionEvidenceAuthority(billingRpc,clock);
  const acceptance={verify:vi.fn(async(snapshot:unknown,_asOf:string)=>{
    if(fiscalSnapshotSha256(snapshot)!==fiscalSnapshotSha256(original.doc))throw new Error('SYNTHETIC_OWNER_SCOPE');
    return original.run();
  })};
  const prerequisites=new BetaCorrectionEvidence(acceptance as never);
  // Both execute branches retain their actual owner seal checks.
  const outcomeCore=new BetaVerifiedSupplementOutcome(outcome.owner,outcome.signatures,outcome.cdrTrust);
  const owner={acceptance,prerequisites,outcomes:outcomeCore};
  const sunatCore=new SunatCorrectionEvidence(owner as never,callback,clock);
  const sunat=await NestFactory.create(SunatCorrectionEvidenceModule.isolated(sunatCore,[fingerprint(tls.edge)]),{logger:false,bodyParser:false,httpsOptions});
  sunat.useBodyParser('json',{limit:'2mb'});sunat.useGlobalFilters(new B2bContextFilter());
  await sunat.listen(0,'127.0.0.1');
  const sunatPort=(sunat.getHttpServer().address() as AddressInfo).port;
  const sunatRpc=new B2bPrivateHttp(`https://127.0.0.1:${sunatPort}`,{ca:tls.ca,cert:tls.edge,key:tls.key});
  const commands={load:vi.fn(async()=>structuredClone(command))};
  const client=new HttpBetaCorrectionEvidence(sunatRpc,async()=>TOKEN,'SERVICE',binding,commands,clock);
  // Fixture construction already inspected original bytes; assertions start here.
  original.ports.read.mockClear();original.ports.load.mockClear();
  const body=(action:'ORIGINAL'|'PREREQUISITES'|'OUTCOME'='ORIGINAL')=>({schemaVersion:'factuez.b2b.correction-evidence-request.v1',requestId:id(100),kind:'SERVICE',action,binding:structuredClone(binding),asOf:AS_OF,payload:structuredClone(action==='ORIGINAL'?original.doc:command)});
  async function send(target:'billing'|'sunat',path:string,value:unknown,options:{peer?:'edge'|'resource'|'other'|null;token?:string;trust?:boolean;method?:string;headers?:Record<string,string>}={}){
    const peer=options.peer===undefined?(target==='billing'?'resource':'edge'):options.peer;
    const bytes=value===undefined?undefined:JSON.stringify(value);
    return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port:target==='billing'?billingPort:sunatPort,path,method:options.method??'POST',rejectUnauthorized:true,timeout:10000,
        ...(options.trust===false?{}:{ca:tls.ca}),...(peer?{cert:tls[peer],key:tls.key}:{}),headers:{Authorization:'Bearer '+(options.token??TOKEN),
          ...(bytes?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(bytes)}:{}),...options.headers}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{
          try{resolve({status:res.statusCode!,headers:res.headers,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null});}catch(error){reject(error);}
        });
      });req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('SYNTHETIC_LOOPBACK_TIMEOUT')));req.end(bytes);
    });
  }
  return{original,outcome,outcomeCore,command,binding,actor,state,authority,scope,callback,acceptance,prerequisites,owner,client,billingRpc,sunatRpc,commands,body,send,
    close:async()=>{await sunat.close();await billing.close();},closeBilling:()=>billing.close()};
}
