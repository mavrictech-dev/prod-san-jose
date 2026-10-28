import {describe, expect, it, vi} from 'vitest';
import {randomBytes, randomUUID, createCipheriv} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {inspect} from 'node:util';
import {DeploymentBackupAdapter, type DeploymentBackupOptions} from '../infra/b2b/deployment-backup/adapter';
import {openPackage, sealPackage, type PackageContent} from '../infra/b2b/deployment-backup/codec';
import {CoordinatorOfflineLease} from '../infra/b2b/deployment-backup/lease';
import {B2bDeploymentMaintenance, b2bManagedServices, type B2bManagedService} from '../packages/service-access/src/b2b-deployment-maintenance';
import {CONFIG_NAMES, CUSTODY_PURPOSES, OWNERS, OWNER_FORMATS, PROFILE, VERSION,
  type Configuration, type Context, type Inventory, type Owner, type OwnerSnapshot,
  type RestoreReceipt, type TargetIdentity, type CatalogEntry} from '../infra/b2b/deployment-backup/ports';
import {allSnapshots, canonical, configuration, inventory, LIMITS, sha, snapshot} from '../infra/b2b/deployment-backup/model';

/** FULL-MEMORY MODEL ONLY. PGDMP+JSON is a fixture, not a PostgreSQL backup. */
function fixture(enabled: boolean | undefined = true) {
  const roster = {deploymentId: randomUUID(), revision: 1, environment: 'BETA' as const,
    instances: Object.keys(b2bManagedServices).map(service => ({service: service as B2bManagedService, instanceId: randomUUID(), bootId: randomUUID()}))};
  const participants = roster.instances.map(instance => ({instanceId: instance.instanceId,
    port: {advance: vi.fn(async (phase: any, request: any) => ({...request, phase, state: 'QUIESCED_PHASE', pending: 0, storageClosed: phase === 'STORAGE'}))}}));
  const verifier = {inspect: vi.fn(async (r: any) => ({runId: r.runId, deploymentId: r.inventory.deploymentId, inventorySha256: r.inventorySha256,
    environment: 'BETA', instances: structuredClone(r.inventory.instances), observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 2000).toISOString(),
    state: 'REGISTERED_WRITERS_OFFLINE', unlistedWriters: 0, activeApplicationConnections: 0, forcedStops: 0}))};
  const coordinator = new B2bDeploymentMaintenance({enabled: true, inventory: roster, participants, verifier: verifier as any});
  const lease = new CoordinatorOfflineLease(coordinator);
  const c: Context = {deploymentId: roster.deploymentId, runId: randomUUID(), backupId: randomUUID(), keyVersion: 7, environment: 'BETA', datasetClass: 'SYNTHETIC'};
  const cfg: Configuration = {fingerprints: CONFIG_NAMES.map(name => ({name, sha256: sha('synthetic:' + name)})),
    custody: CUSTODY_PURPOSES.map(purpose => ({purpose, reference: 'synthetic_' + purpose.toLowerCase(), version: 7, fingerprintSha256: sha('custody:' + purpose)}))};
  type Data = {schema: string; rows: Record<string, {id: number; key: string; state: string; value: string}[]>;
    sequences: {name: string; lastValue: string; isCalled: boolean}[]; checkpoints: Record<string, string>; files: {path: string; bytes: Buffer}[]; redis?: {key: string; value: string; expiresAt: string | null}[]};
    const checkpoints = () => ({epoch: 'epoch-4', offset: '42', queuedUnknownPolicy: 'PRESERVE_NO_REPLAY_OR_SEND', redisTtlPolicy: 'ABSOLUTE_EXPIRY'});
  const schema = (owner: Owner, cfgValue: Configuration) => owner === 'CONFIG' ? canonical(configuration(cfgValue)) : 'DDL:' + owner + ':ACL:RLS:CHECK:TRIGGER:AUDIT';
  const approvedConfig = configuration(structuredClone(cfg));
  const domainTables: Partial<Record<Owner, string[]>> = {
    IDENTITY: ['B2bClient', 'B2bGrant', 'B2bAdminSession', 'RevokedKey'],
    BILLING: ['SalesDocument', 'FinancialLedger', 'SeriesCounter', 'BillingOutbox', 'B2bDraft', 'B2bReportPurgeAudit'],
    SUNAT: ['GuideDispatchAttempt', 'DocumentArtifact', 'FiscalConfiguration'],
    MAILER: ['B2bCorporateEmailDelivery', 'SmtpConfiguration'],
    RECEIVED: ['ReceivedDocument', 'ReceivedArtifact', 'B2bReceivedCommand'],
    HISTORY: ['HistoricalDocument', 'HistoricalImport', 'HistoricalArtifact'],
    EXPORTS: ['IntegrationExportRecord', 'ChangeDelivery', 'ExportCut'],
    WEBHOOKS: ['WebhookSubscription', 'WebhookDelivery', 'WebhookAttempt'],
  };
  const data = new Map<Owner, Data>();
  for (const owner of OWNERS) {
    const sql = OWNER_FORMATS[owner] === 'PG_CUSTOM';
    data.set(owner, {schema: schema(owner, approvedConfig),
      rows: sql ? {OwnerJournal: [
        {id: 1, key: 'replay-accepted', state: 'COMPLETED', value: owner + '-accepted'},
        {id: 2, key: 'replay-queued', state: 'QUEUED', value: owner + '-queued'},
        {id: 3, key: 'replay-unknown', state: 'UNKNOWN', value: owner + '-ambiguous'},
      ], ImmutableAudit: [{id: 1, key: 'audit-1', state: 'APPENDED', value: 'chain-' + owner}]} : {},
      sequences: sql ? [{name: 'owner_sequence', lastValue: '9007199254740993', isCalled: true}] : [],
      checkpoints: checkpoints(), redis: owner === 'REDIS' ? [{key: 'synthetic:queue:queued', value: 'QUEUED', expiresAt: null}, {key: 'synthetic:queue:unknown', value: 'UNKNOWN', expiresAt: null}, {key: 'synthetic:session:1', value: 'opaque-session', expiresAt: '2099-01-01T00:00:00.000Z'}] : [],
      files: owner === 'ARTIFACTS' ? [{path: 'synthetic/document.xml', bytes: Buffer.from('<synthetic id="1"/>')}, {path: 'synthetic/cdr.zip', bytes: Buffer.from('SYNTHETIC-ZIP')}]
        : owner === 'FILES' ? [{path: 'history/archive.jsonl', bytes: Buffer.from('{"synthetic":true}\n')}, {path: 'exports/report.csv', bytes: Buffer.from('id,total\n1,42\n')}] : []});
  }
    for (const owner of OWNERS) {
    const d = data.get(owner)!;
    for (const table of domainTables[owner] ?? []) d.rows[table] = [{id: 1, key: owner.toLowerCase() + '_domain_' + table, state: 'PERSISTED', value: 'synthetic-' + table}];
    if (owner === 'ARTIFACTS' || owner === 'FILES') d.files.push({path: 'state/checkpoints.json', bytes: Buffer.from(canonical(d.checkpoints))});
  }
  const inv = (owner: Owner, d: Data): Inventory => inventory({owner, profile: PROFILE, schemaSha256: sha(d.schema),
    state: owner === 'REDIS' ? {count: d.redis!.length, sha256: sha(canonical(d.redis))}
      : owner === 'CONFIG' ? {count: approvedConfig.fingerprints.length + approvedConfig.custody.length, sha256: sha(canonical(approvedConfig))}
      : {count: Object.values(d.rows).reduce((n, rows) => n + rows.length, 0) + d.files.length,
        sha256: sha(canonical({rows: d.rows, files: d.files.map(f => ({path: f.path, sha256: sha(f.bytes)})).sort((a, b) => a.path < b.path ? -1 : 1)}))},
    tables: Object.entries(d.rows).map(([name, rows]) => ({name, columns: ['id', 'key', 'state', 'value'], count: rows.length, sha256: sha(canonical(rows))})),
    sequences: structuredClone(d.sequences), checkpoints: Object.entries(d.checkpoints).map(([name, value]) => ({name, sha256: sha(value)})),
    files: d.files.map(f => ({path: f.path, size: f.bytes.length, sha256: sha(f.bytes)}))});
  const encode = (owner: Owner): OwnerSnapshot => {
    const d = data.get(owner)!, format = OWNER_FORMATS[owner], {files, ...state} = d;
    return snapshot({inventory: inv(owner, d), payload: {format,
      bytes: format === 'NONE' ? Buffer.alloc(0) : Buffer.from((format === 'PG_CUSTOM' ? 'PGDMP' : 'REDIS0011') + canonical(state))}, files});
  };
  const decode = (s: OwnerSnapshot, targetConfig = approvedConfig): Data => {
    const d = s.payload.format === 'NONE' ? {schema: schema(s.inventory.owner, targetConfig), rows: {}, sequences: [], checkpoints: s.inventory.owner === 'CONFIG' ? checkpoints() : JSON.parse(s.files.find(f => f.path === 'state/checkpoints.json')!.bytes.toString())}
      : JSON.parse(s.payload.bytes.subarray(s.payload.format === 'PG_CUSTOM' ? 5 : 9).toString());
    return {...d, files: s.files.map(f => ({path: f.path, bytes: Buffer.from(f.bytes)}))};
  };
  const events: string[] = [];
  const owners = OWNERS.map(owner => ({owner,
    inventory: vi.fn(async () => inv(owner, data.get(owner)!)), snapshot: vi.fn(async () => {events.push('capture:' + owner); return encode(owner);}),
    verify: vi.fn(async (s: OwnerSnapshot) => {events.push('verify:' + owner); expect(inv(owner, decode(s))).toEqual(s.inventory);})}));
  const catalogRows = new Map<string, CatalogEntry | null>();
  const catalog = {
    reserve: vi.fn(async (ctx: Context) => {if (catalogRows.has(ctx.backupId)) throw Error('BACKUP_ID_REUSE'); catalogRows.set(ctx.backupId, null);}),
    publish: vi.fn(async (entry: CatalogEntry) => {if (!catalogRows.has(entry.context.backupId)) throw Error(); catalogRows.set(entry.context.backupId, structuredClone(entry));}),
    fail: vi.fn(async (ctx: Context) => {catalogRows.set(ctx.backupId, null);}),
    lookup: vi.fn(async (ctx: Context) => {const entry = catalogRows.get(ctx.backupId); if (!entry) throw Error('NOT_READY'); return structuredClone(entry);}),
  };
  const key = randomBytes(32), issuedKeys: Buffer[] = [], allowedVersions = new Set([7]);
  const keys = {acquire: vi.fn(async (ctx: Context): Promise<{version: number; key: Buffer}> => {
    if (!allowedVersions.has(ctx.keyVersion)) throw Error('REVOKED'); const copy = Buffer.from(key); issuedKeys.push(copy); return {version: ctx.keyVersion, key: copy};
  })};
  const targetConfigs = new Map<string, Configuration>();
  const allocations: TargetIdentity[] = [], targets = new Map<string, Map<Owner, Data>>();
  const target = {
    createNew: vi.fn(async ({context: _, restoreId, creationId}: any) => {
      events.push('allocate'); const id: TargetIdentity = {deploymentId: randomUUID(), restoreId, creationId, isolated: true, admissionClosed: true,
        resources: OWNERS.map(owner => ({owner, resourceId: randomUUID(), createdBy: creationId, empty: true}))};
      allocations.push(id); targets.set(id.deploymentId, new Map()); return structuredClone(id);
    }),
    inspect: vi.fn(async (id: TargetIdentity) => {
      const allocated = allocations.find(a => a.deploymentId === id.deploymentId)!;
      return {...structuredClone(allocated), resources: allocated.resources.map(r => ({...r, empty: !targets.get(id.deploymentId)!.has(r.owner)}))};
    }),
    restore: vi.fn(async (id: TargetIdentity, owner: Owner, s: OwnerSnapshot, configValue: Configuration) => {events.push('restore:' + owner); if (owner === 'CONFIG') targetConfigs.set(id.deploymentId, structuredClone(configValue)); targets.get(id.deploymentId)!.set(owner, decode(s, configValue));}),
    inventory: vi.fn(async (id: TargetIdentity, owner: Owner) => inv(owner, targets.get(id.deploymentId)!.get(owner)!)),
    configuration: vi.fn(async (id: TargetIdentity) => structuredClone(targetConfigs.get(id.deploymentId)!)), sealIsolated: vi.fn(async () => {events.push('seal');}),
    rollbackOrQuarantine: vi.fn(async (id: TargetIdentity) => {events.push('quarantine'); targets.delete(id.deploymentId);}),
  };
  const claims = new Map<string, {binding: string; receipt: RestoreReceipt | null}>();
  const journal = {
    claim: vi.fn(async (ctx: Context, restoreId: string) => {
      const old = claims.get(restoreId); if (old) {if (old.binding !== canonical(ctx) || !old.receipt) throw Error('RESTORE_ALREADY_CLAIMED'); return structuredClone(old.receipt);}
      claims.set(restoreId, {binding: canonical(ctx), receipt: null}); return null;
    }),
    complete: vi.fn(async (receipt: RestoreReceipt) => {claims.get(receipt.restoreId)!.receipt = structuredClone(receipt);}), fail: vi.fn(async () => undefined),
  };
  // Unit-test stubs only: never produce a TI approval receipt or an AUTHORIZED_COPY label.
  const authorization = {authorize: vi.fn(async (r: any) => {expect(r.context.datasetClass).toBe('SYNTHETIC');})};
  const custody = {verify: vi.fn(async (value: Configuration) => {expect(configuration(value)).toEqual(configuration(cfg));})};
  const audit = {append: vi.fn(async (event: any) => {events.push('audit:' + event.operation + ':' + event.phase);})};
  const config = {inspect: vi.fn(async () => structuredClone(cfg))};
  const options: DeploymentBackupOptions = {enabled, owners, lease, configuration: config, custody, authorization, keys, catalog, target, journal, audit};
  const adapter = new DeploymentBackupAdapter(options);
  const start = async () => {coordinator.stop(); const view = await coordinator.wait(1000); expect(view.state).toBe('STOPPED_CLEAN'); c.runId = view.runId!;};
  const content = (): PackageContent => ({context: c, capturedAt: new Date().toISOString(), lease: {deploymentId: c.deploymentId, runId: c.runId,
    inventoryRevision: 1, inventorySha256: 'a'.repeat(64), scope: 'EXPLICIT_REGISTERED_DEPLOYMENT'}, configuration: cfg, owners: OWNERS.map(encode)});
  return {adapter, options, start, c, key, cfg, data, inv, encode, content, events, coordinator, lease, verifier, participants,
    owners, authorization, keys, issuedKeys, allowedVersions, custody, config, catalog, catalogRows, target, allocations, targets, journal, claims, audit};
}

