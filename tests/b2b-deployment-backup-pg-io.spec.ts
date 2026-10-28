import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {inspect} from 'node:util';
import {randomUUID} from 'node:crypto';
import {PG_BINARIES, PG_IO_MARKER, PG_IO_VERSION, PG_SOURCE_QUERY, SyntheticPostgresArchiveDriver, parsePgToc,
  type PgArchiveOptions} from '../infra/b2b/deployment-backup/pg-archive-io';
import {canonical, LIMITS, sha} from '../infra/b2b/deployment-backup/model';
import {PROFILE, type Context, type LeaseProof, type TiAuthorizationPort, type OfflineLeasePort} from '../infra/b2b/deployment-backup/ports';

// Text fixture of native PG16 list syntax. The mocked binary boundary below does NOT create a valid archive.
const toc = Buffer.from([
  '; Archive created at 2026-10-27 10:20:00',
  ';     dbname: fz_synthetic_fixture',
  ';     TOC Entries: 14',
  ';     Compression: 0',
  ';     Dump Version: 1.15-0',
  ';     Format: CUSTOM',
  ';     Integer: 4',
  ';     Offset: 8',
  ';     Dumped from database version: 16.11',
  ';     Dumped by pg_dump version: 16.11',
  ';',
  '5; 2615 2200 SCHEMA - public postgres',
  '214; 1259 16387 TABLE public "strange table" postgres',
  '215; 1259 16388 SEQUENCE public "strange table_id_seq" postgres',
  '3340; 0 16387 TABLE DATA public "strange table" postgres',
  '3341; 0 0 SEQUENCE SET public "strange table_id_seq" postgres',
  '3200; 1255 20000 FUNCTION public update_epoch() postgres',
  '3201; 0 0 ACL public TABLE "strange table" postgres',
  '3202; 3256 20001 POLICY public "strange table" tenant_policy postgres',
  '3203; 0 16387 ROW SECURITY public "strange table" postgres',
  '3204; 2620 20002 TRIGGER public "strange table" update_epoch postgres',
  '3205; 0 0 DEFAULT ACL public DEFAULT PRIVILEGES FOR TABLES postgres',
  '3206; 0 0 COMMENT public TABLE "strange table" postgres',
  '',
].join('\n'));
const schema = Buffer.from('-- PostgreSQL database dump\nCREATE TABLE public.example (id bigint);\n');
const script = Buffer.from(schema.toString() + 'COPY public.example (id) FROM stdin;\n1\n\\.\n');
// Deliberately only a process response fixture, never presented to native pg_restore.
const archive = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 42)]);
type Node = {kind: 'file' | 'dir'; bytes: Buffer; ino: bigint; mode: bigint; uid: bigint; nlink: bigint};
let originalGetuid: PropertyDescriptor | undefined;
let c: Context, proof: LeaseProof, o: PgArchiveOptions, marker: any;
let nodes: Map<string, Node>, handles: Map<number, {name: string; cursor: number}>, nextFd: number, nextIno: bigint;
let authorize: ReturnType<typeof vi.fn<TiAuthorizationPort['authorize']>>;
let assertHeld: ReturnType<typeof vi.fn<OfflineLeasePort['assertHeld']>>, exec: ReturnType<typeof vi.spyOn>;
let observedInputs: Buffer[];
function stat(n: Node): any {
  return {dev: 1n, ino: n.ino, mode: n.mode, uid: n.uid, nlink: n.nlink,
    size: BigInt(n.bytes.length), mtimeNs: 10n, ctimeNs: 10n,
    isDirectory: () => n.kind === 'dir', isFile: () => n.kind === 'file', isSymbolicLink: () => false};
}
function put(name: string, kind: Node['kind'], bytes = Buffer.alloc(0)) {
  nodes.set(name, {kind, bytes: Buffer.from(bytes), ino: nextIno++, mode: kind === 'dir' ? 0o40700n : 0o100600n, uid: 1000n, nlink: 1n});
}
function get(name: string): Node {const n = nodes.get(name); if (!n) throw new Error('ENOENT'); return n;}
function driver(config = o) {
  return new SyntheticPostgresArchiveDriver(config, {authorization: {authorize}, lease: {assertHeld, withOfflineSnapshot: vi.fn()}});
}
function runDir() {return path.join(o.root, c.backupId);}
function processResponse(binary: any, args: any, cfg?: any): Buffer {
  if (binary === PG_BINARIES.restore && cfg) observedInputs.push(Buffer.from(cfg.input));
  if (binary === PG_BINARIES.psql) return Buffer.from(JSON.stringify({database: marker.database, serverVersion: '160011', marker}) + '\n');
  if (binary === PG_BINARIES.dump) return Buffer.from(archive);
  if (binary === PG_BINARIES.restore && args.includes('--list')) return Buffer.from(toc);
  if (binary === PG_BINARIES.restore && args.includes('--schema-only')) return Buffer.from(schema);
  if (binary === PG_BINARIES.restore) return Buffer.from(script);
  throw new Error('UNEXPECTED_BINARY');
}
beforeEach(() => {
  c = {deploymentId: randomUUID(), runId: randomUUID(), backupId: randomUUID(), keyVersion: 1, environment: 'BETA', datasetClass: 'SYNTHETIC'};
  proof = {deploymentId: c.deploymentId, runId: c.runId, inventorySha256: 'a'.repeat(64), inventoryRevision: 1, scope: 'EXPLICIT_REGISTERED_DEPLOYMENT'};
  const rootId = randomUUID();
  o = {root: path.resolve('pg-io-unit', 'factuez-pg-io-' + rootId), rootId, deploymentId: c.deploymentId, databaseId: randomUUID(),
    profile: PROFILE, environment: 'BETA', datasetClass: 'SYNTHETIC', purpose: 'NEW_SYNTHETIC'};
  const {root: _, ...rest} = o;
  marker = {schemaVersion: PG_IO_VERSION, ...rest, database: 'fz_synthetic_' + o.databaseId.replace(/-/g, '')};
  nodes = new Map(); handles = new Map(); nextFd = 100; nextIno = 1n;
  let parent = o.root; for (;;) {put(parent, 'dir'); const next = path.dirname(parent); if (next === parent) break; parent = next;}
  put(path.join(o.root, PG_IO_MARKER), 'file', Buffer.from(canonical(marker)));
  originalGetuid = Object.getOwnPropertyDescriptor(process, 'getuid');
  Object.defineProperty(process, 'getuid', {configurable: true, value: () => 1000});
  vi.spyOn(os, 'platform').mockReturnValue('linux');
  vi.spyOn(fs, 'lstatSync').mockImplementation(((name: any) => stat(get(String(name)))) as any);
  vi.spyOn(fs.realpathSync, 'native').mockImplementation(((name: any) => String(name)) as any);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number) => stat(get(handles.get(fd)!.name))) as any);
  vi.spyOn(fs, 'mkdirSync').mockImplementation(((name: any) => {
    const n = String(name); if (nodes.has(n)) throw new Error('EEXIST'); get(path.dirname(n)); put(n, 'dir');
  }) as any);
  vi.spyOn(fs, 'openSync').mockImplementation(((name: any, flags: number) => {
    const n = String(name);
    if (flags & fs.constants.O_CREAT) {
      if (nodes.has(n)) throw new Error('EEXIST'); get(path.dirname(n)); put(n, 'file');
    } else get(n);
    const fd = nextFd++; handles.set(fd, {name: n, cursor: 0}); return fd;
  }) as any);
  vi.spyOn(fs, 'readSync').mockImplementation(((fd: number, dest: Buffer, offset: number, count: number) => {
    const h = handles.get(fd)!, bytes = get(h.name).bytes;
    const n = Math.min(count, bytes.length - h.cursor); bytes.copy(dest, offset, h.cursor, h.cursor + n); h.cursor += n; return n;
  }) as any);
  vi.spyOn(fs, 'writeFileSync').mockImplementation(((fd: number, bytes: any) => {get(handles.get(fd)!.name).bytes = Buffer.from(bytes);}) as any);
  vi.spyOn(fs, 'fsyncSync').mockImplementation(() => {});
  vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {handles.delete(fd);});
  // All native processes are intercepted, including valid parse test scenarios.
  exec = vi.spyOn(childProcess, 'execFileSync').mockImplementation(processResponse as any);
  authorize = vi.fn<TiAuthorizationPort['authorize']>().mockResolvedValue(undefined);
  assertHeld = vi.fn<OfflineLeasePort['assertHeld']>(); observedInputs = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalGetuid) Object.defineProperty(process, 'getuid', originalGetuid); else Reflect.deleteProperty(process, 'getuid');
});

