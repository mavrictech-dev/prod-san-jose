import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {createCorporateEmailDeliveries,type CorporateEmailOptions} from '../services/mailer-worker/src/b2b/email-deliveries.corporate';
import {emailHash} from '../services/mailer-worker/src/b2b/email-deliveries';
import {B2bSecurityError} from '../services/mailer-worker/src/b2b/email-deliveries.security';
import type {B2bBinding,B2bPrincipal,EmailDeliveryEvent,EmailDeliveryJob,EmailDeliveryStore,EmailDeliveryTransaction} from '../services/mailer-worker/src/b2b/email-deliveries.types';
import type {CorporateSmtpConfiguration} from '../services/mailer-worker/src/smtp-configuration.policy';

/** Transactional persisted fixture; no DB, SMTP listener, env, certificates or real owner credentials. */
export class CorporateStore implements EmailDeliveryStore {
  disk={jobs:[] as EmailDeliveryJob[],events:[] as EmailDeliveryEvent[]};
  failAudit=false; private tail:Promise<unknown>=Promise.resolve();
  transaction<T>(_locks:readonly string[],work:(tx:EmailDeliveryTransaction)=>Promise<T>):Promise<T> {
    const run=this.tail.then(async()=>{
      const data=structuredClone(this.disk);
      const result=await work({
        job:async id=>structuredClone(data.jobs.find(j=>j.id===id)??null),
        prior:async(a,k)=>structuredClone(data.jobs.find(j=>j.actorKey===a&&j.keyHash===k)??null),
        insert:async j=>{if(data.jobs.some(x=>x.id===j.id||x.actorKey===j.actorKey&&x.keyHash===j.keyHash))throw Error('DUPLICATE');data.jobs.push(structuredClone(j));},
        save:async(j,r)=>{const index=data.jobs.findIndex(x=>x.id===j.id&&x.revision===r);
          if(index<0)throw new B2bSecurityError(409,'EMAIL_REVISION_CONFLICT');data.jobs[index]=structuredClone(j);},
        append:async e=>{if(this.failAudit)throw new B2bSecurityError(503,'EMAIL_STORE_UNAVAILABLE');data.events.push(structuredClone(e));},
      });
      this.disk=JSON.parse(JSON.stringify(data));return result;
    });this.tail=run.catch(()=>{});return run;
  }
  async close(){await this.tail;}
}
export function corporateEmailFixture<S extends EmailDeliveryStore=CorporateStore>(options:CorporateEmailOptions & {profile?:'CORPORATE'|'NONE'}={
  enabled:true,realSendEnabled:true,profile:'CORPORATE',approvedHosts:['smtp.corporate.example.org'],
}, suppliedStore?:S) {
  const binding:B2bBinding={issuerId:1,issuerRuc:'20000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
  const documentId=randomUUID(),p:B2bPrincipal={kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,
    scopes:['b2b:email:send','b2b:email:read','b2b:documents:read','b2b:artifacts:read'],bindings:[binding],environment:'BETA'};
  const configuration:CorporateSmtpConfiguration={host:'smtp.corporate.example.org',port:587,tlsMode:'STARTTLS',
    fromName:'Synthetic issuer',fromAddress:'sender@example.invalid',replyTo:'reply@example.invalid',username:'synthetic-user',password:'fictional-password'};
  const row={companyId:1,ruc:binding.issuerRuc,revision:1,keyVersion:1,configurationCipher:'v1.1.synthetic.ciphertext.one',updatedAt:new Date(0)};
  const grant={allowed:true as const,grantId:randomUUID(),grantRevision:1};
  const originals=[{id:'XML',kind:'XML' as const,fileName:'original.xml',mediaType:'application/xml' as const,bytes:Buffer.from('<SyntheticOriginal/>')},
    {id:'CDR',kind:'CDR' as const,fileName:'original.zip',mediaType:'application/zip' as const,bytes:Buffer.from('PK-fictional-cdr')}];
  const proof={binding,documentId,sourceProofSha256:emailHash('synthetic-owner-proof'),presentationRevision:'pdf-v1',
    originals:originals.map(({bytes,...o})=>({...o,sha256:emailHash(bytes),byteLength:bytes.length}))};
  const artifacts={authorizeDocumentCurrent:vi.fn(async()=>structuredClone(proof)),
    currentPdf:vi.fn(async()=>({bytes:Buffer.from('%PDF-1.7 synthetic'),presentationRevision:proof.presentationRevision})),
    readOriginal:vi.fn(async(_proof:unknown,id:string)=>Buffer.from(originals.find(o=>o.id===id)!.bytes))};
  const permission={authorizeRealSendCurrent:vi.fn(async()=>structuredClone(grant) as typeof grant|null)};
  const configurations={read:vi.fn(async()=>structuredClone(row) as typeof row|null)};
  const buffers:Buffer[]=[];
  const vault={open:vi.fn(()=>{const b=Buffer.from(JSON.stringify(configuration));buffers.push(b);return b;})};
  const sendMail=vi.fn(async(message:any)=>({messageId:message.messageId,accepted:[message.to],rejected:[] as string[],response:'250 2.0.0 queued'}));
  const mailer={sendMail,close:vi.fn()},network={resolve:vi.fn(async()=>['8.8.8.8']),createTransport:vi.fn(()=>mailer)};
  const store=(suppliedStore??new CorporateStore()) as S,identity={authenticate:vi.fn(async()=>structuredClone(p))},execution={freshIdentity:vi.fn(async()=>structuredClone(p))};
  const owner={permission,configurations,vault},input={binding,documentId,recipient:'recipient@example.invalid',format:'a4' as const,idempotencyKey:randomUUID()};
  const assemble=(storeOverride:EmailDeliveryStore=store)=>createCorporateEmailDeliveries({store:storeOverride,identity,artifacts,execution,owner,network,options});
  const app=assemble();
  const create=(q=input)=>app.engine.execute({token:'synthetic-token',kind:p.kind},'CREATE',q);
  return {app,assemble,create,p,binding,documentId,input,proof,originals,configuration,row,grant,permission,configurations,vault,buffers,
    store,identity,execution,artifacts,network,mailer,sendMail,owner};
}

