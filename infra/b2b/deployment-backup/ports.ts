/** Pure ports: no discovery, connection strings, filesystem roots or live runner. */
export const OWNER_FORMATS = Object.freeze({
  IDENTITY: 'PG_CUSTOM', BILLING: 'PG_CUSTOM', SUNAT: 'PG_CUSTOM', MAILER: 'PG_CUSTOM',
  RECEIVED: 'PG_CUSTOM', HISTORY: 'PG_CUSTOM', EXPORTS: 'PG_CUSTOM', WEBHOOKS: 'PG_CUSTOM',
  REDIS: 'REDIS_RDB', CONFIG: 'NONE', ARTIFACTS: 'NONE', FILES: 'NONE',
} as const);
export type Owner = keyof typeof OWNER_FORMATS;
export const OWNERS = Object.freeze(Object.keys(OWNER_FORMATS) as Owner[]);
export const PROFILE = 'FACTUEZ_DEPLOYMENT_SYNTHETIC_V1' as const;
export const VERSION = 'factuez.b2b.deployment-backup.v1' as const;
export const CONFIG_NAMES = Object.freeze(['DEPLOYMENT_CONFIG', 'OWNER_PROFILES', 'ROLE_ACL_POLICY',
  'SCHEMA_MIGRATIONS', 'ARTIFACT_LAYOUT', 'QUEUE_TOPOLOGY'] as const);
export const CUSTODY_PURPOSES = Object.freeze(['BACKUP_KEY', 'JWT_SIGNING', 'SUNAT_SIGNING', 'APP_MASTER',
  'SMTP_SETTINGS', 'RECEPTION_SETTINGS', 'DATABASE_ACCESS', 'REDIS_ACCESS', 'TLS_PRIVATE',
  'WEBHOOK_VAULT', 'EXPORT_VAULT'] as const);
export interface Context {
  deploymentId: string; runId: string; backupId: string; keyVersion: number;
  environment: 'BETA'; datasetClass: 'SYNTHETIC';
}
export interface FileEntry { path: string; size: number; sha256: string }
export interface Inventory {
  owner: Owner; profile: typeof PROFILE; schemaSha256: string; state: {count: number; sha256: string};
  /** schemaSha256 must cover complete DDL, effective ACL/RLS, triggers, functions and roles without passwords. */
  tables: {name: string; columns: string[]; count: number; sha256: string}[];
  sequences: {name: string; lastValue: string; isCalled: boolean}[];
  /** Epochs, consumer offsets, queue topology, TTL policy and audit chain heads. */
  checkpoints: {name: string; sha256: string}[];
  files: FileEntry[];
}
export interface OwnerSnapshot {
  inventory: Inventory;
  payload: {format: typeof OWNER_FORMATS[Owner]; bytes: Buffer};
  /** Logical application data only. Never vault roots, raw credentials or signing keys. */
  files: {path: string; bytes: Buffer}[];
}
export interface Configuration {
  fingerprints: {name: typeof CONFIG_NAMES[number]; sha256: string}[];
  /** Opaque external custody references, not paths/URLs or secret bytes. */
  custody: {purpose: typeof CUSTODY_PURPOSES[number]; reference: string; version: number; fingerprintSha256: string}[];
}
export interface LeaseProof {
  deploymentId: string; runId: string; inventorySha256: string; inventoryRevision: number;
  scope: 'EXPLICIT_REGISTERED_DEPLOYMENT';
}
export interface OfflineLeasePort {
  withOfflineSnapshot<T>(context: Context, work: (proof: LeaseProof) => Promise<T>): Promise<T>;
  assertHeld(proof: LeaseProof, context: Context): void;
}
export interface OwnerPort {
  readonly owner: Owner;
  /** Fresh complete read, never a cached snapshot receipt. Include hidden/large objects and monotonic writer epochs. */
  inventory(): Promise<Inventory>;
  snapshot(): Promise<OwnerSnapshot>;
  /** Read only semantic verification, including dump TOC/schema/coverage, prior to ANY target creation. */
  verify(snapshot: OwnerSnapshot): Promise<void>;
}
export interface ConfigurationPort { inspect(): Promise<Configuration> }
export interface KeyPort {
  /** External allowlist rejects retired/revoked versions and supplies an owned 32-byte copy. */
  acquire(context: Context, operation: 'SEAL' | 'OPEN'): Promise<{version: number; key: Buffer}>;
}
/** Separate TI approval boundary. No implementation here grants approval or accepts a boolean receipt. */
export interface TiAuthorizationPort {
  authorize(request: {operation: 'BACKUP' | 'RESTORE'; context: Context; restoreId: string | null}): Promise<void>;
}
export interface CatalogEntry { context: Context; envelopeSha256: string; createdAt: string; expiresAt: string }
export interface BackupCatalogPort {
  /** Atomic insert-only identity reservation: FAILED ids are burned too. */
  reserve(context: Context): Promise<void>;
  publish(entry: CatalogEntry): Promise<void>;
  /** Durable FAILED tombstone, revoking even an uncertain publish. Never make a failed id reusable. */
  fail(context: Context): Promise<void>;
  /** Trusted catalog selected independently of the untrusted encrypted bytes. */
  lookup(context: Context): Promise<CatalogEntry>;
}
export interface TargetIdentity {
  deploymentId: string; creationId: string; restoreId: string; isolated: true; admissionClosed: true;
  resources: {owner: Owner; resourceId: string; createdBy: string; empty: boolean}[];
}
export interface RestoreTargetPort {
  /** Only NEW allocation in durable quarantine. Enforce exclusive ownership, no attach/reuse/overwrite.
   * Allocation errors must self-quarantine any partially allocated resources before rejecting. */
  createNew(request: {context: Context; restoreId: string; creationId: string}): Promise<TargetIdentity>;
  inspect(identity: TargetIdentity): Promise<TargetIdentity>;
  /** Identity check and mutation must be atomic in the implementation; no clean/disable-trigger flags. */
  restore(identity: TargetIdentity, owner: Owner, snapshot: OwnerSnapshot, configuration: Configuration): Promise<void>;
  inventory(identity: TargetIdentity, owner: Owner): Promise<Inventory>;
  /** Compare complete target config and verify external custody access without exporting keys. */
  configuration(identity: TargetIdentity): Promise<Configuration>;
  /** Preserve isolation on success. This is not application/fiscal activation. */
  sealIsolated(identity: TargetIdentity): Promise<void>;
  /** Only the proven NEW resources. Must leave durable quarantine if rollback cannot finish. */
  rollbackOrQuarantine(identity: TargetIdentity): Promise<void>;
}
export interface RestoreReceipt {
  context: Context; restoreId: string; targetDeploymentId: string;
  state: 'VERIFIED_ISOLATED'; backupAuthorized: false; globalUnmanagedWritersVerified: false;
}
export interface RestoreJournalPort {
  /** Atomic claim keyed by restoreId AND context. Refuse pending/failed/conflicting replays. */
  claim(context: Context, restoreId: string): Promise<RestoreReceipt | null>;
  complete(receipt: RestoreReceipt): Promise<void>;
  /** Durable failure tombstone must invalidate any uncertain complete; pending/failed ids require manual reconciliation. */
  fail(context: Context, restoreId: string): Promise<void>;
}
export interface AuditPort {
  /** Durable append-only, metadata only. Never raw errors, payloads, keys, paths or credentials. */
  append(event: {operation: 'BACKUP' | 'RESTORE'; phase: 'STARTED' | 'COMPLETED' | 'FAILED' | 'QUARANTINE_REQUIRED';
    context: Context; restoreId: string | null}): Promise<void>;
}



