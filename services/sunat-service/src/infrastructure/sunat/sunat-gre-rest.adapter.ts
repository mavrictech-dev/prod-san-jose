import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import type { SignedPackage, SubmissionReceipt, SunatSubmissionPort, TicketStatus } from '../../domain/ports/sunat-adapter.port';
export const GRE_OFFICIAL = Object.freeze({
  security: 'https://api-seguridad.sunat.gob.pe/v1/clientessol',
  api: 'https://api-cpe.sunat.gob.pe/v1/contribuyente/gem/comprobantes',
  scope: 'https://api-cpe.sunat.gob.pe',
});
export interface GreRestConfig {
  environment: 'PRODUCTION'; enabled: boolean; ruc: string; solUser: string; solPassword: string;
  clientId: string; clientSecret: string; credentialRevision: number;
  readiness: { certificateTrusted: boolean; xsdValidated: boolean; fiscalRulesValidated: boolean };
}
export class GreRestError extends Error {
  constructor(readonly code: string, readonly receiptUnknown = false) { super(`GRE: ${code}${receiptUnknown ? ' · recepción desconocida; conciliar, no reenviar automáticamente' : ''}`); }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validRuc(value: string) {
  if (!/^(10|20)\d{9}$/.test(value)) return false;
  const sum = [5,4,3,2,7,6,5,4,3,2].reduce((n,w,i) => n + w * Number(value[i]), 0), digit = 11 - sum % 11;
  return Number(value[10]) === (digit === 10 ? 0 : digit === 11 ? 1 : digit);
}
function secret(s: unknown, max = 2048): s is string { return typeof s === 'string' && s.length > 0 && s.length <= max && !/[\r\n\0]/.test(s); }
async function boundedJson(response: Response, limit: number) {
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) { await response.body?.cancel(); throw new GreRestError('RESPUESTA_INVALIDA'); }
  const reader = response.body?.getReader(); if (!reader) throw new GreRestError('RESPUESTA_VACIA');
  const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > limit) throw new Error(); parts.push(part.value); }
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch { await reader.cancel().catch(() => undefined); throw new GreRestError('RESPUESTA_INVALIDA'); }
}
/** URLs oficiales fijas, TLS de Node, redirects prohibidos. Token sólo RAM por RUC/client/revisión.
 * Este adaptador NO se registra en GreQaModule ni permite una GRE local como envío oficial.
 * El caller fiscal deberá verificar XMLDSig/PKI/reglas/CDR fuera de este transporte.
 */
