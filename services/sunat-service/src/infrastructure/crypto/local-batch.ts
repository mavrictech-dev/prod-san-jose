import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { validateLocalInvoice, limaIssueDate } from '@factuez/sunat-core';
import { escapeXml as x } from '../sunat/safe-xml';
import { XmlSignerService } from './xml-signer.service';
import { zipSync } from 'fflate';

export type BatchQaKind = 'RC_ALTA' | 'RC_BAJA' | 'RA';
export interface BatchQaInput { kind: BatchQaKind; snapshots: FiscalDocumentSnapshot[]; reasons?: string[]; notDelivered?: boolean }
export const MAX_BATCH_QA_MEMBERS = 50;
/** Perfil acotado: una fecha/RUC, ventas PEN gravadas 18%, sin modificar ventas. */
export function validateBatchQa(input: BatchQaInput) {
  if (!['RC_ALTA','RC_BAJA','RA'].includes(input.kind) || !Array.isArray(input.snapshots) || !input.snapshots.length || input.snapshots.length > MAX_BATCH_QA_MEMBERS) throw new Error('Lote QA inválido (1 a 50 documentos)');
  const first = input.snapshots[0]; const ids = new Set<string>(); const numbers = new Set<string>();
  const referenceDate = limaIssueDate(first.issueDate);
  for (const snapshot of input.snapshots) {
    validateLocalInvoice(snapshot);
    if (!/^00\d{9}$/.test(snapshot.issuer.identityNumber) || snapshot.issuer.identityNumber !== first.issuer.identityNumber ||
      snapshot.issuer.legalName !== first.issuer.legalName || snapshot.companyId !== first.companyId || snapshot.currencyCode !== 'PEN' ||
      snapshot.documentTypeCode !== (input.kind === 'RA' ? '01' : '03') || limaIssueDate(snapshot.issueDate) !== referenceDate ||
      ids.has(snapshot.documentId) || numbers.has(snapshot.fullNumber)) throw new Error('No mezcle emisores, fechas, tipos o documentos repetidos');
    ids.add(snapshot.documentId); numbers.add(snapshot.fullNumber);
  }
  if (input.kind === 'RA' && (input.notDelivered !== true || !input.reasons || input.reasons.length !== input.snapshots.length || input.reasons.some(reason => typeof reason !== 'string' || !reason.trim() || reason.length > 100 || /[\x00-\x1f\x7f]/.test(reason)))) throw new Error('RA requiere motivos y declaración de documentos no entregados');
  if (input.kind !== 'RA' && (input.reasons?.length || input.notDelivered)) throw new Error('Campos RA no aplican a RC');
  return { issuerRuc: first.issuer.identityNumber, referenceDate };
}
export function buildBatchQaXml(input: BatchQaInput, identifier: string) {
  const { issuerRuc, referenceDate } = validateBatchQa(input);
  const prefix = input.kind === 'RA' ? 'RA' : 'RC';
  if (!new RegExp(`^${prefix}-\\d{8}-[1-9]\\d{0,4}$`).test(identifier)) throw new Error('Identificador QA inválido');
  const day = identifier.slice(3,11); const issue = `${day.slice(0,4)}-${day.slice(4,6)}-${day.slice(6)}`;
  const date = new Date(`${issue}T12:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== issue || issue < referenceDate) throw new Error('Fecha del lote inválida');
  const root = input.kind === 'RA' ? 'VoidedDocuments' : 'SummaryDocuments';
  const issuer = input.snapshots[0].issuer;
  const header = `<?xml version="1.0" encoding="UTF-8"?><${root} xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:${root}-1" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>${input.kind === 'RA' ? '1.0' : '1.1'}</cbc:CustomizationID><cbc:ID>${x(identifier)}</cbc:ID><cbc:ReferenceDate>${referenceDate}</cbc:ReferenceDate><cbc:IssueDate>${issue}</cbc:IssueDate><cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${issuerRuc}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${x(issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${issuerRuc}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${x(issuer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>`;
  const lines = input.snapshots.map((s, index) => input.kind === 'RA'
    ? `<sac:VoidedDocumentsLine><cbc:LineID>${index+1}</cbc:LineID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode><sac:DocumentSerialID>${s.series}</sac:DocumentSerialID><sac:DocumentNumberID>${s.number}</sac:DocumentNumberID><sac:VoidReasonDescription>${x(input.reasons![index].trim())}</sac:VoidReasonDescription></sac:VoidedDocumentsLine>`
    : `<sac:SummaryDocumentsLine><cbc:LineID>${index+1}</cbc:LineID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode><cbc:ID>${s.fullNumber}</cbc:ID><cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>${x(s.customer.identityNumber)}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>${x(s.customer.identityType)}</cbc:AdditionalAccountID></cac:AccountingCustomerParty><cac:Status><cbc:ConditionCode>${input.kind === 'RC_BAJA' ? '3' : '1'}</cbc:ConditionCode></cac:Status><sac:TotalAmount currencyID="PEN">${s.totals.payableAmount}</sac:TotalAmount><sac:BillingPayment><cbc:PaidAmount currencyID="PEN">${s.totals.taxableAmount}</cbc:PaidAmount><cbc:InstructionID>01</cbc:InstructionID></sac:BillingPayment><cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${s.totals.igvAmount}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="PEN">${s.totals.igvAmount}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal></sac:SummaryDocumentsLine>`).join('');
  return `${header}${lines}</${root}>`;
}
export function prepareBatchQa(input: BatchQaInput, identifier: string, bytes: Buffer, password: string) {
  const unsigned = buildBatchQaXml(input, identifier);
  const signed = new XmlSignerService().sign(unsigned, bytes, password, input.kind === 'RA' ? 'VoidedDocuments' : 'SummaryDocuments');
  const fileName = `${input.snapshots[0].issuer.identityNumber}-${identifier}.zip`;
  return { ...signed, fileName, zip: Buffer.from(zipSync({ [fileName.replace(/\.zip$/,'.xml')]: Buffer.from(signed.xml) }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') })) };
}
