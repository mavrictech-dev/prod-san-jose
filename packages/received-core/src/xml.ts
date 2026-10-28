import { createHash } from 'node:crypto';
import type { Element } from '@xmldom/xmldom';
import type { ReceivedDocumentProjectionV1, ReceivedParty, ReceivedTax, ReceivedItem } from '@factuez/contracts';
import { CBC, CAC, EXT, SAC, DS, children, ensure, safeReceivedXml } from './safety';

const UBL = 'urn:oasis:names:specification:ubl:schema:xsd:';
const SUNAT = 'urn:sunat:names:specification:ubl:peru:schema:xsd:';
const day = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const decimal = (s: string) => { ensure(/^[+-]?(?:\d{1,30})(?:\.\d{1,20})?$/.test(s), 'Decimal XML inválido'); return s; };

/** Incoming evidence only. supplier denotes the document issuer (AgentParty for
 * retention/perception), recipient denotes its receiver, never tenant authority.
 * No XSD, signature mathematics, PKI, SUNAT status or ownership checks here. */
export function parseReceivedXml(bytes: Uint8Array): ReceivedDocumentProjectionV1 {
  const root = safeReceivedXml(bytes), kind = root.localName!;
  const sales = ['Invoice', 'CreditNote', 'DebitNote'].includes(kind), guide = kind === 'DespatchAdvice',
    agent = ['Perception', 'Retention'].includes(kind);
  ensure((sales || guide) && root.namespaceURI === `${UBL}${kind}-2` || agent && root.namespaceURI === `${SUNAT}${kind}-1`, 'Tipo o namespace XML no soportado');
  const warnings: string[] = [], consumed = new Set<Element>([root]), attributes = new Set<AttrKey>();
  type AttrKey = string;
  const attrKeys = new Map<Element, number>(); let nextKey = 0;
  const key = (node: Element, name: string) => { if (!attrKeys.has(node)) attrKeys.set(node, ++nextKey); return `${attrKeys.get(node)}:${name}`; };
  const warn = (message: string) => { if (warnings.length < 200 && !warnings.includes(message)) warnings.push(message); };
  const many = (parent: Element | null, name: string, ns = CAC, max = 1000): Element[] => {
    if (!parent) return [];
    const sameName = children(parent).filter(n => n.localName === name);
    ensure(sameName.every(n => n.namespaceURI === ns), `Namespace inválido: ${name}`);
    ensure(sameName.length <= max, `Demasiados nodos: ${name}`);
    sameName.forEach(n => consumed.add(n)); return sameName;
  };
  const one = (parent: Element | null, name: string, ns = CAC, required = false): Element | null => {
    const nodes = many(parent, name, ns, 1);
    ensure(!required || nodes.length === 1, `Falta nodo XML: ${name}`); return nodes[0] ?? null;
  };
  const text = (node: Element | null): string | null => {
    if (!node) return null;
    ensure(children(node).length === 0, `Texto XML ambiguo: ${node.localName}`);
    const value = (node.textContent ?? '').trim();
    ensure(value.length <= 4096, `Texto XML excede límite: ${node.localName}`);
    if (!value) { warn(`Campo vacío: ${node.localName}`); return null; } return value;
  };
  const leaf = (parent: Element | null, name: string, required = false, ns = CBC): string | null => {
    const value = text(one(parent, name, ns, required));
    ensure(!required || value !== null, `Campo XML vacío: ${name}`);
    if (value === null) warn(`Campo ausente: ${parent?.localName ?? kind}/${name}`);
    return value;
  };
  const attr = (node: Element | null, name: string): string | null => {
    if (!node || !node.hasAttribute(name)) { warn(`Atributo ausente: ${node?.localName ?? kind}/@${name}`); return null; }
    attributes.add(key(node, name)); return node.getAttribute(name) || null;
  };
  const version = leaf(root, 'UBLVersionID'), customization = leaf(root, 'CustomizationID');
  ensure(version === null || (agent ? version === '2.0' : ['2.0', '2.1'].includes(version)), 'Versión UBL no soportada');
  if (version || customization) warn('Metadatos UBLVersionID/CustomizationID conservados en XML original');
  const typeField = sales ? kind === 'Invoice' ? 'InvoiceTypeCode' : kind + 'TypeCode' : guide ? 'DespatchAdviceTypeCode' : 'DocumentTypeCode';
  const explicitType = leaf(root, typeField, kind === 'Invoice' || guide);
  const documentType = kind === 'Invoice' || guide ? explicitType! : kind === 'CreditNote' ? '07' : kind === 'DebitNote' ? '08' : kind === 'Perception' ? '40' : '20';
  ensure(kind === 'Invoice' ? ['01', '03'].includes(documentType) : guide ? ['09', '31'].includes(documentType) : explicitType === null || explicitType === documentType, 'Código de documento no soportado o contradictorio');
  for (const other of ['InvoiceTypeCode', 'CreditNoteTypeCode', 'DebitNoteTypeCode', 'DespatchAdviceTypeCode', 'DocumentTypeCode']) {
    if (other !== typeField) ensure(children(root).every(n => n.localName !== other), 'Código de documento ajeno a la raíz');
  }
  const fullNumber = leaf(root, 'ID', true)!;
  ensure(/^[A-Za-z0-9]{1,8}-\d{1,12}$/.test(fullNumber) && !/-0+$/.test(fullNumber), 'Número de documento inválido');
  const [series, number] = fullNumber.split('-'), issueDate = leaf(root, 'IssueDate', true)!;
  ensure(day(issueDate), 'Fecha de emisión inválida');
  const issueTime = leaf(root, 'IssueTime'), dueDate = leaf(root, 'DueDate');
  ensure(issueTime === null || /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:0\d|1[0-4]):[0-5]\d)?$/.test(issueTime), 'Hora de emisión inválida');
  ensure(dueDate === null || day(dueDate), 'Fecha de vencimiento inválida');
  const declaredCurrency = leaf(root, 'DocumentCurrencyCode');
  let currencyCode = declaredCurrency;
  if (agent && currencyCode === null) currencyCode = attr(one(root, 'TotalInvoiceAmount', CBC), 'currencyID');
  ensure(currencyCode === null || /^[A-Z]{3}$/.test(currencyCode), 'Moneda XML inválida');
  const amount = (parent: Element | null, name: string, ns = CBC): string | null => {
    const node = one(parent, name, ns), value = text(node);
    if (value === null) { warn(`Importe ausente: ${parent?.localName ?? kind}/${name}`); return null; }
    const currency = attr(node, 'currencyID');
    ensure(currency === null || /^[A-Z]{3}$/.test(currency), 'Moneda de importe inválida');
    // Tax accounting currencies and source invoices may differ: preserve, never convert.
    if (currency !== null && currency !== currencyCode) warn(`Moneda distinta (${currency}): ${parent?.localName}/${name}; consulte XML original`);
    return decimal(value);
  };
  function party(name: string, direct = false): ReceivedParty {
    const wrapper = one(root, name), p = direct ? wrapper : one(wrapper, 'Party');
    const identification = one(p, 'PartyIdentification'), id = one(identification, 'ID', CBC), legal = one(p, 'PartyLegalEntity');
    const legacyId = leaf(wrapper, 'CustomerAssignedAccountID'), legacyType = leaf(wrapper, 'AdditionalAccountID');
    const partyId = text(id), partyType = attr(id, 'schemeID');
    ensure(legacyId === null || partyId === null || legacyId === partyId, 'Identidad XML contradictoria');
    ensure(legacyType === null || partyType === null || legacyType === partyType, 'Tipo de identidad contradictorio');
    const identityNumber = partyId ?? legacyId, identityType = partyType ?? legacyType;
    const trade = one(p, 'PartyName'), registered = one(legal, 'RegistrationAddress'), postal = one(p, 'PostalAddress');
    const legalName = leaf(legal, 'RegistrationName') ?? leaf(trade, 'Name');
    if (identityNumber === null) warn(`Identidad ausente: ${name}`);
    if (identityType === '6' && identityNumber !== null) ensure(/^\d{11}$/.test(identityNumber), 'RUC XML inválido');
    const addressNode = registered ?? postal;
    // Retain both addresses in the original; registration address takes precedence.
    if (registered && postal) warn(`Dos direcciones en ${name}; dirección postal en XML original`);
    const addressLines = many(addressNode, 'AddressLine', CAC, 20).map(n => leaf(n, 'Line')).filter((s): s is string => s !== null);
    const address = addressLines.length ? addressLines.join(', ') : leaf(addressNode, 'StreetName');
    return { identityNumber, identityType, legalName, address };
  }
  const supplier = party(agent ? 'AgentParty' : guide ? 'DespatchSupplierParty' : 'AccountingSupplierParty', agent),
    recipient = party(agent ? 'ReceiverParty' : guide ? 'DeliveryCustomerParty' : 'AccountingCustomerParty', agent);
  function taxes(parent: Element): ReceivedTax[] {
    const result: ReceivedTax[] = [];
    for (const total of many(parent, 'TaxTotal', CAC, 20)) {
      const totalAmount = amount(total, 'TaxAmount'), subtotals = many(total, 'TaxSubtotal', CAC, 100);
      if (!subtotals.length) {
        result.push({ schemeId: null, name: null, amount: totalAmount, taxableAmount: null, percent: null, affectationCode: null });
        warn(`Desglose tributario ausente: ${parent.localName}`);
      } else {
        // Total and subtotal are different levels: do not double-count in the DTO.
        warn(`TaxTotal/TaxAmount conservado en XML original: ${parent.localName}`);
        for (const subtotal of subtotals) {
          const category = one(subtotal, 'TaxCategory'), scheme = one(category, 'TaxScheme');
          const categoryPercent = leaf(category, 'Percent'), subtotalPercent = leaf(subtotal, 'Percent');
          ensure(categoryPercent === null || subtotalPercent === null || decimal(categoryPercent) === decimal(subtotalPercent), 'Porcentaje tributario contradictorio');
          const percent = categoryPercent ?? subtotalPercent;
          const tax = { schemeId: leaf(scheme, 'ID'), name: leaf(scheme, 'Name'), amount: amount(subtotal, 'TaxAmount'),
            taxableAmount: amount(subtotal, 'TaxableAmount'), percent: percent === null ? null : decimal(percent), affectationCode: leaf(category, 'TaxExemptionReasonCode') };
          result.push(tax);
          if (tax.schemeId !== '1000' || percent !== null && !/^\+?0*18(?:\.0+)?$/.test(percent)) warn(`Tributo/tasa sin normalizar: ${tax.schemeId ?? 'desconocido'}/${percent ?? 'ausente'}`);
        }
      }
    }
    if (!result.length) warn(`Tributos ausentes: ${parent.localName}`);
    return result;
  }
  const lineName = guide ? 'DespatchLine' : kind === 'CreditNote' ? 'CreditNoteLine' : kind === 'DebitNote' ? 'DebitNoteLine' : 'InvoiceLine';
  const quantityName = guide ? 'DeliveredQuantity' : kind === 'CreditNote' ? 'CreditedQuantity' : kind === 'DebitNote' ? 'DebitedQuantity' : 'InvoicedQuantity';
  const ids = new Set<string>();
  const items: ReceivedItem[] = agent ? [] : many(root, lineName).map(line => {
    const lineId = leaf(line, 'ID', true)!;
    ensure(!ids.has(lineId), 'Ítem XML duplicado'); ids.add(lineId);
    const qtyNode = one(line, quantityName, CBC), quantity = text(qtyNode), unitCode = attr(qtyNode, 'unitCode');
    if (quantity === null) warn(`Cantidad ausente: ${lineName}/${lineId}`);
    const item = one(line, 'Item'), price = one(line, 'Price'), pricing = one(line, 'PricingReference');
    const supplierCode = leaf(one(item, 'SellersItemIdentification'), 'ID');
    const commodity = many(item, 'CommodityClassification', CAC, 20);
    const sunatCodes = commodity.map(n => leaf(n, 'ItemClassificationCode')).filter((s): s is string => s !== null);
    ensure(new Set(sunatCodes).size <= 1, 'Código SUNAT de ítem ambiguo');
    const descriptions = many(item, 'Description', CBC, 20).map(n => text(n)).filter((s): s is string => s !== null);
    if (!descriptions.length) warn(`Descripción ausente: ${lineId}`);
    const alternatives = many(pricing, 'AlternativeConditionPrice', CAC, 20);
    let unitPrice: string | null = null;
    const priceTypes = new Set<string>();
    for (const alternative of alternatives) {
      const type = leaf(alternative, 'PriceTypeCode', true)!;
      ensure(!priceTypes.has(type), 'Precio alternativo duplicado'); priceTypes.add(type);
      const value = amount(alternative, 'PriceAmount');
      if (type === '01') unitPrice = value;
      else warn(`Precio alternativo ${type} conservado en XML original: ${lineId}`);
    }
    if (unitPrice === null) warn(`Precio unitario ausente: ${lineId}`);
    const allowances = many(line, 'AllowanceCharge', CAC, 100).map(a => {
      const charge = leaf(a, 'ChargeIndicator', true)!;
      ensure(['true', 'false', '1', '0'].includes(charge), 'Indicador de cargo inválido');
      return { charge: charge === 'true' || charge === '1', amount: amount(a, 'Amount'), reason: leaf(a, 'AllowanceChargeReason') };
    });
    return { lineId, supplierCode, sunatCode: sunatCodes[0] ?? null, description: descriptions.join('\n'), unitCode,
      quantity: quantity === null ? null : decimal(quantity), unitValue: amount(price, 'PriceAmount'), unitPrice,
      lineExtensionAmount: amount(line, 'LineExtensionAmount'), allowances, taxes: taxes(line) };
  });
  if (!items.length) warn(agent ? 'Este tipo referencia comprobantes; no declara ítems comerciales' : 'Ítems ausentes');
  for (const other of ['InvoiceLine', 'CreditNoteLine', 'DebitNoteLine', 'DespatchLine']) {
    if (agent || other !== lineName) ensure(children(root).every(n => n.localName !== other), 'Ítems ajenos al tipo de documento');
  }
  const monetary = one(root, kind === 'DebitNote' ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal');
  ensure(!children(root).some(n => n.localName === (kind === 'DebitNote' ? 'LegalMonetaryTotal' : 'RequestedMonetaryTotal')), 'Totales ajenos al tipo de documento');
  const totals = { lineExtensionAmount: amount(monetary, 'LineExtensionAmount'), taxExclusiveAmount: amount(monetary, 'TaxExclusiveAmount'),
    taxInclusiveAmount: amount(monetary, 'TaxInclusiveAmount'), allowanceTotalAmount: amount(monetary, 'AllowanceTotalAmount'),
    chargeTotalAmount: amount(monetary, 'ChargeTotalAmount'), prepaidAmount: amount(monetary, 'PrepaidAmount'), payableAmount: amount(monetary, 'PayableAmount') };
  // TotalInvoiceAmount is the aggregate amount retained/perceived, not a sales payable.
  // SUNATTotalPaid/Cashed describe paid/cashed totals. The DTO has no accurate field.
  if (agent) {
    amount(root, 'TotalInvoiceAmount'); amount(root, kind === 'Retention' ? 'SUNATTotalPaid' : 'SUNATTotalCashed', SAC);
    const system = leaf(root, `SUNAT${kind}SystemCode`, false, SAC), percent = leaf(root, `SUNAT${kind}Percent`, false, SAC);
    if (percent !== null) decimal(percent);
    warn(`Totales/régimen ${kind} (${system ?? 'ausente'}, ${percent ?? 'ausente'}) conservados en XML original; no equivalen a total de venta`);
  }
  const paymentTerms = many(root, 'PaymentTerms', CAC, 100).map(p => {
    const date = leaf(p, 'PaymentDueDate'); ensure(date === null || day(date), 'Fecha de cuota inválida');
    return { id: leaf(p, 'ID'), means: leaf(p, 'PaymentMeansID'), amount: amount(p, 'Amount'), dueDate: date };
  });
  const references: ReceivedDocumentProjectionV1['references'] = [];
  const reference = (node: Element, refKind: string, idName = 'ID') => {
    const id = one(node, idName, CBC), number = text(id), explicit = leaf(node, 'DocumentTypeCode'), fromAttr = attr(id, 'schemeID');
    ensure(explicit === null || fromAttr === null || explicit === fromAttr, 'Tipo de referencia contradictorio');
    references.push({ kind: refKind, number, documentType: explicit ?? fromAttr });
  };
  for (const billing of many(root, 'BillingReference', CAC, 100)) {
    for (const name of ['InvoiceDocumentReference', 'CreditNoteDocumentReference', 'DebitNoteDocumentReference', 'DespatchDocumentReference', 'ReceiptDocumentReference', 'AdditionalDocumentReference']) {
      const node = one(billing, name); if (node) reference(node, name);
    }
  }
  for (const name of ['AdditionalDocumentReference', 'DespatchDocumentReference', 'ReceiptDocumentReference', 'OrderReference', 'ContractDocumentReference', 'DiscrepancyResponse']) {
    for (const node of many(root, name, CAC, 100)) reference(node, name, name === 'DiscrepancyResponse' ? 'ReferenceID' : 'ID');
  }
  if (agent) for (const node of many(root, `SUNAT${kind}DocumentReference`, SAC, 1000)) reference(node, `SUNAT${kind}DocumentReference`);
  const notes = many(root, 'Note', CBC, 100).map(n => text(n)).filter((s): s is string => s !== null);
  const headerTaxes = taxes(root);
  // Enforce structural extension cardinality without treating contents as business data.
  const extensions = one(root, 'UBLExtensions', EXT);
  for (const extension of many(extensions, 'UBLExtension', EXT, 20)) one(extension, 'ExtensionContent', EXT, true);
  const signature = root.ownerDocument!.getElementsByTagNameNS(DS, 'Signature').length > 0;
  warn(signature ? 'Firma presente sin verificación matemática ni confianza oficial' : 'Firma XML ausente');
  const xmlSha256 = createHash('sha256').update(bytes).digest('hex');
  // Bounded namespace-qualified pointers make every unmapped field discoverable
  // in the original artifact. No normalized rewrite of signed bytes is produced.
  let unmapped = 0, shown = 0;
  const pending = [{ node: root, path: kind }];
  while (pending.length) {
    const { node, path } = pending.pop()!;
    if (!consumed.has(node)) {
      unmapped++;
      if (shown++ < 60) warn(`Campo no proyectado: ${path}; XML original ${xmlSha256}`);
    }
    for (let i = 0; i < node.attributes.length; i++) {
      const a = node.attributes.item(i)!;
      if (a.namespaceURI !== 'http://www.w3.org/2000/xmlns/' && !attributes.has(key(node, a.name))) {
        unmapped++; if (shown++ < 60) warn(`Atributo no proyectado: ${path}/@${a.name}; XML original ${xmlSha256}`);
      }
    }
    children(node).forEach((child, i) => pending.push({ node: child, path: `${path}/{${child.namespaceURI}}${child.localName}[${i + 1}]` }));
  }
  if (unmapped) warn(`Proyección parcial: ${unmapped} campos/atributos no proyectados; consulte XML original ${xmlSha256}`);
  if (warnings.length >= 199) warnings.splice(199, warnings.length - 199, `Advertencias limitadas; consulte XML original ${xmlSha256}`);
  return { schemaVersion: 'factuez.received-document.v1', documentType, fullNumber, series, number, issueDate, issueTime, dueDate,
    currencyCode, supplier, recipient, items, totals, taxes: headerTaxes, paymentTerms, references, notes, warnings, xmlSha256,
    signature: { status: signature ? 'PRESENT_UNVERIFIED' : 'MISSING', officialTrust: false } };
}
