import type {HydrocarbonApproval,HydrocarbonPurchaseCargo,PurchaseFuelFamily} from '@factuez/contracts/production-guides';
type Good={code:string;description:string;unitCode:string;family?:string};
/** Catalogue review metadata stays on the server; the fiscal body is closed. */
export function guideFormItems(approved:readonly Good[]|undefined,selection:readonly {code:string;quantity:string}[]){
 if(!selection.length||selection.length>100||new Set(selection.map(i=>i.code)).size!==selection.length)throw Error('Seleccione entre 1 y 100 bienes únicos');
 return selection.map(row=>{
  const good=approved?.find(candidate=>candidate.code===row.code);
  if(!good||!/^\d{1,12}(\.\d{1,6})?$/.test(row.quantity)||Number(row.quantity)<=0)throw Error('Seleccione bienes y cantidades mayores que cero');
  return {code:good.code,description:good.description,unitCode:good.unitCode,quantity:row.quantity};
 });
}
/** Build purchase metadata from explicit reviewed approvals and SCOP per product.
 * The backend still revalidates the complete catalogue hash and live grants. */
export function guidePurchaseCargo(approved:readonly Good[]|undefined,selection:readonly {code:string;scopCode?:string;approvalIndex?:string}[],approvals:readonly HydrocarbonApproval[],context:{branchId:string;supplier:{ruc:string;legalName:string};vehiclePlate:string;originUbigeo:string;destinationUbigeo:string}):HydrocarbonPurchaseCargo{
 let common:{senderRegistration:string;vehicleAuthorization:string}|undefined;
 const items=selection.map(row=>{
  const good=approved?.find(g=>g.code===row.code),a=row.approvalIndex!==undefined&&row.approvalIndex!==''?approvals[Number(row.approvalIndex)]:undefined;
  if(!good||!['DIESEL','GASOHOL_REGULAR','GASOHOL_PREMIUM'].includes(good.family??'')||!['GLL','LTR'].includes(good.unitCode))throw Error('Compra privada sólo admite diésel/gasoholes en GLL o LTR revisadas; no se convierte BJ');
  if(!a||a.profile!=='GRE09_HYDROCARBON_PRIVATE02_V1'||a.family!==good.family||a.branchId!==context.branchId||a.supplier.ruc!==context.supplier.ruc||a.supplier.legalName!==context.supplier.legalName||a.vehiclePlate!==context.vehiclePlate||a.routeUbigeos[0]!==context.originUbigeo||a.routeUbigeos.at(-1)!==context.destinationUbigeo||Date.parse(a.validUntil)<=Date.now()||a.geography!=='OUTSIDE_SPECIAL_ZONE'||!a.scopRequired||!a.vehicleAuthorization)throw Error('Seleccione una habilitación Compra vigente para cada familia, proveedor, sede, ruta y vehículo');
  if(common&&(common.senderRegistration!==a.senderRegistration||common.vehicleAuthorization!==a.vehicleAuthorization))throw Error('Las habilitaciones de todas las familias deben usar los mismos registros del remitente y vehículo');
  common={senderRegistration:a.senderRegistration,vehicleAuthorization:a.vehicleAuthorization};
  if(!row.scopCode||!/^(?!0{11}$)[0-9]{11}$/.test(row.scopCode))throw Error('Declare el SCOP de 11 dígitos de cada producto sin reutilizarlo automáticamente');
  return {code:row.code,family:good.family as PurchaseFuelFamily,scopCode:row.scopCode};
 });
 if(!common||new Set(items.map(i=>i.code)).size!==items.length)throw Error('Complete productos únicos y sus habilitaciones');
 return {schemaVersion:'factuez.gre-hydrocarbon.v2',items,handoverDate:null,carrierRegistration:null,...common};
}
