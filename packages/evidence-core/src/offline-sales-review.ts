import { createHash } from 'node:crypto';
import { isProxy } from 'node:util/types';
import type { Element } from '@xmldom/xmldom';
import { OFFLINE_REVIEW_POLICY, OfflineReviewError, inspectOfflineCdr,
  offlineXmlDiagnostics, validateOfflineReviewScope } from './offline-review';

const CBC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
const CAC = 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2';
const EXT = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const DS = 'http://www.w3.org/2000/09/xmldsig#';
const { parse, children, one, text, plain, withinScope, assessment } = offlineXmlDiagnostics;
function requireValue(ok: unknown, code: string): asserts ok { if (!ok) throw new OfflineReviewError(code); }
export type OfflineSalesType = '01' | '03' | '07' | '08';
const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const cents = (value: string) => BigInt(value.replace('.', ''));
const money = (value: bigint) => `${value < 0n ? '-' : ''}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, '0')}`;
function decimal(value: string, scale: number) {
  requireValue(new RegExp(`^(0|[1-9][0-9]{0,11})(\\.[0-9]{1,${scale}})?$`).test(value), 'SALES_DECIMAL');
  const [whole, fraction = ''] = value.split('.'); return `${whole}.${fraction.padEnd(scale, '0')}`;
}

/** Read-only UBL 2.1 projection. Does not accept a real document into the
 * SYNTHETIC history runner, validate all fiscal rules, or declare acceptance.
 * Unknown elements are explicitly inventoried; no claim of complete mapping. */
