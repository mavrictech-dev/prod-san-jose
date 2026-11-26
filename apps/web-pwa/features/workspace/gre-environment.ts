/** Presentation only. Opening a module never changes company, gates or grants. */
export function fiscalContextMessage(pathname:string,salesEnvironment?:string){
 if(pathname==='/guides')return `GRE nativa · PRODUCTION: este módulo solicita envío real con serie y concesión propias. Ventas: ${salesEnvironment??'sin emisor seleccionado'}. Requiere activación GRE y CDR íntegro; no habilita facturas ni cambia el ambiente de ventas.`;
 if(pathname==='/guides/laboratory')return 'Laboratorio GRE · Pruebas locales sin validez tributaria ni envío real a SUNAT. Separado de GRE nativa PRODUCTION.';
 return salesEnvironment==='PRODUCTION'?'Producción · El estado fiscal de cada comprobante se confirma con su CDR.':salesEnvironment==='BETA'?'Ambiente de pruebas Beta · Sin validez tributaria.':'Vista consolidada de las empresas y sedes autorizadas.';
}
