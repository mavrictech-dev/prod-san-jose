import type {GuideReferenceCatalogue} from '@factuez/sunat-core/dist/fiscal-guide-catalogues';
import type {B2bGuideBinding} from '@factuez/contracts/b2b-guide-security';
import type {GuideBody} from './guide-model';
import type {EstablishmentCompany,EstablishmentAdminAuthority,EstablishmentContext} from './guide-establishments';

/** Metadata of the shared product master. There is deliberately no invented
 * companyId on FuelProduct. Eligibility is explicitly scoped by the policy. */
export type GuideGoodsProduct={id:string;sku:string;description:string;category:string;unitCode:string;
  sunatProductCode:string|null;active:boolean;updatedAt:string};
export type GuideGoodsEntry={productId:string;productSha256:string;
  classification:'NON_REGULATED'|'REGULATED'|'UNKNOWN';rationale:string};
export type GuideGoodsSnapshot={schemaVersion:'factuez.guide-goods-policy.v1';companyId:number;
  issuerRuc:string;issuerRevision:number;revision:number;catalogue:GuideReferenceCatalogue;
  entries:GuideGoodsEntry[];actorId:string;authRevision:number;at:string;
  source:'ADMIN_LOCAL_CONFIGURATION';sha256:string};
export type GuideGoodsAudit={id:string;requestId:string;peerSha256:string;companyId:number;
  revision:number;actorId:string;action:'READ'|'REPLACE';at:string};
export interface GuideGoodsTransaction{
  company(id:number):Promise<EstablishmentCompany|null>;
  products(ids:string[]):Promise<GuideGoodsProduct[]>;
  head(companyId:number):Promise<GuideGoodsSnapshot|null>;
  save(snapshot:GuideGoodsSnapshot,expectedRevision:number):Promise<void>;
  audit(value:GuideGoodsAudit):Promise<void>;
}
export interface GuideGoodsStore{
  transaction<T>(companyId:number,work:(tx:GuideGoodsTransaction)=>Promise<T>):Promise<T>;
  rate(keySha256:string,window:number,limit:number):Promise<boolean>;
}
export interface GuideGoodsGuard{
  assertLocalGoods(binding:B2bGuideBinding,body:GuideBody):Promise<{fresh():Promise<void>}>;
}
export type GuideGoodsAuthority=EstablishmentAdminAuthority;
export type GuideGoodsContext=EstablishmentContext;
