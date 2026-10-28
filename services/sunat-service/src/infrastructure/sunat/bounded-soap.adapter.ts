import { createHash } from 'node:crypto';
import { isRucStructurallyValid } from '@factuez/sunat-core';
import type { SignedPackage, SubmissionReceipt, SunatSubmissionPort, TicketStatus } from '../../domain/ports/sunat-adapter.port';
import { safeXml, child, children, leaf, escapeXml, SOAP_NS, SERVICE_NS } from './safe-xml';
import { singleNotesTransportXml, validateNoteBillXml } from './notes-transport-qa-validator';
import { validateBetaPackage } from './beta-package-validator';
import { validateProductionPackage, validateProductionCdr } from './production-package-validator';
import { assertProductionSoapAuthorized, hasProductionSoapAuthorization, type ProductionSoapAuthorization } from './production-soap-authorization';
export const SUNAT_PRODUCTION_ENDPOINT = 'https://e-factura.sunat.gob.pe/ol-ti-itcpfegem/billService';
export const SUNAT_BETA_ENDPOINT = 'https://e-beta.sunat.gob.pe/ol-ti-itcpfegem-beta/billService';
/** Identificador y contraseña públicos del SOAP Beta, no las claves SOL del emisor. */
export const SUNAT_BETA_PUBLIC_CREDENTIAL = 'MODDATOS';
// El apartado 2.3 publica MODDATOS; sus ejemplos WSSE usan moddatos.
// Se admiten sólo estas variantes públicas, sin fallback/reenvío automático.
export const SUNAT_BETA_PUBLIC_PASSWORDS: readonly string[] = Object.freeze(['MODDATOS', 'moddatos']);
export const LOCAL_QA_ENDPOINT = 'http://sunat-emulator:3006/billService';
export const QA_SCENARIOS = ['ACCEPTED', 'OBSERVED', 'REJECTED', 'UNCERTAIN', 'INVALID_CDR', 'TRANSIENT_STATUS'] as const;
export type QaScenario = typeof QA_SCENARIOS[number];
export interface SoapSunatConfig { environment: 'BETA' | 'LOCAL_QA' | 'PRODUCTION'; ruc: string; solUser: string; solPassword: string; qaScenario?: QaScenario }
export class SoapSubmissionError extends Error {
  constructor(readonly kind: 'BUSINESS' | 'UNKNOWN', readonly code: string) { super(kind === 'BUSINESS' ? 'El servicio devolvió un error de negocio' : 'Resultado del transporte desconocido; requiere conciliación'); }
}
export function base64Zip(value: string) {
  const compact = value.replace(/\s/g, '');
  if (!compact || compact.length > 6 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) throw new Error('ZIP base64 inválido');
  const bytes = Buffer.from(compact, 'base64'); if (bytes.subarray(0, 4).toString('hex') !== '504b0304') throw new Error('Respuesta no es ZIP'); return bytes;
}
/** SOAP 1.1/WS-Security. Destinos fijos, sin WSDL remoto ni logs de credenciales. */
export class BoundedSoapAdapter implements SunatSubmissionPort {
  readonly #config: Readonly<SoapSunatConfig>;
  readonly #productionAuthorization?: ProductionSoapAuthorization;
  constructor(config: SoapSunatConfig, productionAuthorization?: ProductionSoapAuthorization) {
    // La configuración validada no puede cambiar por mutación del objeto del llamador.
    this.#config = Object.freeze({ environment: config.environment, ruc: config.ruc,
      solUser: config.solUser, solPassword: config.solPassword, qaScenario: config.qaScenario });
    this.#productionAuthorization = productionAuthorization;
    this.assertTransportEnabled();
  }
  private assertTransportEnabled() {
    const config = this.#config;
    if (typeof config.ruc !== 'string' || typeof config.solUser !== 'string' || typeof config.solPassword !== 'string') throw new Error('Credenciales SOAP inválidas');
    if (!/^\d{11}$/.test(config.ruc) || !config.solUser || !config.solPassword || config.solUser.length > 100 || config.solPassword.length > 512) throw new Error('Credenciales SOAP inválidas');
    if (config.environment === 'LOCAL_QA') {
      if (process.env.FISCAL_CIRCUIT_QA_ENABLED !== 'true' || !/^00\d{9}$/.test(config.ruc)) throw new Error('Transporte QA deshabilitado');
    } else if (config.environment === 'PRODUCTION') {
      if (!hasProductionSoapAuthorization(this.#productionAuthorization, config.ruc) || config.qaScenario !== undefined)
        throw new Error('Transmisión de producción deshabilitada: autorización privada requerida');
      if (!isRucStructurallyValid(config.ruc)) throw new Error('RUC inválido para SOAP producción');
      if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS de producción requiere verificación');
      if (config.solUser.trim() !== config.solUser || !config.solUser.trim() || !config.solPassword.trim() ||
          config.solUser.startsWith(config.ruc) || /moddatos/i.test(config.solUser) || /moddatos/i.test(config.solPassword))
        throw new Error('SOAP producción exige credenciales SOL privadas sin RUC prefijado');
      escapeXml(config.solUser); escapeXml(config.solPassword);
    } else {
      if (config.environment !== 'BETA' || config.qaScenario !== undefined || process.env.SUNAT_BETA_TRANSMISSION_ENABLED !== 'true') throw new Error('Transmisión fiscal deshabilitada');
      if (!isRucStructurallyValid(config.ruc)) throw new Error('RUC inválido para SOAP Beta');
      if (config.solUser !== SUNAT_BETA_PUBLIC_CREDENTIAL || !SUNAT_BETA_PUBLIC_PASSWORDS.includes(config.solPassword)) throw new Error('SOAP Beta sólo admite las credenciales públicas de prueba');
    }
    if (config.qaScenario !== undefined && !QA_SCENARIOS.includes(config.qaScenario)) throw new Error('Escenario QA inválido');
  }
  async submit(pkg: SignedPackage): Promise<SubmissionReceipt> {
    this.assertTransportEnabled();
    if (this.#config.environment === 'PRODUCTION') {
      // Copy mutable request bytes before the asynchronous private authorization check.
      pkg = { ...pkg, zip: Buffer.from(pkg.zip) };
      validateProductionPackage(pkg, this.#config.ruc, 'sendBill');
    } else if (this.#config.environment === 'BETA') validateBetaPackage(pkg, this.#config.ruc, 'sendBill');
    else if (!/^\d{11}-01-F[A-Z0-9]{3}-[1-9]\d{0,7}\.zip$/.test(pkg.fileName)) {
      validateNoteBillXml(singleNotesTransportXml(pkg.zip, pkg.fileName).toString('utf8'), pkg.fileName, this.#config.ruc);
    }
    const response = await this.call('sendBill', this.packageXml(pkg));
    try { return { kind: 'CDR', cdrZip: this.responseZip(leaf(response, '', 'applicationResponse', 6 * 1024 * 1024), pkg.fileName) }; }
    catch { throw new SoapSubmissionError('UNKNOWN', 'INVALID_RESPONSE'); }
  }
  async submitSummary(pkg: SignedPackage): Promise<string> {
    this.assertTransportEnabled();
    if (!/^\d{11}-(?:RC|RA)-\d{8}-[1-9]\d{0,4}\.zip$/.test(pkg.fileName)) throw new Error('Nombre RC/RA inválido');
    if (this.#config.environment === 'PRODUCTION') {
      pkg = { ...pkg, zip: Buffer.from(pkg.zip) };
      validateProductionPackage(pkg, this.#config.ruc, 'sendSummary');
    } else if (this.#config.environment === 'BETA') validateBetaPackage(pkg, this.#config.ruc, 'sendSummary');
    const response = await this.call('sendSummary', this.packageXml(pkg));
    try { const ticket = leaf(response, '', 'ticket', 120); if (!/^[A-Za-z0-9_-]{1,120}$/.test(ticket)) throw new Error(); return ticket; }
    catch { throw new SoapSubmissionError('UNKNOWN', 'INVALID_TICKET'); }
  }
  async getStatus(ticket: string): Promise<TicketStatus> {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(ticket)) throw new Error('Ticket inválido');
    const response = await this.call('getStatus', `<ticket>${escapeXml(ticket)}</ticket>`);
    try {
      const status = child(response, '', 'status'); const code = leaf(status, '', 'statusCode', 10);
      if (code === '98' && children(status, '', 'content').length === 0) return { kind: 'PROCESSING' };
      if (code === '0' || code === '99') return { kind: 'CDR', cdrZip: this.responseZip(leaf(status, '', 'content', 6 * 1024 * 1024)) };
      return { kind: 'ERROR', code: /^\d{1,8}$/.test(code) ? code : 'INVALID_STATUS', message: 'Estado de ticket no reconocido; conciliar', retryable: false };
    } catch { throw new SoapSubmissionError('UNKNOWN', 'INVALID_STATUS'); }
  }
  private responseZip(value: string, fileName?: string): Buffer {
    const zip = base64Zip(value);
    if (this.#config.environment === 'PRODUCTION') return validateProductionCdr(zip, this.#config.ruc, fileName);
    return zip;
  }
  private packageXml(pkg: SignedPackage) {
    if (!pkg.fileName.startsWith(`${this.#config.ruc}-`) || !pkg.zip.length || pkg.zip.length > 4 * 1024 * 1024 || createHash('sha256').update(pkg.zip).digest('hex') !== pkg.sha256) throw new Error('Paquete inconsistente');
    return `<fileName>${escapeXml(pkg.fileName)}</fileName><contentFile>${pkg.zip.toString('base64')}</contentFile>`;
  }
  private async call(method: 'sendBill' | 'sendSummary' | 'getStatus', body: string) {
    // Revocar un flag detiene también instancias ya construidas, antes de cualquier POST.
    this.assertTransportEnabled();
    const wsse = 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd';
    const envelope = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${SOAP_NS}" xmlns:ser="${SERVICE_NS}" xmlns:wsse="${wsse}"><soap:Header><wsse:Security soap:mustUnderstand="1"><wsse:UsernameToken><wsse:Username>${escapeXml(this.#config.ruc + this.#config.solUser)}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(this.#config.solPassword)}</wsse:Password></wsse:UsernameToken></wsse:Security></soap:Header><soap:Body><ser:${method}>${body}</ser:${method}></soap:Body></soap:Envelope>`;
    if (this.#config.environment === 'PRODUCTION') {
      await assertProductionSoapAuthorized(this.#productionAuthorization, this.#config.ruc, method);
      // Recheck revocation/TLS after awaiting owner policy and immediately before POST.
      this.assertTransportEnabled();
    }
    try {
      const endpoint = this.#config.environment === 'LOCAL_QA' ? LOCAL_QA_ENDPOINT
        : this.#config.environment === 'PRODUCTION' ? SUNAT_PRODUCTION_ENDPOINT : SUNAT_BETA_ENDPOINT;
      const response = await fetch(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: method, Accept: 'text/xml', ...(this.#config.environment === 'LOCAL_QA' ? { 'X-Factuez-QA-Scenario': this.#config.qaScenario ?? 'ACCEPTED' } : {}) }, body: envelope, redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      if (Number(response.headers.get('content-length')) > 7 * 1024 * 1024) { await response.body?.cancel(); throw new Error(); }
      const chunks: Uint8Array[] = []; let length = 0; const reader = response.body?.getReader(); if (!reader) throw new Error();
      while (true) { const item = await reader.read(); if (item.done) break; length += item.value.length;
        if (length > 7 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(item.value); }
      const root = safeXml(Buffer.concat(chunks).toString('utf8'), 7 * 1024 * 1024);
      if (root.namespaceURI !== SOAP_NS || root.localName !== 'Envelope') throw new Error();
      const responseBody = child(root, SOAP_NS, 'Body'); const faults = children(responseBody, SOAP_NS, 'Fault');
      if (faults.length === 1) {
        const raw = leaf(faults[0], '', 'faultcode', 100); const code = raw.match(/(?:^|\.)(\d{3,5})$/)?.[1];
        if (code && response.status === 500) throw new SoapSubmissionError('BUSINESS', code); throw new Error();
      }
      if (!response.ok || faults.length) throw new Error(); return child(responseBody, SERVICE_NS, `${method}Response`);
    } catch (error) { if (error instanceof SoapSubmissionError) throw error; throw new SoapSubmissionError('UNKNOWN', 'TRANSPORT_OR_RESPONSE'); }
  }
}
