import {B2bSecurityError} from '@factuez/contracts/b2b-security';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import type {DeliveryAuthority} from './model';
export class HttpDeliveryAuthority implements DeliveryAuthority {
  constructor(private readonly http:B2bPrivateHttp){}
  async check(actor:Parameters<DeliveryAuthority['check']>[0],binding:Parameters<DeliveryAuthority['check']>[1]){
    const result=await this.http.post('/internal/b2b/authorize-webhook',{actor,binding});if(!result||Object.keys(result).join(',')!=='allowed'||typeof(result as any).allowed!=='boolean')throw new B2bSecurityError(503,'INVALID_IDENTITY_RESPONSE');return (result as any).allowed as boolean;
  }
}
