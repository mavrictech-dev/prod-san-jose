import { createHash } from 'node:crypto';
import { inflateSync } from 'fflate';
import type { FiscalDocumentSnapshot } from '@factuez/contracts';
import {
  fiscalCanonical, fiscalDate, fiscalLimaDate, fiscalSnapshotSha256, fiscalTimestamp,
  validateFiscalAcceptance, validateFiscalOriginal,
  type FiscalAcceptanceEvidence, type FiscalNoteSnapshot,
} from '@factuez/sunat-core/dist/fiscal-note';
import { buildFiscalBatchUbl, validateFiscalBatchSnapshot, type FiscalBatchSnapshot } from '@factuez/sunat-core/dist/fiscal-batch';
import { parseCdrZip } from '../infrastructure/sunat/cdr-parser';
import { CAC_NS, CBC_NS, children, safeXml } from '../infrastructure/sunat/safe-xml';

/**
 * Verificador async con dependencias sólo por puertos internos; sin SQL, Nest,
 * filesystem, claves, activación ni llamadas SUNAT. Sólo RC BETA del perfil core.
 * Fuente primaria: manual SUNAT mayo2021, anexo1 (CDR/ApplicationResponse), y
 * guía RC enero2018 (estados1/2/3 y versión del miembro):
 * https://cpe.sunat.gob.pe/sites/default/files/inline-files/manual_programador%20(1).pdf
 * https://cpe.sunat.gob.pe/sites/default/files/inline-files/GUIA_Resumen_de_Boletas_11-01-2018%20(2)_2_0%20(1)_0.pdf
 * loadBatch adapta una lectura AUTORITATIVA, única por RUC/BETA/identifier, de
 * snapshot inmutable, estado y completedAt del envío RC aceptado, no de la PWA.
 * Se lee DOS veces para detectar cambio de versión/estado/artefacto durante await.
 * Un RC global acredita sólo el miembro/versión1/2 que se compara íntegramente.
 * Condición3 NO acredita aceptación del comprobante. No busca otra línea si el
 * índice declarado falla. completedAt debe coincidir literalmente con acceptedAt
 * (instante de aceptación registrado, no se sustituye por fecha del XML del CDR).
 * Firma: verifySignature debe verificar criptografía y confianza SUNAT fijada,
 * documento completo, algoritmos, cadena/revocación; nunca devolver una bandera
 * archivada ni confiar sólo en KeyInfo o un booleano aportado por el cliente.
 * requestXml opcional: si está presente, hash y cuerpo completo deben coincidir
 * con el builder core, omitiendo sólo UBLExtensions de firma en copias DOM.
 * Sin requestXml, la vinculación RC->snapshot descansa en loadBatch confiable.
 * No reserva ni proyecta estado. El wiring debe usar los hashes retornados como
 * predicados de versión dentro de su transacción/reserva: releer no elimina una
 * carrera posterior al retorno ni demuestra que no exista otro RC más reciente.
 * ZIP acotado clásico, no cifrado/ZIP64: un XML esperado y dummy/ vacío opcional;
 * cabeceras central/local, tamaños, rutas, duplicados y CRC comprobados en memoria.
 */
