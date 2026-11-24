import type { HydrocarbonCargo, HydrocarbonApproval } from '@factuez/contracts/production-guides';
import { fiscalRuc, fiscalSnapshotSha256 } from './fiscal-note';

export const HYDROCARBON_RULES = Object.freeze({
 version:'SUNAT-GRE-20261106-XSL-2.0.1-20261001',
 workbookUrl:'https://cpe.sunat.gob.pe/sites/default/files/2026-11/ValidacionesGREv20261106_publicacion_v1.0.xlsx',
 workbookSha256:'5e1aed6df969afafca284e1cda228d36336ebf1ac31ea84f877f8170f584ec01',
 xslUrl:'https://cpe.sunat.gob.pe/sites/default/files/2026-10/Archivos_XSL.10.zip',
 xslSha256:'bcaa31e7195295372e905374f6b4adcd1b40bf4ba05b989132e34c03d484aeb7',
 xsdUrl:'https://cpe.sunat.gob.pe/sites/default/files/inline-files/Archivo%20XSD.zip',
 xsdArchiveSha256:'011225702980d1f8874f7aa0940a0de782aa79dd0cc1931c90f2b8142490bcea',
 xsdEntrySha256:'35c1a053744d57b332da258f5ae0bb8ba8f1b22e24077d580fcdea07f93dd93a',
 geographySources:['https://orientacion.sunat.gob.pe/23-zonas-geograficas-bajo-regimen-especial','https://orientacion.sunat.gob.pe/427-bienes-o-insumos-fiscalizados','https://orientacion.sunat.gob.pe/15-ley-32412'],
 geographyReviewedAt:'2026-11-24',
 geographyEvidence:[
  {norm:'DS015-2019-IN',url:'https://orientacion.sunat.gob.pe/sites/default/files/inline-files/Decreto_Supremo_015-2019-IN_1012.pdf',sha256:'6593606413de16163c87d92559d2598f1b1e83276056fb957f273364026f03b6'},
  {norm:'Ley32412/DS117-2026-EF',url:'https://cdn.www.gob.pe/uploads/document/file/10212932/8303432-ds-117-2026-ef.pdf?v=1782484340',sha256:'6afae08753c4b842e48406430f74ebcc0415888107e59a934f38697b98ae82c0'},
 ],
});
/** DS015-2019-IN districts as linked by SUNAT today; codes from official SFS cat13.
 * Madre de Dios is also held for special-control review (Ley32412/DS117-2026-EF).
 * A non-match does not replace reviewing the complete declared itinerary.
 */
