import type {
  ReceivedAutomationConfig, ReceivedAutomationSave, ReceivedAutomationSettings,
  ReceivedSireDiscovery, ReceivedSyncRun,
} from '@factuez/contracts';
import { createReceivedOperation, RECEIVED_API, type ReceivedSelection } from './received-documents-model';
import type { User } from './types';

export const RECEIVED_AUTOMATION_API = `${RECEIVED_API}/automation`;
export const RECEIVED_AUTOMATION_POLL_MS = 20_000;
export type ReceivedAutomationSource = 'MAIL' | 'SIRE' | 'ALL';
/** The incident endpoint exposes metadata only, with no record body or credentials. */
export type ReceivedSireIncidentMetadata = { id: string; period: string; ordinal: number; code: string; observedAt: string };
export type ReceivedAutomationIncidentPage = { items: ReceivedSireIncidentMetadata[] };
export type ReceivedAutomationCredentials = { mailPassword: string; sireClientSecret: string; solPassword: string };
export type ReceivedAutomationDraft = {
  expectedRevision: number;
  settings: ReceivedAutomationSettings;
  savedSettings: ReceivedAutomationSettings;
  credentials: ReceivedAutomationCredentials;
};

export function canManageReceivedAutomation(user: User | undefined, permission: boolean) {
  return !!user && permission && user.scope.kind === 'GLOBAL' && user.roles.includes('ADMIN');
}

/** Clearing either form must not clear pending work in the other form. */
export function receivedListDirty(importDirty: boolean, automationDirty: boolean) {
  return importDirty || automationDirty;
}

export function receivedAutomationSelectionAllowed(selection: ReceivedSelection, user: User | undefined) {
  return !!user && Number.isSafeInteger(selection.company.id) && selection.company.id > 0 &&
    /^\d{11}$/.test(selection.company.ruc) && (user.scope.kind === 'GLOBAL' ||
      !!selection.branchId && user.scope.branchIds.includes(selection.branchId));
}

/** Authorization/source changes remount every feed and clear all in-memory secrets. */
export function receivedAutomationScopeKey(selection: ReceivedSelection, user: User, catalogSource: string) {
  return JSON.stringify([selection.company.id, selection.company.ruc, selection.branchId,
    selection.dataSource, catalogSource, user.sub, user.scope, user.roles, user.permissions]);
}

export function receivedAutomationQuery(selection: ReceivedSelection, resource: 'config' | 'runs' | 'discoveries' | 'incidents') {
  const params = new URLSearchParams({ companyId: String(selection.company.id) });
  if (resource === 'discoveries' && selection.branchId) params.set('branchId', selection.branchId);
  return `${RECEIVED_AUTOMATION_API}/${resource}?${params}`;
}

function copySettings(settings: ReceivedAutomationSettings): ReceivedAutomationSettings {
  return { ...settings, mailbox: { ...settings.mailbox }, sire: { ...settings.sire } };
}

export function createReceivedAutomationDraft(config: ReceivedAutomationConfig): ReceivedAutomationDraft {
  return { expectedRevision: config.revision, settings: copySettings(config.settings), savedSettings: copySettings(config.settings),
    credentials: { mailPassword: '', sireClientSecret: '', solPassword: '' } };
}

/** Polls update safe status only. Loading a new draft is always an explicit action. */
export function reconcileReceivedAutomationDraft(draft: ReceivedAutomationDraft | undefined, config: ReceivedAutomationConfig) {
  return draft ?? createReceivedAutomationDraft(config);
}

export function receivedAutomationDraftDirty(draft: ReceivedAutomationDraft) {
  return JSON.stringify(draft.settings) !== JSON.stringify(draft.savedSettings) ||
    Object.values(draft.credentials).some(value => value.length > 0);
}

