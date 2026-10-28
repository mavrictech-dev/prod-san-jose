import {inspect} from 'node:util';
import {b2bBindingsContain,validB2bBinding,validB2bPrincipal} from './email-deliveries.security';
import {emailHash,emailSameActor,emailUuid} from './email-deliveries';
import type {CorporateEmailSendPermission} from './email-deliveries.corporate';
import type {B2bBinding,B2bPrincipal,EmailDeliveryActor,EmailDeliveryCorporateRequest,EmailDeliveryDocument} from './email-deliveries.types';
export type CorporateEmailSendGrant={id:string;revision:number;active:boolean;actor:EmailDeliveryActor;binding:B2bBinding;
 recipients:readonly string[];allowAnyRecipient:boolean;expiresAt:string};
/** TI-owned immutable deployment grants, separate from SMTP configuration and
 * token scopes. Revocation uses current Identity or replacement with a higher
 * grant revision; queued jobs cannot reuse the older authorization snapshot. */
export class FixedCorporateEmailSendPermission implements CorporateEmailSendPermission{
 #grants:CorporateEmailSendGrant[];
 constructor(input:readonly CorporateEmailSendGrant[]){
  if(!Array.isArray(input)||!input.length||input.length>100)throw new Error('EXPLICIT_CORPORATE_SEND_GRANTS_REQUIRED');
  const grants=structuredClone([...input]),keys=new Set<string>();
  for(const g of grants){
   if(!g||!emailUuid(g.id)||!Number.isSafeInteger(g.revision)||g.revision<1||typeof g.active!=='boolean'||!validB2bBinding(g.binding)||!g.actor||!emailUuid(g.actor.clientId)||
    !Number.isSafeInteger(g.actor.revision)||g.actor.revision<1||(g.actor.kind==='SERVICE'?(g.actor.subjectId!==null||g.actor.userAuthRevision!==null):g.actor.kind!=='USER'||!emailUuid(g.actor.subjectId)||!Number.isSafeInteger(g.actor.userAuthRevision)||Number(g.actor.userAuthRevision)<0)||
    !Array.isArray(g.recipients)||g.recipients.length>1000||new Set(g.recipients).size!==g.recipients.length||g.recipients.some((r:string)=>typeof r!=='string'||r.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r))||typeof g.allowAnyRecipient!=='boolean'||
    !g.allowAnyRecipient&&!g.recipients.length||typeof g.expiresAt!=='string'||!Number.isFinite(Date.parse(g.expiresAt))||new Date(g.expiresAt).toISOString()!==g.expiresAt)throw new Error('INVALID_CORPORATE_SEND_GRANT');
   const key=emailHash(JSON.stringify([g.actor,g.binding]));if(keys.has(key))throw new Error('DUPLICATE_CORPORATE_SEND_GRANT');keys.add(key);
  }
  this.#grants=grants;
 }
 async authorizeRealSendCurrent(p:B2bPrincipal,r:EmailDeliveryCorporateRequest,d:EmailDeliveryDocument){
  if(!validB2bPrincipal(p)||!['b2b:email:send','b2b:documents:read','b2b:artifacts:read'].every(s=>p.scopes.includes(s as any))||!b2bBindingsContain(p.bindings,r.binding)||d.documentId!==r.documentId||!b2bBindingsContain([d.binding],r.binding))return null;
  const g=this.#grants.find(g=>g.active&&emailSameActor(p,g.actor)&&b2bBindingsContain([g.binding],r.binding)&&Date.parse(g.expiresAt)>Date.now()&&(g.allowAnyRecipient||g.recipients.includes(r.recipient)));
  return g?{allowed:true as const,grantId:g.id,grantRevision:g.revision}:null;
 }
 toJSON(){return {policy:'CorporateEmailSend',configured:true};}
 [inspect.custom](){return 'FixedCorporateEmailSendPermission { grants: [PRIVATE] }';}
}
