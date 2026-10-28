import { createRequire } from 'node:module';
import type { ProductionGuidesSnapshot as Snapshot,ProductionGuidesResult as Result } from '@factuez/contracts/production-guides';
import { validateProductionGuidesSnapshot } from '@factuez/sunat-core/dist/production-guides';
/** Read-only representation from the protected frozen owner, never signs or contacts SUNAT. */
export async function renderProductionGuidesPdf(raw:Snapshot,result:Result):Promise<Buffer>{
 const s=validateProductionGuidesSnapshot(raw),b=s.body as any;
 const local=createRequire(require.resolve('@factuez/pdf-renderer'));const PDFDocument=local('pdfkit');
 const doc=new PDFDocument({size:'A4',margin:40,autoFirstPage:true,info:{Title:`GRE ${s.documentType} ${s.series}-${s.number}`,Author:s.issuer.legalName}});
 const bytes:Buffer[]=[];const complete=new Promise<Buffer>((resolve,reject)=>{doc.on('data',(x:Buffer)=>bytes.push(x));doc.on('end',()=>resolve(Buffer.concat(bytes)));doc.on('error',()=>reject(Error('GRE_PDF_RENDER_FAILED')));});
 const text=(v:string,size=10)=>{doc.fontSize(size).text(v,{width:515});doc.moveDown(0.35);};
 text(s.documentType==='31'?'GUÍA DE REMISIÓN TRANSPORTISTA':'GUÍA DE REMISIÓN REMITENTE',16);text(`${s.series}-${s.number}`,15);
 text(`${s.issuer.legalName} — RUC ${s.issuer.ruc}`);text(`Emisión: ${b.issueDate} | Inicio del traslado: ${b.transferDate}`);
 text(`Sede: ${s.scope.branchId} | Establecimiento: ${s.scope.establishmentCode}`);
 text(`Estado: ${result.state} | Origen de evidencia: ${result.source}`);
 text(result.officialCdrVerified?'CDR SUNAT con firma y vínculo verificados.':'Sin CDR oficial verificada. Esta representación no acredita autorización de traslado.');
 for(const [label,p] of [['Remitente',b.sender],['Destinatario',b.recipient]] as const)text(`${label}: ${p.legalName} — RUC ${p.ruc}`);
 text(`Partida: ${b.origin.address} | Ubigeo ${b.origin.ubigeo}${b.origin.establishmentCode?' | Est. '+b.origin.establishmentCode:''}`);
 text(`Llegada: ${b.destination.address} | Ubigeo ${b.destination.ubigeo}${b.destination.establishmentCode?' | Est. '+b.destination.establishmentCode:''}`);
 text(`Peso: ${b.grossWeight} ${b.weightUnit} | Modalidad: ${b.transport?.mode??b.transportMode} | Motivo: ${b.reasonCode??'Servicio de transporte'}`);
 const carrier=b.transport?.carrier??b.carrier;if(carrier)text(`Transportista: ${carrier.legalName} | RUC ${carrier.ruc} | MTC ${carrier.mtcRegistration??b.mtcRegistration}`);
 const t=b.transport;if(t?.vehicle)text(`Vehículo: ${t.vehicle.plate} | Registro/TUC: ${t.vehicle.tuc??t.vehicle.registration}`);
 if(t?.driver)text(`Conductor: ${t.driver.firstName} ${t.driver.lastName} | Documento ${t.driver.identityNumber} | Licencia ${t.driver.license}`);
 if(b.reference09)text(`GRE remitente: ${b.reference09.issuerRuc} / ${b.reference09.series}-${b.reference09.number}`);
 text('BIENES',12);for(const [n,i]of b.items.entries())text(`${n+1}. ${i.code} | ${i.description} | ${i.quantity} ${i.unitCode}`);
 text(`XML SHA-256: ${result.xmlSha256??'Pendiente'}`,8);text(`ZIP SHA-256: ${result.zipSha256??'Pendiente'}`,8);
 if(result.ticket)text(`Ticket: ${result.ticket}`,8);if(result.cdrZipSha256)text(`CDR ZIP SHA-256: ${result.cdrZipSha256}`,8);
 text('Representación del documento original conservado por FactuEz. Consulte el estado y conserve los originales XML/ZIP/CDR.',8);
 doc.end();return complete;
}
