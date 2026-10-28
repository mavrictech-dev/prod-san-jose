import {randomUUID} from 'node:crypto';
import {inspect} from 'node:util';
import {OWNERS, OWNER_FORMATS, VERSION, PROFILE, type AuditPort, type BackupCatalogPort, type ConfigurationPort, type Context,
  type KeyPort, type OfflineLeasePort, type OwnerPort, type RestoreJournalPort, type RestoreReceipt,
  type RestoreTargetPort, type TargetIdentity, type TiAuthorizationPort, type Configuration} from './ports';
import {openPackage, sealPackage} from './codec';
import {allSnapshots, configuration, context, equal, inventory, iso, LIMITS, list, record, requireThat, sha, snapshot as normalizeSnapshot, UUID} from './model';
export interface ExternalCustodyPort {
  /** Read-only verification of independently held versions and approved configuration fingerprints.
   * Never returns private material. This must not be derived from the backup's own assertions. */
  verify(config: Configuration, context: Context): Promise<void>;
}
export interface DeploymentBackupOptions {
  enabled?: boolean; owners: OwnerPort[]; lease: OfflineLeasePort; configuration: ConfigurationPort;
  custody: ExternalCustodyPort; authorization: TiAuthorizationPort; keys: KeyPort;
  catalog: BackupCatalogPort; target: RestoreTargetPort; journal: RestoreJournalPort; audit: AuditPort;
}
/** Inert until explicitly enabled. Supplied ports are the trust/side-effect boundary.
 * No process/env/files/SQL/network/worker activation and no operational authorization implementation. */
