// Fixture aislado: no es una venta ni el generador de emisión de Billing.
exports.buildPilotXml = function buildPilotXml(snapshot, buildInvoiceUbl) {
  if (snapshot.issuer.identityNumber !== '20615878481' || snapshot.environment !== 'BETA' ||
      snapshot.documentTypeCode !== '01' || snapshot.fullNumber !== 'FQ01-1') throw new Error('Contexto del piloto inválido');
  const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const name = escape(snapshot.issuer.legalName), address = escape(snapshot.issuer.address);
  const taxScheme = '<cac:TaxScheme><cbc:ID schemeID="UN/ECE 5153" schemeAgencyID="6">1000</cbc:ID><cbc:Name>IGV</cbc:Name><cbc:TaxTypeCode>VAT</cbc:TaxTypeCode></cac:TaxScheme>';
  let xml = buildInvoiceUbl(snapshot);
  xml = xml.replace('<cbc:InvoiceTypeCode listID="0101">01</cbc:InvoiceTypeCode>',
    '<cbc:InvoiceTypeCode listID="0101" listAgencyName="PE:SUNAT" listName="SUNAT:Identificador de Tipo de Documento" listURI="urn:pe:gob:sunat:cpe:see:gem:catalogos:catalogo01">01</cbc:InvoiceTypeCode><cbc:Note>PRUEBA TECNICA BETA SIN OPERACION COMERCIAL</cbc:Note>');
  const signature = `<cac:Signature><cbc:ID>signatureFactuEz</cbc:ID><cac:SignatoryParty><cac:PartyIdentification><cbc:ID>20615878481</cbc:ID></cac:PartyIdentification><cac:PartyName><cbc:Name>${name}</cbc:Name></cac:PartyName></cac:SignatoryParty><cac:DigitalSignatureAttachment><cac:ExternalReference><cbc:URI>#signatureFactuEz</cbc:URI></cac:ExternalReference></cac:DigitalSignatureAttachment></cac:Signature>`;
  xml = xml.replace('  <cac:AccountingSupplierParty>', '  ' + signature + '\n  <cac:AccountingSupplierParty>');
  const registration = `<cac:RegistrationAddress><cbc:ID schemeAgencyName="PE:INEI" schemeName="Ubigeos">${snapshot.issuer.ubigeo}</cbc:ID><cbc:AddressTypeCode>0000</cbc:AddressTypeCode><cac:AddressLine><cbc:Line>${address}</cbc:Line></cac:AddressLine><cac:Country><cbc:IdentificationCode>PE</cbc:IdentificationCode></cac:Country></cac:RegistrationAddress>`;
  xml = xml.replace(`<cbc:RegistrationName>${name}</cbc:RegistrationName></cac:PartyLegalEntity>`, `<cbc:RegistrationName>${name}</cbc:RegistrationName>${registration}</cac:PartyLegalEntity>`);
  xml = xml.replace('  <cac:TaxTotal><cbc:TaxAmount currencyID="PEN">0.18</cbc:TaxAmount></cac:TaxTotal>',
    `  <cac:PaymentTerms><cbc:ID>FormaPago</cbc:ID><cbc:PaymentMeansID>Contado</cbc:PaymentMeansID></cac:PaymentTerms><cac:TaxTotal><cbc:TaxAmount currencyID="PEN">0.18</cbc:TaxAmount><cac:TaxSubtotal><cbc:TaxableAmount currencyID="PEN">1.00</cbc:TaxableAmount><cbc:TaxAmount currencyID="PEN">0.18</cbc:TaxAmount><cac:TaxCategory>${taxScheme}</cac:TaxCategory></cac:TaxSubtotal></cac:TaxTotal>`);
  xml = xml.replace('<cbc:PayableAmount currencyID="PEN">1.18</cbc:PayableAmount>', '<cbc:TaxInclusiveAmount currencyID="PEN">1.18</cbc:TaxInclusiveAmount><cbc:PayableAmount currencyID="PEN">1.18</cbc:PayableAmount>');
  return xml;
};