// Authenticate malformed-but-encrypted fixture wire to exercise parser/manifest checks independently of GCM.
function forged(f: ReturnType<typeof fixture>, change: (wire: any) => void, serialize: (v: any) => string = canonical): Buffer {
  const v = f.content(), wire: any = {schemaVersion: VERSION, ...v, owners: v.owners.map(o => ({inventory: o.inventory,
    payload: {format: o.payload.format, byteLength: o.payload.bytes.length, sha256: sha(o.payload.bytes), base64: o.payload.bytes.toString('base64')},
    files: o.files.map(file => ({path: file.path, base64: file.bytes.toString('base64')}))}))};
  change(wire); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', f.key, iv);
  cipher.setAAD(Buffer.from(canonical({schemaVersion: VERSION, context: f.c})));
  const raw = Buffer.concat([cipher.update(Buffer.from(serialize(wire))), cipher.final()]);
  return Buffer.concat([Buffer.from('FZDBAK01'), iv, cipher.getAuthTag(), raw]);
}



describe('deployment backup: full-memory owners and parent offline coordinator', () => {
  it('round-trips every mandatory owner and independent inventory, preserving replay keys/audit/QUEUED/UNKNOWN without dispatch', async () => {
    const f = fixture(); await f.start(); const baseline = OWNERS.map(o => f.inv(o, f.data.get(o)!));
    const saved = await f.adapter.backup(f.c); expect(saved.receipt.backupAuthorized).toBe(false); expect(saved.receipt.globalUnmanagedWritersVerified).toBe(false);
    expect(f.verifier.inspect).toHaveBeenCalledTimes(2);
    expect(f.owners.every(p => p.inventory.mock.calls.length === 2 && p.snapshot.mock.calls.length === 1)).toBe(true);
    const restored = await f.adapter.restore(f.c, saved.envelope, randomUUID());
    expect(restored.state).toBe('VERIFIED_ISOLATED'); expect(f.target.restore).toHaveBeenCalledTimes(OWNERS.length);
    const recovered = f.targets.get(restored.targetDeploymentId)!;
    for (const owner of OWNERS) {
      expect(f.inv(owner, recovered.get(owner)!)).toEqual(baseline.find(i => i.owner === owner));
      if (OWNER_FORMATS[owner] === 'PG_CUSTOM') {
        expect(recovered.get(owner)!.rows.OwnerJournal.map(r => r.state)).toEqual(['COMPLETED', 'QUEUED', 'UNKNOWN']);
        expect(recovered.get(owner)!.rows.OwnerJournal.find(r => r.key === 'replay-unknown')!.value).toBe(owner + '-ambiguous');
        expect(recovered.get(owner)!.rows.ImmutableAudit).toEqual(f.data.get(owner)!.rows.ImmutableAudit);
        expect(recovered.get(owner)!.sequences[0].lastValue).toBe('9007199254740993');
      }
    }
    const beforeAllocate = f.events.lastIndexOf('allocate');
    expect(f.events.slice(0, beforeAllocate).filter(e => e.startsWith('verify:'))).toHaveLength(OWNERS.length * 2);
    expect(f.target.inventory).toHaveBeenCalledTimes(OWNERS.length * 2);
    expect(f.target.sealIsolated).toHaveBeenCalledOnce(); expect(f.target.rollbackOrQuarantine).not.toHaveBeenCalled();
    expect(f.issuedKeys.every(k => k.every(b => b === 0))).toBe(true);
    expect(JSON.stringify(f.adapter)).toContain('SYNTHETIC_ONLY'); expect(inspect(f.adapter)).not.toContain(f.key.toString('hex'));
    expect(f.coordinator.snapshot()).toMatchObject({backupAuthorized: false, globalUnmanagedWritersVerified: false});
  });
  it('is disabled by default, with zero side effects', async () => {
    const f = fixture(); f.adapter = new DeploymentBackupAdapter({...f.options, enabled: undefined}); await expect(f.adapter.backup(f.c)).rejects.toThrow('DISABLED');
    await expect(f.adapter.restore(f.c, Buffer.from('x'), randomUUID())).rejects.toThrow('DISABLED');
    expect(f.authorization.authorize).not.toHaveBeenCalled(); expect(f.target.createNew).not.toHaveBeenCalled();
  });
  it('requires the fixed complete owner set of twelve real owners, never a three-profile legacy package', () => {
    const f = fixture(); expect(OWNERS).toHaveLength(12); expect(OWNERS).not.toContain('REPORTING');
    expect(() => new DeploymentBackupAdapter({...f.options, owners: f.owners.slice(1)})).toThrow();
    expect(() => new DeploymentBackupAdapter({...f.options, owners: f.owners.map((o, i) => i === 0 ? f.owners[1] : o)})).toThrow('OWNER');
    expect(() => allSnapshots(f.content().owners.slice(0, 3))).toThrow();
  });
  it.each(['PRODUCTION', 'AUTHORIZED_COPY', 'REAL'])('rejects real/non-synthetic context %s before calling any owner', async label => {
    const f = fixture(); await f.start();
    await expect(f.adapter.backup({...f.c, [label === 'PRODUCTION' ? 'environment' : 'datasetClass']: label} as any)).rejects.toThrow('BACKUP_FAILED');
    expect(f.owners.every(o => !o.snapshot.mock.calls.length)).toBe(true);
  });
  it('requires TI authorization independently of the coordinator and returns sanitized errors', async () => {
    const f = fixture(); await f.start(); f.authorization.authorize.mockRejectedValue(Error('password=never-log-this'));
    await expect(f.adapter.backup(f.c)).rejects.toThrow(/^DEPLOYMENT_BACKUP_FAILED$/);
    expect(f.owners[0].inventory).not.toHaveBeenCalled(); expect(f.catalog.reserve).not.toHaveBeenCalled();
    expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('never-log-this');
  });
  it('rejects backup without a live parent lease, before inventory or capture', async () => {
    const f = fixture(); await expect(f.adapter.backup(f.c)).rejects.toThrow('BACKUP_FAILED');
    expect(f.owners[0].inventory).not.toHaveBeenCalled(); expect(f.catalog.publish).not.toHaveBeenCalled();
  });
  it('a serialized or expired local lease receipt cannot be replayed', async () => {
    const f = fixture(); await f.start(); let held: any;
    await f.lease.withOfflineSnapshot(f.c, async proof => {held = proof; f.lease.assertHeld(proof, f.c); expect(() => f.lease.assertHeld({...proof}, f.c)).toThrow('LEASE');});
    expect(() => f.lease.assertHeld(held, f.c)).toThrow('LEASE');
  });
  it('binds a live lease to the backup identity and key version', async () => {
    const f = fixture(); await f.start();
    await f.lease.withOfflineSnapshot(f.c, async proof => {
      expect(() => f.lease.assertHeld(proof, {...f.c, backupId: randomUUID()})).toThrow('DEPLOYMENT_LEASE_CHANGED');
      expect(() => f.lease.assertHeld(proof, {...f.c, keyVersion: f.c.keyVersion + 1})).toThrow('DEPLOYMENT_LEASE_CHANGED');
      f.lease.assertHeld(proof, f.c);
    });
  });
  it('the AFTER verifier must pass before the encrypted package is published', async () => {
    const f = fixture(); await f.start(); const original = f.verifier.inspect.getMockImplementation()!;
    f.verifier.inspect.mockImplementation(async r => ({...await original(r), activeApplicationConnections: f.verifier.inspect.mock.calls.length === 2 ? 1 : 0}));
    await expect(f.adapter.backup(f.c)).rejects.toThrow('BACKUP_FAILED'); expect(f.catalog.publish).not.toHaveBeenCalled(); expect(f.catalog.fail).toHaveBeenCalledOnce();
  });
  it.each(['tables', 'schema', 'sequences', 'checkpoints', 'files'])('independently detects source %s changing during capture', async part => {
    const f = fixture(); await f.start(); const trigger = f.owners.find(o => o.owner === 'FILES')!, read = trigger.snapshot.getMockImplementation()!;
    trigger.snapshot.mockImplementation(async () => {
      const value = await read(); const d = f.data.get(part === 'files' ? 'ARTIFACTS' : 'BILLING')!;
      if (part === 'tables') d.rows.OwnerJournal[0].value = 'changed';
      if (part === 'schema') d.schema += ':MISSING_CHECK';
      if (part === 'sequences') d.sequences[0].lastValue = '9007199254740994';
      if (part === 'checkpoints') d.checkpoints.epoch = 'epoch-5';
      if (part === 'files') d.files[0].bytes = Buffer.from('<changed/>');
      return value;
    });
    await expect(f.adapter.backup(f.c)).rejects.toThrow('BACKUP_FAILED'); expect(f.catalog.publish).not.toHaveBeenCalled();
  });
  it('compares configuration before and after capture independently', async () => {
    const f = fixture(); await f.start(); const read = f.config.inspect.getMockImplementation()!;
    f.config.inspect.mockImplementation(async () => {const c = await read(); if (f.config.inspect.mock.calls.length > 1) c.fingerprints[0].sha256 = 'b'.repeat(64); return c;});
    await expect(f.adapter.backup(f.c)).rejects.toThrow(); expect(f.catalog.publish).not.toHaveBeenCalled();
  });
  it('detects a stale snapshot even if independent source inventories are stable', async () => {
    const f = fixture(); await f.start(); const port = f.owners[0], old = port.snapshot.getMockImplementation()!;
    port.snapshot.mockImplementation(async () => {const s = await old(); s.inventory.schemaSha256 = 'b'.repeat(64); return s;});
    port.verify.mockResolvedValue(); await expect(f.adapter.backup(f.c)).rejects.toThrow(); expect(f.catalog.publish).not.toHaveBeenCalled();
  });
  it('burns failed backup ids and refuses reuse, concurrent captures and stale key versions', async () => {
    const f = fixture(); await f.start(); let release!: () => void;
    const gate = new Promise<void>(r => {release = r;}); const old = f.owners[0].snapshot.getMockImplementation()!;
    f.owners[0].snapshot.mockImplementation(async () => {await gate; return old();});
    const first = f.adapter.backup(f.c); await expect(f.adapter.backup(f.c)).rejects.toThrow('BUSY'); release(); await first;
    await expect(f.adapter.backup(f.c)).rejects.toThrow('BACKUP_FAILED');
    f.c.backupId = randomUUID(); f.allowedVersions.clear(); const captures = f.owners[0].snapshot.mock.calls.length;
    await expect(f.adapter.backup(f.c)).rejects.toThrow(); expect(f.owners[0].snapshot).toHaveBeenCalledTimes(captures);
    f.allowedVersions.add(7); await expect(f.adapter.backup(f.c)).rejects.toThrow();
  });
});


