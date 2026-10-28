import type {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import type {PrismaService} from '../infrastructure/prisma.service';
import type {ContextIdentity} from './context';
import {BillingB2bGuideAuthorization} from './guide-authorization';
import {PrismaGuideDraftCatalogue} from './guide-catalogue';
import {PostgresB2bGuideStore} from './guide-store';
import {B2bGuides} from './guide-drafts';
import {BillingGuidePreparation,PrismaGuidePreparationIssuer} from './guide-preparation';
import {GuideEstablishments,type EstablishmentAdminAuthority} from './guide-establishments';
import {PostgresGuideEstablishmentStore} from './guide-establishment-store';
import {GuideGoods} from './guide-goods';
import {PostgresGuideGoodsStore} from './guide-goods-store';
/** Explicit draft-only composition. Never registers a fiscal producer, reads
 * credentials, migrates a database or attaches the laboratory tables. */
export function createBillingGuideDrafts(db:PrismaService,identity:ContextIdentity,authority:Pick<B2bPrivateHttp,'post'>,now=()=>new Date().toISOString()){
  return new B2bGuides(new PostgresB2bGuideStore(db),new BillingB2bGuideAuthorization(identity,authority),new PrismaGuideDraftCatalogue(db),now);
}
/** Optional preparation module; the caller must explicitly install its HTTP
 * module. Construction does not query/migrate a DB or enable fiscal transport. */
export function createBillingGuidePreparation(db:PrismaService,guides:B2bGuides){
  return new BillingGuidePreparation(guides,new PrismaGuidePreparationIssuer(db));
}
/** Explicit privileged local registry composition. No schema deployment or
 * inferred human administrator. Caller supplies its authenticated admin port. */
export function createBillingGuideEstablishments(db:PrismaService,admin:EstablishmentAdminAuthority,now=()=>new Date().toISOString()){
  return new GuideEstablishments(new PostgresGuideEstablishmentStore(db),admin,now);
}
/** Strict mode refuses missing/stale/local mismatched establishment maps. The
 * previous advisory factory stays unchanged; neither factory activates SUNAT. */
export function createBillingMappedGuidePreparation(db:PrismaService,guides:B2bGuides,registry:GuideEstablishments){
  return new BillingGuidePreparation(guides,new PrismaGuidePreparationIssuer(db),registry);
}
/** Scoped privileged configuration only; no default catalogue or classifications. */
export function createBillingGuideGoods(db:PrismaService,admin:EstablishmentAdminAuthority,now=()=>new Date().toISOString()){
  return new GuideGoods(new PostgresGuideGoodsStore(db),admin,now);
}
/** Both local controls are mandatory in this explicit composition. No fallback
 * to advisory preparation, official-rule approval or fiscal activation. */
export function createBillingCataloguedGuidePreparation(db:PrismaService,guides:B2bGuides,registry:GuideEstablishments,goods:GuideGoods){
  if(!registry||typeof registry.assertLocalMapping!=='function'||!goods||typeof goods.assertLocalGoods!=='function')throw new Error('Explicit local guide controls required');
  return new BillingGuidePreparation(guides,new PrismaGuidePreparationIssuer(db),registry,goods);
}