export function inspectOfflineSales(xml: unknown, scopeInput: unknown) {
  const scope = validateOfflineReviewScope(scopeInput);
  // Determine only the root name from the bounded strict parser; no regex-based
  // content substitution and no mutation of the signed XML.
  let parsed: ReturnType<typeof parse> | undefined;
  for (const kind of ['Invoice', 'CreditNote', 'DebitNote'] as const) {
    try { parsed = parse(xml, kind); break; }
    catch (error) { if (!(error instanceof OfflineReviewError) || error.code !== 'XML_ROOT') throw error; }
  }
  requireValue(parsed, 'SALES_ROOT');
  const root = parsed.root, consumed = new Set<Element>([root]);
  const mark = (node: Element | null) => { if (node) consumed.add(node); return node; };
  const get = (parent: Element, ns: string, name: string, required = true) => mark(one(parent, ns, name, required));
  const agg = (parent: Element, name: string, required = true) => get(parent, CAC, name, required);
  const leaf = (parent: Element, name: string, required = true) => text(get(parent, CBC, name, required));
  const many = (parent: Element, ns: string, name: string, max = 1000) => {
    const nodes = children(parent, ns, name); requireValue(nodes.length <= max, 'SALES_NODE_LIMIT');
    nodes.forEach(n => consumed.add(n)); return nodes;
  };
  requireValue(leaf(root, 'UBLVersionID') === '2.1' && leaf(root, 'CustomizationID') === '2.0', 'SALES_VERSION');
  const invoiceType = root.localName === 'Invoice' ? get(root, CBC, 'InvoiceTypeCode')! : null;
  const type = (invoiceType ? text(invoiceType) : root.localName === 'CreditNote' ? '07' : '08') as OfflineSalesType;
  requireValue(['01', '03', '07', '08'].includes(type), 'SALES_TYPE');
  const fullNumber = leaf(root, 'ID')!, issueDate = leaf(root, 'IssueDate')!, issueTime = leaf(root, 'IssueTime', false);
  requireValue(/^[FB][A-Z0-9]{3}-[0-9]{1,8}$/.test(fullNumber) && !/-0+$/.test(fullNumber) &&
    (type !== '01' || fullNumber.startsWith('F')) && (type !== '03' || fullNumber.startsWith('B')), 'SALES_NUMBER');
  requireValue(issueTime === null || /^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.\d{1,3})?$/.test(issueTime), 'SALES_TIME');
  const currency = leaf(root, 'DocumentCurrencyCode')!;
  requireValue(/^[A-Z]{3}$/.test(currency), 'SALES_CURRENCY');
  const operationTypeCode = invoiceType?.getAttribute('listID') || leaf(root, 'ProfileID', false);
  const amount = (parent: Element, name: string, required = true, scale = 2) => {
    const node = get(parent, CBC, name, required); if (!node) return null;
    requireValue(node.getAttribute('currencyID') === currency, 'SALES_AMOUNT_CURRENCY');
    return decimal(text(node)!, scale);
  };
  function address(parent: Element) {
    const line = agg(parent, 'AddressLine', false), country = agg(parent, 'Country', false);
    return { line: line ? leaf(line, 'Line', false) : null, ubigeo: leaf(parent, 'ID', false),
      establishmentCode: leaf(parent, 'AddressTypeCode', false), city: leaf(parent, 'CityName', false),
      district: leaf(parent, 'District', false), department: leaf(parent, 'CountrySubentity', false),
      street: leaf(parent, 'StreetName', false), countryCode: country ? leaf(country, 'IdentificationCode', false) : null };
  }
  function party(name: string, supplier: boolean) {
    const aggregate = agg(root, name)!, p = agg(aggregate, 'Party')!;
    const identification = agg(p, 'PartyIdentification')!, id = get(identification, CBC, 'ID')!;
    const legal = agg(p, 'PartyLegalEntity')!, trade = agg(p, 'PartyName', false);
    const registered = agg(legal, 'RegistrationAddress', false), postal = agg(p, 'PostalAddress', false);
    const identityNumber = text(id)!, identityType = id.getAttribute('schemeID');
    if (supplier) requireValue(identityType === '6' && /^\d{11}$/.test(identityNumber), 'SALES_ISSUER');
    return { identityNumber, identityType, legalName: leaf(legal, 'RegistrationName')!,
      tradeName: trade ? leaf(trade, 'Name', false) : null,
      registeredAddress: registered ? address(registered) : null, postalAddress: postal ? address(postal) : null };
  }
  const issuer = party('AccountingSupplierParty', true), customer = party('AccountingCustomerParty', false);
  withinScope(issuer.identityNumber, issueDate, scope);
  const findings: Array<{ code: string; path: string }> = [];
  const finding = (condition: boolean, code: string, path: string) => { if (!condition) findings.push({ code, path }); };
  function taxes(parent: Element, path: string) {
    return many(parent, CAC, 'TaxTotal', 10).map((total, index) => {
      const totalAmount = amount(total, 'TaxAmount')!;
      const subtotals = many(total, CAC, 'TaxSubtotal', 20).map(subtotal => {
        const category = agg(subtotal, 'TaxCategory')!, scheme = agg(category, 'TaxScheme')!;
        const percent = leaf(category, 'Percent', false);
        return { schemeId: leaf(scheme, 'ID')!, name: leaf(scheme, 'Name', false),
          taxType: leaf(scheme, 'TaxTypeCode', false), taxableAmount: amount(subtotal, 'TaxableAmount', false),
          taxAmount: amount(subtotal, 'TaxAmount')!, percent: percent === null ? null : decimal(percent, 6),
          affectation: leaf(category, 'TaxExemptionReasonCode', false) };
      });
      if (subtotals.length) finding(subtotals.reduce((sum, s) => sum + cents(s.taxAmount), 0n) === cents(totalAmount),
        'TAX_SUBTOTAL_SUM_MISMATCH', `${path}.${index}`);
      else findings.push({ code: 'TAX_SUBTOTALS_NOT_DECLARED', path: `${path}.${index}` });
      return { taxAmount: totalAmount, subtotals };
    });
  }
  function allowances(parent: Element) {
    return many(parent, CAC, 'AllowanceCharge', 20).map(a => {
      const charge = leaf(a, 'ChargeIndicator'); requireValue(['true', 'false'].includes(charge!), 'SALES_ALLOWANCE');
      const factor = leaf(a, 'MultiplierFactorNumeric', false);
      return { charge: charge === 'true', reasonCode: leaf(a, 'AllowanceChargeReasonCode', false),
        reason: leaf(a, 'AllowanceChargeReason', false), amount: amount(a, 'Amount')!,
        baseAmount: amount(a, 'BaseAmount', false), factor: factor === null ? null : decimal(factor, 6) };
    });
  }
  const lineName = type === '07' ? 'CreditNoteLine' : type === '08' ? 'DebitNoteLine' : 'InvoiceLine';
  const quantityName = type === '07' ? 'CreditedQuantity' : type === '08' ? 'DebitedQuantity' : 'InvoicedQuantity';
  const lineIds = new Set<string>();
  const items = many(root, CAC, lineName).map((line, index) => {
    const id = leaf(line, 'ID')!, quantityNode = get(line, CBC, quantityName)!;
    requireValue(/^[0-9]{1,6}$/.test(id) && !lineIds.has(id), 'SALES_LINE_ID'); lineIds.add(id);
    const quantity = decimal(text(quantityNode)!, 6), unitCode = quantityNode.getAttribute('unitCode');
    requireValue(cents(quantity) > 0n && /^[A-Z0-9]{2,3}$/.test(unitCode ?? ''), 'SALES_QUANTITY');
    const item = agg(line, 'Item')!, product = agg(item, 'SellersItemIdentification', false), price = agg(line, 'Price')!;
    const pricing = agg(line, 'PricingReference', false);
    const alternatives = pricing ? many(pricing, CAC, 'AlternativeConditionPrice', 10).map(p =>
      ({ priceTypeCode: leaf(p, 'PriceTypeCode')!, amount: amount(p, 'PriceAmount', true, 6)! })) : [];
    return { id, quantity, unitCode: unitCode!, lineExtensionAmount: amount(line, 'LineExtensionAmount')!,
      descriptions: many(item, CBC, 'Description', 20).map(n => text(n)!),
      productCode: product ? leaf(product, 'ID') : null, unitValue: amount(price, 'PriceAmount', true, 6)!,
      alternativePrices: alternatives, allowances: allowances(line), taxes: taxes(line, `items.${index}.taxes`) };
  });
  requireValue(items.length > 0, 'SALES_ITEMS');
  const monetary = agg(root, type === '08' ? 'RequestedMonetaryTotal' : 'LegalMonetaryTotal')!;
  const totals = { lineExtensionAmount: amount(monetary, 'LineExtensionAmount', false),
    taxExclusiveAmount: amount(monetary, 'TaxExclusiveAmount', false), taxInclusiveAmount: amount(monetary, 'TaxInclusiveAmount', false),
    allowanceTotalAmount: amount(monetary, 'AllowanceTotalAmount', false), chargeTotalAmount: amount(monetary, 'ChargeTotalAmount', false),
    prepaidAmount: amount(monetary, 'PrepaidAmount', false), payableAmount: amount(monetary, 'PayableAmount')!,
    payableRoundingAmount: (() => {
      const n = get(monetary, CBC, 'PayableRoundingAmount', false); if (!n) return null;
      requireValue(n.getAttribute('currencyID') === currency, 'SALES_AMOUNT_CURRENCY');
      const value = text(n)!; return (value.startsWith('-') ? '-' : '') + decimal(value.replace(/^-/, ''), 2);
    })() };
  const headerTaxes = taxes(root, 'taxes'), headerAllowances = allowances(root);
  const lineSum = items.reduce((sum, line) => sum + cents(line.lineExtensionAmount), 0n);
  if (totals.lineExtensionAmount !== null) finding(lineSum === cents(totals.lineExtensionAmount), 'LINE_SUM_MISMATCH', 'totals.lineExtensionAmount');
  else findings.push({ code: 'LINE_EXTENSION_TOTAL_NOT_DECLARED', path: 'totals.lineExtensionAmount' });
  const headerTaxSum = headerTaxes.reduce((sum, tax) => sum + cents(tax.taxAmount), 0n);
  const lineTaxSum = items.reduce((sum, line) => sum + line.taxes.reduce((n, tax) => n + cents(tax.taxAmount), 0n), 0n);
  if (headerTaxes.length && items.every(item => item.taxes.length)) finding(headerTaxSum === lineTaxSum, 'HEADER_LINE_TAX_MISMATCH', 'taxes');
  else findings.push({ code: 'TAX_RECONCILIATION_INCOMPLETE', path: 'taxes' });
  const schemeSums = (taxTotals: ReturnType<typeof taxes>) => {
    const sums = new Map<string, bigint>();
    taxTotals.forEach(total => total.subtotals.forEach(subtotal =>
      sums.set(subtotal.schemeId, (sums.get(subtotal.schemeId) ?? 0n) + cents(subtotal.taxAmount))));
    return sums;
  };
  const headerSchemes = schemeSums(headerTaxes), lineSchemes = schemeSums(items.flatMap(item => item.taxes));
  if (headerSchemes.size && lineSchemes.size) finding(headerSchemes.size === lineSchemes.size &&
    [...headerSchemes].every(([id, sum]) => lineSchemes.get(id) === sum), 'TAX_SCHEME_SUM_MISMATCH', 'taxes.subtotals');
  if (totals.taxInclusiveAmount !== null) finding(cents(totals.payableAmount) === cents(totals.taxInclusiveAmount) -
    cents(totals.prepaidAmount ?? '0.00') + cents(totals.payableRoundingAmount ?? '0.00'), 'PAYABLE_TOTAL_MISMATCH', 'totals.payableAmount');
  else findings.push({ code: 'PAYABLE_RECONCILIATION_INCOMPLETE', path: 'totals.taxInclusiveAmount' });
  // Missing aggregates are unknown, not presumed zero. No inference of global
  // discount/charge allocation or fiscal rounding from a historical snapshot.
  const payments = many(root, CAC, 'PaymentTerms', 101).map(p => ({ id: leaf(p, 'ID', false),
    paymentMeansId: leaf(p, 'PaymentMeansID', false), amount: amount(p, 'Amount', false), dueDate: leaf(p, 'PaymentDueDate', false) }));
  for (const payment of payments)
    requireValue(payment.dueDate === null || day(payment.dueDate), 'SALES_PAYMENT_DATE');
  const discrepancies = many(root, CAC, 'DiscrepancyResponse', 20).map(r => ({ referenceId: leaf(r, 'ReferenceID')!,
    reasonCode: leaf(r, 'ResponseCode')!, description: leaf(r, 'Description', false) }));
  const references = many(root, CAC, 'BillingReference', 20).map(r => {
    const doc = agg(r, 'InvoiceDocumentReference')!;
    return { fullNumber: leaf(doc, 'ID')!, type: leaf(doc, 'DocumentTypeCode')!, issueDate: leaf(doc, 'IssueDate', false) };
  });
  if (type === '07' || type === '08') {
    requireValue(discrepancies.length > 0 && references.length > 0, 'SALES_NOTE_REFERENCE');
    for (const reference of references) requireValue(/^[FB][A-Z0-9]{3}-[0-9]{1,8}$/.test(reference.fullNumber) &&
      !/-0+$/.test(reference.fullNumber) && ['01', '03'].includes(reference.type) &&
      (reference.type === '01' ? reference.fullNumber.startsWith('F') : reference.fullNumber.startsWith('B')) &&
      (reference.issueDate === null || day(reference.issueDate)), 'SALES_NOTE_REFERENCE');
    finding(discrepancies.every(d => references.some(r => r.fullNumber === d.referenceId)), 'NOTE_REFERENCE_MISMATCH', 'references');
  }
  const notes = many(root, CBC, 'Note', 100).map(n => ({ code: n.getAttribute('languageLocaleID'), value: text(n)! }));
  const extensions = get(root, EXT, 'UBLExtensions', false);
  // Only the signature subtree is outside business-field coverage; unsupported
  // extensions remain visible in the unmapped inventory.
  if (extensions) for (const extension of children(extensions)) {
    consumed.add(extension);
    const content = get(extension, EXT, 'ExtensionContent', false);
    if (content) for (const signature of children(content, DS, 'Signature')) {
      const pending = [signature]; while (pending.length) { const n = pending.pop()!; consumed.add(n); pending.push(...children(n)); }
    }
  }
  const signature = assessment(parsed, issueDate);
  const unmappedPaths: string[] = []; let unmappedElementCount = 0;
  const pending = [{ node: root, path: root.localName! }];
  while (pending.length) {
    const { node, path } = pending.pop()!;
    if (!consumed.has(node)) { unmappedElementCount++; if (unmappedPaths.length < 200) unmappedPaths.push(path); }
    children(node).forEach((child, index) => pending.push({ node: child, path: `${path}/{${child.namespaceURI}}${child.localName}[${index + 1}]` }));
  }
  if (unmappedElementCount) findings.push({ code: 'UNMAPPED_BUSINESS_ELEMENTS', path: 'coverage' });
  return { schemaVersion: 'factuez.offline-sales-evidence.v1' as const, ...OFFLINE_REVIEW_POLICY,
    rawSha256: createHash('sha256').update(parsed.rawXml).digest('hex'), signature,
    projection: { documentTypeCode: type, fullNumber, issueDate, issueTime, currencyCode: currency,
      operationTypeCode, issuer, customer, items, taxes: headerTaxes, allowances: headerAllowances, totals,
      payments, discrepancies, references, notes }, findings,
    reconciliation: { lineSum: money(lineSum), headerTaxSum: money(headerTaxSum), lineTaxSum: money(lineTaxSum),
      headerTaxBreakdown: [...headerSchemes].sort(([a], [b]) => a.localeCompare(b)).map(([schemeId, sum]) => ({ schemeId, amount: money(sum) })),
      lineTaxBreakdown: [...lineSchemes].sort(([a], [b]) => a.localeCompare(b)).map(([schemeId, sum]) => ({ schemeId, amount: money(sum) })),
      checksPassed: findings.length === 0, fiscalRulesVerified: false as const },
    coverage: { unmappedElementCount, unmappedPaths, truncated: unmappedElementCount > unmappedPaths.length,
      attributesFullyMapped: false as const, mappingCompleteness: 'PARTIAL_DIAGNOSTIC' as const },
    xsdVerified: false as const, businessRulesVerified: false as const,
    notMapped: ['sourceDatabaseId', 'ownership.station', 'ownership.emissionPoint', 'seriesAuthorization',
      'fullFiscalRules', 'allUBLAttributes', 'PKI_AND_SIGNER_AUTHORIZATION', 'RC_LINE_BINDING'] };
}