describe('integral encrypted package: authenticated context and bounded complete manifests', () => {
  it('uses fresh nonces, exact manifests, independent binary hashes, no private material in configuration', () => {
    const f = fixture(), input = f.content(), a = sealPackage(input, f.key), b = sealPackage(input, f.key);
    expect(a.equals(b)).toBe(false); expect(openPackage(a, f.key, f.c)).toEqual({...input,
      configuration: configuration(input.configuration), owners: allSnapshots(input.owners)});
    expect(JSON.stringify(input.configuration)).not.toContain(f.key.toString('hex'));
    expect(() => openPackage(a, randomBytes(32), f.c)).toThrow('PACKAGE_INVALID');
  });
  it.each(['deploymentId', 'runId', 'backupId', 'keyVersion'])('AAD binds %s independently', field => {
    const f = fixture(), envelope = sealPackage(f.content(), f.key), changed = {...f.c, [field]: field === 'keyVersion' ? 8 : randomUUID()};
    expect(() => openPackage(envelope, f.key, changed)).toThrow('PACKAGE_INVALID');
  });
  it.each([0, 8, 20, 36, -1])('rejects envelope tampering at byte %s', offset => {
    const f = fixture(), envelope = sealPackage(f.content(), f.key); envelope[offset < 0 ? envelope.length - 1 : offset] ^= 1;
    expect(() => openPackage(envelope, f.key, f.c)).toThrow('PACKAGE_INVALID');
  });
  it.each([
    ['owner missing', (v: any) => v.owners.pop()],
    ['owner duplicate', (v: any) => {v.owners[0] = v.owners[1];}],
    ['legacy schema', (v: any) => {v.schemaVersion = 'factuez.b2b.synthetic-recovery.v1';}],
    ['unknown owner', (v: any) => {v.owners[0].inventory.owner = 'EXTRA';}],
    ['stale profile', (v: any) => {v.owners[0].inventory.profile = 'REPORTS_ONLY';}],
    ['bad dump hash', (v: any) => {v.owners.find((o: any) => o.inventory.owner === 'WEBHOOKS').payload.sha256 = 'a'.repeat(64);}],
    ['bad file hash', (v: any) => {v.owners.find((o: any) => o.inventory.owner === 'FILES').inventory.files[0].sha256 = 'a'.repeat(64);}],
    ['bad payload length', (v: any) => {v.owners[0].payload.byteLength++;}],
    ['invalid base64', (v: any) => {v.owners[0].payload.base64 = '!!!!';}],
    ['extra plaintext credentials field', (v: any) => {v.credentials = 'must-not-enter-manifest';}],
    ['configuration missing', (v: any) => {v.configuration.fingerprints.pop();}],
    ['custody missing', (v: any) => {v.configuration.custody.pop();}],
    ['custody duplicate', (v: any) => {v.configuration.custody.push(v.configuration.custody[0]);}],
    ['custody local key path', (v: any) => {v.configuration.custody[0].reference = 'C:/vault/private.key';}],
    ['config contains file', (v: any) => {v.owners.find((o: any) => o.inventory.owner === 'CONFIG').files.push({path: 'key.dat', base64: 'eA=='});}],
    ['snapshot lease from other deployment', (v: any) => {v.lease.deploymentId = randomUUID();}],
    ['global scope claim', (v: any) => {v.lease.scope = 'GLOBAL_VERIFIED';}],
    ['unsafe sequence precision', (v: any) => {v.owners.find((o: any) => o.inventory.owner === 'BILLING').inventory.sequences[0].lastValue = '9223372036854775808';}],
  ])('authenticates but rejects malformed manifest: %s', (_, change: any) => {
    const f = fixture(); expect(() => openPackage(forged(f, change), f.key, f.c)).toThrow('PACKAGE_INVALID');
  });
  it.each(['../key.xml', '/absolute.xml', 'C:/a.xml', 'a\\b.xml', '%2e%2e/key.xml', 'a//b.xml', 'a/./b.xml',
    'a/../b.xml', 'a.xml:stream', 'CON.xml', 'con.xml', 'com1.dat', 'a.pfx', 'vault/private.key', 'a.xml.', 'a.xml\0', 'é.xml'])('rejects unsafe logical path %s', path => {
    const f = fixture(), s = f.encode('ARTIFACTS'); s.files[0].path = path; expect(() => snapshot(s)).toThrow();
  });
  it('rejects duplicates, file/directory shadows, accessors and private key markers', () => {
    const f = fixture(), s = f.encode('ARTIFACTS');
    s.files.push(s.files[0]); expect(() => snapshot(s)).toThrow();
    const inv = f.encode('ARTIFACTS').inventory; inv.files.push({...inv.files[0], path: inv.files[0].path + '/other.xml'}); expect(() => inventory(inv)).toThrow();
    const untouched = f.encode('BILLING'), getter = vi.fn(() => {throw Error('untrusted getter');});
    Object.defineProperty(untouched.inventory, 'tables', {get: getter}); expect(() => snapshot(untouched)).toThrow(); expect(getter).not.toHaveBeenCalled();
    const privateFile = f.encode('FILES'); privateFile.files[0].bytes = Buffer.from('-----BEGIN PRIVATE KEY-----\nnot-for-bundle'); expect(() => snapshot(privateFile)).toThrow('PRIVATE');
  });
  it('enforces actual dump/file/aggregate/count limits before sealing', () => {
    const f = fixture(), s = f.encode('BILLING'); s.payload.bytes = Buffer.alloc(LIMITS.dump + 1); expect(() => snapshot(s)).toThrow();
    const file = f.encode('FILES'); file.files[0].bytes = Buffer.alloc(LIMITS.file + 1); expect(() => snapshot(file)).toThrow();
    const many = f.encode('FILES'); many.files = Array(129).fill(many.files[0]); expect(() => snapshot(many)).toThrow();
    const large = f.content().owners;
    for (const owner of large.filter(o => o.payload.format === 'PG_CUSTOM').slice(0, 5)) {owner.payload.bytes = Buffer.alloc(LIMITS.dump); owner.payload.bytes.write('PGDMP');}
    expect(() => allSnapshots(large)).toThrow('LIMIT');
    expect(() => openPackage(Buffer.alloc(LIMITS.envelope + 1), f.key, f.c)).toThrow('PACKAGE_INVALID');
  });
  it('never accepts the legacy capsule format as an integral backup', () => {
    const f = fixture(); expect(() => openPackage(Buffer.from('FZB2B9R1' + 'x'.repeat(100)), f.key, f.c)).toThrow('PACKAGE_INVALID');
  });
});

