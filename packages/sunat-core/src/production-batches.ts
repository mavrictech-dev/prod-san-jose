import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import { PRODUCTION_BATCHES_PROFILE, type ProductionBatchesSnapshot, type ProductionBatchesEntry, type ProductionBatchesAcceptance } from '@factuez/contracts/production-batches';
import { assertFiscalSnapshot } from './fiscal-rules';
import { fiscalArray, fiscalDate, fiscalEqual, fiscalLimaDate, fiscalObject, fiscalRuc, fiscalSignatureXml, fiscalSnapshotSha256, fiscalText, fiscalTimestamp, fiscalUuid, fiscalXml, fiscalAmountXml, fiscalTaxXml, FISCAL_XML_EXTENSION, FISCAL_XML_NAMESPACES } from './fiscal-note';
import { FISCAL_BATCH_SOURCES, type FiscalBatchIdentity } from './fiscal-batch';
/** Reuse fiscal-batch's identity, shared fiscal primitives, limits and XML semantics.
 * Its BETA-only snapshot/acceptance builders are intentionally NEVER invoked or rewritten.
 * Initial native production coverage is RC03/RA01; notes require their own native owner evidence. */
export const PRODUCTION_BATCHES_SOURCES = { ...FISCAL_BATCH_SOURCES,
  transport: 'https://cpe.sunat.gob.pe/sites/default/files/inline-files/manual_programador%20(1).pdf',
  reviewedOn: '2026-10-28' } as const;
