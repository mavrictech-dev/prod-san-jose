import {fuelSnapshot,fuelCatalogue} from './production-guides-hydrocarbon.fixture';
import {hydrocarbonRouteHash} from '../packages/sunat-core/src/production-guides';
import type {ProductionGuidesCatalogue} from '../services/sunat-service/src/production-guides-crypto';
import type {HydrocarbonPurchaseApproval} from '../packages/contracts/src/production-guides';
export function purchaseSnapshot(){
 const s=fuelSnapshot(),b=s.body as any;s.profile='GRE09_HYDROCARBON_PRIVATE02_V1';
 b.reasonCode='02';b.supplier={ruc:'20000000028',legalName:'PROVEEDOR SINTETICO'};
 b.origin={ubigeo:'150101',address:'ALMACEN DEL PROVEEDOR SINTETICO',establishmentCode:'0001'};
 b.destination={ubigeo:'150102',address:'ALMACEN DEL COMPRADOR SINTETICO',establishmentCode:s.scope.establishmentCode};
 b.items=['DIESEL','GASOHOL_REGULAR','GASOHOL_PREMIUM'].map((family,i)=>({code:'PURCHASE-'+(i+1),description:'COMBUSTIBLE SINTETICO '+family,quantity:String(10+i),unitCode:'GLL'}));
 b.hydrocarbon={schemaVersion:'factuez.gre-hydrocarbon.v2',items:['DIESEL','GASOHOL_REGULAR','GASOHOL_PREMIUM'].map((family,i)=>({code:b.items[i].code,family,scopCode:i===0?'10000000001':'10000000002'})),handoverDate:null,senderRegistration:'RH-SYNTHETIC',carrierRegistration:null,vehicleAuthorization:'RH-VEHICLE'};return s;
}
export function purchaseCatalogue(s=purchaseSnapshot()):ProductionGuidesCatalogue{
 const c=fuelCatalogue(),b=s.body as any,h=b.hydrocarbon,template=c.hydrocarbonApprovals![0];
 return {...c,issuerRuc:s.issuer.ruc,companyId:s.scope.companyId,units:['GLL','LTR'],ubigeos:[b.origin.ubigeo,b.destination.ubigeo],goods:b.items.map((i:any)=>({...Object.fromEntries(['code','description','unitCode'].map(k=>[k,i[k]])),classification:'HYDROCARBON',family:h.items.find((r:any)=>r.code===i.code).family})) as any,routes:[{origin:b.origin,destination:b.destination}],vehicles:[b.transport.vehicle],drivers:[b.transport.driver],hydrocarbonApprovals:h.items.map((i:any)=>({...template,profile:s.profile,branchId:s.scope.branchId,family:i.family,supplier:structuredClone(b.supplier),routeSha256:hydrocarbonRouteHash(b)} as HydrocarbonPurchaseApproval))};
}