export type BetaSummaryAcceptedStatus = 'ACCEPTED' | 'ACCEPTED_WITH_OBSERVATIONS';
export type BetaSummaryCdrArtifact = { fileName: string; sha256: string; sizeBytes: number; storageKey?: string };
export type BetaSummaryRequestXml = { bytes: Buffer; sha256: string };
export type BetaSummaryAcceptedBatch = {
  batch: FiscalBatchSnapshot; status: BetaSummaryAcceptedStatus; completedAt: string;
  cdrZip: BetaSummaryCdrArtifact; requestXml?: BetaSummaryRequestXml;
};
export interface BetaSummaryAcceptancePorts {
  loadBatch(issuerRuc: string, environment: 'BETA', identifier: string): Promise<BetaSummaryAcceptedBatch | null>;
  readCdr(record: BetaSummaryAcceptedBatch): Promise<Buffer>;
  verifySignature(xml: Buffer): Promise<boolean>;
}
export type BetaSummaryAcceptanceMetadata = {
  environment: 'BETA'; issuerRuc: string; batchDocumentId: string; identifier: string; batchSnapshotSha256: string;
  documentId: string; documentTypeCode: '03' | '07' | '08'; fullNumber: string; snapshotSha256: string;
  referenceDate: string; lineNumber: number; conditionCode: '1' | '2'; acceptedAt: string;
  status: BetaSummaryAcceptedStatus; responseCode: '0';
  cdrFileName: string; cdrZipSha256: string; cdrXmlSha256: string;
  description: string; notes: string[]; requestXmlSha256?: string;
};
export type BetaSummaryAcceptanceErrorCode =
  | 'FISCAL_EVIDENCE_INVALID' | 'BATCH_NOT_FOUND' | 'BATCH_UNAVAILABLE' | 'BATCH_INVALID' | 'BATCH_CHANGED'
  | 'MEMBER_NOT_FOUND' | 'MEMBER_DUPLICATE' | 'MEMBER_VERSION_MISMATCH' | 'MEMBER_CONDITION_INVALID'
  | 'ACCEPTANCE_TIME_MISMATCH' | 'CDR_UNAVAILABLE' | 'CDR_ARTIFACT_MISMATCH' | 'CDR_INVALID'
  | 'CDR_REJECTED' | 'CDR_UNTRUSTED' | 'REQUEST_XML_MISMATCH' | 'INPUT_CHANGED';