const days = (a: string, b: string) => (Date.parse(a + 'T12:00:00Z') - Date.parse(b + 'T12:00:00Z')) / 86400000;
function acceptance(s: FiscalDocumentSnapshot, a: ProductionBatchesAcceptance, asOf: string, source: 'RC' | 'DOCUMENT') {
  fiscalObject(a, ['documentId','snapshotSha256','issuerRuc','acceptedAt','cdrZipSha256','cdrXmlSha256','requestXmlSha256','reference','source'], 'acceptance');
  fiscalTimestamp(a.acceptedAt, 'acceptedAt');
  if (a.documentId !== s.documentId || a.issuerRuc !== s.issuer.identityNumber || a.snapshotSha256 !== fiscalSnapshotSha256(s) ||
      ![a.cdrXmlSha256,a.cdrZipSha256,a.requestXmlSha256].every(h => /^[a-f0-9]{64}$/.test(h)) ||
      Date.parse(a.acceptedAt) < Date.parse(s.issueDate) || Date.parse(a.acceptedAt) > Date.parse(asOf) ||
      (source === 'RC' ? !['INDIVIDUAL_RC','BATCH_RC'].includes(a.source) || !/^RC-\d{8}-[1-9]\d{0,4}$/.test(a.reference) : a.source !== 'DOCUMENT' || a.reference !== s.fullNumber))
    throw Error('Aceptación propietaria exacta requerida');
}
export function assertProductionBatchesSnapshot(b: ProductionBatchesSnapshot, asOf = new Date().toISOString()) {
  fiscalObject(b, ['environment','profile','batchId','identifier','kind','companyId','issuerRuc','currencyCode','issueDate','referenceDate','entries'], 'batch');
  fiscalUuid(b.batchId,'batchId'); fiscalRuc(b.issuerRuc,'issuerRuc');
  fiscalDate(b.issueDate,'issueDate'); fiscalDate(b.referenceDate,'referenceDate'); fiscalTimestamp(asOf,'asOf');
  fiscalArray(b.entries,100,'entries');
  if (b.environment !== 'PRODUCTION' || b.profile !== PRODUCTION_BATCHES_PROFILE || !['RC','RA'].includes(b.kind) ||
      !Number.isSafeInteger(b.companyId) || b.companyId < 1 || b.currencyCode !== 'PEN' || !b.entries.length ||
      !new RegExp('^' + b.kind + '-\\d{8}-[1-9]\\d{0,4}$').test(b.identifier) ||
      b.identifier.slice(3,11) !== b.issueDate.replaceAll('-','') || b.issueDate > fiscalLimaDate(asOf) || b.referenceDate > b.issueDate)
    throw Error('Identidad/perfil productivo inválido');
  const seen = new Set<string>(), numbers = new Set<string>();
  let first: FiscalDocumentSnapshot | undefined;
  for (const e of b.entries) {
    fiscalObject(e,['snapshot','conditionCode','previous','acceptance','declaration','pendingRoute'],'entry');
    const s = e.snapshot;
    assertFiscalSnapshot(s,{mode:'REAL_PREPARATION'});
    if (s.environment !== 'PRODUCTION' || s.companyId !== b.companyId || s.issuer.identityNumber !== b.issuerRuc ||
        s.currencyCode !== b.currencyCode || fiscalLimaDate(s.issueDate) !== b.referenceDate || seen.has(s.documentId) ||
        numbers.has(s.documentTypeCode + '/' + s.fullNumber) || s.documentId === b.batchId ||
        s.paymentTerms && s.paymentTerms.type !== 'CONTADO') throw Error('Documentos heterogéneos o duplicados');
    if (first) { fiscalEqual(s.issuer,first.issuer,'issuer'); fiscalEqual(s.branchId,first.branchId,'branchId'); } else first = s;
    seen.add(s.documentId); numbers.add(s.documentTypeCode + '/' + s.fullNumber);
    if (b.kind === 'RC') {
      if (s.documentTypeCode !== '03' || !['1','2','3'].includes(e.conditionCode ?? '') || days(b.issueDate,b.referenceDate) > 7 || e.acceptance)
        throw Error('RC03 requiere condición 1/2/3 dentro de siete días');
      if (e.conditionCode === '1') {
        if (e.previous || e.declaration || !e.pendingRoute || e.pendingRoute.documentId !== s.documentId || e.pendingRoute.transmissionStarted !== false)
          throw Error('Alta sólo para boleta pendiente reservada antes de transmisión');
        fiscalUuid(e.pendingRoute.token,'pending.token');
      } else {
        if (!e.previous || e.pendingRoute) throw Error('RC2/3 requiere versión previa aceptada');
        const p = e.previous.snapshot;
        assertFiscalSnapshot(p,{mode:'REAL_PREPARATION'}); acceptance(p,e.previous.acceptance,asOf,'RC');
        for (const k of ['environment','companyId','branchId','documentId','documentTypeCode','fullNumber','series','number','issueDate','issuer','customer','currencyCode','operationTypeCode'] as const)
          fiscalEqual(s[k],p[k],'previous.' + k);
        if (e.conditionCode === '3') fiscalEqual(s,p,'void.snapshot');
        else if (e.declaration) throw Error('RC2 no admite declaración de baja');
      }
    } else {
      if (s.documentTypeCode !== '01' || e.conditionCode || e.previous || e.pendingRoute || !e.acceptance)
        throw Error('RA01 exige aceptación documental y declaración');
      acceptance(s,e.acceptance,asOf,'DOCUMENT');
      if (days(b.issueDate,fiscalLimaDate(e.acceptance.acceptedAt)) > 7) throw Error('Baja fuera de siete días desde aceptación');
    }
    if (b.kind === 'RA' || e.conditionCode === '3') {
      const d = e.declaration;
      if (!d || d.status !== 'NOT_DELIVERED' || d.documentId !== s.documentId || d.snapshotSha256 !== fiscalSnapshotSha256(s) || d.issuerRuc !== b.issuerRuc)
        throw Error('Declaración administrativa propia de no entrega requerida');
      fiscalUuid(d.id,'declaration.id'); fiscalUuid(d.actorId,'declaration.actorId'); fiscalTimestamp(d.assertedAt,'assertedAt'); fiscalText(d.reason,100,'reason');
      if (Date.parse(d.assertedAt) < Date.parse(s.issueDate) || Date.parse(d.assertedAt) > Date.parse(asOf)) throw Error('Fecha de declaración inválida');
    }
  }
}
/** Identity shape comes directly from fiscal-batch.ts; number is allocated by owner transaction. */
export function buildProductionBatchesSnapshot(entries: ProductionBatchesEntry[], kind: 'RC'|'RA', identity: FiscalBatchIdentity, companyId: number, asOf: string): ProductionBatchesSnapshot {
  const b: ProductionBatchesSnapshot = { environment:'PRODUCTION',profile:PRODUCTION_BATCHES_PROFILE,batchId:identity.documentId,identifier:identity.identifier,
    kind,companyId,issuerRuc:entries[0]?.snapshot.issuer.identityNumber,currencyCode:'PEN',issueDate:identity.issueDate,referenceDate:identity.referenceDate,entries:structuredClone(entries) };
  assertProductionBatchesSnapshot(b,asOf); return b;
}
export function buildProductionBatchesUbl(b: ProductionBatchesSnapshot, asOf = b.issueDate + 'T23:59:59-05:00') {
  assertProductionBatchesSnapshot(b,asOf);
  const root = b.kind === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments', issuer = b.entries[0].snapshot.issuer;
  const lines = b.entries.map((e,i) => {
    const s = e.snapshot;
    if (b.kind === 'RA') return '<sac:VoidedDocumentsLine><cbc:LineID>'+(i+1)+'</cbc:LineID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode><sac:DocumentSerialID>'+s.series+'</sac:DocumentSerialID><sac:DocumentNumberID>'+s.number+'</sac:DocumentNumberID><sac:VoidReasonDescription>'+fiscalXml(e.declaration!.reason)+'</sac:VoidReasonDescription></sac:VoidedDocumentsLine>';
    const paid = (v:string,c:string) => '<sac:BillingPayment>'+fiscalAmountXml('PaidAmount',v)+'<cbc:InstructionID>'+c+'</cbc:InstructionID></sac:BillingPayment>';
    return '<sac:SummaryDocumentsLine><cbc:LineID>'+(i+1)+'</cbc:LineID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode><cbc:ID>'+s.fullNumber+'</cbc:ID><cac:AccountingCustomerParty><cbc:CustomerAssignedAccountID>'+fiscalXml(s.customer.identityNumber)+'</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>'+s.customer.identityType+'</cbc:AdditionalAccountID></cac:AccountingCustomerParty><cac:Status><cbc:ConditionCode>'+e.conditionCode+'</cbc:ConditionCode></cac:Status><sac:TotalAmount currencyID="PEN">'+s.totals.payableAmount+'</sac:TotalAmount>'+paid(s.totals.taxableAmount,'01')+paid('0.00','02')+paid('0.00','03')+fiscalTaxXml(s.totals.taxableAmount,s.totals.igvAmount,false)+'</sac:SummaryDocumentsLine>';
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8"?><'+root+' xmlns="urn:sunat:names:specification:ubl:peru:schema:xsd:'+root+'-1" '+FISCAL_XML_NAMESPACES+' xmlns:sac="urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1">'+FISCAL_XML_EXTENSION+'<cbc:UBLVersionID>2.0</cbc:UBLVersionID><cbc:CustomizationID>'+(b.kind==='RC'?'1.1':'1.0')+'</cbc:CustomizationID><cbc:ID>'+b.identifier+'</cbc:ID><cbc:ReferenceDate>'+b.referenceDate+'</cbc:ReferenceDate><cbc:IssueDate>'+b.issueDate+'</cbc:IssueDate>'+fiscalSignatureXml(issuer)+'<cac:AccountingSupplierParty><cbc:CustomerAssignedAccountID>'+b.issuerRuc+'</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID><cac:Party><cac:PartyLegalEntity><cbc:RegistrationName>'+fiscalXml(issuer.legalName)+'</cbc:RegistrationName></cac:PartyLegalEntity></cac:Party></cac:AccountingSupplierParty>'+lines+'</'+root+'>';
}
