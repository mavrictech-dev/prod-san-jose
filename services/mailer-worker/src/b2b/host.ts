import type {MailerHostFactoryContext} from './main';
import type {MailerHostPorts} from './runtime';
import type {EmailDeliveryPgPool} from './email-deliveries.store';
import {createMountedMailerDocumentSource} from './host-document-source-files';
import {createMailerSmtpOwnerResource,loadMailerSmtpOwnerMount} from './host-smtp';
/** Builtin, enumerated composition. No customer-written plugin or discovery of
 * application secrets; loading does not issue tokens, query PG or send SMTP. */
export async function createBuiltinMailerHostPorts(root:string,pool:EmailDeliveryPgPool,clients:MailerHostFactoryContext):Promise<MailerHostPorts>{
 const emailSource=createMountedMailerDocumentSource(root,clients.config.identityOrigin,clients.identityHttp,clients.billingHttp);
 let smtpOwner:MailerHostPorts['smtpOwner'];
 try{
  if(clients.config.smtpAdministration){
   const mount=loadMailerSmtpOwnerMount(root);
   try{smtpOwner=createMailerSmtpOwnerResource({pool,key:mount.key,keyVersion:mount.keyVersion,approvedHosts:mount.approvedHosts,
    database:clients.config.database,billingHttp:clients.billingHttp});}finally{mount.close();}
  }
  return {emailSource,smtpOwner};
 }catch{emailSource.close();await smtpOwner?.close();throw Error('B2B_MAILER_BUILTIN_HOST_CONFIGURATION_INVALID');}
}
