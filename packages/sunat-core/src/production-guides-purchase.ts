import {fiscalDate,fiscalDecimal,fiscalLimaDate,fiscalRuc,fiscalTimestamp} from './fiscal-note';
/** Independent ordinary 09/private02/purchase02 profile; never adapts purchase to reason04.
 * SUNAT pinned XSL 2.0.1: SellerSupplierParty 4375/3448, origin 3411; cat20=02.
 * Narrow support: RUC supplier, buyer=issuer=sender=recipient, explicit establishments,
 * GLL/LTR only. Other identities, units, third-party delivery and BF remain blocked. */
export function validatePurchaseGuide09Body(body:unknown,issuer:{ruc:string;legalName:string},establishmentCode:string){
 const b=body as any;
 const exact=(v:any,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join(',')!==keys.sort().join(','))throw Error('Campos de compra privada inválidos');};
 const text=(v:any,max:number)=>{if(typeof v!=='string'||v.trim()!==v||!v||v.length>max||/[\x00-\x1f\x7f-\x9f\ud800-\udfff\ufffe\uffff]/u.test(v))throw Error('Texto de compra inválido');};
 const pattern=(v:any,re:RegExp)=>{if(typeof v!=='string'||!re.test(v))throw Error('Dato de compra inválido');};
 const party=(p:any)=>{exact(p,['ruc','legalName']);fiscalRuc(p.ruc,'party.ruc');text(p.legalName,200);};
 exact(b,['issueDate','transferDate','reasonCode','origin','destination','sender','recipient','supplier','grossWeight','weightUnit','transport','items','references','regulatedGoods']);
 if(b.reasonCode!=='02'||b.regulatedGoods!==false||!Array.isArray(b.references)||b.references.length)throw Error('Perfil Compra privada requiere motivo 02 y ningún documento fiscal relacionado no revisado');
 fiscalTimestamp(b.issueDate,'issueDate');fiscalDate(b.transferDate,'transferDate');
 if(new Date(b.issueDate).toISOString()!==b.issueDate||b.transferDate<fiscalLimaDate(b.issueDate))throw Error('Fechas de compra inválidas');
 for(const p of [b.sender,b.recipient,b.supplier])party(p);
 if([b.sender,b.recipient].some(p=>p.ruc!==issuer.ruc||p.legalName!==issuer.legalName)||b.supplier.ruc===issuer.ruc)throw Error('Compra requiere comprador/remitente/destinatario emisor y proveedor tercero');
 for(const p of [b.origin,b.destination]){exact(p,['ubigeo','address','establishmentCode']);pattern(p.ubigeo,/^(?!000000)[0-9]{6}$/);pattern(p.establishmentCode,/^[0-9]{4}$/);text(p.address,300);}
 if(b.destination.establishmentCode!==establishmentCode||b.origin.ubigeo===b.destination.ubigeo&&b.origin.address===b.destination.address)throw Error('Compra requiere llegada a la sede autorizada y origen del proveedor diferente');
 fiscalDecimal(b.grossWeight,3,true,'grossWeight');if(!['KGM','TNE'].includes(b.weightUnit))throw Error('Declare peso bruto en KGM o TNE sin conversiones implícitas');
 const t=b.transport;exact(t,['mode','vehicle','driver']);if(t.mode!=='02')throw Error('Compra sólo admite transporte privado 02');
 exact(t.vehicle,['plate','registration']);pattern(t.vehicle.plate,/^[A-Z0-9]{6,8}$/);pattern(t.vehicle.registration,/^[A-Z0-9]{1,15}$/);
 const d=t.driver;exact(d,['identityType','identityNumber','firstName','lastName','license']);if(!['1','4'].includes(d.identityType))throw Error('Identidad de conductor inválida');pattern(d.identityNumber,d.identityType==='1'?/^[0-9]{8}$/:/^[A-Z0-9]{1,12}$/);text(d.firstName,100);text(d.lastName,100);pattern(d.license,/^[A-Z0-9]{1,10}$/);
 if(!Array.isArray(b.items)||!b.items.length||b.items.length>100)throw Error('Seleccione hasta 100 productos');
 const seen=new Set<string>();for(const i of b.items){exact(i,['code','description','quantity','unitCode']);text(i.code,40);text(i.description,250);fiscalDecimal(i.quantity,6,true,'quantity');if(!['GLL','LTR'].includes(i.unitCode))throw Error('Compra sólo admite GLL o LTR expresamente revisadas; BJ no se convierte a galones');if(seen.has(i.code))throw Error('Producto duplicado');seen.add(i.code);}
 return structuredClone(b);
}
