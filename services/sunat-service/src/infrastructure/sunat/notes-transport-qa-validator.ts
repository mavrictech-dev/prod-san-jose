import { unzipSync } from 'fflate';
import { safeXml, child, children, leaf, CBC_NS, CAC_NS } from './safe-xml';

export const SAC_NS = 'urn:sunat:names:specification:ubl:peru:schema:xsd:SunatAggregateComponents-1';
export function singleNotesTransportXml(zip: Buffer, fileName: string) {
  if (!zip.length || zip.length > 4 * 1024 * 1024) throw new Error('ZIP de nota fuera de límite');
  let entries = 0;
  const files = unzipSync(zip, { filter: file => {
    if (++entries !== 1 || file.name !== fileName.replace(/\.zip$/, '.xml') || file.originalSize <= 0 || file.originalSize > 2 * 1024 * 1024) throw new Error('ZIP de nota ambiguo');
    return true;
  } });
  if (entries !== 1 || Object.keys(files).length !== 1) throw new Error('ZIP de nota ambiguo');
  return Buffer.from(Object.values(files)[0]);
}
/** Validación de ruta compartida por emulador y sendBill 07/08. No acredita fiscalidad. */
export function validateNoteBillXml(xml: string, fileName: string, ruc: string) {
  if (process.env.NOTES_QA_ENABLED !== 'true' || process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true' || !/^00\d{9}$/.test(ruc)) throw new Error('Notas de transporte QA deshabilitadas');
  const match = fileName.match(/^\d{11}-(07|08)-(F[A-Z0-9]{3}-[1-9]\d{0,7})\.zip$/);
  if (!match || !fileName.startsWith(`${ruc}-`)) throw new Error('sendBill de nota requiere serie F');
  const root = safeXml(xml); const kind = match[1] === '07' ? 'CreditNote' : 'DebitNote';
  if (root.localName !== kind || root.namespaceURI !== `urn:oasis:names:specification:ubl:schema:xsd:${kind}-2` || leaf(root, CBC_NS, 'ID', 40) !== match[2]) throw new Error('Identidad de nota inconsistente');
  const supplier = child(child(child(root, CAC_NS, 'AccountingSupplierParty'), CAC_NS, 'Party'), CAC_NS, 'PartyIdentification');
  if (leaf(supplier, CBC_NS, 'ID', 11) !== ruc) throw new Error('Nota de otro RUC');
  const reference = child(child(root, CAC_NS, 'BillingReference'), CAC_NS, 'InvoiceDocumentReference');
  const referenceId = leaf(reference, CBC_NS, 'ID', 40);
  if (leaf(reference, CBC_NS, 'DocumentTypeCode', 2) !== '01' || !/^F[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(referenceId)) throw new Error('sendBill de nota requiere factura original');
  const discrepancy = child(root, CAC_NS, 'DiscrepancyResponse');
  if (leaf(discrepancy, CBC_NS, 'ReferenceID', 40) !== referenceId ||
    !(match[1] === '07' ? ['01', '06', '07'] : ['02']).includes(leaf(discrepancy, CBC_NS, 'ResponseCode', 2))) throw new Error('Referencia o motivo de nota fuera del perfil QA');
  return root;
}
export function validateNoteSummaryLines(root: ReturnType<typeof safeXml>) {
  const lines = children(root, SAC_NS, 'SummaryDocumentsLine');
  const noteLines = lines.filter(line => ['07', '08'].includes(leaf(line, CBC_NS, 'DocumentTypeCode', 2)));
  if (!noteLines.length) return;
  if (process.env.NOTES_QA_ENABLED !== 'true' || lines.length !== 1) throw new Error('RC propio de nota requiere una única nota');
  const line = noteLines[0];
  if (!/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(leaf(line, CBC_NS, 'ID', 40)) || leaf(child(line, CAC_NS, 'Status'), CBC_NS, 'ConditionCode', 1) !== '1') throw new Error('RC de nota fuera del perfil de alta');
  const reference = child(child(line, CAC_NS, 'BillingReference'), CAC_NS, 'InvoiceDocumentReference');
  if (leaf(reference, CBC_NS, 'DocumentTypeCode', 2) !== '03' || !/^B[A-Z0-9]{3}-[1-9]\d{0,7}$/.test(leaf(reference, CBC_NS, 'ID', 40))) throw new Error('RC de nota sin boleta referenciada');
}
