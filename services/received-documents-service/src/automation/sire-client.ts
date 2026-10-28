import { receptionHttpsFetch } from './network';
import { parseSirePurchaseBatch, type SirePurchaseBatch, type SirePurchaseIncident } from './sire-parser';
import { SIRE_LIMITS, SireError, sireEnsure, sireUtf8, validateSireContext, validateSireFileName } from './sire-safety';
import { SIRE_ORIGIN, SIRE_MASSIVE_PATH, sireTokenUrl, sireExportUrl, sireRequest, sireDelay } from './sire-http';
import { unpackSireZip } from './sire-zip';

export type SireCredentials = { ruc: string; clientId: string; clientSecret: string; solUsername: string; solPassword: string };
export type SirePurchase = {
  recipientRuc: string; period: string; supplierRuc: string; supplierName: string | null;
  documentType: string; series: string; number: string; fullNumber: string; issueDate: string;
  currencyCode: string | null; amount: string | null; rawRecord: Record<string, string>;
};
export { SireError, SIRE_LIMITS } from './sire-safety';
export type { SirePurchaseBatch, SirePurchaseIncident } from './sire-parser';

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  sireEnsure(value !== null && typeof value === 'object' && !Array.isArray(value), 'RESPONSE'); return value as JsonObject;
}
function json(bytes: Buffer): JsonObject {
  let value: unknown;
  try { value = JSON.parse(sireUtf8(bytes, 'RESPONSE')); } catch { throw new SireError('RESPONSE'); }
  const result = object(value);
  // Error envelopes must also fail when the server responds HTTP 200.
  sireEnsure(!['cod', 'errors', 'error', 'exc'].some(key => Object.hasOwn(result, key)), 'RESPONSE');
  return result;
}
function ticketNumber(value: unknown): string {
  sireEnsure(typeof value === 'string' && /^\d{14}$/.test(value), 'TICKET'); return value;
}

/** Current Lima period and its two predecessors, newest first; no I/O. */
export function sireRecentPeriods(startPeriod?: string): string[] {
  if (startPeriod === undefined) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    startPeriod = `${parts.find(p => p.type === 'year')!.value}${parts.find(p => p.type === 'month')!.value}`;
  }
  validateSireContext('00000000000', startPeriod);
  const monthIndex = Number(startPeriod.slice(0, 4)) * 12 + Number(startPeriod.slice(4)) - 1;
  return Array.from({ length: 3 }, (_, offset) => {
    const index = monthIndex - offset;
    const period = `${String(Math.floor(index / 12)).padStart(4, '0')}${String(index % 12 + 1).padStart(2, '0')}`;
    validateSireContext('00000000000', period); return period;
  });
}

/**
 * Consult/download only, based on official Manual SIRE Compras v28:
 * https://cpe.sunat.gob.pe/sites/default/files/inline-files/Manual%20de%20servicios%20Web%20Api%20-%20SIRE_Compras%20v28_0.pdf
 * §5.1 password grant (username RUC+SOL user); §5.34 export GET;
 * §5.31 ticket GET; §5.32 ZIP download GET. No acceptance, upload, generation
 * of a fiscal book, persistence, logging, CDR, document items or fiscal status.
 * Token is local to each invocation; credentials belong to exactly one RUC.
 * No live validation has been performed. Defaults to zero network activity.
 */
export class SireReadClient {
  #credentials: SireCredentials;
  #fetch: typeof fetch;
  #liveAllowed: boolean;

