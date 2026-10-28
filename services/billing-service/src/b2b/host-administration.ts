import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {HttpB2bOwnerAdministration} from '@factuez/service-access/dist/b2b-owner-administration';
/** These two required Billing ports now have a concrete implementation. The
 * caller supplies a dedicated owner-authority certificate, never its general
 * resource/facade certificate. Other Billing dependencies remain independent. */
export function createBillingHostAdministration(http:Pick<B2bPrivateHttp,'post'>){
 const authority=new HttpB2bOwnerAdministration(http,'billing');
 return {privilegedAdmin:{authority,liveIdentity:authority},assertAdministrationInfrastructure:async()=>{await authority.readiness();}};
}
