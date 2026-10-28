import { unzipSync } from 'fflate';
import { safeXml, child, leaf, children, CBC_NS, CAC_NS } from './safe-xml';
export const RESPONSE_NS = 'urn:oasis:names:specification:ubl:schema:xsd:ApplicationResponse-2';
/** Valida estructura/vinculación, NO confianza criptográfica del emisor del CDR. */
export function parseCdrZip(zip: Buffer, expected: { fileName: string; issuerRuc: string; reference: string }) {
  if (!zip.length || zip.length > 4 * 1024 * 1024 || !/^R-[A-Za-z0-9_-]{1,100}\.xml$/.test(expected.fileName)) throw new Error('CDR fuera de límite');
  let entries = 0; let xmlEntries = 0; let emptyDirectory = false;
  const files = unzipSync(zip, { filter: entry => {
    if (++entries > 2) throw new Error('CDR ZIP inesperado');
    // SUNAT Beta incluye dummy/ vacío. No se escribe en disco, ni se aceptan
    // otros directorios, rutas, contenido, duplicados o XML adicionales.
    if (entry.name === 'dummy/' && entry.originalSize === 0 && !emptyDirectory) { emptyDirectory = true; return false; }
    if (++xmlEntries !== 1 || entry.name !== expected.fileName || entry.originalSize > 2 * 1024 * 1024 || entry.originalSize === 0) throw new Error('CDR ZIP inesperado'); return true;
  } });
  if (xmlEntries !== 1 || Object.keys(files).length !== 1) throw new Error('CDR ZIP ambiguo');
  const xml = Buffer.from(files[expected.fileName]); const root = safeXml(xml.toString('utf8'));
  if (root.namespaceURI !== RESPONSE_NS || root.localName !== 'ApplicationResponse') throw new Error('CDR raíz inválida');
  if (leaf(child(child(root, CAC_NS, 'ReceiverParty'), CAC_NS, 'PartyIdentification'), CBC_NS, 'ID', 11) !== expected.issuerRuc) throw new Error('CDR de otro RUC');
  const documentResponse = child(root, CAC_NS, 'DocumentResponse');
  if (leaf(child(documentResponse, CAC_NS, 'DocumentReference'), CBC_NS, 'ID', 40) !== expected.reference) throw new Error('CDR de otro comprobante/resumen');
  const response = child(documentResponse, CAC_NS, 'Response'); const code = leaf(response, CBC_NS, 'ResponseCode', 8);
  if (!/^\d{1,8}$/.test(code)) throw new Error('Código CDR inválido');
  const description = leaf(response, CBC_NS, 'Description', 2048);
  const notes = children(root, CBC_NS, 'Note').map(el => { const value = el.textContent?.trim() ?? ''; if (!value || value.length > 2048 || el.getElementsByTagName('*').length) throw new Error('Observación fuera de límite'); return value; });
  if (notes.length > 50) throw new Error('Demasiadas observaciones');
  return { xml, code, description, notes, status: code === '0' ? (notes.length ? 'ACCEPTED_WITH_OBSERVATIONS' : 'ACCEPTED') : 'REJECTED' } as const;
}
