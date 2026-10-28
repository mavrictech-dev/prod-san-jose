import type {ShadowCaseReport,ShadowCaseV1,ShadowReviewCategory,ShadowRunReport} from '@factuez/shadow-core';
export type ShadowPanelData={schemaVersion:'factuez.shadow-panel.v1';report:ShadowRunReport;cases:ShadowCaseV1[]};
export type ShadowPanelRow={source:ShadowCaseV1;report:ShadowCaseReport};
export type ShadowFilters={search:string;status:string;type:string;category:string};
export type ShadowNote={caseId:string;inputSha256:string;differenceId:string;category:ShadowReviewCategory;reason:string};
export const INITIAL_FILTERS:ShadowFilters={search:'',status:'ALL',type:'ALL',category:'ALL'};
export const STATUS_LABELS:Record<string,string>={MATCH_WITH_UNVERIFIED_EVIDENCE:'Coincide, sin verificar',DIFFERENCES_FOUND:'Con diferencias',INCOMPLETE:'Evidencia faltante'};
export const CATEGORY_LABELS:Record<ShadowReviewCategory,string>={CORRECTION_REQUIRED:'Requiere corrección',COSMETIC:'Presentación',DATA_MISSING:'Dato o evidencia faltante',LEGACY_BUG_PENDING_APPROVAL:'Posible bug del origen, pendiente'};
export const TYPE_LABELS:Record<string,string>={'01':'Factura','03':'Boleta','07':'Nota de crédito','08':'Nota de débito'};
const normalized=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('es-PE');
export function panelRows(data:ShadowPanelData):ShadowPanelRow[]{
  const sources=new Map(data.cases.map(c=>[c.caseId,c]));
  const isolated=(r:ShadowRunReport|ShadowCaseReport)=>r.environment==='BETA'&&r.datasetClass==='SYNTHETIC'&&r.mode==='SHADOW'&&r.transmission===false&&r.productionBlocked===true&&r.fiscalAuthority===false&&r.countersChanged===false&&r.accountingApproved===false&&r.persisted===false&&r.cutoverAuthorized===false&&r.signatureVerified===false&&r.cdrAuthenticityVerified===false&&r.pdfBytesVerified===false&&r.fiscalWrites===0&&r.outboxWrites===0&&r.reviewRequired===true;
  if(data.schemaVersion!=='factuez.shadow-panel.v1'||!isolated(data.report)||sources.size!==data.cases.length||data.report.reports.length!==data.cases.length||new Set(data.report.reports.map(r=>r.caseId)).size!==data.cases.length||!data.cases.length||data.cases.length>50||data.report.count!==data.cases.length||data.report.differenceCount!==data.report.reports.reduce((n,r)=>n+r.differenceCount,0)||data.report.matchingCount!==data.report.reports.filter(r=>r.comparativeMatch).length)throw new Error('El panel sólo admite el laboratorio ficticio aislado.');
  return data.report.reports.map(report=>{
    const source=sources.get(report.caseId);
    if(!source||source.environment!=='BETA'||source.datasetClass!=='SYNTHETIC'||source.mode!=='SHADOW'||!isolated(report)||!Object.hasOwn(STATUS_LABELS,report.status)||![source.legacy.snapshot.issuer.ruc,source.factuez.snapshot.issuer.ruc,source.legacy.snapshot.ownership.issuerRuc,source.factuez.snapshot.ownership.issuerRuc].every(r=>/^00000000[0-9]{3}$/.test(r)))throw new Error('El caso no corresponde al laboratorio ficticio.');
    return {source,report};
  });
}
export function filterShadowRows(rows:ShadowPanelRow[],f:ShadowFilters){
  const query=normalized(f.search.trim().slice(0,120));
  return rows.filter(({source,report})=>{
    const s=source.legacy.snapshot;
    return (f.status==='ALL'||report.status===f.status)&&(f.type==='ALL'||s.ownership.documentTypeCode===f.type)&&
      (f.category==='ALL'||report.counts[f.category as keyof typeof report.counts]>0)&&
      (!query||normalized(`${s.ownership.series}-${s.number} ${s.issuer.ruc} ${s.customer.legalName} ${s.originId} ${TYPE_LABELS[s.ownership.documentTypeCode]}`).includes(query));
  });
}
export function exactMoney(value:string,currency:string){
  if(!/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,2})?$/.test(value)||!['PEN','USD'].includes(currency))return 'Dato inválido';
  const [whole,fraction='']=value.split('.');return `${currency==='PEN'?'S/':'US$'} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction.padEnd(2,'0')}`;
}
/** Prices can have six decimals; never round them through binary floating point. */
export function exactUnitPrice(value:string,currency:string){
  if(!/^(0|[1-9][0-9]{0,19})(\.[0-9]{1,6})?$/.test(value)||!['PEN','USD'].includes(currency))return 'Dato inválido';
  const [whole,fraction='']=value.split('.');return `${currency==='PEN'?'S/':'US$'} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')}.${fraction.padEnd(2,'0')}`;
}
export function differenceLabels(path:string){
  const internal=/^(xml|prints)\.(legacy|factuez)\./.exec(path);
  return internal?{left:'Esperado (snapshot/XML)',right:`Observado (${internal[2]==='legacy'?'referencia':'FactuEz'})`}:{left:'Referencia ficticia',right:'FactuEz ficticio'};
}
export function displayDifference(value:string|null){
  if(value===null)return 'Sin dato';
  try{const parsed=JSON.parse(value);return typeof parsed==='string'?parsed:JSON.stringify(parsed);}catch{return value;}
}
export function upsertShadowNote(rows:ShadowPanelRow[],notes:ShadowNote[],input:ShadowNote):ShadowNote[]{
  const row=rows.find(r=>r.report.caseId===input.caseId),reason=input.reason.trim();
  if(!row||row.report.inputSha256!==input.inputSha256||!row.report.differences.some(d=>d.id===input.differenceId)||
    !Object.hasOwn(CATEGORY_LABELS,input.category)||!reason||reason.length>500||/[\x00-\x1f\x7f]/.test(reason))throw new Error('Elige una diferencia vigente y escribe un motivo de 1 a 500 caracteres.');
  return [...notes.filter(n=>n.caseId!==input.caseId||n.differenceId!==input.differenceId),{...input,reason}];
}
export function exportShadowReviews(rows:ShadowPanelRow[],notes:ShadowNote[],reviewerId:string){
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewerId))throw new Error('La sesión no tiene una identidad válida para exportar el borrador.');
  let validated:ShadowNote[]=[];for(const note of notes)validated=upsertShadowNote(rows,validated,note);
  return {schemaVersion:'factuez.shadow-review-drafts.v1',environment:'BETA',datasetClass:'SYNTHETIC',mode:'SHADOW',annotationsOnly:true,
    reviewerIdentityAuthenticated:false,accountingApproved:false,transmission:false,countersChanged:false,cutoverAuthorized:false,
    cases:rows.filter(r=>validated.some(n=>n.caseId===r.report.caseId)).map(r=>({schemaVersion:'factuez.shadow-review.v1',environment:'BETA',datasetClass:'SYNTHETIC',mode:'SHADOW',
      caseId:r.report.caseId,inputSha256:r.report.inputSha256,reviewerId,decisions:validated.filter(n=>n.caseId===r.report.caseId).map(({differenceId,category,reason})=>({differenceId,category,reason}))}))};
}
export function reportCsv(rows:ShadowPanelRow[]){
  const cell=(v:unknown)=>{let s=String(v??'');if(/^[\s]*[=+\-@\t\r\n]/.test(s))s="'"+s;return `"${s.replaceAll('"','""')}"`;};
  const values=[['Documento ficticio','Tipo','RUC ficticio','Estado comparativo','Diferencias','Correcciones','Ausencias','Presentación','Hash del caso','Autoridad fiscal','Envío','Corte autorizado'],
    ...rows.map(({source,report:r})=>[`${source.legacy.snapshot.ownership.series}-${source.legacy.snapshot.number}`,TYPE_LABELS[source.legacy.snapshot.ownership.documentTypeCode],source.legacy.snapshot.issuer.ruc,STATUS_LABELS[r.status],r.differenceCount,r.counts.CORRECTION_REQUIRED,r.counts.DATA_MISSING,r.counts.COSMETIC,r.inputSha256,'NO','NO','NO'])];
  return '\uFEFF'+values.map(row=>row.map(cell).join(',')).join('\r\n');
}
