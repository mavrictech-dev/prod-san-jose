import type {ApiFieldIssue} from '@factuez/contracts';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** Input diagnostics only. Native totals, tax policy, ownership and admission remain authoritative. */
export function issuanceInputIssues(input:unknown):ApiFieldIssue[]{
 const errors:ApiFieldIssue[]=[];
 const add=(field:string,message:string,code='INVALID_VALUE')=>{if(errors.length<100)errors.push({field,code,message});};
 const exact=(v:Record<string,any>,allowed:string[],field:string)=>{if(Object.keys(v).some(key=>!allowed.includes(key)))add(field,'Hay campos no admitidos. Descuentos, anticipos e impuestos especiales requieren un perfil compatible.','UNSUPPORTED_FIELDS');};
 if(!object(input))return [{field:'request',code:'INVALID_BODY',message:'Envíe un objeto JSON con el comprobante.'}];
 exact(input,['emissionPointId','shiftId','documentType','series','issueDate','currencyCode','paymentTerms','customer','lines'],'request');
 if(typeof input.emissionPointId!=='string'||!uuid.test(input.emissionPointId))add('emissionPointId','Seleccione un punto de emisión válido.');
 if(input.shiftId!==undefined&&(typeof input.shiftId!=='string'||!uuid.test(input.shiftId)))add('shiftId','El turno debe ser un UUID válido del punto de emisión.');
 if(typeof input.series!=='string'||!/^[FB][A-Z0-9]{3}$/.test(input.series))add('series','La serie debe tener cuatro caracteres y comenzar con F o B, según el tipo de comprobante.');
 if(!['INVOICE','SALES_RECEIPT'].includes(input.documentType))add('documentType','Seleccione factura (INVOICE) o boleta (SALES_RECEIPT).');
 if(input.currencyCode!==undefined&&!['PEN','USD'].includes(input.currencyCode))add('currencyCode','Seleccione PEN o USD; el perfil productivo instalado admite PEN.');
 if(input.issueDate!==undefined&&(typeof input.issueDate!=='string'||!Number.isFinite(Date.parse(input.issueDate))))add('issueDate','La fecha de emisión no es válida. Envíela en formato ISO 8601.');
 if(!object(input.customer))add('customer','Complete los datos del cliente.');
 else{
  const c=input.customer;
  exact(c,['identityType','identityNumber','legalName','address','email'],'customer');
  if(typeof c.legalName!=='string'||!c.legalName.trim()||c.legalName.length>200)add('customer.legalName','El nombre o razón social del cliente es obligatorio y admite hasta 200 caracteres.');
  if(typeof c.identityType!=='string'||!/^[A-Z0-9]$/.test(c.identityType))add('customer.identityType','Seleccione un código de un carácter del catálogo SUNAT para el documento del cliente.');
  if(c.address!==undefined&&(typeof c.address!=='string'||c.address.length>300))add('customer.address','La dirección del cliente admite hasta 300 caracteres.');
  if(c.email!==undefined&&(typeof c.email!=='string'||c.email.length>254||c.email!==''&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)))add('customer.email','Ingrese un correo válido de hasta 254 caracteres o deje el campo vacío.');
  if(typeof c.identityNumber!=='string'||!c.identityNumber.trim()||c.identityNumber.length>20)add('customer.identityNumber','Complete el número de documento del cliente, con hasta 20 caracteres.');
  else if(input.documentType==='INVOICE'&&!/^\d{11}$/.test(c.identityNumber))add('customer.identityNumber','La factura requiere un RUC de exactamente 11 dígitos.');
  else if(c.identityType==='1'&&!/^\d{8}$/.test(c.identityNumber))add('customer.identityNumber','El DNI debe contener exactamente 8 dígitos.');
  else if(c.identityType==='6'&&!/^\d{11}$/.test(c.identityNumber))add('customer.identityNumber','El RUC debe contener exactamente 11 dígitos.');
  if(input.documentType==='INVOICE'&&c.identityType!=='6')add('customer.identityType','Para una factura seleccione RUC (código 6).');
 }
 if(!Array.isArray(input.lines)||input.lines.length<1||input.lines.length>100)add('lines','El comprobante requiere entre 1 y 100 ítems.');
 else input.lines.forEach((line:unknown,index:number)=>{
  const path='lines['+index+']',label='Ítem '+(index+1)+': ';
  if(!object(line)){add(path,label+'complete un objeto con los datos del producto.');return;}
  exact(line,['productId','productCode','description','unitCode','quantity','unitPriceWithTax','taxAffectationCode','igvRate'],path);
  if(line.productId!==undefined&&(typeof line.productId!=='string'||!uuid.test(line.productId)))add(path+'.productId',label+'seleccione un UUID del catálogo de productos.');
  if(line.productCode!==undefined&&(typeof line.productCode!=='string'||line.productCode.length>40))add(path+'.productCode',label+'el código del producto admite hasta 40 caracteres.');
  if(typeof line.description!=='string'||!line.description.trim()||line.description.length>250)add(path+'.description',label+'la descripción es obligatoria y admite hasta 250 caracteres.');
  if(typeof line.unitCode!=='string'||!/^[A-Z0-9]{2,3}$/.test(line.unitCode))add(path+'.unitCode',label+'seleccione una unidad válida del maestro, por ejemplo GLL o NIU.');
  for(const [field,name] of [['quantity','la cantidad'],['unitPriceWithTax','el precio con IGV']] as const){const value=line[field];if(typeof value!=='string'||!/^\d{1,12}(\.\d{1,6})?$/.test(value)||Number(value)<=0)add(path+'.'+field,label+name+' debe ser un decimal positivo, con hasta 12 enteros y 6 decimales.');}
  if(!['10','20','30'].includes(line.taxAffectationCode))add(path+'.taxAffectationCode',label+'el código de afectación no es un porcentaje. Seleccione gravado (10), exonerado (20) o inafecto (30), según la política autorizada.');
  else if(line.taxAffectationCode==='10'&&(typeof line.igvRate!=='string'||!/^(?:[0-9]|[1-9][0-9])(?:\.\d{1,2})?$/.test(line.igvRate)||Number(line.igvRate)<=0))add(path+'.igvRate',label+'indique la tasa porcentual de IGV de la política vigente; la tasa general configurada es 18.');
  else if(line.taxAffectationCode!=='10'&&!['0','0.00'].includes(line.igvRate))add(path+'.igvRate',label+'los tratamientos exonerado e inafecto requieren tasa 0.00.');
 });
 return errors;
}