export class DeploymentBackupAdapter {
  #options: DeploymentBackupOptions; #owners: Map<string, OwnerPort>; #busy = false;
  constructor(options: DeploymentBackupOptions) {
    requireThat(options && (options.enabled === undefined || typeof options.enabled === 'boolean'));
    list(options.owners, OWNERS.length, OWNERS.length);
    requireThat(new Set(options.owners.map(p => p.owner)).size === OWNERS.length &&
      OWNERS.every(o => options.owners.some(p => p.owner === o && typeof p.inventory === 'function' && typeof p.snapshot === 'function' && typeof p.verify === 'function')), 'ALL_OWNER_PORTS_REQUIRED');
    for (const [port, methods] of [[options.lease, ['withOfflineSnapshot', 'assertHeld']], [options.configuration, ['inspect']],
      [options.custody, ['verify']], [options.authorization, ['authorize']], [options.keys, ['acquire']],
      [options.catalog, ['reserve', 'publish', 'fail', 'lookup']], [options.target, ['createNew', 'inspect', 'restore', 'inventory', 'configuration', 'sealIsolated', 'rollbackOrQuarantine']],
      [options.journal, ['claim', 'complete', 'fail']], [options.audit, ['append']]] as [any, string[]][]) {
      requireThat(port && methods.every(method => typeof port[method] === 'function'), 'EXPLICIT_PORT_REQUIRED');
    }
    this.#options = {...options}; this.#owners = new Map(options.owners.map(p => [p.owner, p]));
  }
  private enter() {
    requireThat(this.#options.enabled === true, 'DEPLOYMENT_BACKUP_DISABLED'); requireThat(!this.#busy, 'DEPLOYMENT_BACKUP_BUSY'); this.#busy = true;
  }
  private event(operation: 'BACKUP' | 'RESTORE', phase: 'STARTED' | 'COMPLETED' | 'FAILED' | 'QUARANTINE_REQUIRED', c: Context, restoreId: string | null = null) {
    return this.#options.audit.append({operation, phase, context: {...c}, restoreId});
  }
  private async key(c: Context, operation: 'SEAL' | 'OPEN') {
    const acquired = await this.#options.keys.acquire({...c}, operation);
    record(acquired, ['version', 'key']);
    try {
      requireThat(acquired.version === c.keyVersion && Buffer.isBuffer(acquired.key) && acquired.key.length === 32, 'KEY_VERSION_NOT_APPROVED');
      return Buffer.from(acquired.key);
    } finally {if (Buffer.isBuffer(acquired.key)) acquired.key.fill(0);}
  }
  private async inventories() {
    const values = [];
    for (const owner of OWNERS) {
      const value = inventory(await this.#owners.get(owner)!.inventory()); requireThat(value.owner === owner, 'OWNER_IDENTITY_MISMATCH'); values.push(value);
    }
    return values;
  }
  async backup(input: Context): Promise<{envelope: Buffer; receipt: {context: Context; envelopeSha256: string; backupAuthorized: false; globalUnmanagedWritersVerified: false}}> {
    this.enter(); let c: Context | undefined, key: Buffer | undefined, envelope: Buffer | undefined, reserved = false;
    try {
      c = context(input); const bound = c;
      await this.#options.authorization.authorize({operation: 'BACKUP', context: {...c}, restoreId: null});
      await this.event('BACKUP', 'STARTED', c);
      await this.#options.catalog.reserve({...c}); reserved = true; key = await this.key(c, 'SEAL');
      let calls = 0;
      const result = await this.#options.lease.withOfflineSnapshot({...c}, async proof => {
        requireThat(++calls === 1, 'SINGLE_LEASE_CALLBACK_REQUIRED');
        this.#options.lease.assertHeld(proof, bound);
        const before = await this.inventories(), configBefore = configuration(await this.#options.configuration.inspect());
        await this.#options.custody.verify(structuredClone(configBefore), {...bound});
        const captured = [];
        for (const owner of OWNERS) {
          this.#options.lease.assertHeld(proof, bound);
          const value = normalizeSnapshot(await this.#owners.get(owner)!.snapshot());
          requireThat(value.inventory.owner === owner, 'OWNER_IDENTITY_MISMATCH'); captured.push(value);
        }
        const owners = allSnapshots(captured);
        for (const value of owners) await this.#owners.get(value.inventory.owner)!.verify(normalizeSnapshot(value));
        const after = await this.inventories(), configAfter = configuration(await this.#options.configuration.inspect());
        for (const owner of OWNERS) {
          const original = before.find(v => v.owner === owner)!;
          equal(original, owners.find(s => s.inventory.owner === owner)!.inventory, 'SNAPSHOT_NOT_CURRENT');
          equal(original, after.find(v => v.owner === owner), 'SOURCE_CHANGED_DURING_BACKUP');
        }
        equal(configBefore, configAfter, 'CONFIG_CHANGED_DURING_BACKUP'); this.#options.lease.assertHeld(proof, bound);
        const capturedAt = new Date().toISOString();
        envelope = sealPackage({context: bound, capturedAt, lease: proof, configuration: configBefore, owners}, key!);
        return {capturedAt, envelope};
      });
      // Do not publish before the coordinator's fresh AFTER verifier succeeds.
      requireThat(calls === 1 && result.envelope === envelope, 'DEPLOYMENT_LEASE_REQUIRED');
      const envelopeSha256 = sha(result.envelope);
      await this.event('BACKUP', 'COMPLETED', c);
      await this.#options.catalog.publish({context: {...c}, envelopeSha256, createdAt: result.capturedAt,
        expiresAt: new Date(iso(result.capturedAt) + LIMITS.maxAgeMs).toISOString()});
      return {envelope: result.envelope, receipt: {context: {...c}, envelopeSha256, backupAuthorized: false, globalUnmanagedWritersVerified: false}};
    } catch {
      envelope?.fill(0);
      if (c && reserved) await this.#options.catalog.fail({...c}).catch(() => undefined);
      if (c) await this.event('BACKUP', 'FAILED', c).catch(() => undefined);
      throw new Error('DEPLOYMENT_BACKUP_FAILED');
    } finally {key?.fill(0); this.#busy = false;}
  }
  private identity(value: TargetIdentity, c: Context, restoreId: string, creationId: string, empty: boolean): TargetIdentity {
    record(value, ['deploymentId', 'creationId', 'restoreId', 'isolated', 'admissionClosed', 'resources']);
    requireThat(typeof value.deploymentId === 'string' && UUID.test(value.deploymentId) && value.deploymentId !== c.deploymentId &&
      value.creationId === creationId && value.restoreId === restoreId && value.isolated === true && value.admissionClosed === true, 'NEW_ISOLATED_TARGET_REQUIRED');
    list(value.resources, OWNERS.length, OWNERS.length);
    for (const resource of value.resources) {
      record(resource, ['owner', 'resourceId', 'createdBy', 'empty']);
      requireThat(OWNERS.includes(resource.owner) && typeof resource.resourceId === 'string' && UUID.test(resource.resourceId) &&
        resource.createdBy === creationId && typeof resource.empty === 'boolean' && (!empty || resource.empty), 'NEW_EMPTY_RESOURCE_REQUIRED');
    }
    requireThat(new Set(value.resources.map(r => r.owner)).size === OWNERS.length && new Set(value.resources.map(r => r.resourceId)).size === OWNERS.length);
    return {...structuredClone(value), resources: [...structuredClone(value.resources)].sort((a, b) => a.owner < b.owner ? -1 : 1)};
  }
  private async checkTarget(id: TargetIdentity, c: Context, empty = false) {
    const actual = this.identity(await this.#options.target.inspect(structuredClone(id)), c, id.restoreId, id.creationId, empty);
    equal({...id, resources: id.resources.map(({empty: _, ...r}) => r)},
      {...actual, resources: actual.resources.map(({empty: _, ...r}) => r)}, 'TARGET_IDENTITY_CHANGED');
    return actual;
  }
  private receipt(value: RestoreReceipt, c: Context, restoreId: string): RestoreReceipt {
    record(value, ['context', 'restoreId', 'targetDeploymentId', 'state', 'backupAuthorized', 'globalUnmanagedWritersVerified']);
    equal(context(value.context), c); requireThat(value.restoreId === restoreId && typeof value.targetDeploymentId === 'string' &&
      UUID.test(value.targetDeploymentId) && value.targetDeploymentId !== c.deploymentId && value.state === 'VERIFIED_ISOLATED' &&
      value.backupAuthorized === false && value.globalUnmanagedWritersVerified === false, 'RESTORE_REPLAY_INVALID'); return structuredClone(value);
  }
  async restore(input: Context, encrypted: Buffer, restoreId: string): Promise<RestoreReceipt> {
    this.enter(); let c: Context | undefined, key: Buffer | undefined, target: TargetIdentity | undefined, owned = false, claimed = false, allocationAttempted = false;
    try {
      c = context(input); requireThat(typeof restoreId === 'string' && UUID.test(restoreId));
      requireThat(Buffer.isBuffer(encrypted) && encrypted.length > 36 && encrypted.length <= LIMITS.envelope);
      const envelope = Buffer.from(encrypted);
      await this.#options.authorization.authorize({operation: 'RESTORE', context: {...c}, restoreId});
      const entry = await this.#options.catalog.lookup({...c});
      record(entry, ['context', 'envelopeSha256', 'createdAt', 'expiresAt']); equal(context(entry.context), c);
      const now = Date.now(), created = iso(entry.createdAt), expires = iso(entry.expiresAt);
      requireThat(created <= now && expires > now && expires > created && expires - created <= LIMITS.maxAgeMs && now - created <= LIMITS.maxAgeMs && entry.envelopeSha256 === sha(envelope), 'TRUSTED_BACKUP_CATALOG_REQUIRED');
      key = await this.key(c, 'OPEN'); const value = openPackage(envelope, key, c); equal(value.capturedAt, entry.createdAt);
      // Read-only validation of ALL dumps/snapshots and external custody before ANY allocation/mutation.
      await this.#options.custody.verify(structuredClone(value.configuration), {...c});
      for (const snapshot of value.owners) await this.#owners.get(snapshot.inventory.owner)!.verify(normalizeSnapshot(snapshot));
      const replay = await this.#options.journal.claim({...c}, restoreId);
      if (replay) return this.receipt(replay, c, restoreId); claimed = true;
      await this.event('RESTORE', 'STARTED', c, restoreId);
      const creationId = randomUUID();
      allocationAttempted = true; const allocated = await this.#options.target.createNew({context: {...c}, restoreId, creationId});
      target = this.identity(allocated, c, restoreId, creationId, true);
      await this.checkTarget(target, c, true); owned = true;
      const restored = new Set<string>();
      for (const owner of OWNERS) {
        const current = await this.checkTarget(target, c);
        requireThat(current.resources.filter(r => !restored.has(r.owner)).every(r => r.empty), 'TARGET_NOT_EMPTY');
        await this.#options.target.restore(structuredClone(target), owner, normalizeSnapshot(value.owners.find(s => s.inventory.owner === owner)!), structuredClone(value.configuration));
        restored.add(owner);
      }
      const expected = value.owners.map(s => s.inventory);
      const verifyTarget = async () => {
        await this.checkTarget(target!, c!);
        for (const before of expected) equal(inventory(await this.#options.target.inventory(structuredClone(target!), before.owner)), before, 'RESTORED_STATE_MISMATCH');
        equal(configuration(await this.#options.target.configuration(structuredClone(target!))), value.configuration, 'RESTORED_CONFIG_MISMATCH');
      };
      await verifyTarget(); await this.#options.target.sealIsolated(structuredClone(target)); await verifyTarget();
      const receipt: RestoreReceipt = {context: {...c}, restoreId, targetDeploymentId: target.deploymentId,
        state: 'VERIFIED_ISOLATED', backupAuthorized: false, globalUnmanagedWritersVerified: false};
      await this.event('RESTORE', 'COMPLETED', c, restoreId); await this.#options.journal.complete(structuredClone(receipt));
      return receipt;
    } catch {
      let quarantined = false;
      if (c && owned && target) {
        try {await this.checkTarget(target, c); await this.#options.target.rollbackOrQuarantine(structuredClone(target)); quarantined = true;} catch { /* Never clean up an identity that changed. */ }
      }
      if (c && allocationAttempted && !quarantined) await this.event('RESTORE', 'QUARANTINE_REQUIRED', c, restoreId).catch(() => undefined);
      if (c && claimed) await this.#options.journal.fail({...c}, restoreId).catch(() => undefined);
      if (c) await this.event('RESTORE', 'FAILED', c, restoreId).catch(() => undefined);
      throw new Error('DEPLOYMENT_RESTORE_FAILED');
    } finally {key?.fill(0); this.#busy = false;}
  }
  capabilities() {return {schemaVersion: VERSION, profile: PROFILE, enabled: this.#options.enabled === true,
    owners: OWNERS.map(owner => ({owner, format: OWNER_FORMATS[owner], mandatory: true})),
    operations: ['BACKUP', 'RESTORE_NEW_ISOLATED'], externalCustodyRequired: true, realExecution: false,
    backupAuthorized: false, globalUnmanagedWritersVerified: false};}
  toJSON() {return {enabled: this.#options.enabled === true, busy: this.#busy, profile: 'SYNTHETIC_ONLY',
    backupAuthorized: false, globalUnmanagedWritersVerified: false};}
  [inspect.custom]() {return this.toJSON();}
}



