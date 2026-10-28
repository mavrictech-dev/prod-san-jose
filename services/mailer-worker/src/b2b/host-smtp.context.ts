import {validB2bBinding,type B2bBinding} from '@factuez/contracts/b2b-security';
import {Phase8AdminCapabilities,Phase8AdminOperation,adminDenied,adminSnapshot,type Phase8AdminContextRequest,type Phase8AdminContextResolver,type Phase8AdminOwnerContext} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
/** Optional host-only enrichment. Neither the shared capabilities contract nor
 * legacy owners change. Only this opener associates the REAL op with its handle. */
const resolvers=new WeakMap<Phase8AdminCapabilities,MailerSmtpCapabilityResolver>();
class MailerSmtpCapabilityResolver implements Phase8AdminContextResolver {
 #caps:Phase8AdminCapabilities;#bindings=new WeakMap<object,B2bBinding>();
 constructor(caps:Phase8AdminCapabilities){this.#caps=caps;}
 open(operation:Phase8AdminOperation){
  if(!(operation instanceof Phase8AdminOperation)||!['SMTP_READ','SMTP_SAVE'].includes(operation.action)||!validB2bBinding(operation.input.binding)||operation.input.binding.environment!=='BETA')
   return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
  const binding=adminSnapshot(operation.input.binding),handle=this.#caps.open(operation);
  this.#bindings.set(handle,binding);return handle;
 }
 revoke(handle:object){this.#bindings.delete(handle);this.#caps.revoke(handle);}
 async resolve(handle:object,request:Phase8AdminContextRequest):Promise<Phase8AdminOwnerContext & {currentIssuerB2bOwnerBinding:B2bBinding}>{
  const binding=this.#bindings.get(handle);
  if(!binding)return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
  // Uses the same legacy capability validation, including payload/action/current human.
  const context=await this.#caps.resolve(handle,request);
  if(this.#bindings.get(handle)!==binding||context.environment!=='BETA'||context.issuer.companyId!==binding.issuerId||context.issuer.ruc!==binding.issuerRuc)
   return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
  return {...context,currentIssuerB2bOwnerBinding:adminSnapshot(binding)};
 }
}
/** Explicit opt-in only from the concrete host resource createOwner(caps). */
export function mailerSmtpOwnerContextResolver(caps:Phase8AdminCapabilities):Phase8AdminContextResolver{
 if(!(caps instanceof Phase8AdminCapabilities))return adminDenied(403,'INVALID_ADMIN_CAPABILITY');
 let resolver=resolvers.get(caps);if(!resolver){resolver=new MailerSmtpCapabilityResolver(caps);resolvers.set(caps,resolver);}return resolver;
}
/** Called by B2bPhase8SmtpAdmin only after Phase8AdminOperation.open succeeds. */
export function openMailerSmtpOwnerCapability(caps:Phase8AdminCapabilities,operation:Phase8AdminOperation):object{
 return resolvers.get(caps)?.open(operation)??caps.open(operation);
}
export function revokeMailerSmtpOwnerCapability(caps:Phase8AdminCapabilities,handle:object):void{
 const resolver=resolvers.get(caps);if(resolver)resolver.revoke(handle);else caps.revoke(handle);
}
