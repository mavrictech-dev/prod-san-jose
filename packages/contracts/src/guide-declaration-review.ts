import { summarizeGuideFuelProfile, type GuideOperationalSettings } from './guide-operational-settings';

export type GuideReviewedCatalogue = {
 goods: {code:string;description:string;unitCode:string;classification?:string;family?:string}[];
 routes: {origin:unknown;destination:unknown}[];
};
/** Maps declarations to the existing reviewed catalogue; never creates catalogue rows or grants. */
export function reviewGuideDeclarations(settings:GuideOperationalSettings,catalogue:GuideReviewedCatalogue|null){
 const fuel=summarizeGuideFuelProfile(settings),blockers=[...fuel.blockers];
 if(settings.products.some(p=>p.type==='OTHER_REGULATED'))blockers.push('Otros bienes fiscalizados requieren revisión externa; no se habilitan como mercancía general.');
 if(!catalogue)blockers.push('Catálogo nativo revisado pendiente; las declaraciones no autorizan emisión.');
 const products=settings.products.map(p=>{
  const family=settings.fuelProfile?.products.find(f=>f.productId===p.id)?.family;
  const match=catalogue?.goods.find(g=>g.code===p.commercialCode&&g.description===p.name&&g.unitCode===p.unit&&
   (p.type==='FUEL'?g.classification==='HYDROCARBON'&&g.family===family:p.type==='GENERAL'&&g.classification==='NON_REGULATED'));
  if(!match)blockers.push(`${p.name}: código, nombre, unidad o familia no coinciden exactamente con el catálogo revisado.`);
  return {productId:p.id,matched:!!match};
 });
 const samePlace=(a:unknown,b:unknown)=>{
  const x=a as Record<string,unknown>,y=b as Record<string,unknown>;
  return !!x&&!!y&&x.ubigeo===y.ubigeo&&x.address===y.address&&x.establishmentCode===y.establishmentCode;
 };
 const routes=settings.routes.map(r=>{
  const matched=!!catalogue?.routes.some(c=>samePlace(c.origin,r.origin)&&samePlace(c.destination,r.destination));
  if(!matched)blockers.push(`${r.name}: partida y llegada no coinciden con el catálogo revisado; conserve direcciones, ubigeos y establecimientos exactos.`);
  return {routeId:r.id,matched};
 });
 return {status:blockers.length?'REVIEW_PENDING' as const:'MATCHED_REVIEWED_CATALOGUE' as const,blockers,products,routes,
  profiles:fuel.profiles,fiscalTransmission:false as const};
}
