import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { limaIssueDate } from './local-validation';
import { validateInvoicePaymentTerms, validateInvoiceSupportedFields, type FiscalValidationMode } from './fiscal-rules';
import { formatScaled, parseDecimal } from './tax';

function xml(value: string): string {
  if (typeof value !== 'string' || /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(value)) throw new Error('Texto XML inválido');
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function buildInvoiceUbl(document: FiscalDocumentSnapshot, options: { mode: FiscalValidationMode } = { mode: 'LOCAL_DEVELOPMENT' }): string {
  if (document.documentTypeCode !== '01' && document.documentTypeCode !== '03') {
    throw new Error(`Tipo no soportado por Invoice UBL: ${document.documentTypeCode}`);
  }
  if (document.lines.length === 0 || document.lines.length > 500) throw new Error('El documento requiere de 1 a 500 líneas');
  if (!['PEN', 'USD'].includes(document.currencyCode) || !['01', '03'].includes(document.documentTypeCode)) throw new Error('Cabecera XML inválida');
  const profileIssues = [...validateInvoiceSupportedFields(document), ...validateInvoicePaymentTerms(document, options)];
  if (profileIssues.length) throw new Error(`Snapshot fuera del perfil Invoice: ${profileIssues.map(issue => `${issue.code}@${issue.path}`).join(', ')}`);
  if (document.operationTypeCode !== '0101' || document.lines.some(line => line.taxAffectationCode !== '10' || !['18', '18.00'].includes(line.igvRate)))
    throw new Error('Perfil tributario XML no implementado: sólo operación 0101, afectación 10 e IGV 18%');
  for (const line of document.lines) {
    if (!Number.isSafeInteger(line.lineNumber) || line.lineNumber < 1 ||
      [line.quantity, line.lineExtensionAmount, line.unitPriceWithTax, line.igvAmount, line.igvRate, line.unitValue].some(value => !/^\d{1,12}(\.\d{1,6})?$/.test(value))) throw new Error('Importe XML inválido');
  }
  if (Object.values(document.totals).some(value => !/^\d{1,12}(\.\d{1,6})?$/.test(value))) throw new Error('Total XML inválido');

  // No paymentTerms on historical snapshots means no PaymentTerms XML; never infer Contado.
  // Each SUNAT identifier has its own aggregate (XLSX rule 3461). Preserve frozen order.
  const terms = document.paymentTerms;
  const paymentAmount = (value: string) => `<cbc:Amount currencyID="${document.currencyCode}">${formatScaled(parseDecimal(value, 2), 2)}</cbc:Amount>`;
  const paymentTerm = (id: string, amount = '', dueDate = '') => `
  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>${id}</cbc:PaymentMeansID>${amount}${dueDate ? `<cbc:PaymentDueDate>${dueDate}</cbc:PaymentDueDate>` : ''}</cac:PaymentTerms>`;
  const paymentTerms = terms === undefined ? '' : terms.type === 'CONTADO' ? paymentTerm('Contado') :
    paymentTerm('Credito', paymentAmount(terms.pendingAmount)) + terms.installments.map((installment, index) =>
      paymentTerm(`Cuota${String(index + 1).padStart(3, '0')}`, paymentAmount(installment.amount), installment.dueDate)).join('');

  // Preserve the exact historical local representation/hash. Modern fiscal
  // metadata belongs to REAL_PREPARATION, not a rewrite of archived QA XML.
  const modern = options.mode === 'REAL_PREPARATION';
  const currency = document.currencyCode;
  const taxScheme = '<cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme>';
  const registrationAddress = `<cac:RegistrationAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${xml(document.issuer.ubigeo)}</cbc:ID><cbc:AddressTypeCode>${xml(document.issuer.establishmentCode)}</cbc:AddressTypeCode>${document.issuer.address ? `<cac:AddressLine><cbc:Line>${xml(document.issuer.address)}</cbc:Line></cac:AddressLine>` : ''}<cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>`;

  const lines = document.lines.map((line) => `
  <cac:InvoiceLine>
    <cbc:ID>${line.lineNumber}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="${xml(line.unitCode)}">${line.quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${document.currencyCode}">${line.lineExtensionAmount}</cbc:LineExtensionAmount>
    <cac:PricingReference><cac:AlternativeConditionPrice>
      <cbc:PriceAmount currencyID="${document.currencyCode}">${line.unitPriceWithTax}</cbc:PriceAmount>
      <cbc:PriceTypeCode>01</cbc:PriceTypeCode>
    </cac:AlternativeConditionPrice></cac:PricingReference>
    <cac:TaxTotal><cbc:TaxAmount currencyID="${document.currencyCode}">${line.igvAmount}</cbc:TaxAmount>
      <cac:TaxSubtotal><cbc:TaxableAmount currencyID="${document.currencyCode}">${line.lineExtensionAmount}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${document.currencyCode}">${line.igvAmount}</cbc:TaxAmount>
        <cac:TaxCategory><cbc:Percent>${line.igvRate}</cbc:Percent>
          <cbc:TaxExemptionReasonCode>${xml(line.taxAffectationCode)}</cbc:TaxExemptionReasonCode>
          <cac:TaxScheme><cbc:ID>1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme>
        </cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Description>${xml(line.description)}</cbc:Description></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${document.currencyCode}">${line.unitValue}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
 xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
 xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2"
 xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2">
  <ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions>
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID><cbc:CustomizationID>2.0</cbc:CustomizationID>
  <cbc:ID>${xml(document.fullNumber)}</cbc:ID><cbc:IssueDate>${limaIssueDate(document.issueDate)}</cbc:IssueDate>
  <cbc:InvoiceTypeCode listID="${xml(document.operationTypeCode)}"${modern ? ' listAgencyName="PE:SUNAT" listName="Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01"' : ''}>${document.documentTypeCode}</cbc:InvoiceTypeCode>
  <cbc:DocumentCurrencyCode>${document.currencyCode}</cbc:DocumentCurrencyCode>
${modern ? `  <cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>${xml(document.issuer.identityNumber)}</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${xml(document.issuer.legalName)}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>\n` : ''}  <cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="6">${xml(document.issuer.identityNumber)}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>${xml(document.issuer.legalName)}</cbc:RegistrationName>${modern ? registrationAddress : ''}</cac:PartyLegalEntity>
  </cac:Party></cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty><cac:Party><cac:PartyIdentification><cbc:ID schemeID="${xml(document.customer.identityType)}">${xml(document.customer.identityNumber)}</cbc:ID></cac:PartyIdentification>
    <cac:PartyLegalEntity><cbc:RegistrationName>${xml(document.customer.legalName)}</cbc:RegistrationName></cac:PartyLegalEntity>
  </cac:Party></cac:AccountingCustomerParty>${paymentTerms}
  <cac:TaxTotal><cbc:TaxAmount currencyID="${currency}">${document.totals.igvAmount}</cbc:TaxAmount>${modern ? `<cac:TaxSubtotal><cbc:TaxableAmount currencyID="${currency}">${document.totals.taxableAmount}</cbc:TaxableAmount><cbc:TaxAmount currencyID="${currency}">${document.totals.igvAmount}</cbc:TaxAmount><cac:TaxCategory>${taxScheme}</cac:TaxCategory></cac:TaxSubtotal>` : ''}</cac:TaxTotal>
  <cac:LegalMonetaryTotal><cbc:LineExtensionAmount currencyID="${document.currencyCode}">${document.totals.taxableAmount}</cbc:LineExtensionAmount>
${modern ? `    <cbc:TaxInclusiveAmount currencyID="${currency}">${document.totals.payableAmount}</cbc:TaxInclusiveAmount>\n` : ''}    <cbc:PayableAmount currencyID="${document.currencyCode}">${document.totals.payableAmount}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${lines}
</Invoice>`;
}
