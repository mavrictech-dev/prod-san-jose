import {createHash} from 'node:crypto';
import {types} from 'node:util';
import {CONFIG_NAMES, CUSTODY_PURPOSES, OWNER_FORMATS, OWNERS, PROFILE,
  type Context, type Configuration, type Inventory, type OwnerSnapshot} from './ports';
export const LIMITS = Object.freeze({dump: 8 * 1024 ** 2, file: 4 * 1024 ** 2,
  raw: 32 * 1024 ** 2, envelope: 48 * 1024 ** 2, files: 128, tables: 512, maxAgeMs: 24 * 3600000});
export class BackupError extends Error {
  constructor(code: string) { super(code); this.name = 'DeploymentBackupError'; }
}
export function requireThat(ok: unknown, code = 'DEPLOYMENT_BACKUP_INVALID'): asserts ok {
  if (!ok) throw new BackupError(code);
}
export const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
export function record(value: any, keys: string[]) {
  requireThat(value && typeof value === 'object' && !types.isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireThat(Reflect.ownKeys(value).length === keys.length && keys.every(k => Object.hasOwn(descriptors, k)) &&
    Object.values(descriptors).every(d => d.enumerable && 'value' in d));
}
export function list(value: any, max: number, min = 0) {
  requireThat(Array.isArray(value) && !types.isProxy(value) && Object.getPrototypeOf(value) === Array.prototype &&
    value.length >= min && value.length <= max && Reflect.ownKeys(value).length === value.length + 1);
  for (let n = 0; n < value.length; n++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(n));
    requireThat(descriptor?.enumerable && 'value' in descriptor);
  }
}
export const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max;
export function context(value: Context): Context {
  record(value, ['deploymentId', 'runId', 'backupId', 'keyVersion', 'environment', 'datasetClass']);
  requireThat([value.deploymentId, value.runId, value.backupId].every(v => typeof v === 'string' && UUID.test(v)) &&
    integer(value.keyVersion, 1, 2147483647) && value.environment === 'BETA' && value.datasetClass === 'SYNTHETIC');
  return {...value};
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const same = (a: any, b: any) => canonical(a) === canonical(b);
export function equal(a: unknown, b: unknown, code = 'STATE_CHANGED') { requireThat(same(a, b), code); }
export function portablePath(value: string) {
  requireThat(typeof value === 'string' && value.length <= 240);
  const parts = value.split('/');
  requireThat(parts.length <= 8 && parts.every(p => /^[a-z0-9][a-z0-9_-]{0,119}(\.(xml|zip|pdf|csv|json|jsonl|ndjson|dat))?$/.test(p) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/.test(p)) && /\.(xml|zip|pdf|csv|json|jsonl|ndjson|dat)$/.test(value));
  // Fixed lowercase namespace also prevents Windows case folding collisions, ADS and encoded traversal.
  return value;
}
function unique<T>(values: T[], key: (v: T) => string) { requireThat(new Set(values.map(key)).size === values.length); }
const ordered = <T>(values: T[], key: (v: T) => string): T[] => values.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
export function inventory(value: Inventory): Inventory {
  record(value, ['owner', 'profile', 'schemaSha256', 'state', 'tables', 'sequences', 'checkpoints', 'files']);
  requireThat(OWNERS.includes(value.owner) && value.profile === PROFILE && typeof value.schemaSha256 === 'string' && SHA.test(value.schemaSha256));
  record(value.state, ['count', 'sha256']); requireThat(integer(value.state.count) && typeof value.state.sha256 === 'string' && SHA.test(value.state.sha256));
  list(value.tables, LIMITS.tables); list(value.sequences, LIMITS.tables); list(value.checkpoints, LIMITS.tables); list(value.files, LIMITS.files);
  const tables = value.tables.map(t => {
    record(t, ['name', 'columns', 'count', 'sha256']); list(t.columns, 256, 1);
    requireThat(typeof t.name === 'string' && NAME.test(t.name) && integer(t.count) && typeof t.sha256 === 'string' && SHA.test(t.sha256));
    requireThat(t.columns.every(c => typeof c === 'string' && NAME.test(c))); unique(t.columns, c => c);
    return {...t, columns: [...t.columns]}; // Physical column order is meaningful.
  });
  const sequences = value.sequences.map(s => {
    record(s, ['name', 'lastValue', 'isCalled']);
    requireThat(typeof s.name === 'string' && NAME.test(s.name) && typeof s.lastValue === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(s.lastValue) &&
      BigInt(s.lastValue) <= 9223372036854775807n && typeof s.isCalled === 'boolean'); return {...s};
  });
  const checkpoints = value.checkpoints.map(c => {
    record(c, ['name', 'sha256']); requireThat(typeof c.name === 'string' && NAME.test(c.name) && typeof c.sha256 === 'string' && SHA.test(c.sha256)); return {...c};
  });
  const files = value.files.map(f => {
    record(f, ['path', 'size', 'sha256']); portablePath(f.path);
    requireThat(integer(f.size, 1, LIMITS.file) && typeof f.sha256 === 'string' && SHA.test(f.sha256)); return {...f};
  });
  unique(tables, t => t.name); unique(sequences, s => s.name); unique(checkpoints, c => c.name); unique(files, f => f.path);
  // No file may shadow a directory used by another file.
  for (const f of files) requireThat(!files.some(other => other.path.startsWith(f.path + '/')));
  if (OWNER_FORMATS[value.owner] === 'PG_CUSTOM') requireThat(tables.length > 0);
  else requireThat(tables.length === 0 && sequences.length === 0);
  requireThat(checkpoints.length > 0);
  if (value.owner === 'CONFIG') requireThat(files.length === 0);
  return {...value, state: {...value.state}, tables: ordered(tables, t => t.name), sequences: ordered(sequences, s => s.name),
    checkpoints: ordered(checkpoints, c => c.name), files: ordered(files, f => f.path)};
}
export function configuration(value: Configuration): Configuration {
  record(value, ['fingerprints', 'custody']); list(value.fingerprints, CONFIG_NAMES.length, CONFIG_NAMES.length);
  list(value.custody, 128, CUSTODY_PURPOSES.length);
  const fingerprints = value.fingerprints.map(f => {
    record(f, ['name', 'sha256']); requireThat(CONFIG_NAMES.includes(f.name) && typeof f.sha256 === 'string' && SHA.test(f.sha256)); return {...f};
  });
  const custody = value.custody.map(c => {
    record(c, ['purpose', 'reference', 'version', 'fingerprintSha256']);
    requireThat(CUSTODY_PURPOSES.includes(c.purpose) && typeof c.reference === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(c.reference) &&
      integer(c.version, 1, 2147483647) && typeof c.fingerprintSha256 === 'string' && SHA.test(c.fingerprintSha256)); return {...c};
  });
  unique(fingerprints, f => f.name); unique(custody, c => c.purpose + ':' + c.reference + ':' + c.version);
  requireThat(CUSTODY_PURPOSES.every(purpose => custody.some(c => c.purpose === purpose)));
  return {fingerprints: ordered(fingerprints, f => f.name), custody: ordered(custody, c => c.purpose + ':' + c.reference + ':' + c.version)};
}
export function snapshot(value: OwnerSnapshot): OwnerSnapshot {
  record(value, ['inventory', 'payload', 'files']); record(value.payload, ['format', 'bytes']); list(value.files, LIMITS.files);
  const inv = inventory(value.inventory), raw = value.payload.bytes;
  requireThat(value.payload.format === OWNER_FORMATS[inv.owner] && Buffer.isBuffer(raw) && !types.isProxy(raw) && raw.length <= LIMITS.dump);
  if (value.payload.format === 'PG_CUSTOM') requireThat(raw.subarray(0, 5).toString('ascii') === 'PGDMP');
  else if (value.payload.format === 'REDIS_RDB') requireThat(/^REDIS[0-9]{4}$/.test(raw.subarray(0, 9).toString('ascii')));
  else requireThat(raw.length === 0);
  const files = value.files.map(f => {
    record(f, ['path', 'bytes']); portablePath(f.path);
    requireThat(Buffer.isBuffer(f.bytes) && !types.isProxy(f.bytes) && f.bytes.length > 0 && f.bytes.length <= LIMITS.file);
    requireThat(!/-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----/.test(f.bytes.toString('utf8')), 'PRIVATE_MATERIAL_FORBIDDEN');
    return {path: f.path, bytes: Buffer.from(f.bytes)};
  });
  const actual = ordered(files.map(f => ({path: f.path, size: f.bytes.length, sha256: sha(f.bytes)})), f => f.path);
  equal(actual, inv.files, 'FILE_INVENTORY_MISMATCH');
  return {inventory: inv, payload: {format: value.payload.format, bytes: Buffer.from(raw)}, files: ordered(files, f => f.path)};
}
export function allSnapshots(values: OwnerSnapshot[]): OwnerSnapshot[] {
  list(values, OWNERS.length, OWNERS.length);
  const normalized = values.map(snapshot); unique(normalized, s => s.inventory.owner);
  requireThat(OWNERS.every(o => normalized.some(s => s.inventory.owner === o)), 'ALL_OWNERS_REQUIRED');
  const total = normalized.reduce((n, s) => n + s.payload.bytes.length + s.files.reduce((m, f) => m + f.bytes.length, 0), 0);
  requireThat(total <= LIMITS.raw && normalized.reduce((n, s) => n + s.files.length, 0) <= LIMITS.files, 'BACKUP_LIMIT_EXCEEDED');
  return ordered(normalized, s => s.inventory.owner);
}
export function iso(value: string): number {
  requireThat(typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
  return Date.parse(value);
}