export class BetaSummaryAcceptanceError extends Error {
  constructor(readonly code: BetaSummaryAcceptanceErrorCode) { super(`Evidencia RC no acreditada (${code})`); this.name = 'BetaSummaryAcceptanceError'; }
}
function reject(code: BetaSummaryAcceptanceErrorCode): never { throw new BetaSummaryAcceptanceError(code); }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/;
const EXT_NS = 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2';
const DS_NS = 'http://www.w3.org/2000/09/xmldsig#';
type XmlElement = ReturnType<typeof safeXml>;
/** Una etiqueta con alias de namespace o una identidad repetida no se ignora. */
function one(parent: XmlElement, ns: string, name: string): XmlElement {
  let local = 0;
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n.nodeType === 1 && (n as XmlElement).localName === name) local++;
  const matches = children(parent, ns, name);
  if (local !== 1 || matches.length !== 1) reject('CDR_INVALID');
  return matches[0];
}
function text(parent: XmlElement, ns: string, name: string, max: number): string {
  const element = one(parent, ns, name), value = element.textContent ?? '';
  if (element.getElementsByTagName('*').length || !value.trim() || value.length > max || value !== value.trim()) reject('CDR_INVALID');
  return value;
}
function strictXml(bytes: Buffer): XmlElement {
  if (!Buffer.isBuffer(bytes) || !Buffer.from(bytes.toString('utf8')).equals(bytes)) reject('CDR_INVALID');
  return safeXml(bytes.toString('utf8'));
}
function recordFingerprint(record: BetaSummaryAcceptedBatch): string {
  return fiscalSnapshotSha256({ batch: record.batch, status: record.status, completedAt: record.completedAt,
    cdrZip: record.cdrZip, requestXml: record.requestXml ? { sha256: record.requestXml.sha256, bytesSha256: sha256(record.requestXml.bytes) } : undefined });
}
function copyRecord(record: BetaSummaryAcceptedBatch): BetaSummaryAcceptedBatch {
  return { batch: structuredClone(record.batch), status: record.status, completedAt: record.completedAt,
    cdrZip: structuredClone(record.cdrZip), ...(record.requestXml ? { requestXml: { sha256: record.requestXml.sha256, bytes: Buffer.from(record.requestXml.bytes) } } : {}) };
}
function checkAliases(batch: FiscalBatchSnapshot): void {
  const ids = new Set<string>(), identities = new Set<string>();
  for (const entry of batch.input.entries) {
    const s = entry.document.snapshot, id = s.documentId.toLowerCase();
    const key = `${s.issuer.identityNumber}/${s.documentTypeCode}/${s.series.toUpperCase()}/${BigInt(s.number)}`;
    if (ids.has(id) || identities.has(key)) reject('MEMBER_DUPLICATE');
    ids.add(id); identities.add(key);
  }
}
function validateRecord(record: BetaSummaryAcceptedBatch, doc: FiscalDocumentSnapshot | FiscalNoteSnapshot, evidence: FiscalAcceptanceEvidence, asOf: string) {
  if (!record || !record.batch || !['ACCEPTED', 'ACCEPTED_WITH_OBSERVATIONS'].includes(record.status)) reject('BATCH_INVALID');
  const batch = record.batch, source = evidence.source;
  if (source.kind !== 'CDR_SUMMARY' || batch.kind !== 'RC' || batch.input.kind !== 'RC' || batch.environment !== 'BETA' ||
    batch.issuer.identityNumber !== evidence.issuerRuc || batch.identifier !== source.identifier || batch.referenceDate !== source.referenceDate ||
    batch.referenceDate !== fiscalLimaDate(doc.issueDate)) reject('BATCH_INVALID');
  try { checkAliases(batch); validateFiscalBatchSnapshot(batch, asOf); fiscalTimestamp(record.completedAt, 'completedAt'); }
  catch (error) { if (error instanceof BetaSummaryAcceptanceError) throw error; reject('BATCH_INVALID'); }
  if (record.completedAt !== evidence.acceptedAt || Date.parse(record.completedAt) > Date.parse(asOf) || fiscalLimaDate(record.completedAt) < batch.issueDate)
    reject('ACCEPTANCE_TIME_MISMATCH');
  const entry = batch.input.entries[source.lineNumber - 1];
  if (!entry) reject('MEMBER_NOT_FOUND');
  if (entry.conditionCode === '3' || !['1', '2'].includes(entry.conditionCode) || entry.conditionCode !== source.conditionCode) reject('MEMBER_CONDITION_INVALID');
  const member = entry.document.snapshot;
  if (member.documentId !== doc.documentId || member.documentTypeCode !== doc.documentTypeCode || member.fullNumber !== doc.fullNumber ||
    fiscalCanonical(member) !== fiscalCanonical(doc) || fiscalSnapshotSha256(member) !== evidence.snapshotSha256) reject('MEMBER_VERSION_MISMATCH');
  const artifact = record.cdrZip;
  if (!artifact || artifact.fileName !== `R-${evidence.issuerRuc}-${source.identifier}.zip` || !HASH.test(artifact.sha256) || artifact.sha256 !== evidence.cdrSha256 ||
    !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 22 || artifact.sizeBytes > 4 * 1024 * 1024) reject('CDR_ARTIFACT_MISMATCH');
  return entry;
}