/** Isolated phase-3 preflight, not an import command or a cutover approval.
 * Source identifiers must come from the authorized export, not filenames. */
export function reviewOfflineSalesInventory(input: unknown) {
  const i = plain(input);
  requireValue(Object.keys(i).sort().join(',') === 'entries,schemaVersion,scope' &&
    i.schemaVersion === 'factuez.offline-sales-inventory.v1', 'INVENTORY_FIELDS');
  const scope = validateOfflineReviewScope(i.scope);
  requireValue(Array.isArray(i.entries) && !isProxy(i.entries) && Object.getPrototypeOf(i.entries) === Array.prototype, 'INVENTORY_SHAPE');
  // Reject accessors and proxies before any array traversal.
  const descriptors = Object.getOwnPropertyDescriptors(i.entries);
  requireValue(Reflect.ownKeys(descriptors).every(k => typeof k === 'string' && 'value' in descriptors[k]) &&
    Object.keys(i.entries).length === i.entries.length, 'INVENTORY_SHAPE');
  requireValue(i.entries.length > 0 && i.entries.length <= 20, 'INVENTORY_LIMIT');
  const findings: Array<{ row: number; code: string }> = [], origins = new Set<string>(), fiscal = new Map<string, string>();
  const groups = new Map<string, { issuerRuc: string; currencyCode: string; documentTypeCode: OfflineSalesType; series: string;
    count: number; payable: bigint; tax: bigint; pairIntegrityFailures: number; reconciliationFailures: number }>();
  let totalBytes = 0;
  const summaries = i.entries.map((entry: unknown, index: number) => {
    const e = plain(entry), row = index + 1;
    requireValue(Object.keys(e).sort().join(',') === 'cdrXml,documentXml,originRecordId,originSystem', 'INVENTORY_ENTRY');
    requireValue(typeof e.originSystem === 'string' && /^[A-Za-z0-9_.-]{1,40}$/.test(e.originSystem) &&
      typeof e.originRecordId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(e.originRecordId), 'ORIGIN_ID');
    requireValue(typeof e.documentXml === 'string' && (e.cdrXml === null || typeof e.cdrXml === 'string'), 'INVENTORY_ENTRY');
    totalBytes += Buffer.byteLength(e.documentXml) + (e.cdrXml === null ? 0 : Buffer.byteLength(e.cdrXml));
    requireValue(totalBytes <= 16 * 1024 * 1024, 'INVENTORY_BYTES');
    const r = reviewOfflineSalesPair({ scope, documentXml: e.documentXml, cdrXml: e.cdrXml }), p = r.document.projection;
    const [series, number] = p.fullNumber.split('-');
    const fiscalKey = `${p.issuer.identityNumber}:${p.documentTypeCode}:${series}:${BigInt(number)}`;
    const originKey = JSON.stringify([e.originSystem, e.originRecordId]);
    if (origins.has(originKey)) findings.push({ row, code: 'DUPLICATE_ORIGIN' }); origins.add(originKey);
    if (fiscal.has(fiscalKey)) findings.push({ row, code: fiscal.get(fiscalKey) === r.document.rawSha256 ? 'DUPLICATE_FISCAL' : 'CONFLICTING_FISCAL_XML' });
    else fiscal.set(fiscalKey, r.document.rawSha256);
    if (!r.cryptographicPairBound) findings.push({ row, code: 'PAIR_INTEGRITY_OR_BINDING_FAILED' });
    if (!r.typeBindingVerified) findings.push({ row, code: 'CDR_TYPE_NOT_BOUND' });
    r.document.findings.forEach(f => findings.push({ row, code: f.code }));
    const groupKey = `${p.issuer.identityNumber}:${p.currencyCode}:${p.documentTypeCode}:${series}`;
    const group = groups.get(groupKey) ?? { issuerRuc: p.issuer.identityNumber, currencyCode: p.currencyCode,
      documentTypeCode: p.documentTypeCode, series, count: 0, payable: 0n, tax: 0n, pairIntegrityFailures: 0, reconciliationFailures: 0 };
    group.count++; group.payable += cents(p.totals.payableAmount); group.tax += cents(r.document.reconciliation.headerTaxSum);
    if (!r.cryptographicPairBound) group.pairIntegrityFailures++;
    if (!r.document.reconciliation.checksPassed) group.reconciliationFailures++;
    groups.set(groupKey, group);
    return { row, fiscalKey, documentSha256: r.document.rawSha256, cdrSha256: r.cdr?.rawSha256 ?? null,
      documentIntegrity: r.document.signature.status, cdrIntegrity: r.cdr?.signature.status ?? 'MISSING',
      lineCount: p.items.length };
  });
  return { schemaVersion: 'factuez.offline-sales-inventory-report.v1' as const, ...OFFLINE_REVIEW_POLICY,
    rowCount: summaries.length, uniqueFiscalCount: fiscal.size, uniqueOriginCount: origins.size,
    findings, summaries, metadataChecksPassed: findings.length === 0,
    // Gross declared amounts, including duplicates and notes separately. Not a
    // net revenue ledger: never subtract a NC or deduplicate implicitly.
    groups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => {
      const { payable, tax, ...metadata } = g;
      return { ...metadata, declaredPayableTotal: money(payable), declaredTaxTotal: money(tax) };
    }), totalsMeaning: 'DECLARED_GROSS_BY_RUC_CURRENCY_TYPE_SERIES' as const,
    missingApprovals: ['AUTHORIZED_COMPLETE_EXPORT', 'CONFIRMED_OWNERSHIP_MAP', 'FULL_SNAPSHOT_BINDING',
      'PKI_TRUST_AND_REVOCATION', 'ACCOUNTING_RECONCILIATION', 'BACKUP_RESTORE_REHEARSAL', 'CUTOVER_ACT'],
    notAnImportManifest: true as const, networkRequests: 0 as const, fiscalWrites: 0 as const, outboxWrites: 0 as const };
}

