import {describe,it,expect} from 'vitest';import {inspect} from 'node:util';import {randomUUID} from 'node:crypto';
import {FixedCorporateEmailSendPermission,type CorporateEmailSendGrant} from '../services/mailer-worker/src/b2b/email-deliveries.corporate-policy';
import {corporateEmailFixture} from './b2b-email-deliveries-corporate.fixture';
function fixture(){const f=corporateEmailFixture(),policy:CorporateEmailSendGrant={id:randomUUID(),revision:1,active:true,
 actor:{kind:f.p.kind,clientId:f.p.clientId,subjectId:f.p.subjectId,revision:f.p.revision,userAuthRevision:f.p.userAuthRevision},binding:f.binding,
 recipients:[f.input.recipient],allowAnyRecipient:false,expiresAt:new Date(Date.now()+600000).toISOString()};return {f,policy};}
describe('separate corporate real-send deployment grants',()=>{
 it('does not infer permission from SMTP configuration, token scopes or an unlisted recipient',async()=>{
  const {f,policy}=fixture(),owner=new FixedCorporateEmailSendPermission([policy]);
  // The permission only reads the existing owner projection's identity/scope;
  // the transport independently verifies every attachment and current source proof.
  const document={binding:f.binding,documentId:f.input.documentId};
  expect(await owner.authorizeRealSendCurrent(f.p,f.input,document as any)).toMatchObject({allowed:true,grantId:policy.id,grantRevision:1});
  expect(await owner.authorizeRealSendCurrent(f.p,{...f.input,recipient:'unlisted@example.invalid'},document as any)).toBeNull();
  expect(JSON.stringify(owner)).not.toContain(f.input.recipient);expect(inspect(owner)).not.toContain(f.binding.issuerRuc);
 });
 it.each(['client','revision','branch','scope','expired','inactive'] as const)('rejects a changed %s even with an old queued send',async change=>{
  const {f,policy}=fixture();if(change==='expired')policy.expiresAt=new Date(Date.now()-1000).toISOString();if(change==='inactive')policy.active=false;
  const owner=new FixedCorporateEmailSendPermission([policy]);if(change==='client')f.p.clientId=randomUUID();if(change==='revision')f.p.revision++;
  if(change==='branch')f.input.binding={...f.binding,branchId:randomUUID()};if(change==='scope')f.p.scopes=f.p.scopes.filter(s=>s!=='b2b:email:send');
  expect(await owner.authorizeRealSendCurrent(f.p,f.input,{binding:f.binding,documentId:f.input.documentId} as any)).toBeNull();
 });
 it('requires a separate explicit allowAnyRecipient decision and snapshots the supplied configuration',async()=>{
  const {f,policy}=fixture(),owner=new FixedCorporateEmailSendPermission([policy]);policy.allowAnyRecipient=true;
  expect(await owner.authorizeRealSendCurrent(f.p,{...f.input,recipient:'another@example.invalid'},{binding:f.binding,documentId:f.input.documentId} as any)).toBeNull();
  const broad=new FixedCorporateEmailSendPermission([policy]);expect(await broad.authorizeRealSendCurrent(f.p,{...f.input,recipient:'another@example.invalid'},{binding:f.binding,documentId:f.input.documentId} as any)).toMatchObject({allowed:true});
 });
});
