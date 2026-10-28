import {B2bEmailDeliveries, emailFail} from './email-deliveries';
import {NodemailerCorporateEmailTransport, type CorporateEmailDependencies, type CorporateEmailNetwork, type CorporateEmailOptions} from './email-deliveries.corporate';
import type {B2bIdentityPort} from '@factuez/service-access/dist/b2b-read-adapter';
import type {EmailDeliveryDocumentSource, EmailDeliveryExecutionAuthority, EmailDeliveryProfile, EmailDeliveryStore} from './email-deliveries.types';

/** Explicit, inert composition for a host-owned document source. The caller owns
 * the source lifecycle. This factory does not mount itself into the runtime. */
export function createCorporateEmailWithSource(input:{store:EmailDeliveryStore; identity:B2bIdentityPort;
 source:EmailDeliveryDocumentSource; execution:EmailDeliveryExecutionAuthority; owner:CorporateEmailDependencies;
 options?:CorporateEmailOptions & {profile?:EmailDeliveryProfile}; network?:CorporateEmailNetwork}) {
 const options=input.options??{}, profile=options.profile??'NONE';
 if(profile!=='NONE' && profile!=='CORPORATE') emailFail(400,'INVALID_REQUEST');
 if(!input.source || typeof input.source.authorizeDocumentCurrent!=='function') throw Error('B2B_MAILER_EMAIL_SOURCE_REQUIRED');
 const transport=profile==='CORPORATE'?new NodemailerCorporateEmailTransport(input.owner,options,input.network):null;
 const engine=new B2bEmailDeliveries(input.store,input.identity,input.source,transport,{enabled:options.enabled,profile});
 return {engine,run:(jobId:string)=>engine.run(jobId,input.execution)};
}