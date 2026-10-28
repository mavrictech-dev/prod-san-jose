import { PRODUCTION_NOTES_EXTENDED_PROFILE, type FiscalDocumentSnapshot, type ProductionNotesAnySnapshot } from '@factuez/contracts';
import { assertProductionNotesAnySnapshot, buildProductionNotesAnyUbl,
  fiscalLimaDate, fiscalSnapshotSha256, fiscalXml, fiscalSignatureXml, FISCAL_XML_EXTENSION, FISCAL_XML_NAMESPACES } from '@factuez/sunat-core';
export type ProductionNotesContext = { original: FiscalDocumentSnapshot; creditHistory: ProductionNotesAnySnapshot[]; identifier?: string };
export function assertProductionNotesContext(note: ProductionNotesAnySnapshot, context: ProductionNotesContext) {
  assertProductionNotesAnySnapshot(note,context.original,context.creditHistory);
}
export function productionNotesUnsigned(note: ProductionNotesAnySnapshot, context?: ProductionNotesContext) {
  if(context)assertProductionNotesContext(note,context);
  return buildProductionNotesAnyUbl(note);
}
export const productionNotesUsesRc = (note: ProductionNotesAnySnapshot) => note.reference.documentTypeCode === '03';
export function productionNotesRcSnapshot(note: ProductionNotesAnySnapshot, identifier: string) {
  if (!productionNotesUsesRc(note) || note.profile !== PRODUCTION_NOTES_EXTENDED_PROFILE || !/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(note.fullNumber) || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(identifier)) throw Error('RC exige una nota B sobre boleta 03');
  const compact=identifier.slice(3,11), issueDate=compact.slice(0,4)+'-'+compact.slice(4,6)+'-'+compact.slice(6), referenceDate=fiscalLimaDate(note.issueDate);
  if (new Date(issueDate+'T12:00:00Z').toISOString().slice(0,10)!==issueDate || issueDate<referenceDate || Date.parse(issueDate+'T12:00:00Z')-Date.parse(referenceDate+'T12:00:00Z')>7*86400000) throw Error('RC fuera del plazo de 7 días');
  return { environment: 'PRODUCTION' as const, profile: note.profile, identifier, issueDate, referenceDate, noteSnapshotSha256: fiscalSnapshotSha256(note), note: structuredClone(note) };
}
/** Own production reconstruction; no Beta snapshot rewriting, clock override or individual CDR. */
export function buildProductionNotesRc(note: ProductionNotesAnySnapshot, identifier: string, context: ProductionNotesContext) {
  assertProductionNotesContext(note,context);
  const snapshot=productionNotesRcSnapshot(note,identifier), x=fiscalXml, unaffected='unaffectedAmount' in note.totals ? note.totals.unaffectedAmount : '0.00';
  const payment=(value:string,code:string)=>`<sac:BillingPayment><cbc:PaidAmount currencyID="PEN">${value}</cbc:PaidAmount><cbc:InstructionID>${code}</cbc:InstructionID></sac:BillingPayment>`;
  const tax=(value:string,id:string,name:string,code:string)=>`<cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${value}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="PEN">${value}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>${id}</cbc:ID><cbc:Name>${name}</cbc:Name><cbc:TaxTypeCode>${code}</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`;
  return `<?xml version="1.0" encoding="UTF-8"?><SummaryDocuments xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1" ${FISCAL_XML_NAMESPACES} xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1">${FISCAL_XML_EXTENSION}<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.1</cbc:CustomizationID><cbc:ID>${identifier}</cbc:ID><cbc:ReferenceDate>${snapshot.referenceDate}</cbc:ReferenceDate><cbc:IssueDate>${snapshot.issueDate}</cbc:IssueDate>${fiscalSignatureXml(note.issuer)}<cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${note.issuer.identityNumber}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${x(note.issuer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><sac:SummaryDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>${note.documentTypeCode}</cbc:DocumentTypeCode><cbc:ID>${note.fullNumber}</cbc:ID><cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>${x(note.customer.identityNumber)}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>${x(note.customer.identityType)}</cbc:AdditionalAccountID></cac:AccountingCustomerParty><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${note.reference.fullNumber}</cbc:ID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference><cac:Status><cbc:ConditionCode>1</cbc:ConditionCode></cac:Status><sac:TotalAmount currencyID="PEN">${note.totals.payableAmount}</sac:TotalAmount>${payment(note.totals.taxableAmount,'01')}${unaffected!=='0.00'?payment(unaffected,'03'):''}${tax(note.totals.igvAmount,'1000','IGV','VAT')}${unaffected!=='0.00'?tax('0.00','9998','INA','FRE'):''}</sac:SummaryDocumentsLine></SummaryDocuments>`;
}