export function reviewOfflineSalesPair(input: unknown) {
  const i = plain(input); requireValue(Object.keys(i).sort().join(',') === 'cdrXml,documentXml,scope', 'PAIR_FIELDS');
  const document = inspectOfflineSales(i.documentXml, i.scope);
  const cdr = i.cdrXml === null ? null : inspectOfflineCdr(i.cdrXml, i.scope), p = document.projection;
  const reference = cdr?.projection.reference;
  const isSummary = reference !== undefined && /^(RC|RA)-/.test(reference);
  const bindings = cdr ? { issuerMatches: p.issuer.identityNumber === cdr.projection.receiverRuc,
    referenceMatches: !isSummary && p.fullNumber === reference &&
      (cdr.projection.responseReference === null || p.fullNumber === cdr.projection.responseReference),
    documentTypeMatches: cdr.projection.documentTypeCode === null ? null : cdr.projection.documentTypeCode === p.documentTypeCode } : null;
  const issues = document.findings.map(f => f.code);
  if (!document.signature.wholeDocumentIntegrity) issues.push('DOCUMENT_' + document.signature.status);
  if (!cdr) issues.push('CDR_NOT_PROVIDED');
  else {
    if (!cdr.signature.wholeDocumentIntegrity) issues.push('CDR_' + cdr.signature.status);
    if (!bindings!.issuerMatches) issues.push('CDR_OTHER_ISSUER');
    if (!bindings!.referenceMatches) issues.push(isSummary ? 'CDR_SUMMARY_REQUIRES_BATCH_BINDING' : 'CDR_OTHER_DOCUMENT');
    if (bindings!.documentTypeMatches === false) issues.push('CDR_OTHER_TYPE');
    if (bindings!.documentTypeMatches === null) issues.push('CDR_TYPE_NOT_DECLARED');
  }
  issues.push('PKI_AND_SIGNER_AUTHORIZATION_NOT_VERIFIED', 'PARTIAL_SNAPSHOT_NOT_IMPORTABLE');
  return { schemaVersion: 'factuez.offline-sales-review.v1' as const, ...OFFLINE_REVIEW_POLICY,
    document, cdr, bindings, issues: [...new Set(issues)],
    cryptographicPairBound: !!cdr && document.signature.wholeDocumentIntegrity && cdr.signature.wholeDocumentIntegrity &&
      bindings!.issuerMatches && bindings!.referenceMatches && bindings!.documentTypeMatches !== false,
    typeBindingVerified: bindings?.documentTypeMatches === true,
    networkRequests: 0 as const, fiscalWrites: 0 as const, outboxWrites: 0 as const };
}