describe('native PG16 TOC text parser (no binary execution)', () => {
  it('parses native list syntax including ACL/RLS, trigger, function, sequence and quoted names without losing metadata', () => {
    const entries = parsePgToc(toc);
    expect(entries).toHaveLength(12);
    expect(entries.find(e => e.dumpId === 214)).toEqual({dumpId: 214, catalogOid: '1259', objectOid: '16387',
      definition: 'TABLE public "strange table" postgres'});
    expect(entries.some(e => e.definition.startsWith('ROW SECURITY '))).toBe(true);
    expect(parsePgToc(Buffer.from(toc.toString().replace(/\n/g, '\r\n')))).toEqual(entries);
    expect(exec).not.toHaveBeenCalled();
  });
  it.each([
    Buffer.from('PGDMP+JSON'), Buffer.from('REDIS0011'), Buffer.from(toc.toString().replace('Format: CUSTOM', 'Format: TAR')),
    Buffer.from(toc.toString().replace('Dumped by pg_dump version: 16.11', 'Dumped by pg_dump version: 17.1')),
    Buffer.from(toc.toString() + '214; 1259 123 TABLE public duplicate postgres\n'),
    Buffer.from(toc.toString() + '0; 1 1 TABLE public invalid postgres\n'),
    Buffer.from(toc.toString() + '2147483648; 1 1 TABLE public invalid postgres\n'),
    Buffer.from(toc.toString() + '999; 4294967296 1 TABLE public invalid postgres\n'),
    Buffer.from(toc.toString() + '999; 1 4294967296 TABLE public invalid postgres\n'),
    Buffer.from(toc.toString() + 'garbage\n'), Buffer.from(toc.toString() + '\0'),
    Buffer.concat([toc, Buffer.from([0xff])]),
    Buffer.from(';     Format: CUSTOM\n;     Dumped by pg_dump version: 16.11\n'),
  ])('rejects malformed/ambiguous listing %#', value => {
    expect(() => parsePgToc(value)).toThrow('PG_IO_TOC_INVALID'); expect(exec).not.toHaveBeenCalled();
  });
});

