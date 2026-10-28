import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { limaIssueDate } from './local-validation';
import { validateNoteQaSnapshot, type NoteQaSnapshot } from './notes-qa';

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export function buildNoteQaUbl(note: NoteQaSnapshot, original: FiscalDocumentSnapshot): string {
  validateNoteQaSnapshot(note, original);
  const root = note.documentTypeCode === '07' ? 'CreditNote' : 'DebitNote';
  const lineRoot = `${root}Line`;
  const quantity = note.documentTypeCode === '07' ? 'CreditedQuantity' : 'DebitedQuantity';
  const monetary = note.documentTypeCode === '07' ? 'LegalMonetaryTotal' : 'RequestedMonetaryTotal';
  const amount = (tag: string, value: string) => `<cbc:${tag} currencyID="PEN">${value}</cbc:${tag}>`;
  const taxScheme = '<cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme>';
  const party = (kind: string, value: NoteQaSnapshot['customer'], supplier = false) => `<cac:${kind}><cac:Party>
    <cac:PartyIdentification><cbc:ID schemeID="${xml(value.identityType)}">${xml(value.identityNumber)}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>${xml(value.legalName)}</cbc:RegistrationName>${supplier ? `<cac:RegistrationAddress><cbc:AddressTypeCode>${xml(note.issuer.establishmentCode)}</cbc:AddressTypeCode></cac:RegistrationAddress>` : ''}</cac:PartyLegalEntity>
  </cac:Party></cac:${kind}>`;
  const lines = note.lines.map(line => `<cac:${lineRoot}>
    <cbc:ID>${line.lineNumber}</cbc:ID><cbc:${quantity} unitCode="${xml(line.unitCode)}">${line.quantity}</cbc:${quantity}>
    ${amount('LineExtensionAmount', line.lineExtensionAmount)}
    <cac:PricingReference><cac:AlternativeConditionPrice>${amount('PriceAmount', line.unitPriceWithTax)}<cbc:PriceTypeCode>01</cbc:PriceTypeCode></cac:AlternativeConditionPrice></cac:PricingReference>
    <cac:TaxTotal>${amount('TaxAmount', line.igvAmount)}<cac:TaxSubtotal>${amount('TaxableAmount', line.lineExtensionAmount)}${amount('TaxAmount', line.igvAmount)}
      <cac:TaxCategory><cbc:Percent>18.00</cbc:Percent><cbc:TaxExemptionReasonCode>10</cbc:TaxExemptionReasonCode>${taxScheme}</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
    <cac:Item><cbc:Description>${xml(line.description)}</cbc:Description></cac:Item>
    <cac:Price>${amount('PriceAmount', line.unitValue)}</cac:Price>
  </cac:${lineRoot}>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2"
 xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
 xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
 xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
 <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
 <cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>
 <cbc:ID>${xml(note.fullNumber)}</cbc:ID><cbc:IssueDate>${limaIssueDate(note.issueDate)}</cbc:IssueDate>
 <cbc:Note>PRUEBA LOCAL FICTICIA SIN VALIDEZ TRIBUTARIA</cbc:Note><cbc:DocumentCurrencyCode>PEN</cbc:DocumentCurrencyCode>
 <cac:DiscrepancyResponse><cbc:ReferenceID>${xml(note.reference.fullNumber)}</cbc:ReferenceID>
  <cbc:ResponseCode>${note.reasonCode}</cbc:ResponseCode><cbc:Description>${xml(note.reasonDescription)}</cbc:Description></cac:DiscrepancyResponse>
 <cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>${xml(note.reference.fullNumber)}</cbc:ID>
  <cbc:DocumentTypeCode>${note.reference.documentTypeCode}</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference>
 <cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${note.issuer.identityNumber}</cbc:ID></cac:PartyIdentification>
  <cac:PartyName><cbc:Name>${xml(note.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty>
  <cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>
 ${party('AccountingSupplierParty', note.issuer, true)}${party('AccountingCustomerParty', note.customer)}
 <cac:TaxTotal>${amount('TaxAmount', note.totals.igvAmount)}<cac:TaxSubtotal>${amount('TaxableAmount', note.totals.taxableAmount)}${amount('TaxAmount', note.totals.igvAmount)}<cac:TaxCategory>${taxScheme}</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>
 <cac:${monetary}>${amount('LineExtensionAmount', note.totals.taxableAmount)}${amount('TaxInclusiveAmount', note.totals.payableAmount)}${amount('PayableAmount', note.totals.payableAmount)}</cac:${monetary}>
 ${lines}
</${root}>`;
}