/** fflate descomprime, pero no basta para acreditar CRC ni coherencia central/local. */
export function betaCdrZipMetadata(zip: Buffer, expectedName: string): { crc: number; size: number } {
  try {
    if (zip.length < 22 || zip.length > 4 * 1024 * 1024) reject('CDR_INVALID');
    // EOCD sin comentarios/trailing bytes en este perfil clásico.
    const end = zip.length - 22;
    if (zip.readUInt32LE(end) !== 0x06054b50 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 20)) reject('CDR_INVALID');
    const count = zip.readUInt16LE(end + 10), centralSize = zip.readUInt32LE(end + 12), centralOffset = zip.readUInt32LE(end + 16);
    if (count < 1 || count > 2 || count !== zip.readUInt16LE(end + 8) || centralOffset + centralSize !== end) reject('CDR_INVALID');
    const entries: { offset: number; end: number; name: string; crc: number; size: number }[] = [];
    const names = new Set<string>(); let cursor = centralOffset;
    for (let i = 0; i < count; i++) {
      if (cursor + 46 > end || zip.readUInt32LE(cursor) !== 0x02014b50) reject('CDR_INVALID');
      const flags = zip.readUInt16LE(cursor + 8), method = zip.readUInt16LE(cursor + 10), crc = zip.readUInt32LE(cursor + 16);
      const compressed = zip.readUInt32LE(cursor + 20), size = zip.readUInt32LE(cursor + 24), nameLength = zip.readUInt16LE(cursor + 28);
      const extra = zip.readUInt16LE(cursor + 30), comment = zip.readUInt16LE(cursor + 32), offset = zip.readUInt32LE(cursor + 42);
      if (flags & ~0x0808 || ![0, 8].includes(method) || size > 2 * 1024 * 1024 || compressed === 0xffffffff ||
        offset === 0xffffffff || zip.readUInt16LE(cursor + 34) || cursor + 46 + nameLength + extra + comment > end) reject('CDR_INVALID');
      const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength), name = nameBytes.toString('utf8');
      if (!Buffer.from(name).equals(nameBytes) || names.has(name) || ![expectedName, 'dummy/'].includes(name) ||
        (name === 'dummy/' ? size !== 0 || crc !== 0 : size === 0)) reject('CDR_INVALID');
      names.add(name);
      if (offset + 30 > centralOffset || zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset + 6) !== flags || zip.readUInt16LE(offset + 8) !== method) reject('CDR_INVALID');
      const localNameLength = zip.readUInt16LE(offset + 26), localExtra = zip.readUInt16LE(offset + 28), start = offset + 30 + localNameLength + localExtra;
      if (start + compressed > centralOffset || !zip.subarray(offset + 30, offset + 30 + localNameLength).equals(nameBytes)) reject('CDR_INVALID');
      const local = [zip.readUInt32LE(offset + 14), zip.readUInt32LE(offset + 18), zip.readUInt32LE(offset + 22)], declared = [crc, compressed, size];
      if (local.some((value, n) => (flags & 8) ? value !== 0 && value !== declared[n] : value !== declared[n])) reject('CDR_INVALID');
      let finish = start + compressed;
      if (name === 'dummy/' && (method === 0 ? compressed !== 0 : compressed > 16 || inflateSync(zip.subarray(start, finish)).length !== 0)) reject('CDR_INVALID');
      if (flags & 8) {
        if (finish + 12 > centralOffset) reject('CDR_INVALID');
        if (zip.readUInt32LE(finish) === 0x08074b50) finish += 4;
        if (finish + 12 > centralOffset || declared.some((value, n) => zip.readUInt32LE(finish + n * 4) !== value)) reject('CDR_INVALID');
        finish += 12;
      }
      entries.push({ offset, end: finish, name, crc, size }); cursor += 46 + nameLength + extra + comment;
    }
    if (cursor !== end || !names.has(expectedName)) reject('CDR_INVALID');
    entries.sort((a, b) => a.offset - b.offset);
    if (entries[0].offset !== 0 || entries.some((entry, i) => entry.end !== (entries[i + 1]?.offset ?? centralOffset))) reject('CDR_INVALID');
    return entries.find(e => e.name === expectedName)!;
  } catch { reject('CDR_INVALID'); }
}
export function betaCdrCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function cdrDetails(zip: Buffer, evidence: FiscalAcceptanceEvidence) {
  if (evidence.source.kind !== 'CDR_SUMMARY') reject('FISCAL_EVIDENCE_INVALID');
  const fileName = `R-${evidence.issuerRuc}-${evidence.source.identifier}.xml`, metadata = betaCdrZipMetadata(zip, fileName);
  let parsed: ReturnType<typeof parseCdrZip>;
  try { parsed = parseCdrZip(zip, { fileName, issuerRuc: evidence.issuerRuc, reference: evidence.source.identifier }); }
  catch { reject('CDR_INVALID'); }
  if (parsed.xml.length !== metadata.size || betaCdrCrc32(parsed.xml) !== metadata.crc) reject('CDR_INVALID');
  const root = strictXml(parsed.xml);
  if (text(one(one(root, CAC_NS, 'SenderParty'), CAC_NS, 'PartyIdentification'), CBC_NS, 'ID', 11) !== '20131312955') reject('CDR_INVALID');
  if (text(one(one(root, CAC_NS, 'ReceiverParty'), CAC_NS, 'PartyIdentification'), CBC_NS, 'ID', 11) !== evidence.issuerRuc) reject('CDR_INVALID');
  const response = one(root, CAC_NS, 'DocumentResponse');
  if (text(one(response, CAC_NS, 'DocumentReference'), CBC_NS, 'ID', 40) !== evidence.source.identifier ||
    text(one(response, CAC_NS, 'Response'), CBC_NS, 'ReferenceID', 40) !== evidence.source.identifier) reject('CDR_INVALID');
  if (text(one(response, CAC_NS, 'Response'), CBC_NS, 'ResponseCode', 8) !== '0' || parsed.status === 'REJECTED') reject('CDR_REJECTED');
  fiscalDate(text(root, CBC_NS, 'IssueDate', 10), 'CDR.IssueDate');
  const extension = one(one(one(root, EXT_NS, 'UBLExtensions'), EXT_NS, 'UBLExtension'), EXT_NS, 'ExtensionContent');
  const signatures = root.getElementsByTagNameNS(DS_NS, 'Signature');
  if (signatures.length !== 1 || signatures[0].parentNode !== extension) reject('CDR_UNTRUSTED');
  return parsed;
}
/** Comparación de árbol por namespaces/atributos/texto, no por prefijos ni orden de atributos. */
function bodyTree(node: XmlElement): unknown {
  const attributes: string[][] = [];
  for (let i = 0; i < node.attributes.length; i++) {
    const attribute = node.attributes.item(i)!;
    if (attribute.namespaceURI !== 'http://www.w3.org/2000/xmlns/') attributes.push([attribute.namespaceURI ?? '', attribute.localName ?? attribute.name, attribute.value]);
  }
  attributes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const content: unknown[] = [], hasElements = node.getElementsByTagName('*').length > 0;
  for (let n = node.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) content.push(bodyTree(n as XmlElement));
    else if (n.nodeType === 3 && (!hasElements || (n.nodeValue ?? '').trim())) content.push(n.nodeValue);
  }
  return [node.namespaceURI, node.localName, attributes, content];
}
function checkRequestXml(record: BetaSummaryAcceptedBatch, asOf: string): void {
  if (!record.requestXml) return;
  const request = record.requestXml;
  if (!HASH.test(request.sha256) || sha256(request.bytes) !== request.sha256) reject('REQUEST_XML_MISMATCH');
  try {
    const actual = strictXml(request.bytes), expected = safeXml(buildFiscalBatchUbl(record.batch, asOf));
    for (const root of [actual, expected]) {
      const extensions = one(root, EXT_NS, 'UBLExtensions'); root.removeChild(extensions);
    }
    if (fiscalCanonical(bodyTree(actual)) !== fiscalCanonical(bodyTree(expected))) reject('REQUEST_XML_MISMATCH');
  } catch { reject('REQUEST_XML_MISMATCH'); }
}

