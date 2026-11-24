import {snapshot09,snapshotPublic09} from './production-guides.fixture';
import {HYDROCARBON_RULES,hydrocarbonRouteHash} from '../packages/sunat-core/src/production-guides';
import type {ProductionGuidesCatalogue} from '../services/sunat-service/src/production-guides-crypto';
import type {HydrocarbonFamily,HydrocarbonApproval} from '../packages/contracts/src/production-guides';
export function fuelSnapshot(family:HydrocarbonFamily='DIESEL',priv=true){
 const s=priv?snapshot09():snapshotPublic09(),b=s.body as any;
 s.profile=priv?'GRE09_HYDROCARBON_PRIVATE04_V1':'GRE09_HYDROCARBON_PUBLIC01_V1';
 if(priv)b.transport.vehicle.registration='REG000001';
 b.regulatedGoods=true;b.items=[{code:'FUEL-1',description:family,quantity:'10',unitCode:family==='GLP'?'KGM':'GLL'}];
 b.hydrocarbon={schemaVersion:'factuez.gre-hydrocarbon.v1',family,handoverDate:priv?null:b.transferDate,scopCode:'12345678901',senderRegistration:'RH-SYNTHETIC',carrierRegistration:priv?null:'RH-CARRIER',vehicleAuthorization:priv?'RH-VEHICLE':null};return s;
}
export function fuelCatalogue(s=fuelSnapshot()):ProductionGuidesCatalogue{
 const b=s.body as any,h=b.hydrocarbon,priv=s.profile.includes('PRIVATE');
 const approval:HydrocarbonApproval={branchId:s.scope.branchId,profile:s.profile as any,family:h.family,routeSha256:hydrocarbonRouteHash(b),routeUbigeos:[b.origin.ubigeo,b.destination.ubigeo],geography:'OUTSIDE_SPECIAL_ZONE',documentRegime:'ORDINARY_GRE',senderRegistration:h.senderRegistration,carrierRuc:priv?null:b.carrier.ruc,carrierLegalName:priv?null:b.carrier.legalName,mtcRegistration:priv?null:b.mtcRegistration,carrierRegistration:h.carrierRegistration,vehiclePlate:priv?b.transport.vehicle.plate:null,vehicleAuthorization:h.vehicleAuthorization,scopRequired:true,sourceUrl:'https://www.osinergmin.gob.pe/empresas/hidrocarburos/Paginas/RegistroHidrocarburos/RegistrosHidrocarburos.htm',sourceSha256:'a'.repeat(64),validUntil:'2026-12-31T23:59:59-05:00'};
 return {version:'factuez.production-guides.catalogue.v1',companyId:s.scope.companyId,issuerRuc:s.issuer.ruc,sourceUrl:HYDROCARBON_RULES.workbookUrl,sourceSha256:HYDROCARBON_RULES.workbookSha256,units:[b.items[0].unitCode],ubigeos:[b.origin.ubigeo,b.destination.ubigeo],goods:b.items.map((i:any)=>({code:i.code,description:i.description,unitCode:i.unitCode,classification:'HYDROCARBON',family:h.family})),routes:[{origin:b.origin,destination:b.destination}],vehicles:priv?[b.transport.vehicle]:[],drivers:priv?[b.transport.driver]:[],hydrocarbonApprovals:[approval],officialRules:HYDROCARBON_RULES};
}
