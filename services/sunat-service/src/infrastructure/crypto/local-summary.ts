import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { validateLocalInvoice, limaIssueDate, LOCAL_XML_PROFILE } from '@factuez/sunat-core';
import { zipSync } from 'fflate';
import { XmlSignerService } from './xml-signer.service';
import { escapeXml as x } from '../sunat/safe-xml';

/** RC 2.0 de ALTA, perfil QA: una boleta, PEN, IGV 18%, sin percepciones. */
export function buildLocalSummary(snapshot: FiscalDocumentSnapshot, identifier: string) {
  validateLocalInvoice(snapshot);
  if (snapshot.documentTypeCode !== '03' || snapshot.currencyCode !== 'PEN' || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(identifier)) throw new Error('Perfil RC QA inválido');
  const date = identifier.slice(3, 11); const issue = `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`;
  const parsedDate = new Date(`${issue}T12:00:00Z`);
  if (!Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== issue) throw new Error('Fecha RC inválida');
  const reference = limaIssueDate(snapshot.issueDate);
  if (issue < reference || !/^00\d{9}$/.test(snapshot.issuer.identityNumber)) throw new Error('Resumen QA fuera de contexto');
  return `<?xml version="1.0" encoding="UTF-8"?><SummaryDocuments xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:SummaryDocuments-1" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>1.1</cbc:CustomizationID><cbc:ID>${x(identifier)}</cbc:ID><cbc:ReferenceDate>${reference}</cbc:ReferenceDate><cbc:IssueDate>${issue}</cbc:IssueDate><cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${snapshot.issuer.identityNumber}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${x(snapshot.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature><cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>${snapshot.issuer.identityNumber}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>${x(snapshot.issuer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty><sac:SummaryDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode><cbc:ID>${snapshot.fullNumber}</cbc:ID><cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>${x(snapshot.customer.identityNumber)}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>${x(snapshot.customer.identityType)}</cbc:AdditionalAccountID></cac:AccountingCustomerParty><cac:Status><cbc:ConditionCode>1</cbc:ConditionCode></cac:Status><sac:TotalAmount currencyID="PEN">${snapshot.totals.payableAmount}</sac:TotalAmount><sac:BillingPayment><cbc:PaidAmount currencyID="PEN">${snapshot.totals.taxableAmount}</cbc:PaidAmount><cbc:InstructionID>01</cbc:InstructionID></sac:BillingPayment><cac:TaxTotal><cbc:TaxAmount currencyID="PEN">${snapshot.totals.igvAmount}</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxAmount currencyID="PEN">${snapshot.totals.igvAmount}</cbc:TaxAmount><cac:TaxCategory><cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal></sac:SummaryDocumentsLine></SummaryDocuments>`;
}
export function prepareLocalSummary(snapshot: FiscalDocumentSnapshot, bytes: Buffer, password: string, identifier: string) {
  const unsigned = buildLocalSummary(snapshot, identifier); const signed = new XmlSignerService().sign(unsigned, bytes, password, 'SummaryDocuments');
  const fileName = `${snapshot.issuer.identityNumber}-${identifier}`;
  return { ...signed, fileName, profile: LOCAL_XML_PROFILE, zip: Buffer.from(zipSync({ [`${fileName}.xml`]: Buffer.from(signed.xml) }, { level: 6, mtime: new Date('2020-01-01T00:00:00Z') })) };
}