describe('restore: prevalidation, new empty targets, failure isolation and replay', () => {
  it('rejects every invalid package before even allocating a destination', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c);
    saved.envelope[saved.envelope.length - 1] ^= 1;
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow('RESTORE_FAILED');
    expect(f.target.createNew).not.toHaveBeenCalled(); expect(f.target.restore).not.toHaveBeenCalled();
  });
  it('checks a malformed LAST owner even with a valid GCM tag and trusted catalog hash', async () => {
    const f = fixture(); await f.start(); await f.adapter.backup(f.c);
    const envelope = forged(f, v => {v.owners.find((o: any) => o.inventory.owner === 'WEBHOOKS').payload.sha256 = 'a'.repeat(64);});
    const entry = f.catalogRows.get(f.c.backupId)!; entry.envelopeSha256 = sha(envelope);
    // capturedAt need not be adjusted: malformed owner rejection precedes any timestamp/target operation.
    await expect(f.adapter.restore(f.c, envelope, randomUUID())).rejects.toThrow(); expect(f.target.createNew).not.toHaveBeenCalled();
  });
  it('semantic verification of ALL owners precedes allocation and detects mismatched data despite valid magic', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), content = openPackage(saved.envelope, f.key, f.c);
    const s = content.owners.find(o => o.inventory.owner === 'WEBHOOKS')!;
    const d = JSON.parse(s.payload.bytes.subarray(5).toString()); d.rows.OwnerJournal[0].value = 'ALTERED'; s.payload.bytes = Buffer.from('PGDMP' + canonical(d));
    const changed = sealPackage(content, f.key); f.catalogRows.get(f.c.backupId)!.envelopeSha256 = sha(changed);
    await expect(f.adapter.restore(f.c, changed, randomUUID())).rejects.toThrow(); expect(f.target.createNew).not.toHaveBeenCalled();
  });
  it.each(['expired', 'future', 'wrongHash', 'wrongContext', 'tooLong'])('rejects stale or untrusted catalog entry: %s', async variant => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), entry = f.catalogRows.get(f.c.backupId)!;
    if (variant === 'expired') {entry.createdAt = new Date(Date.now() - 2000).toISOString(); entry.expiresAt = new Date(Date.now() - 1000).toISOString();}
    if (variant === 'future') entry.createdAt = new Date(Date.now() + 60000).toISOString();
    if (variant === 'wrongHash') entry.envelopeSha256 = 'a'.repeat(64);
    if (variant === 'wrongContext') entry.context.backupId = randomUUID();
    if (variant === 'tooLong') entry.expiresAt = new Date(Date.now() + 2 * LIMITS.maxAgeMs).toISOString();
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.createNew).not.toHaveBeenCalled();
  });
  it('requires live TI and external custody approval plus a non-revoked key for restore', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c);
    f.allowedVersions.clear(); await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow();
    f.allowedVersions.add(7); f.custody.verify.mockRejectedValueOnce(Error('PRIVATE_REASON'));
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow();
    f.authorization.authorize.mockRejectedValueOnce(Error('PRIVATE_AUTHORIZATION_REASON'));
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(/^DEPLOYMENT_RESTORE_FAILED$/);
    expect(f.target.createNew).not.toHaveBeenCalled(); expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('PRIVATE_');
  });
  it.each(['nonempty', 'sourceIdentity', 'creationIdentity', 'missingOwner', 'sharedResource', 'notIsolated'])('never writes or cleans an unproven/existing target: %s', async variant => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), create = f.target.createNew.getMockImplementation()!;
    f.target.createNew.mockImplementation(async r => {
      const id = await create(r);
      if (variant === 'nonempty') id.resources[0].empty = false;
      if (variant === 'sourceIdentity') id.deploymentId = f.c.deploymentId;
      if (variant === 'creationIdentity') id.resources[0].createdBy = randomUUID();
      if (variant === 'missingOwner') id.resources.pop();
      if (variant === 'sharedResource') id.resources[0].resourceId = id.resources[1].resourceId;
      if (variant === 'notIsolated') (id as any).isolated = false;
      return id;
    });
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow();
    expect(f.target.restore).not.toHaveBeenCalled(); expect(f.target.rollbackOrQuarantine).not.toHaveBeenCalled();
  });
  it('requires independent target inspection to agree with allocation before writing or cleanup', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), read = f.target.inspect.getMockImplementation()!;
    f.target.inspect.mockImplementation(async id => ({...await read(id), deploymentId: randomUUID()}));
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow();
    expect(f.target.restore).not.toHaveBeenCalled(); expect(f.target.rollbackOrQuarantine).not.toHaveBeenCalled();
    expect(f.audit.append.mock.calls.some(([e]) => e.phase === 'QUARANTINE_REQUIRED')).toBe(true);
  });
  it('refuses a later nonempty owner and rolls back only the new proven deployment', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), apply = f.target.restore.getMockImplementation()!;
    f.target.restore.mockImplementation(async (id, owner, s) => {
      await apply(id, owner, s, structuredClone(f.cfg));
      if (owner === 'IDENTITY') f.targets.get(id.deploymentId)!.set('BILLING', structuredClone(f.data.get('BILLING')!));
    });
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow();
    expect(f.target.restore.mock.calls.map(c => c[1])).toEqual(['IDENTITY']); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce();
    expect(f.data.get('BILLING')!.rows.OwnerJournal).toHaveLength(3);
  });
  it('restoration failure in a later owner quarantines the whole partial target and never seals or completes', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), apply = f.target.restore.getMockImplementation()!;
    f.target.restore.mockImplementation(async (id, owner, s) => {if (owner === 'MAILER') throw Error('CREDENTIAL_MUST_NOT_ESCAPE'); await apply(id, owner, s, structuredClone(f.cfg));});
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(/^DEPLOYMENT_RESTORE_FAILED$/);
    expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce(); expect(f.target.sealIsolated).not.toHaveBeenCalled(); expect(f.journal.complete).not.toHaveBeenCalled();
    expect(f.targets.size).toBe(0); expect(JSON.stringify(f.audit.append.mock.calls)).not.toContain('CREDENTIAL');
  });
  it.each(['schema', 'rows', 'sequences', 'checkpoint', 'files'])('detects corrupt restored %s from independent destination reads', async section => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), apply = f.target.restore.getMockImplementation()!;
    f.target.restore.mockImplementation(async (id, owner, s) => {
      await apply(id, owner, s, structuredClone(f.cfg));
      if (owner === 'FILES') {
        const target = f.targets.get(id.deploymentId)!;
        const d = target.get(section === 'files' ? 'ARTIFACTS' : 'BILLING')!;
        if (section === 'schema') d.schema += ':TRIGGER_DROPPED';
        if (section === 'rows') d.rows.OwnerJournal[2].state = 'QUEUED';
        if (section === 'sequences') d.sequences[0].isCalled = false;
        if (section === 'checkpoint') d.checkpoints.offset = '43';
        if (section === 'files') d.files[0].bytes = Buffer.from('<corrupt/>');
      }
    });
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce(); expect(f.journal.complete).not.toHaveBeenCalled();
  });
  it('does not trust mutation receipts or allow a port to rewrite the expected inventory', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), apply = f.target.restore.getMockImplementation()!;
    f.target.restore.mockImplementation(async (id, owner, s) => {
      if (owner === 'BILLING') {s.inventory.schemaSha256 = sha('bad'); await apply(id, owner, s, structuredClone(f.cfg)); f.targets.get(id.deploymentId)!.get(owner)!.schema = 'bad';}
      else await apply(id, owner, s, structuredClone(f.cfg));
    });
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce();
  });
  it('configuration mismatch or mutation during final isolation validation prevents completion', async () => {
    for (const variant of ['config', 'afterSeal']) {
      const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c);
      if (variant === 'config') f.target.configuration.mockImplementation(async () => {const cfg = structuredClone(f.cfg); cfg.fingerprints[0].sha256 = 'a'.repeat(64); return cfg;});
      else f.target.sealIsolated.mockImplementation(async () => {f.targets.get(f.allocations[0].deploymentId)!.get('REDIS')!.checkpoints.epoch = 'wrong';});
      await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce(); expect(f.journal.complete).not.toHaveBeenCalled();
    }
  });
  it('identity drift prevents any further write AND prevents cleanup of a potentially foreign target', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), apply = f.target.restore.getMockImplementation()!;
    f.target.restore.mockImplementation(async (id, owner, s) => {await apply(id, owner, s, structuredClone(f.cfg)); f.allocations[0].resources[0].resourceId = randomUUID();});
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.restore).toHaveBeenCalledOnce();
    expect(f.target.rollbackOrQuarantine).not.toHaveBeenCalled(); expect(f.audit.append.mock.calls.some(([e]) => e.phase === 'QUARANTINE_REQUIRED')).toBe(true);
  });
  it('failed rollback records manual quarantine requirement; never returns success or permits a retry into the partial target', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), restoreId = randomUUID();
    f.target.restore.mockRejectedValueOnce(Error('restore failed')); f.target.rollbackOrQuarantine.mockRejectedValueOnce(Error('cleanup failed'));
    await expect(f.adapter.restore(f.c, saved.envelope, restoreId)).rejects.toThrow();
    expect(f.audit.append.mock.calls.some(([e]) => e.phase === 'QUARANTINE_REQUIRED')).toBe(true); expect(f.journal.complete).not.toHaveBeenCalled();
    await expect(f.adapter.restore(f.c, saved.envelope, restoreId)).rejects.toThrow(); expect(f.target.createNew).toHaveBeenCalledOnce();
  });
  it('completed replay returns the same isolated receipt without target writes, reallocation or dispatch', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), restoreId = randomUUID();
    const first = await f.adapter.restore(f.c, saved.envelope, restoreId), mutations = f.target.restore.mock.calls.length;
    expect(await f.adapter.restore(f.c, saved.envelope, restoreId)).toEqual(first);
    expect(f.target.createNew).toHaveBeenCalledOnce(); expect(f.target.restore).toHaveBeenCalledTimes(mutations);
    expect(f.authorization.authorize).toHaveBeenCalledTimes(3); expect(f.journal.complete).toHaveBeenCalledOnce();
  });
  it('audit failure before mutation prevents allocation; failure after partial restore quarantines it', async () => {
    const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c);
    f.audit.append.mockImplementationOnce(async () => {throw Error('audit unavailable');});
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.createNew).not.toHaveBeenCalled();
    f.audit.append.mockImplementation(async e => {if (e.operation === 'RESTORE' && e.phase === 'COMPLETED') throw Error('audit unavailable');});
    await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce(); expect(f.journal.complete).not.toHaveBeenCalled();
  });
  it('rejects unexpected key versions and wipes the rejected supplied key', async () => {
    const f = fixture(); await f.start(); const rejected = randomBytes(32);
    f.keys.acquire.mockResolvedValueOnce({version: 6, key: rejected}); await expect(f.adapter.backup(f.c)).rejects.toThrow();
    expect(rejected.equals(Buffer.alloc(32))).toBe(true); expect(f.owners[0].snapshot).not.toHaveBeenCalled();
  });
  it('runner refuses absent opt-in and any live/extra parameters without launching tests', () => {
    const script = 'infra/b2b/deployment-backup/synthetic-runner.mjs';
    for (const args of [[], ['--isolated-synthetic-only', '--url=postgres://real'], ['--target=existing']]) {
      const result = spawnSync(process.execPath, [script, ...args], {encoding: 'utf8', windowsHide: true});
      expect(result.status).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).toContain('SYNTHETIC_OPT_IN_REQUIRED');
    }
  });
});



