import { AccessError } from '@factuez/service-access';
import { isIP } from 'node:net';
import type { ReceivedAutomationSave, ReceivedAutomationSettings, ReceivedSyncCounters } from '@factuez/contracts';
export const RECEIVED_SYNC_QUEUE = 'received-sync-v1';
export const emptyCounters = (): ReceivedSyncCounters => ({ detected: 0, imported: 0, duplicate: 0, rejected: 0, xmlPending: 0, matches: 0, mismatches: 0 });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, limit: number, empty = false): v is string => typeof v === 'string' && (empty || !!v.length) && v.length <= limit && !/[\x00-\x1f\x7f]/.test(v);
function only(v: Record<string, unknown>, keys: string[]) { if (Object.keys(v).some(k => !keys.includes(k))) throw new AccessError(400, 'Campo de recepción no permitido'); }
export function imapHost(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 253 && !isIP(v) && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) && !/(^|\.)(localhost|local|internal|invalid|test|onion|lan|home)$/.test(v);
}
export function imapApproved(host: string, value = process.env.RECEIVED_IMAP_APPROVED_HOSTS ?? '') {
  const hosts = value.split(',').map(s => s.trim().toLowerCase());
  return hosts.length <= 16 && imapHost(host) && hosts.every(h => imapHost(h)) && hosts.includes(host);
}
export function validPeriod(v: unknown): v is string {
  return typeof v === 'string' && /^(20\d{2})(0[1-9]|1[0-2])$/.test(v);
}
export function defaultReceptionSettings(now = new Date()): ReceivedAutomationSettings {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit' }).formatToParts(now);
  const period = `${parts.find(p => p.type === 'year')!.value}${parts.find(p => p.type === 'month')!.value}`;
  return { enabled: false, mode: 'LIVE_READ_ONLY', intervalMinutes: 15,
    mailbox: { enabled: false, host: '', port: 993, folder: 'INBOX', username: '' },
    sire: { enabled: false, startPeriod: period, clientId: '', solUsername: '' } };
}
export function parseAutomationSave(input: unknown, ruc: string): ReceivedAutomationSave {
  if (!object(input) || !object(input.settings)) throw new AccessError(400, 'Configuración de recepción inválida');
  only(input, ['expectedRevision', 'settings', 'credentials']);
  const s = input.settings; only(s, ['enabled', 'mode', 'intervalMinutes', 'mailbox', 'sire']);
  if (!Number.isInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || (input.expectedRevision as number) > 2147483646 ||
    typeof s.enabled !== 'boolean' || !['LOCAL_FIXTURE', 'LIVE_READ_ONLY'].includes(String(s.mode)) || !Number.isInteger(s.intervalMinutes) ||
    (s.intervalMinutes as number) < 5 || (s.intervalMinutes as number) > 1440 || !object(s.mailbox) || !object(s.sire)) throw new AccessError(400, 'Revise modo, revisión e intervalo (5 a 1440 minutos)');
  if (s.mode === 'LOCAL_FIXTURE' && !/^00\d{9}$/.test(ruc)) throw new AccessError(400, 'Los ensayos locales requieren un RUC ficticio; no simulan compras de empresas reales');
  const m = s.mailbox, a = s.sire;
  only(m, ['enabled', 'host', 'port', 'folder', 'username']); only(a, ['enabled', 'startPeriod', 'clientId', 'solUsername']);
  if (typeof m.enabled !== 'boolean' || m.port !== 993 || !text(m.host, 253, true) || !text(m.folder, 150) || !text(m.username, 254, true) ||
    typeof a.enabled !== 'boolean' || !validPeriod(a.startPeriod) || a.startPeriod > defaultReceptionSettings().sire.startPeriod || !text(a.clientId, 150, true) || !text(a.solUsername, 64, true)) throw new AccessError(400, 'Revise buzón y periodo SIRE');
  if (s.mode === 'LIVE_READ_ONLY' && (m.enabled && (!imapHost(m.host) || !m.username) || a.enabled && (!/^[A-Za-z0-9-]{1,128}$/.test(a.clientId) || !/^[A-Za-z0-9]{1,32}$/.test(a.solUsername) || /^\d{11}/.test(a.solUsername)))) throw new AccessError(400, 'Complete los datos de los conectores habilitados; usuario SOL sin RUC como prefijo');
  if (s.enabled && !m.enabled && !a.enabled) throw new AccessError(400, 'Habilite correo o SIRE para automatizar');
  const credentials: Record<string, string> = {};
  if (input.credentials !== undefined) {
    if (!object(input.credentials)) throw new AccessError(400, 'Credenciales inválidas');
    only(input.credentials, ['mailPassword', 'sireClientSecret', 'solPassword']);
    for (const [k, v] of Object.entries(input.credentials)) {
      if (!text(v, 1024, true)) throw new AccessError(400, 'Credencial inválida');
      if (v) credentials[k] = v; // Empty keeps stored value; no accidental deletion.
    }
  }
  return { expectedRevision: input.expectedRevision as number, settings: s as unknown as ReceivedAutomationSettings, credentials };
}
export function receptionReadiness(s: ReceivedAutomationSettings, ruc: string, secrets: Record<string, string>) {
  if (!s.enabled) return 'DISABLED' as const;
  if (s.mode === 'LOCAL_FIXTURE') return /^00\d{9}$/.test(ruc) && process.env.RECEIVED_LOCAL_FIXTURE_ENABLED === 'true' ? 'READY_LOCAL' as const : 'WAITING_TI' as const;
  if (process.env.RECEIVED_LIVE_READ_ALLOWED !== 'true' ||
    s.mailbox.enabled && (!imapApproved(s.mailbox.host) || !secrets.mailPassword) ||
    s.sire.enabled && (!secrets.sireClientSecret || !secrets.solPassword)) return 'WAITING_TI' as const;
  return 'READY_READ_ONLY' as const;
}
/** Revisit latest three periods to catch late reports, without scanning arbitrary history. */
export function receptionPeriods(start: string, now = new Date()) {
  if (!validPeriod(start)) throw new AccessError(400, 'Periodo inválido');
  const periodNow = defaultReceptionSettings(now).sire.startPeriod;
  const result: string[] = [], current = new Date(Date.UTC(Number(periodNow.slice(0, 4)), Number(periodNow.slice(4)) - 1, 1));
  for (let i = 0; i < 3; i++) { const period = current.toISOString().slice(0, 7).replace('-', ''); if (period >= start) result.unshift(period); current.setUTCMonth(current.getUTCMonth() - 1); }
  return result;
}
export function fiscalAmountsMatch(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return false;
  const cents = (s: string) => { if (!/^-?\d{1,16}(?:\.\d{1,6})?$/.test(s)) return undefined; const negative = s.startsWith('-'), [whole, fraction = ''] = s.replace('-', '').split('.'); if (/[1-9]/.test(fraction.slice(2))) return undefined; const n = BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2)); return negative ? -n : n; };
  const first = cents(a), second = cents(b); return first !== undefined && second !== undefined && first === second;
}
