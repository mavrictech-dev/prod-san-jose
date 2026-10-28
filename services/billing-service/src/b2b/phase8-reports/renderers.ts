import type { ReportsCapture, ReportsRenderers } from './types';
import { extended, limits, signedAmount, summary, verifyCapture } from './validation';
const baseColumns=['issuerRuc','branchId','pointId','seriesId','type','id','fullNumber','issueDate','currency','local','payableAmount','taxableAmount','igvAmount','snapshotSha256'];
const extraColumns=['category','signedPayableAmount','signedTaxableAmount','signedIgvAmount','referenceDocumentId','convertedDocumentId','grossWeight','weightUnit','quantities'];
const category=(type:string)=>['09','31'].includes(type)?'TRANSFER':type==='NV'?'COMMERCIAL_NON_FISCAL':'SALE_LOCAL_UNVERIFIED';
const columns=(c:ReportsCapture)=>[...baseColumns,...(extended(c.filters)?extraColumns:[])];
const cells=(c:ReportsCapture)=>c.rows.map(r=>[r.context.issuerRuc,r.context.branchId,r.context.pointId,physicalSeries(c,r),r.type,r.id,r.fullNumber,
  r.issueDate,r.currency??'',r.local,r.payableAmount??'',r.taxableAmount??'',r.igvAmount??'',r.snapshotSha256,
  ...(extended(c.filters)?[category(r.type),signedAmount(r,r.payableAmount)??'',signedAmount(r,r.taxableAmount)??'',signedAmount(r,r.igvAmount)??'',
    r.referenceDocumentId??'',r.convertedDocumentId??'',r.transfer?.grossWeight??'',r.transfer?.weightUnit??'',
    r.transfer?JSON.stringify(r.transfer.quantities):'']:[])]);
import {accessKey as importAccessKey,accessSeries} from './validation';
const physicalSeries=(c:ReportsCapture,r:ReportsCapture['rows'][number])=>{
  const a=(c.access??[]).find(a=>importAccessKey(a)===r.accessKey);return a?accessSeries(a):r.context.seriesId;
};
const safeCsv=(value:string)=>'"'+(/^\s*[=+@-]/.test(value)&&!/^-[0-9]+(?:\.[0-9]+)?$/.test(value)?"'"+value:value).replace(/"/g,'""')+'"';
/** Constructors are explicit optional owner dependencies; no package installation or cross-service lookup. */
export function createReportsRenderers(dependencies:{Workbook?:new()=>any;PdfDocument?:new(options:unknown)=>any}={}):ReportsRenderers {
  const result:ReportsRenderers={CSV:async capture=>{
    verifyCapture(capture);
    return {bytes:Buffer.from('\uFEFF'+[columns(capture),...cells(capture)].map(r=>r.map(safeCsv).join(',')).join('\r\n')+'\r\n','utf8'),mediaType:'text/csv; charset=utf-8'};
  }};
  if(dependencies.Workbook) result.XLSX=async capture=>{
    verifyCapture(capture);const workbook=new dependencies.Workbook!();
    workbook.creator='FactuEz';workbook.created=new Date(capture.capturedAt);workbook.modified=new Date(capture.capturedAt);
    const sheet=workbook.addWorksheet('Documents');sheet.addRow(columns(capture));
    const textRow=(sheet:any,row:string[])=>{const made=sheet.addRow(row);made.eachCell((cell:any)=>{cell.numFmt='@';});};
    for(const row of cells(capture))textRow(sheet,row);
    const totals=workbook.addWorksheet('Summary'),data=summary(capture);
    totals.addRow(['currency','type','local','count','payableAmount','taxableAmount','igvAmount','missingTaxableCount','missingIgvCount']);
    for(const g of data.groups)textRow(totals,[g.currency,g.type,g.local,String(g.count),g.payableAmount,g.taxableAmount??'',g.igvAmount??'',String(g.missingTaxableCount),String(g.missingIgvCount)]);
    if('transfers' in data){
      const transfer=workbook.addWorksheet('Transfers');transfer.addRow(['type','id','grossWeight','weightUnit','quantities']);
      for(const t of data.transfers)textRow(transfer,[t.type,t.id,t.grossWeight!,t.weightUnit!,JSON.stringify(t.quantities)]);
      const net=workbook.addWorksheet('NetSales');net.addRow(['currency','payableAmount','basis']);
      for(const g of data.netSales)textRow(net,[g.currency,g.payableAmount,'LOCAL_ISSUED_01_03_07_08_NOT_FISCAL_ACCEPTANCE']);
      const coverage=workbook.addWorksheet('Coverage');coverage.addRow(['type','source','fiscalAcceptance','consistency']);
      for(const g of data.coverage)textRow(coverage,[g.type,g.source,g.fiscalAcceptance,g.consistency]);
    }
    return {bytes:Buffer.from(await workbook.xlsx.writeBuffer()),mediaType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'};
  };
  if(dependencies.PdfDocument) result.PDF=capture=>new Promise((resolve,reject)=>{
    verifyCapture(capture);
    const doc=new dependencies.PdfDocument!({size:'A4',margin:36,compress:true,info:{Title:'B2B report - BETA candidate',CreationDate:new Date(capture.capturedAt)}});
    const chunks:Buffer[]=[];let size=0,failed=false;
    doc.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limits.contentBytes){failed=true;doc.destroy(new Error('REPORT_CONTENT_TOO_LARGE'));}else chunks.push(Buffer.from(chunk));});
    doc.once('error',reject);doc.once('end',()=>{if(!failed) resolve({bytes:Buffer.concat(chunks),mediaType:'application/pdf'});});
    try {
      const line=(text:string)=>{if(doc.y>745) doc.addPage();doc.fontSize(8).text(text,{width:520});};
      doc.fontSize(14).text('FactuEz - B2B report (BETA candidate)');
      line('Sources: '+capture.filters.types.join('/')+'. Local owner projections; fiscal acceptance is NOT asserted.');
      line('Credit notes have negative effects. Transfers and commercial sales notes are excluded from net sales.');
      line(`Captured: ${capture.capturedAt}`);line(`SHA256: ${capture.sha256}`);
      const data=summary(capture);
      for(const g of data.groups)line(`${g.type==='NV'?'Commercial / ':''}${g.currency} / ${g.type} / ${g.local}: ${g.count} documents, signed payable ${g.payableAmount}, taxable ${g.taxableAmount??'UNKNOWN'}, IGV ${g.igvAmount??'UNKNOWN'}`);
      if('netSales' in data)for(const g of data.netSales)line(`Local issued net sales ${g.currency}: ${g.payableAmount}`);
      for(const r of capture.rows){
        line(`${r.issueDate} | ${r.context.issuerRuc} | ${r.type} ${r.fullNumber} | ${r.local}`);
        if(r.transfer)line(`TRANSFER: gross weight ${r.transfer.grossWeight} ${r.transfer.weightUnit}; quantities ${r.transfer.quantities.map(q=>q.quantity+' '+q.unitCode).join(', ')}`);
        else line(`${category(r.type)} | ${r.currency} original ${r.payableAmount}; signed effect ${signedAmount(r,r.payableAmount)}`);
      }
      doc.end();
    }catch(error){doc.destroy();reject(error);}
  });
  return result;
}