export function receivedAutomationSettingsError(settings: ReceivedAutomationSettings, recipientRuc: string, currentPeriod = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit' }).format(new Date()).replace('-', '')): string | undefined {
  if (!Number.isSafeInteger(settings.intervalMinutes) || settings.intervalMinutes < 5 || settings.intervalMinutes > 1440) return 'El intervalo debe ser un número entero entre 5 y 1440 minutos.';
  if (settings.mailbox.port !== 993) return 'La recepción requiere IMAP con TLS en el puerto 993.';
  if (settings.enabled && !settings.mailbox.enabled && !settings.sire.enabled) return 'Activa correo o SIRE antes de habilitar la recepción automática.';
  if (settings.mode === 'LOCAL_FIXTURE' && !/^00\d{9}$/.test(recipientRuc)) return 'Las fixtures locales sólo se permiten para RUC ficticios con prefijo 00.';
  if (!/^(20\d{2})(0[1-9]|1[0-2])$/.test(settings.sire.startPeriod)) return 'Indica el periodo inicial SIRE en formato AAAAMM, con un mes entre 01 y 12.';
  if (settings.sire.startPeriod > currentPeriod) return 'El periodo inicial SIRE no puede ser posterior al mes actual.';
  if (settings.mode === 'LIVE_READ_ONLY') {
    if (settings.mailbox.enabled) {
      const host = settings.mailbox.host.trim();
      if (host.length > 253 || !host || /^\d+(\.\d+){3}$/.test(host) ||
        !host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) return 'Indica el hostname IMAP exacto aprobado por TI, sin URL ni dirección IP.';
      if (!settings.mailbox.folder.trim() || !settings.mailbox.username.trim()) return 'Completa la carpeta y el usuario del buzón IMAP.';
    }
    if (settings.sire.enabled && (!/^[A-Za-z0-9-]{1,128}$/.test(settings.sire.clientId.trim()) || !/^[A-Za-z0-9]{1,32}$/.test(settings.sire.solUsername.trim()) || /^\d{11}/.test(settings.sire.solUsername.trim()))) return 'Completa el client ID y el usuario SOL (sin RUC como prefijo) para preparar SIRE.';
  }
}

/** Empty password inputs are omitted. Password bytes are never trimmed or persisted. */
export function receivedAutomationSave(draft: ReceivedAutomationDraft): ReceivedAutomationSave {
  const settings = copySettings(draft.settings);
  settings.mailbox.host = settings.mailbox.host.trim().toLowerCase();
  settings.mailbox.username = settings.mailbox.username.trim();
  settings.mailbox.folder = settings.mailbox.folder.trim();
  settings.sire.clientId = settings.sire.clientId.trim();
  settings.sire.solUsername = settings.sire.solUsername.trim();
  const credentials = Object.fromEntries(Object.entries(draft.credentials).filter(([, value]) => value.length > 0));
  return { expectedRevision: draft.expectedRevision, settings, ...(Object.keys(credentials).length ? { credentials } : {}) };
}