describe('concrete archive capture IO with mocked process and filesystem boundaries', () => {
  it('has inert construction and requires explicit profile; diagnostics omit root and database', () => {
    const d = driver(); expect(exec).not.toHaveBeenCalled(); expect(fs.lstatSync).not.toHaveBeenCalled();
    const printable = JSON.stringify(d) + inspect(d);
    expect(printable).not.toContain(o.root); expect(printable).not.toContain(o.databaseId);
    expect(d.toJSON()).toMatchObject({ownerVerified: false, restored: false, backupAuthorized: false});
  });
  it('captures, consumes all archive blocks, retains exclusive artifacts and immutable quarantine journal', async () => {
    const d = driver(), result = await d.capture(c, proof);
    expect(authorize).toHaveBeenCalledExactlyOnceWith({operation: 'BACKUP', context: c, restoreId: null});
    expect(exec.mock.calls.map((call: any) => call[0])).toEqual([
      PG_BINARIES.psql, PG_BINARIES.dump, PG_BINARIES.restore, PG_BINARIES.restore, PG_BINARIES.restore, PG_BINARIES.psql]);
    expect(result.archive).toEqual(archive);
    expect(observedInputs).toEqual([archive, archive, archive]);
    expect(get(path.join(runDir(), 'archive.dump')).bytes).toEqual(archive);
    expect(result.inspection.archiveSha256).toBe(sha(archive));
    expect(result.inspection.scriptSha256).toBe(sha(script));
    expect(result.receipt).toMatchObject({state: 'CAPTURED_QUARANTINED', ownerVerified: false, restored: false, backupAuthorized: false});
    expect(nodes.has(path.join(runDir(), '000-quarantine.json'))).toBe(true);
    expect(nodes.has(path.join(runDir(), '001-captured.json'))).toBe(true);
    expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(false);
    expect(fs.fsyncSync).toHaveBeenCalled(); expect(handles.size).toBe(0);
    for (const call of vi.mocked(fs.openSync).mock.calls) {
      const flags = Number(call[1]);
      expect(flags & fs.constants.O_TRUNC).toBe(0);
      if (flags & fs.constants.O_CREAT) expect(flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
    }
  });
  it('uses fixed binaries, argv, readonly SQL and replacement environment without inherited hooks/credentials', async () => {
    const previous = process.env.PGPASSWORD; process.env.PGPASSWORD = 'ambient-secret';
    try {await driver().capture(c, proof);} finally {
      if (previous === undefined) delete process.env.PGPASSWORD; else process.env.PGPASSWORD = previous;
    }
    for (const [binary, args, cfg] of exec.mock.calls as any[]) {
      expect(Object.values(PG_BINARIES)).toContain(binary); expect(cfg.shell).toBe(false);
      expect(cfg.timeout).toBe(45000); expect(cfg.maxBuffer).toBe(LIMITS.raw);
      expect(cfg.stdio).toEqual(['pipe', 'pipe', 'pipe']); expect(cfg.cwd).toBe(runDir());
      expect(cfg.env.PGPASSFILE).toBe('/dev/null'); expect(cfg.env.PGREQUIREPEER).toBe('factuez_synthetic_postgres');
      expect(cfg.env.PGPASSWORD).toBeUndefined(); expect(cfg.env.PATH).toBeUndefined(); expect(cfg.env.NODE_OPTIONS).toBeUndefined();
      expect(args.join(' ')).not.toMatch(/--clean|--disable-triggers|--no-owner|--no-acl|--exclude|--table=/);
      if (binary === PG_BINARIES.restore) {
        expect(args.join(' ')).not.toMatch(/--dbname|--create|--host|--port|--username/);
        // The owned input buffer is wiped in finally after synchronous execution.
        expect(cfg.input).toEqual(Buffer.alloc(archive.length));
      } else {
        expect(args).toContain('--host=/run/factuez-synthetic-postgresql');
        expect(args).toContain('--port=55439'); expect(args).toContain('--no-password');
        expect(args).toContain('--dbname=' + marker.database);
      }
      if (binary === PG_BINARIES.psql) expect(args).toContain('--command=' + PG_SOURCE_QUERY);
    }
  });
  it('burns the attempt identity and never reuses or overwrites an existing capture', async () => {
    const d = driver(); await d.capture(c, proof); const before = get(path.join(runDir(), 'archive.dump')).bytes;
    exec.mockClear(); await expect(d.capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(exec).not.toHaveBeenCalled(); expect(get(path.join(runDir(), 'archive.dump')).bytes).toBe(before);
    expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(false);
  });
  it.each([0, 1, 2, 3, 4, 5])('redacts process failure at boundary %i and retains quarantine for reconciliation', async index => {
    let n = 0; exec.mockImplementation(((binary: any, args: any) => {
      if (n++ === index) throw Object.assign(new Error('password=VERY_PRIVATE /customer/path'), {stdout: 'PRIVATE', stderr: 'PRIVATE'});
      return processResponse(binary, args);
    }) as any);
    let error: any; try {await driver().capture(c, proof);} catch (e) {error = e;}
    expect(error.message).toBe('PG_IO_CAPTURE_FAILED'); expect(error.cause).toBeUndefined();
    expect(inspect(error)).not.toContain('PRIVATE'); expect(inspect(error)).not.toContain('customer');
    expect(nodes.has(path.join(runDir(), '000-quarantine.json'))).toBe(true);
    expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(true);
    expect(nodes.has(path.join(runDir(), '001-captured.json'))).toBe(false);
    expect(exec).toHaveBeenCalledTimes(index + 1); expect(handles.size).toBe(0);
  });
  it.each(['auth', 'lease', 'platform', 'marker', 'root-mode', 'root-symlink', 'marker-hardlink', 'marker-uid'])('fails before database IO: %s', async mode => {
    if (mode === 'auth') authorize.mockRejectedValue(new Error('private authorization error'));
    if (mode === 'lease') assertHeld.mockImplementation(() => {throw new Error('expired');});
    if (mode === 'platform') vi.mocked(os.platform).mockReturnValue('win32');
    if (mode === 'marker') get(path.join(o.root, PG_IO_MARKER)).bytes = Buffer.from('{}');
    if (mode === 'root-mode') get(o.root).mode = 0o40777n;
    if (mode === 'root-symlink') vi.mocked(fs.realpathSync.native).mockReturnValue(path.dirname(o.root));
    if (mode === 'marker-hardlink') get(path.join(o.root, PG_IO_MARKER)).nlink = 2n;
    if (mode === 'marker-uid') get(path.join(o.root, PG_IO_MARKER)).uid = 2000n;
    await expect(driver().capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(exec).not.toHaveBeenCalled(); expect(nodes.has(runDir())).toBe(false);
  });
  it.each(['source-name', 'source-marker', 'source-version', 'source-extra', 'source-invalid-utf8', 'archive-magic', 'archive-limit', 'toc', 'schema-utf8', 'script-utf8', 'late-source'])('fails closed on malformed response %s', async mode => {
    let sourceCalls = 0;
    exec.mockImplementation(((binary: any, args: any) => {
      if (binary === PG_BINARIES.psql) {
        sourceCalls++; const value = {database: marker.database, serverVersion: '160011', marker: {...marker}};
        if (mode === 'source-name') value.database = 'actual_customer';
        if (mode === 'source-marker' || (mode === 'late-source' && sourceCalls === 2)) value.marker.datasetClass = 'CUSTOMER';
        if (mode === 'source-version') value.serverVersion = '170001';
        if (mode === 'source-extra') (value as any).extra = true;
        if (mode === 'source-invalid-utf8') return Buffer.from([0xff]);
        return Buffer.from(JSON.stringify(value));
      }
      if (binary === PG_BINARIES.dump && mode === 'archive-magic') return Buffer.from('FAKE' + 'x'.repeat(64));
      if (binary === PG_BINARIES.dump && mode === 'archive-limit') return Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(LIMITS.dump)]);
      if (binary === PG_BINARIES.restore && mode === 'toc' && args.includes('--list')) return Buffer.from('PGDMP+fixture');
      if (binary === PG_BINARIES.restore && mode === 'schema-utf8' && args.includes('--schema-only')) return Buffer.from([0xff]);
      if (binary === PG_BINARIES.restore && mode === 'script-utf8' && args.includes('--file=-') && !args.includes('--schema-only')) return Buffer.from([0xff]);
      return processResponse(binary, args);
    }) as any);
    await expect(driver().capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(nodes.has(path.join(runDir(), 'archive.dump'))).toBe(false);
    expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(true);
    if (mode.startsWith('source-')) expect(exec).toHaveBeenCalledTimes(1);
  });
  it('does not journal or write into a replaced attempt directory', async () => {
    exec.mockImplementation(((binary: any, args: any) => {
      const response = processResponse(binary, args);
      if (binary === PG_BINARIES.dump) get(runDir()).ino++;
      return response;
    }) as any);
    await expect(driver().capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(nodes.has(path.join(runDir(), 'archive.dump'))).toBe(false);
    expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(false);
  });
  it('stops immediately after lease loss during dumping, retaining a failure journal without more processes', async () => {
    exec.mockImplementation(((binary: any, args: any) => {
      const response = processResponse(binary, args);
      if (binary === PG_BINARIES.dump) assertHeld.mockImplementation(() => {throw new Error('lease lost');});
      return response;
    }) as any);
    await expect(driver().capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(exec).toHaveBeenCalledTimes(2); expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(true);
  });
  it('retains a partially written archive and failure journal when a later insert/fsync fails', async () => {
    vi.mocked(fs.writeFileSync).mockImplementation(((fd: number, bytes: any) => {
      const name = handles.get(fd)!.name;
      if (name.endsWith('toc.dat')) throw new Error('ENOSPC private path');
      get(name).bytes = Buffer.from(bytes);
    }) as any);
    await expect(driver().capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(get(path.join(runDir(), 'archive.dump')).bytes).toEqual(archive);
    expect(nodes.has(path.join(runDir(), 'toc.dat'))).toBe(true);
    expect(nodes.has(path.join(runDir(), '999-failed.json'))).toBe(true);
    expect(nodes.has(path.join(runDir(), '001-captured.json'))).toBe(false);
    expect(handles.size).toBe(0);
  });
  it('fails closed if journal durability cannot be confirmed, leaving existing attempt burned', async () => {
    vi.mocked(fs.fsyncSync).mockImplementation(() => {throw new Error('EIO');});
    const d = driver(); await expect(d.capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
    expect(nodes.has(runDir())).toBe(true); expect(exec).not.toHaveBeenCalled();
    await expect(d.capture(c, proof)).rejects.toThrow('PG_IO_CAPTURE_FAILED');
  });
  it('rejects concurrent use while authorization is pending', async () => {
    let done!: () => void; authorize.mockImplementation(() => new Promise<void>(resolve => {done = resolve;}));
    const d = driver(), first = d.capture(c, proof);
    await expect(d.capture(c, proof)).rejects.toThrow('PG_IO_BUSY');
    done(); await first; expect(authorize).toHaveBeenCalledTimes(1);
  });
  it.each(['relative-root', 'wrong-root-name', 'profile', 'dataset', 'purpose', 'database-id', 'extra'])('rejects unsafe config without IO: %s', mode => {
    const bad: any = {...o};
    if (mode === 'relative-root') bad.root = 'relative';
    if (mode === 'wrong-root-name') bad.root = path.dirname(o.root);
    if (mode === 'profile') bad.profile = 'REAL';
    if (mode === 'dataset') bad.datasetClass = 'CUSTOMER';
    if (mode === 'purpose') bad.purpose = 'CURRENT_INSTALLATION';
    if (mode === 'database-id') bad.databaseId = 'dbname=customer sslmode=disable';
    if (mode === 'extra') bad.args = ['--clean'];
    expect(() => driver(bad)).toThrow(); expect(exec).not.toHaveBeenCalled(); expect(fs.lstatSync).not.toHaveBeenCalled();
  });
  it('accepts an explicitly marked synthetic copy and still provides no restore or owner-verification method', async () => {
    o.purpose = 'MARKED_SYNTHETIC_COPY'; marker.purpose = o.purpose;
    get(path.join(o.root, PG_IO_MARKER)).bytes = Buffer.from(canonical(marker));
    const d = driver(); await d.capture(c, proof);
    expect((d as any).restore).toBeUndefined(); expect((d as any).verify).toBeUndefined(); expect((d as any).inventory).toBeUndefined();
  });
});