  constructor(credentials: SireCredentials, options?: { fetch?: typeof fetch; liveAllowed?: boolean }) {
    validateSireContext(credentials?.ruc, '200001');
    sireEnsure(typeof credentials.clientId === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(credentials.clientId) &&
      typeof credentials.solUsername === 'string' && /^[A-Za-z0-9]{1,32}$/.test(credentials.solUsername) &&
      !/^\d{11}/.test(credentials.solUsername) &&
      [credentials.clientSecret, credentials.solPassword].every(value => typeof value === 'string' &&
        value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/.test(value)), 'INPUT');
    this.#credentials = { ruc: credentials.ruc, clientId: credentials.clientId, clientSecret: credentials.clientSecret,
      solUsername: credentials.solUsername, solPassword: credentials.solPassword }; this.#fetch = options?.fetch ?? receptionHttpsFetch;
    this.#liveAllowed = options?.liveAllowed === true;
  }

  async readRecentPeriods(startPeriod?: string): Promise<SirePurchase[]> {
    sireEnsure(this.#liveAllowed, 'LIVE_DISABLED');
    const purchases: SirePurchase[] = [];
    for (const period of sireRecentPeriods(startPeriod)) purchases.push(...await this.readPeriod(period));
    return purchases;
  }

  async readPeriod(period: string): Promise<SirePurchase[]> {
    sireEnsure(this.#liveAllowed, 'LIVE_DISABLED');
    const batch = await this.readPeriodDetailed(period);
    // An array cannot carry visible incidents: do not silently return a subset.
    sireEnsure(batch.incidents.length === 0, 'UNSUPPORTED_RECORD'); return batch.purchases;
  }

  async readRecentPeriodsDetailed(startPeriod?: string): Promise<SirePurchaseBatch> {
    sireEnsure(this.#liveAllowed, 'LIVE_DISABLED');
    const result: SirePurchaseBatch = { purchases: [], incidents: [] }; let ordinal = 0;
    for (const period of sireRecentPeriods(startPeriod)) {
      const batch = await this.readPeriodDetailed(period);
      result.purchases.push(...batch.purchases);
      result.incidents.push(...batch.incidents.map(incident => ({ ...incident, ordinal: ordinal + incident.ordinal })));
      ordinal += batch.purchases.length + batch.incidents.length;
    }
    return result;
  }

  async validateCredentials(): Promise<void> { sireEnsure(this.#liveAllowed, 'LIVE_DISABLED'); await this.authenticate(Date.now() + SIRE_LIMITS.requestTimeoutMs); }
  private async authenticate(deadline: number) {
    const { ruc, clientId, clientSecret, solUsername, solPassword } = this.#credentials;
    const body = new URLSearchParams({ grant_type: 'password', scope: SIRE_ORIGIN,
      client_id: clientId, client_secret: clientSecret, username: `${ruc}${solUsername}`, password: solPassword });
    const auth = json(await sireRequest(this.#fetch, sireTokenUrl(clientId), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString(),
    }, SIRE_LIMITS.jsonBytes, deadline));
    sireEnsure(typeof auth.access_token === 'string' && /^[A-Za-z0-9._~+\/-]{1,8192}={0,2}$/.test(auth.access_token) &&
      typeof auth.token_type === 'string' && auth.token_type.toLowerCase() === 'bearer', 'RESPONSE');
    // No token cache, refresh-token retention, external storage or shared RUC state.
    return { Authorization: `Bearer ${auth.access_token}`, Accept: 'application/json', 'Content-Type': 'application/json' };
  }

  async readPeriodDetailed(period: string, checkpoint?: { ticket?: string; saveTicket(ticket: string): Promise<void>; beforeRequest?(): Promise<void> }): Promise<SirePurchaseBatch> {
    sireEnsure(this.#liveAllowed, 'LIVE_DISABLED');
    validateSireContext(this.#credentials.ruc, period);
    const deadline = Date.now() + SIRE_LIMITS.periodTimeoutMs;
    const ruc = this.#credentials.ruc;
    await checkpoint?.beforeRequest?.();
    const headers = await this.authenticate(deadline);
    const getJson = async (address: string) => { await checkpoint?.beforeRequest?.(); return json(await sireRequest(this.#fetch, address, { method: 'GET', headers }, SIRE_LIMITS.jsonBytes, deadline)); };
    const ticket = checkpoint?.ticket ? ticketNumber(checkpoint.ticket) : ticketNumber((await getJson(sireExportUrl(period))).numTicket);
    if (!checkpoint?.ticket) await checkpoint?.saveTicket(ticket);
    const query = new URLSearchParams({ perIni: period, perFin: period, page: '1', perPage: '20',
      numTicket: ticket, codLibro: '080000', codOrigenEnvio: '2' });
    let reports: { name: string; type: string }[] | undefined;
    for (let poll = 0; poll < SIRE_LIMITS.ticketPolls; poll++) {
      let result = await getJson(`${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}consultaestadotickets?${query}`);
      const records: unknown[] = [];
      for (let page = 1; ; page++) {
        sireEnsure(Array.isArray(result.registros) && result.registros.length <= 20, 'TICKET');
        records.push(...result.registros);
        const pagination = result.paginacion === undefined ? undefined : object(result.paginacion);
        const total = pagination?.totalRegistros ?? records.length;
        sireEnsure(Number.isSafeInteger(total) && Number(total) >= records.length && Number(total) <= 2000, 'TICKET');
        if (records.length >= Number(total)) break;
        sireEnsure(page < 100 && result.registros.length > 0, 'TICKET');
        query.set('page', String(page + 1));
        result = await getJson(`${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}consultaestadotickets?${query}`);
      }
      query.set('page', '1'); result = { registros: records };
      sireEnsure(Array.isArray(result.registros) && result.registros.length <= 2000, 'TICKET');
      const matches = result.registros.map(object).filter(record => record.numTicket === ticket && record.perTributario === period);
      sireEnsure(matches.length <= 1, 'TICKET');
      if (matches.length) {
        const record = matches[0];
        // Anexo I: 10 = export proposal; reject other processes even if returned.
        sireEnsure(record.codProceso === '10', 'TICKET');
        const state = record.codEstadoProceso;
        sireEnsure(typeof state === 'string' && /^(?:0?[1-6])$/.test(state), 'TICKET');
        if (state === '03' || state === '3') throw new SireError('TICKET');
        // v28 §5.32 has a codProcesos typo (3/4); §5.31 uses codEstadoProceso.
        // Require completed export, never treat a fiscal acceptance as success.
        if (['04', '4', '06', '6'].includes(state)) {
          const detail = object(record.detalleTicket);
          sireEnsure(ticketNumber(detail.numTicket) === ticket, 'TICKET');
          sireEnsure(Array.isArray(record.archivoReporte) && record.archivoReporte.length > 0 &&
            record.archivoReporte.length <= SIRE_LIMITS.reportFiles, 'TICKET');
          const names = new Set<string>();
          reports = record.archivoReporte.map(value => {
            const report = object(value); validateSireFileName(report.nomArchivoReporte, /\.zip$/i);
            const name = report.nomArchivoReporte;
            sireEnsure(!names.has(name.toLowerCase()), 'TICKET'); names.add(name.toLowerCase());
            // v28 spells the output both codTipoAchivoReporte and codTipoArchivoReporte.
            const hasCorrect = Object.hasOwn(report, 'codTipoArchivoReporte'), hasTypo = Object.hasOwn(report, 'codTipoAchivoReporte');
            sireEnsure(hasCorrect || hasTypo, 'TICKET');
            if (hasCorrect && hasTypo) sireEnsure(report.codTipoArchivoReporte === report.codTipoAchivoReporte, 'TICKET');
            const type = hasCorrect ? report.codTipoArchivoReporte : report.codTipoAchivoReporte;
            sireEnsure(type === null || typeof type === 'string' && /^\d{1,2}$/.test(type), 'TICKET');
            return { name, type: type === null ? 'null' : type as string };
          });
          break;
        }
      }
      if (poll + 1 < SIRE_LIMITS.ticketPolls) await sireDelay(SIRE_LIMITS.pollDelayMs, deadline);
    }
    sireEnsure(reports, 'TICKET_PENDING');
    const purchases: SirePurchase[] = [], incidents: SirePurchaseIncident[] = [], fileNames = new Set<string>();
    let downloaded = 0, expanded = 0, entries = 0, ordinal = 0;
    for (const report of reports) {
      const params = new URLSearchParams({ nomArchivoReporte: report.name, codTipoArchivoReporte: report.type,
        perTributario: period, codProceso: '10', numTicket: ticket, codLibro: '080000' });
      await checkpoint?.beforeRequest?.();
      const bytes = await sireRequest(this.#fetch, `${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}archivoreporte?${params}`, {
        method: 'GET', headers: { ...headers, Accept: 'application/octet-stream' },
      }, Math.min(SIRE_LIMITS.downloadBytes, SIRE_LIMITS.totalDownloadBytes - downloaded), deadline);
      downloaded += bytes.length;
      const files = unpackSireZip(bytes, { maxEntries: SIRE_LIMITS.zipEntries - entries, maxExpandedBytes: SIRE_LIMITS.expandedBytes - expanded });
      for (const file of files) {
        entries++; expanded += file.bytes.length;
        sireEnsure(entries <= SIRE_LIMITS.zipEntries && expanded <= SIRE_LIMITS.expandedBytes, 'SIZE');
        sireEnsure(!fileNames.has(file.fileName.toLowerCase()), 'ARCHIVE'); fileNames.add(file.fileName.toLowerCase());
        const batch = parseSirePurchaseBatch(file.bytes, ruc, period);
        const count = batch.purchases.length + batch.incidents.length;
        sireEnsure(ordinal + count <= SIRE_LIMITS.rows, 'SIZE'); purchases.push(...batch.purchases);
        incidents.push(...batch.incidents.map(incident => ({ ...incident, ordinal: ordinal + incident.ordinal })));
        ordinal += count;
      }
      sireEnsure(Date.now() < deadline, 'TIMEOUT');
    }
    return { purchases, incidents };
  }
}