export const HYDROCARBON_SPECIAL_DISTRICTS = Object.freeze([
 '050502','050507','050505','050503','050509','050510','050408','050407','050409',
 '081106','080408','080902','080908','080904','080901','080903','080906','080905','080909','080907','080910','080913','081203',
 '190306','190304','190308','120604','120606','120608','120603','120609',
 '210303','210309','211209','211205','211207','211210','211201','211208',
 '100606','100604','100601','100605','100602','100505','100702','100905','100902','100901','100403',
]);
export const isHydrocarbonProfile=(p:string)=>p==='GRE09_HYDROCARBON_PRIVATE04_V1'||p==='GRE09_HYDROCARBON_PUBLIC01_V1';
export const isPrivateGuideProfile=(p:string)=>p==='GRE09_PRIVATE04_V1'||p==='GRE09_HYDROCARBON_PRIVATE04_V1';
export function hydrocarbonText(v:unknown):asserts v is string {
 if(typeof v!=='string'||v.length<3||v.length>50||v.trim()!==v||/[\x00-\x1f\x7f]/.test(v))throw Error('Complete el registro o autorización de hidrocarburos (3 a 50 caracteres)');
}
export function validateHydrocarbonCargo(raw:unknown,privateTransport:boolean):HydrocarbonCargo {
 const v=raw as HydrocarbonCargo;
 if(!v||typeof v!=='object'||Object.keys(v).sort().join(',')!==['schemaVersion','family','scopCode','handoverDate','senderRegistration','carrierRegistration','vehicleAuthorization'].sort().join(',')||v.schemaVersion!=='factuez.gre-hydrocarbon.v1'||!['DIESEL','GASOHOL_PREMIUM','GASOHOL_REGULAR','GLP'].includes(v.family))throw Error('Seleccione una familia de combustible soportada; GNV requiere definir suministro en estación o transporte GNC/GNL');
 if(privateTransport?v.handoverDate!==null:typeof v.handoverDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.handoverDate)||!Number.isFinite(Date.parse(v.handoverDate+'T00:00:00Z'))||new Date(v.handoverDate+'T00:00:00Z').toISOString().slice(0,10)!==v.handoverDate)throw Error('Ingrese la fecha de entrega al transportista para transporte público');
 hydrocarbonText(v.senderRegistration);
 if(v.scopCode!==null&&(!/^[0-9]{11}$/.test(v.scopCode)||/^0+$/.test(v.scopCode)))throw Error('El código SCOP debe tener 11 dígitos y ser mayor que cero');
 if(privateTransport){hydrocarbonText(v.vehicleAuthorization);if(v.carrierRegistration!==null)throw Error('El traslado privado no admite registro de transportista contratado');}
 else {hydrocarbonText(v.carrierRegistration);if(v.vehicleAuthorization!==null)throw Error('La GRE remitente pública no registra vehículo sin el indicador específico');if(v.scopCode===null)throw Error('Ingrese el código SCOP para la venta de combustible');}
 return structuredClone(v);
}
export function validateHydrocarbonApproval(raw:HydrocarbonApproval){
 const a=raw;
 const keys=['branchId','profile','family','routeSha256','routeUbigeos','geography','documentRegime','senderRegistration','carrierRuc','carrierLegalName','mtcRegistration','carrierRegistration','vehiclePlate','vehicleAuthorization','scopRequired','sourceUrl','sourceSha256','validUntil'];
 if(!a||Object.keys(a).sort().join(',')!==keys.sort().join(',')||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.branchId)||!isHydrocarbonProfile(a.profile)||a.documentRegime!=='ORDINARY_GRE'||!['OUTSIDE_SPECIAL_ZONE','SPECIAL_ZONE'].includes(a.geography)||!/^https:\/\/(?:[a-z0-9-]+\.)*(?:sunat|osinergmin)\.gob\.pe\//.test(a.sourceUrl)||!/^[a-f0-9]{64}$/.test(a.sourceSha256)||!/^[a-f0-9]{64}$/.test(a.routeSha256)||!Array.isArray(a.routeUbigeos)||a.routeUbigeos.length<2||a.routeUbigeos.length>100||a.routeUbigeos.some(u=>!/^\d{6}$/.test(u)||u==='000000')||!Number.isFinite(Date.parse(a.validUntil))||typeof a.scopRequired!=='boolean')throw Error('Revisión de hidrocarburos incompleta: sede, ruta completa, régimen, evidencia oficial y vigencia requeridos');
 validateHydrocarbonCargo({schemaVersion:'factuez.gre-hydrocarbon.v1',family:a.family,handoverDate:isPrivateGuideProfile(a.profile)?null:'2026-11-24',scopCode:isPrivateGuideProfile(a.profile)?null:'10000000001',senderRegistration:a.senderRegistration,carrierRegistration:a.carrierRegistration,vehicleAuthorization:a.vehicleAuthorization},isPrivateGuideProfile(a.profile));
 if(a.family!=='GLP'&&(a.geography==='SPECIAL_ZONE'||a.routeUbigeos.some(u=>HYDROCARBON_SPECIAL_DISTRICTS.includes(u)||u.startsWith('17'))))throw Error('Ruta de diésel/gasohol con régimen o controles especiales: requiere revisión documental externa; perfil ordinario no habilitado');
 if(isPrivateGuideProfile(a.profile)){if(a.carrierRuc!==null||a.carrierLegalName!==null||a.mtcRegistration!==null||typeof a.vehiclePlate!=='string'||!/^[A-Z0-9]{6,8}$/.test(a.vehiclePlate))throw Error('Seleccione vehículo privado y su autorización');}
 else {fiscalRuc(a.carrierRuc,'carrierRuc');if(typeof a.carrierLegalName!=='string'||a.carrierLegalName.trim().length<3||a.carrierLegalName.length>200||/[\x00-\x1f\x7f]/.test(a.carrierLegalName)||typeof a.mtcRegistration!=='string'||!/^(?!0+$)[A-Z0-9]{1,20}$/.test(a.mtcRegistration))throw Error('Complete razón social y registro MTC del transportista');if(a.vehiclePlate!==null||a.scopRequired!==true)throw Error('Venta pública exige SCOP y transportista autorizado');}
 return structuredClone(a);
}
export function hydrocarbonRouteHash(body:{origin:unknown;destination:unknown}) {return fiscalSnapshotSha256({origin:body.origin,destination:body.destination});}
/** Guard for legacy wrongly reviewed fuel rows, in addition to authoritative product family checks. */
export function looksLikeFuel(v:{code:string;description:string}) {return /\b(?:diesel|diésel|gasohol|gasolina|glp|gnv|gnc|gnl|biodiesel)\b/i.test(`${v.code} ${v.description}`);}