it('fixture binary state reconstructs independent inventories for all owners', async () => {
  const f = fixture(); for (const port of f.owners) {const s = await port.snapshot(); await port.verify(s);}
});


it('restores after the entire source data map is destroyed, reading only encrypted members and external configuration', async () => {
  const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c);
  const expected = OWNERS.map(owner => f.inv(owner, f.data.get(owner)!)); f.data.clear();
  for (const port of f.owners) {port.inventory.mockRejectedValue(Error('SOURCE_GONE')); port.snapshot.mockRejectedValue(Error('SOURCE_GONE'));}
  const receipt = await f.adapter.restore(f.c, saved.envelope, randomUUID()), recovered = f.targets.get(receipt.targetDeploymentId)!;
  for (const owner of OWNERS) expect(f.inv(owner, recovered.get(owner)!)).toEqual(expected.find(i => i.owner === owner));
  expect(recovered.get('REDIS')!.redis!.map(k => k.value)).toEqual(['QUEUED', 'UNKNOWN', 'opaque-session']);
  expect(recovered.get('REDIS')!.redis![2].expiresAt).toBe('2099-01-01T00:00:00.000Z');
  expect(f.owners.every(o => o.snapshot.mock.calls.length === 1 && o.inventory.mock.calls.length === 2)).toBe(true);
});
it('detects independent Redis key/value and TTL changes during source capture', async () => {
  const f = fixture(); await f.start(); const port = f.owners.find(o => o.owner === 'FILES')!, read = port.snapshot.getMockImplementation()!;
  port.snapshot.mockImplementation(async () => {const s = await read(); f.data.get('REDIS')!.redis![0].value = 'AUTO_REPLAYED'; f.data.get('REDIS')!.redis![2].expiresAt = null; return s;});
  await expect(f.adapter.backup(f.c)).rejects.toThrow(); expect(f.catalog.publish).not.toHaveBeenCalled();
});
it('detects independent Redis corruption after restore even when offsets and schema are unchanged', async () => {
  const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c), apply = f.target.restore.getMockImplementation()!;
  f.target.restore.mockImplementation(async (id, owner, s, cfg) => {await apply(id, owner, s, cfg); if (owner === 'FILES') f.targets.get(id.deploymentId)!.get('REDIS')!.redis![1].value = 'QUEUED';});
  await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce();
});
it('failed allocation requires quarantine evidence but never cleans an unknown resource', async () => {
  const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c); f.target.createNew.mockRejectedValueOnce(Error('PARTIAL_ALLOCATION'));
  await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow();
  expect(f.target.restore).not.toHaveBeenCalled(); expect(f.target.rollbackOrQuarantine).not.toHaveBeenCalled();
  expect(f.audit.append.mock.calls.some(([e]) => e.phase === 'QUARANTINE_REQUIRED')).toBe(true);
});
it('failed journal commit quarantines the new target without activating any services', async () => {
  const f = fixture(); await f.start(); const saved = await f.adapter.backup(f.c); f.journal.complete.mockRejectedValueOnce(Error('PERSISTENCE_UNCERTAIN'));
  await expect(f.adapter.restore(f.c, saved.envelope, randomUUID())).rejects.toThrow(); expect(f.target.rollbackOrQuarantine).toHaveBeenCalledOnce(); expect(f.journal.fail).toHaveBeenCalledOnce();
});
it('external custody failure prevents capture and catalog readiness', async () => {
  const f = fixture(); await f.start(); f.custody.verify.mockRejectedValueOnce(Error('MISSING_VERSION'));
  await expect(f.adapter.backup(f.c)).rejects.toThrow(); expect(f.owners.every(o => o.snapshot.mock.calls.length === 0)).toBe(true); expect(f.catalog.publish).not.toHaveBeenCalled();
});

it('rejects duplicate authenticated JSON keys instead of silently accepting the last value', () => {
  const f = fixture(); const envelope = forged(f, () => undefined, wire => {
    const encoded = canonical(wire); return encoded.replace('"datasetClass":"SYNTHETIC"', '"datasetClass":"REAL","datasetClass":"SYNTHETIC"');
  });
  expect(() => openPackage(envelope, f.key, f.c)).toThrow('PACKAGE_INVALID');
});
it('advertises every mandatory capability without implying authorization or real execution', () => {
  const f = fixture(); expect(f.adapter.capabilities()).toMatchObject({realExecution: false, externalCustodyRequired: true, backupAuthorized: false, globalUnmanagedWritersVerified: false});
  expect(f.adapter.capabilities().owners.map(o => o.owner)).toEqual(OWNERS); expect(f.adapter.capabilities().owners.every(o => o.mandatory)).toBe(true);
});

