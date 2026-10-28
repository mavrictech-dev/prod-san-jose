import { Inject, Injectable } from '@nestjs/common';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import type { ProductionBatchesAcceptance } from '@factuez/contracts/production-batches';
import { ProductionBatchesAuthenticator } from '@factuez/sunat-core/dist/production-batches-proof';
import { PRODUCTION_BATCHES_OWNER_AUTH, ProductionBatchesEvidencePort } from '../application/production-batches-owner.service';
@Injectable()
export class ProductionBatchesEvidenceClient extends ProductionBatchesEvidencePort {
 constructor(@Inject(PRODUCTION_BATCHES_OWNER_AUTH) private readonly auth:ProductionBatchesAuthenticator){super();}
 private async call<T>(action:string,snapshot:FiscalDocumentSnapshot,authorization:string,extra:Record<string,string>={}):Promise<T>{
  const body={action,snapshot,...extra},base=process.env.SUNAT_INTERNAL_URL??'http://sunat-service:3003';
  const r=await fetch(base+'/api/v1/setup/sunat/'+snapshot.companyId+'/PRODUCTION/batches/owner',{
   method:'POST',headers:{Authorization:authorization,'Content-Type':'application/json','X-Factuez-Batches-Owner':Buffer.from(JSON.stringify(this.auth.sign(body))).toString('base64url')},
   body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!r.ok)throw Error('Admisión propietaria de lote pendiente');
  return await r.json() as T;
 }
 accepted(snapshot:FiscalDocumentSnapshot,authorization:string){return this.call<ProductionBatchesAcceptance>('accepted',snapshot,authorization);}
 async reservePending(snapshot:FiscalDocumentSnapshot,token:string,authorization:string){await this.call('pending',snapshot,authorization,{token});}
 async assertCorrectionAvailable(snapshot:FiscalDocumentSnapshot,authorization:string){await this.call('available',snapshot,authorization);}
 reserveIdentifier(snapshot:FiscalDocumentSnapshot,kind:'RC'|'RA',batchId:string,issueDate:string,authorization:string){return this.call<{identifier:string}>('number',snapshot,authorization,{kind,batchId,issueDate}).then(v=>v.identifier);}
}
