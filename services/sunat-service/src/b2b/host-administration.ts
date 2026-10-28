import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {HttpB2bOwnerAdministration,HttpB2bOwnerBinding} from '@factuez/service-access/dist/b2b-owner-administration';
export function createSunatHostAdministration(authorityHttp:Pick<B2bPrivateHttp,'post'>,billingHttp:Pick<B2bPrivateHttp,'post'>){
 const authority=new HttpB2bOwnerAdministration(authorityHttp,'fiscal');
 return {authority,liveIdentity:authority,bindingOwner:new HttpB2bOwnerBinding(billingHttp),assertInfrastructure:async()=>{await authority.readiness();}};
}
