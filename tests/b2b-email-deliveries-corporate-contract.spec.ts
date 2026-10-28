import {randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {email} from '../packages/b2b-sdk/src/operations-extra-validation';
import {B2bEmailDeliveryOperations,HttpEmailDeliveryOwner} from '../services/b2b-api-service/src/email-deliveries';
import type {B2bPrincipal,B2bBinding} from '../services/mailer-worker/src/b2b/email-deliveries.types';
const binding:B2bBinding={issuerId:1,issuerRuc:'20000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
const principal:B2bPrincipal={kind:'SERVICE',clientId:randomUUID(),revision:1,subjectId:null,userAuthRevision:null,
  scopes:['b2b:email:send','b2b:email:read','b2b:documents:read','b2b:artifacts:read'],bindings:[binding],environment:'BETA'};
const access={token:'synthetic-contract-token',kind:'SERVICE' as const};
const base={schemaVersion:'factuez.b2b.email-deliveries.v1',environment:'BETA',candidateOnly:true,id:randomUUID(),documentId:randomUUID(),
  binding,format:'a4',revision:1,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',
  attachments:[{kind:'PDF',fileName:'synthetic.pdf',mediaType:'application/pdf',sha256:'a'.repeat(64),byteLength:100,
    representation:'CURRENT_GENERATED',sourceProofSha256:'b'.repeat(64)}],deliveredToClient:false,fiscalAuthority:false,replayed:false};
const identity={authenticate:async()=>structuredClone(principal)};
const validateFacade=(value:unknown)=>new B2bEmailDeliveryOperations(identity,{execute:async()=>structuredClone(value)}).execute(access,'READ',{id:base.id});
const allowed=new Set([
  ['NONE','QUEUED',null],['NONE','WAITING_ARTIFACTS','ARTIFACTS_PENDING'],
  ['LOCAL_CAPTURE','QUEUED',null],['LOCAL_CAPTURE','WAITING_ARTIFACTS','ARTIFACTS_PENDING'],['LOCAL_CAPTURE','DISPATCHING',null],
  ['LOCAL_CAPTURE','CAPTURED_LOCAL',null],['LOCAL_CAPTURE','UNKNOWN','CAPTURE_OUTCOME_UNKNOWN'],
  ['CORPORATE','QUEUED',null],['CORPORATE','WAITING_ARTIFACTS','ARTIFACTS_PENDING'],['CORPORATE','DISPATCHING',null],
  ['CORPORATE','SMTP_ACCEPTED',null],['CORPORATE','UNKNOWN','SMTP_OUTCOME_UNKNOWN'],
].map(v=>JSON.stringify(v)));
const combinations=['NONE','LOCAL_CAPTURE','CORPORATE'].flatMap(profile=>
  ['QUEUED','WAITING_ARTIFACTS','DISPATCHING','CAPTURED_LOCAL','SMTP_ACCEPTED','UNKNOWN'].flatMap(state=>
    [null,'ARTIFACTS_PENDING','CAPTURE_OUTCOME_UNKNOWN','SMTP_OUTCOME_UNKNOWN'].map(errorCode=>({profile,state,errorCode}))));

describe('email API/SDK coherent profile-state-code contract',()=>{
  it.each(combinations)('$profile / $state / $errorCode',async outcome=>{
    const value={...structuredClone(base),...outcome},valid=allowed.has(JSON.stringify([outcome.profile,outcome.state,outcome.errorCode]));
    if(valid){expect(email(value,{id:base.id})).toMatchObject(outcome);expect(await validateFacade(value)).toMatchObject(outcome);}
    else{expect(()=>email(value,{id:base.id})).toThrow();await expect(validateFacade(value)).rejects.toMatchObject({code:'INVALID_EMAIL_OWNER_RESPONSE'});}
  });
  it.each(['NONE','LOCAL_CAPTURE','CORPORATE'])('never treats %s as proof of delivery',async profile=>{
    const value={...structuredClone(base),profile,state:profile==='CORPORATE'?'SMTP_ACCEPTED':profile==='LOCAL_CAPTURE'?'CAPTURED_LOCAL':'QUEUED',errorCode:null,deliveredToClient:true};
    expect(()=>email(value,{id:base.id})).toThrow();await expect(validateFacade(value)).rejects.toMatchObject({code:'INVALID_EMAIL_OWNER_RESPONSE'});
  });
  it.each([{profile:'__proto__',state:'QUEUED',errorCode:null},{profile:'CORPORATE',state:'DELIVERED',errorCode:null},
    {profile:'CORPORATE',state:'UNKNOWN',errorCode:'private-secret'},{profile:null,state:'QUEUED',errorCode:null}])('rejects unknown vocabulary %j',async outcome=>{
    const value={...structuredClone(base),...outcome};expect(()=>email(value,{id:base.id})).toThrow();
    await expect(validateFacade(value)).rejects.toMatchObject({code:'INVALID_EMAIL_OWNER_RESPONSE'});
  });
  it.each([{code:'ACCESS_CHANGED',status:401},{code:'INVALID_PRINCIPAL',status:401},{code:'EMAIL_REAL_SEND_FORBIDDEN',status:403},
    {code:'EMAIL_SMTP_CONFIGURATION_CHANGED',status:409}])('passes through safe owner denial $code/$status',async error=>{
    const adapter=new HttpEmailDeliveryOwner({post:async()=>({error})} as any);
    await expect(adapter.execute(access,'READ',{id:base.id})).rejects.toMatchObject(error);
  });
  it.each([{code:'private password and recipient',status:401},{code:'ACCESS_CHANGED',status:503},{code:'__proto__',status:401}])('redacts unknown or mismatched owner denial %j',async error=>{
    const adapter=new HttpEmailDeliveryOwner({post:async()=>({error})} as any);
    await expect(adapter.execute(access,'READ',{id:base.id})).rejects.toMatchObject({status:error.status,code:'EMAIL_OWNER_REQUEST_DENIED'});
  });
});