export class SunatGreRestAdapter implements SunatSubmissionPort {
  private readonly config: Readonly<GreRestConfig>;
  private token?: { value: string; expiresAt: number }; private pendingToken?: Promise<string>;
  constructor(config: GreRestConfig) { this.config = Object.freeze({ ...config, readiness: Object.freeze({ ...config.readiness }) }); }
  private enabled() {
    const c = this.config;
    if (process.env.GRE_EXTERNAL_TRANSMISSION_ENABLED !== 'true' || !c.enabled || c.environment !== 'PRODUCTION') throw new GreRestError('TRANSMISION_DESHABILITADA');
    if (!validRuc(c.ruc) || !UUID.test(c.clientId) || !/^[A-Za-z0-9]{1,30}$/.test(c.solUser) || !secret(c.solPassword) || !secret(c.clientSecret) || !Number.isSafeInteger(c.credentialRevision) || c.credentialRevision < 1) throw new GreRestError('CONFIGURACION_INVALIDA');
    if (!c.readiness.certificateTrusted || !c.readiness.xsdValidated || !c.readiness.fiscalRulesValidated) throw new GreRestError('GATES_FISCALES_PENDIENTES');
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new GreRestError('TLS_INSEGURO');
  }
  clearToken() { this.token = undefined; }
  private async accessToken() {
    this.enabled();
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (this.pendingToken) return this.pendingToken;
    this.pendingToken = this.obtainToken();
    try { return await this.pendingToken; } finally { this.pendingToken = undefined; }
  }
  private async obtainToken() {
    const c = this.config;
    const form = new URLSearchParams({ grant_type: 'password', scope: GRE_OFFICIAL.scope, client_id: c.clientId, client_secret: c.clientSecret, username: `${c.ruc}${c.solUser}`, password: c.solPassword });
    let response: Response;
    try { response = await fetch(`${GRE_OFFICIAL.security}/${c.clientId}/oauth2/token/`, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form, signal: AbortSignal.timeout(15000) }); }
    catch { throw new GreRestError('TOKEN_NO_DISPONIBLE'); }
    if (!response.ok) { await response.body?.cancel(); throw new GreRestError(`TOKEN_HTTP_${response.status}`); }
    const body = await boundedJson(response, 64 * 1024);
    if (typeof body.access_token !== 'string' || !/^[A-Za-z0-9_.-]{1,8192}$/.test(body.access_token) || !['JWT','Bearer'].includes(String(body.token_type)) || !Number.isInteger(body.expires_in) || Number(body.expires_in) < 61 || Number(body.expires_in) > 86400) throw new GreRestError('TOKEN_INVALIDO');
    this.token = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) - 60) * 1000 };
    return this.token.value;
  }
  private validatePackage(pkg: SignedPackage) {
    this.enabled();
    const match = /^(\d{11})-09-(T[A-Z0-9]{3})-([1-9]\d{0,7})\.zip$/.exec(pkg.fileName);
    if (!match || match[1] !== this.config.ruc || match[2] === 'TQ00' || !Buffer.isBuffer(pkg.zip) || pkg.zip.length < 4 || pkg.zip.length > 2 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(pkg.sha256) || createHash('sha256').update(pkg.zip).digest('hex') !== pkg.sha256) throw new GreRestError('PAQUETE_INVALIDO');
    let selected = 0;
    const expected = pkg.fileName.replace(/\.zip$/, '.xml');
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(pkg.zip, { filter: file => {
        if (++selected > 1 || file.originalSize <= 0 || file.originalSize > 2 * 1024 * 1024 || file.name !== expected) throw new Error();
        return true;
      } });
    } catch { throw new GreRestError('ZIP_INVALIDO'); }
    const bytes = entries[expected];
    if (selected !== 1 || !bytes) throw new GreRestError('XML_INVALIDO');
    const xml = Buffer.from(bytes).toString('utf8');
    if (/<!|<\?(?!xml\s)|PRUEBA LOCAL|GRE-QA-/i.test(xml)) throw new GreRestError('XML_QA_O_INSEGURO');
    try {
      const doc = new DOMParser({ onError: () => { throw new Error(); } }).parseFromString(xml,'application/xml'), root = doc.documentElement;
      if (!root || root.localName !== 'DespatchAdvice' || root.namespaceURI !== 'urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2' || doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#','Signature').length !== 1) throw new Error();
      const cbc = 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
      const direct = (name: string) => Array.from(root.childNodes).filter(n => n.nodeType === 1 && (n as NonNullable<typeof root>).namespaceURI === cbc && (n as NonNullable<typeof root>).localName === name);
      if (direct('ID').length !== 1 || direct('ID')[0].textContent !== `${match[2]}-${match[3]}` || direct('DespatchAdviceTypeCode').length !== 1 || direct('DespatchAdviceTypeCode')[0].textContent !== '09') throw new Error();
    } catch { throw new GreRestError('XML_INVALIDO'); }
    return pkg.fileName.slice(0, -4);
  }
  async submit(pkg: SignedPackage): Promise<SubmissionReceipt> {
    const reference = this.validatePackage(pkg), token = await this.accessToken();
    let response: Response;
    try { response = await fetch(`${GRE_OFFICIAL.api}/${reference}`, { method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ archivo: { nomArchivo: pkg.fileName, arcGreZip: pkg.zip.toString('base64'), hashZip: pkg.sha256 } }), signal: AbortSignal.timeout(30000) }); }
    catch { throw new GreRestError('ENVIO_SIN_RESPUESTA', true); }
    if (response.status === 401) this.clearToken();
    if (!response.ok) { await response.body?.cancel(); throw new GreRestError(`ENVIO_HTTP_${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500); }
    let body: Record<string, unknown>;
    try { body = await boundedJson(response, 64 * 1024); } catch { throw new GreRestError('ENVIO_RESPUESTA_INVALIDA', true); }
    if (typeof body.numTicket !== 'string' || !UUID.test(body.numTicket)) throw new GreRestError('TICKET_INVALIDO', true);
    return { kind: 'TICKET', ticket: body.numTicket };
  }
  async getStatus(ticket: string): Promise<TicketStatus> {
    this.enabled(); if (!UUID.test(ticket)) throw new GreRestError('TICKET_INVALIDO');
    let response: Response; const token = await this.accessToken();
    try { response = await fetch(`${GRE_OFFICIAL.api}/envios/${ticket}`, { redirect: 'error', headers: { authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
    catch { return { kind: 'ERROR', code: 'CONSULTA_NO_DISPONIBLE', message: 'Reintentar sólo consulta del ticket; no reenviar GRE', retryable: true }; }
    if (response.status === 401) this.clearToken();
    if (!response.ok) { await response.body?.cancel(); return { kind: 'ERROR', code: `HTTP_${response.status}`, message: 'Consulta GRE no disponible', retryable: response.status === 429 || response.status >= 500 }; }
    const b = await boundedJson(response, 7 * 1024 * 1024);
    if (b.codRespuesta === '98' && !b.arcCdr) return { kind: 'PROCESSING' };
    if (['0','99'].includes(String(b.codRespuesta)) && b.indCdrGenerado === '1' && typeof b.arcCdr === 'string' && b.arcCdr.length <= 7 * 1024 * 1024 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b.arcCdr)) {
      const zip = Buffer.from(b.arcCdr,'base64');
      if (zip.length >= 4 && zip.length <= 5 * 1024 * 1024 && zip.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4]))) return { kind: 'CDR', cdrZip: zip };
    }
    if (b.codRespuesta === '99' && b.indCdrGenerado === '0') return { kind: 'ERROR', code: 'GRE_RECHAZADA_SIN_CDR', message: 'Respuesta funcional GRE sin CDR; revisar y conciliar', retryable: false };
    return { kind: 'ERROR', code: 'RESPUESTA_GRE_INVALIDA', message: 'Respuesta inesperada; no declarar aceptación', retryable: false };
  }
}