export async function verifyBetaSummaryAcceptance(
  doc: FiscalDocumentSnapshot | FiscalNoteSnapshot, evidence: FiscalAcceptanceEvidence, asOf: string, ports: BetaSummaryAcceptancePorts,
): Promise<BetaSummaryAcceptanceMetadata> {
  let frozenDoc: typeof doc, frozenEvidence: FiscalAcceptanceEvidence, inputFingerprint: string;
  try {
    frozenDoc = structuredClone(doc); frozenEvidence = structuredClone(evidence);
    if (frozenDoc.documentTypeCode === '03') validateFiscalOriginal(frozenDoc, asOf);
    validateFiscalAcceptance(frozenDoc, frozenEvidence, asOf);
    if (frozenEvidence.source.kind !== 'CDR_SUMMARY' || !['03', '07', '08'].includes(frozenDoc.documentTypeCode)) reject('FISCAL_EVIDENCE_INVALID');
    inputFingerprint = fiscalSnapshotSha256({ doc, evidence });
  } catch { reject('FISCAL_EVIDENCE_INVALID'); }
  const source = frozenEvidence.source;
  if (source.kind !== 'CDR_SUMMARY') reject('FISCAL_EVIDENCE_INVALID');
  async function load(): Promise<BetaSummaryAcceptedBatch> {
    let loaded: BetaSummaryAcceptedBatch | null;
    try { loaded = await ports.loadBatch(frozenEvidence.issuerRuc, 'BETA', source.identifier); } catch { reject('BATCH_UNAVAILABLE'); }
    if (!loaded) reject('BATCH_NOT_FOUND');
    return loaded;
  }
  const loaded = await load(); let record: BetaSummaryAcceptedBatch, fingerprint: string;
  try { record = copyRecord(loaded); validateRecord(record, frozenDoc, frozenEvidence, asOf); fingerprint = recordFingerprint(record); checkRequestXml(record, asOf); }
  catch (error) { if (error instanceof BetaSummaryAcceptanceError) throw error; reject('BATCH_INVALID'); }
  let zip: Buffer;
  try { zip = Buffer.from(await ports.readCdr(copyRecord(record))); } catch { reject('CDR_UNAVAILABLE'); }
  if (zip.length !== record.cdrZip.sizeBytes || sha256(zip) !== frozenEvidence.cdrSha256) reject('CDR_ARTIFACT_MISMATCH');
  let parsed: ReturnType<typeof parseCdrZip>;
  try { parsed = cdrDetails(zip, frozenEvidence); } catch (error) { if (error instanceof BetaSummaryAcceptanceError) throw error; reject('CDR_INVALID'); }
  if (parsed.status !== record.status || parsed.status !== frozenEvidence.status) reject('CDR_ARTIFACT_MISMATCH');
  let trusted: boolean;
  try { trusted = await ports.verifySignature(Buffer.from(parsed.xml)); } catch { reject('CDR_UNTRUSTED'); }
  if (trusted !== true) reject('CDR_UNTRUSTED');
  const current = await load();
  try {
    if (recordFingerprint(loaded) !== fingerprint || recordFingerprint(current) !== fingerprint) reject('BATCH_CHANGED');
    validateRecord(current, frozenDoc, frozenEvidence, asOf);
    if (fiscalSnapshotSha256({ doc, evidence }) !== inputFingerprint) reject('INPUT_CHANGED');
  } catch (error) { if (error instanceof BetaSummaryAcceptanceError) throw error; reject('BATCH_CHANGED'); }
  return {
    environment: 'BETA', issuerRuc: frozenEvidence.issuerRuc, batchDocumentId: record.batch.documentId, identifier: source.identifier,
    batchSnapshotSha256: fiscalSnapshotSha256(record.batch), documentId: frozenDoc.documentId, documentTypeCode: frozenDoc.documentTypeCode as '03' | '07' | '08',
    fullNumber: frozenDoc.fullNumber, snapshotSha256: frozenEvidence.snapshotSha256, referenceDate: source.referenceDate,
    lineNumber: source.lineNumber, conditionCode: source.conditionCode, acceptedAt: record.completedAt,
    status: record.status, responseCode: '0', cdrFileName: `R-${frozenEvidence.issuerRuc}-${source.identifier}.xml`,
    cdrZipSha256: sha256(zip), cdrXmlSha256: sha256(parsed.xml), description: parsed.description, notes: [...parsed.notes],
    ...(record.requestXml ? { requestXmlSha256: record.requestXml.sha256 } : {}),
  };
}
