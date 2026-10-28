import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {types} from 'node:util';
import {OWNERS, VERSION, type Context, type Configuration, type LeaseProof, type OwnerSnapshot} from './ports';
import {allSnapshots, canonical, configuration, context, equal, iso, LIMITS, record, requireThat, sha} from './model';
const MAGIC = Buffer.from('FZDBAK01');
export interface PackageContent {
  context: Context; capturedAt: string; lease: LeaseProof; configuration: Configuration; owners: OwnerSnapshot[];
}
function lease(value: LeaseProof, c: Context): LeaseProof {
  record(value, ['deploymentId', 'runId', 'inventorySha256', 'inventoryRevision', 'scope']);
  requireThat(value.deploymentId === c.deploymentId && value.runId === c.runId && value.scope === 'EXPLICIT_REGISTERED_DEPLOYMENT' &&
    typeof value.inventorySha256 === 'string' && /^[a-f0-9]{64}$/.test(value.inventorySha256) &&
    Number.isSafeInteger(value.inventoryRevision) && value.inventoryRevision > 0 && value.inventoryRevision <= 2147483647);
  return {...value};
}
function normalize(value: PackageContent): PackageContent {
  record(value, ['context', 'capturedAt', 'lease', 'configuration', 'owners']);
  const c = context(value.context), cfg = configuration(value.configuration), owners = allSnapshots(value.owners);
  iso(value.capturedAt);
  // Configuration payload is fingerprints/references ONLY and bound to its inventory.
  equal(owners.find(o => o.inventory.owner === 'CONFIG')!.inventory.schemaSha256, sha(canonical(cfg)), 'CONFIG_INVENTORY_MISMATCH');
  requireThat(cfg.custody.some(custody => custody.purpose === 'BACKUP_KEY' && custody.version === c.keyVersion), 'BACKUP_KEY_CUSTODY_REQUIRED');
  return {context: c, capturedAt: value.capturedAt, lease: lease(value.lease, c), configuration: cfg, owners};
}
const aad = (c: Context) => Buffer.from(canonical({schemaVersion: VERSION, context: context(c)}));
function wire(value: PackageContent) {
  return {schemaVersion: VERSION, ...value, owners: value.owners.map(o => ({inventory: o.inventory,
    payload: {format: o.payload.format, byteLength: o.payload.bytes.length, sha256: sha(o.payload.bytes), base64: o.payload.bytes.toString('base64')},
    files: o.files.map(f => ({path: f.path, base64: f.bytes.toString('base64')}))}))};
}
function decode(value: string, max: number): Buffer {
  requireThat(typeof value === 'string' && value.length <= Math.ceil(max / 3) * 4 && value.length % 4 === 0);
  const result = Buffer.from(value, 'base64'); requireThat(result.length <= max && result.toString('base64') === value); return result;
}
function unwire(value: any): PackageContent {
  record(value, ['schemaVersion', 'context', 'capturedAt', 'lease', 'configuration', 'owners']);
  requireThat(value.schemaVersion === VERSION);
  // Bound arrays before mapping/allocating decoded binary members.
  const {schemaVersion: _, ...v} = value;
  requireThat(Array.isArray(v.owners) && v.owners.length === OWNERS.length);
  const owners = v.owners.map((o: any) => {
    record(o, ['inventory', 'payload', 'files']); record(o.payload, ['format', 'byteLength', 'sha256', 'base64']);
    requireThat(Array.isArray(o.files) && o.files.length <= LIMITS.files);
    const bytes = decode(o.payload.base64, LIMITS.dump);
    requireThat(bytes.length === o.payload.byteLength && sha(bytes) === o.payload.sha256);
    const files = o.files.map((f: any) => {record(f, ['path', 'base64']); return {path: f.path, bytes: decode(f.base64, LIMITS.file)};});
    return {inventory: o.inventory, payload: {format: o.payload.format, bytes}, files};
  });
  return normalize({...v, owners} as PackageContent);
}
function keyBytes(key: Buffer) {requireThat(Buffer.isBuffer(key) && !types.isProxy(key) && key.length === 32, 'BACKUP_KEY_INVALID');}
/** Pure in-memory SYNTHETIC codec. A valid envelope is NOT a TI authorization. */
export function sealPackage(input: PackageContent, key: Buffer): Buffer {
  let plaintext: Buffer | undefined;
  try {
    const value = normalize(input); keyBytes(key);
    plaintext = Buffer.from(canonical(wire(value))); requireThat(plaintext.length + 36 <= LIMITS.envelope);
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(value.context));
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
  } catch { throw new Error('DEPLOYMENT_BACKUP_PACKAGE_INVALID'); }
  finally {plaintext?.fill(0);}
}
/** All members authenticate before any target port is invoked. Expected context must be trusted. */
export function openPackage(envelope: Buffer, key: Buffer, expected: Context): PackageContent {
  let plaintext: Buffer | undefined;
  try {
    const c = context(expected); keyBytes(key);
    requireThat(Buffer.isBuffer(envelope) && !types.isProxy(envelope) && envelope.length > 36 && envelope.length <= LIMITS.envelope && envelope.subarray(0, 8).equals(MAGIC));
    const cipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(8, 20));
    cipher.setAAD(aad(c)); cipher.setAuthTag(envelope.subarray(20, 36));
    plaintext = Buffer.concat([cipher.update(envelope.subarray(36)), cipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    requireThat(Buffer.from(canonical(parsed)).equals(plaintext)); // Reject duplicate JSON keys and non-canonical encodings.
    const value = unwire(parsed); equal(value.context, c); return value;
  } catch {throw new Error('DEPLOYMENT_BACKUP_PACKAGE_INVALID');}
  finally {plaintext?.fill(0);}
}