export function receivedAutomationSyncBlock(config: ReceivedAutomationConfig, source: ReceivedAutomationSource): string | undefined {
  if (!config.canManage) return 'La configuración no autoriza gestionar la recepción.';
  if (!config.settings.enabled) return 'La recepción automática está deshabilitada.';
  const mail = source !== 'SIRE' && config.settings.mailbox.enabled;
  const sire = source !== 'MAIL' && config.settings.sire.enabled;
  if (!mail && !sire) return 'La fuente seleccionada está deshabilitada.';
  if (config.settings.mode === 'LOCAL_FIXTURE') {
    if (!/^00\d{9}$/.test(config.recipientRuc)) return 'Las fixtures locales sólo se permiten para RUC ficticios con prefijo 00.';
    if (config.state !== 'READY_LOCAL') return 'La preparación local todavía no está lista.';
  } else {
    if (!config.liveReadAllowed) return 'Esperando TI: la lectura externa todavía no está autorizada en el servidor.';
    if (mail && !config.mailHostApproved) return 'Esperando TI: el hostname IMAP guardado aún no está aprobado.';
    if ((mail && !config.credentials.mailPassword) || (sire && (!config.credentials.sireClientSecret || !config.credentials.solPassword))) return 'Esperando TI: faltan credenciales guardadas para esta fuente.';
    if (config.state !== 'READY_READ_ONLY') return 'Esperando TI: el servidor todavía no declara lista la lectura.';
  }
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === 'string';
function isSettings(value: unknown): value is ReceivedAutomationSettings {
  if (!object(value) || !object(value.mailbox) || !object(value.sire)) return false;
  const { mailbox, sire } = value;
  return typeof value.enabled === 'boolean' && ['LOCAL_FIXTURE', 'LIVE_READ_ONLY'].includes(String(value.mode)) &&
    Number.isSafeInteger(value.intervalMinutes) && typeof mailbox.enabled === 'boolean' && mailbox.port === 993 &&
    ['host', 'folder', 'username'].every(key => typeof mailbox[key] === 'string') &&
    typeof sire.enabled === 'boolean' && ['startPeriod', 'clientId', 'solUsername'].every(key => typeof sire[key] === 'string');
}

export function receivedAutomationConfigInScope(value: unknown, selection: ReceivedSelection): value is ReceivedAutomationConfig {
  if (!object(value) || !object(value.credentials)) return false;
  const { credentials } = value;
  return object(value) && value.companyId === selection.company.id && value.recipientRuc === selection.company.ruc &&
    Number.isSafeInteger(value.revision) && Number(value.revision) >= 0 && nullableString(value.updatedAt) && isSettings(value.settings) &&
    ['mailPassword', 'sireClientSecret', 'solPassword'].every(key => typeof credentials[key] === 'boolean') &&
    typeof value.liveReadAllowed === 'boolean' && typeof value.mailHostApproved === 'boolean' && typeof value.canManage === 'boolean' &&
    ['DISABLED', 'READY_LOCAL', 'WAITING_TI', 'READY_READ_ONLY'].includes(String(value.state)) && typeof value.notice === 'string';
}

export function receivedAutomationRunsValid(value: unknown): value is { items: ReceivedSyncRun[] } {
  return object(value) && Array.isArray(value.items) && value.items.every(row => {
    if (!object(row) || !object(row.counters)) return false;
    const { counters } = row;
    return typeof row.id === 'string' &&
    ['MAIL', 'SIRE'].includes(String(row.source)) && ['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'BLOCKED'].includes(String(row.status)) &&
    nullableString(row.startedAt) && nullableString(row.finishedAt) && nullableString(row.errorCode) &&
    ['detected', 'imported', 'duplicate', 'rejected', 'xmlPending', 'matches', 'mismatches'].every(key => Number.isSafeInteger(counters[key]) && Number(counters[key]) >= 0);
  });
}

export function receivedAutomationDiscoveriesInScope(value: unknown, selection: ReceivedSelection, matchedOnly = false): value is { items: ReceivedSireDiscovery[] } {
  return object(value) && Array.isArray(value.items) && value.items.every(row => object(row) && row.companyId === selection.company.id &&
    row.recipientRuc === selection.company.ruc && ['id', 'period', 'supplierRuc', 'documentType', 'fullNumber', 'issueDate', 'observedAt'].every(key => typeof row[key] === 'string') &&
    ['supplierName', 'currencyCode', 'amount', 'documentId'].every(key => nullableString(row[key])) && ['PENDING', 'MATCHED', 'CONFLICT'].includes(String(row.xmlStatus)) &&
    (!matchedOnly || row.xmlStatus === 'MATCHED' && typeof row.documentId === 'string' && row.documentId.length > 0));
}

/** Reject the whole response if any incident includes rawRecord or other fields. */
export function receivedAutomationIncidentsValid(value: unknown): value is ReceivedAutomationIncidentPage {
  if (!object(value) || Object.keys(value).some(key => key !== 'items') || !Array.isArray(value.items)) return false;
  const keys = ['id', 'period', 'ordinal', 'code', 'observedAt'];
  const ids = new Set<string>();
  return value.items.every(row => {
    if (!object(row) || Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key)) ||
      typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id) ||
      typeof row.period !== 'string' || !/^\d{4}(0[1-9]|1[0-2])$/.test(row.period) ||
      !Number.isSafeInteger(row.ordinal) || Number(row.ordinal) < 0 ||
      typeof row.code !== 'string' || !row.code.trim() ||
      typeof row.observedAt !== 'string' || !Number.isFinite(Date.parse(row.observedAt))) return false;
    ids.add(row.id);
    return true;
  });
}

/** No overlapping polls, no completion after unmount/scope change, no initial-data reset. */
export function createReceivedAutomationPoll<T>(read: (signal: AbortSignal) => Promise<T>, onValue: (value: T) => void, onError: () => void) {
  const operation = createReceivedOperation();
  let pending = false, cancelled = false;
  return {
    async run() {
      if (pending || cancelled) return;
      pending = true;
      const controller = operation.start();
      try {
        const value = await read(controller.signal);
        if (operation.current(controller)) onValue(value);
      } catch {
        if (operation.current(controller)) onError();
      } finally { pending = false; }
    },
    cancel() { cancelled = true; operation.cancel(); },
  };
}
