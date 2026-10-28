/**
 * Concrete PostgreSQL archive IO, deliberately NOT an OwnerPort/RestoreTargetPort.
 * Linux PG16 + dedicated synthetic Unix socket only. Nothing runs at import/construction.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import {inspect} from 'node:util';
import {TextDecoder} from 'node:util';
import {PROFILE, type Context, type LeaseProof, type OfflineLeasePort, type TiAuthorizationPort} from './ports';
import {BackupError, LIMITS, UUID, canonical, context, equal, record, requireThat, sha} from './model';

export const PG_IO_VERSION = 'factuez.b2b.synthetic-pg-archive-io.v1';
export const PG_IO_MARKER = 'synthetic-pg-root.json';
export const PG_BINARIES = Object.freeze({
  psql: '/usr/lib/postgresql/16/bin/psql',
  dump: '/usr/lib/postgresql/16/bin/pg_dump',
  restore: '/usr/lib/postgresql/16/bin/pg_restore',
});
const SOCKET = '/run/factuez-synthetic-postgresql';
const USER = 'factuez_synthetic_backup';
const PEER = 'factuez_synthetic_postgres';
export const PG_SOURCE_QUERY = "SELECT pg_catalog.json_build_object('database', pg_catalog.current_database(), " +
  "'serverVersion', pg_catalog.current_setting('server_version_num'), " +
  "'marker', (SELECT profile FROM factuez_backup.synthetic_profile))::text;";
export interface PgArchiveOptions {
  root: string; rootId: string; deploymentId: string; databaseId: string;
  profile: typeof PROFILE; environment: 'BETA'; datasetClass: 'SYNTHETIC';
  purpose: 'NEW_SYNTHETIC' | 'MARKED_SYNTHETIC_COPY';
}
export interface PgArchiveInspection {
  entries: {dumpId: number; catalogOid: string; objectOid: string; definition: string}[];
  /** Complete native schema extraction, not a claim of complete source/target inventory. */
  schemaSql: Buffer; toc: Buffer; scriptSha256: string; archiveSha256: string;
}
export interface PgArchiveCapture {
  archive: Buffer; inspection: PgArchiveInspection;
  receipt: {backupId: string; state: 'CAPTURED_QUARANTINED'; archiveSha256: string;
    ownerVerified: false; restored: false; backupAuthorized: false; globalUnmanagedWritersVerified: false};
}
function check(ok: unknown, code: string): asserts ok { requireThat(ok, 'PG_IO_' + code); }
function decode(bytes: Buffer): string {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= LIMITS.raw, 'TEXT_LIMIT');
  const value = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  check(!value.includes('\0'), 'TEXT_NUL'); return value;
}
/** Parses actual pg_restore --list syntax; it does not infer semantic coverage from object names. */
export function parsePgToc(bytes: Buffer): PgArchiveInspection['entries'] {
  try {
    const text = decode(bytes), lines = text.split(/\r?\n/), entries: PgArchiveInspection['entries'] = [];
    check(lines.some(l => /^;\s+Format: CUSTOM\s*$/.test(l)), 'TOC_FORMAT');
    check(lines.some(l => /^;\s+Dumped by pg_dump version: 16(?:\.[0-9]+)+(?: .*)?$/.test(l)), 'TOC_VERSION');
    const ids = new Set<number>();
    for (const line of lines) {
      if (!line.trim() || line.startsWith(';')) continue;
      const m = /^([1-9][0-9]{0,9}); ([0-9]{1,10}) ([0-9]{1,10}) ([^\r\n]+)$/.exec(line);
      check(m && +m[1] <= 2147483647 && BigInt(m[2]) <= 4294967295n && BigInt(m[3]) <= 4294967295n &&
        !ids.has(+m[1]) && entries.length < 16384, 'TOC_ENTRY');
      ids.add(+m[1]); entries.push({dumpId: +m[1], catalogOid: m[2], objectOid: m[3], definition: m[4]});
    }
    check(entries.length > 0, 'TOC_EMPTY'); return entries;
  } catch { throw new BackupError('PG_IO_TOC_INVALID'); }
}
function options(value: PgArchiveOptions): PgArchiveOptions {
  record(value, ['root', 'rootId', 'deploymentId', 'databaseId', 'profile', 'environment', 'datasetClass', 'purpose']);
  check([value.rootId, value.deploymentId, value.databaseId].every(v => typeof v === 'string' && UUID.test(v)), 'IDENTITY');
  check(value.profile === PROFILE && value.environment === 'BETA' && value.datasetClass === 'SYNTHETIC' &&
    ['NEW_SYNTHETIC', 'MARKED_SYNTHETIC_COPY'].includes(value.purpose), 'PROFILE');
  check(typeof value.root === 'string' && path.isAbsolute(value.root) && path.resolve(value.root) === value.root &&
    path.basename(value.root) === 'factuez-pg-io-' + value.rootId && !value.root.includes('\0') &&
    !value.root.startsWith('\\\\') && !/(^|[\\/])(proc|sys|dev|etc|boot|secrets?|vault)([\\/]|$)/i.test(value.root), 'ROOT');
  return {...value};
}
type NodeId = {dev: bigint; ino: bigint};
function nodeId(st: fs.BigIntStats): NodeId { return {dev: st.dev, ino: st.ino}; }
function sameId(a: NodeId, b: NodeId): boolean { return a.dev === b.dev && a.ino === b.ino; }
function directory(name: string, owned = false): fs.BigIntStats {
  const st = fs.lstatSync(name, {bigint: true});
  check(st.isDirectory() && !st.isSymbolicLink() && st.dev > 0n && st.ino > 0n &&
    fs.realpathSync.native(name) === name, 'DIRECTORY');
  if (owned) check(typeof process.getuid === 'function' && st.uid === BigInt(process.getuid()) &&
    (st.mode & 0o077n) === 0n, 'DIRECTORY_OWNER');
  return st;
}
function ancestry(name: string): void {
  let current = name;
  for (;;) {
    const st = directory(current);
    // Shared system tmp is allowed only with sticky bit; owned roots remain private.
    check((st.mode & 0o022n) === 0n || (st.uid === 0n && (st.mode & 0o1000n) !== 0n), 'ANCESTRY_WRITABLE');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function readMarker(root: string): Buffer {
  const name = path.join(root, PG_IO_MARKER), before = fs.lstatSync(name, {bigint: true});
  check(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n &&
    before.uid === BigInt(process.getuid!()) && (before.mode & 0o077n) === 0n &&
    before.size > 0n && before.size <= 8192n, 'MARKER_FILE');
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, {bigint: true});
    check(sameId(nodeId(before), nodeId(opened)) && opened.size === before.size, 'MARKER_CHANGED');
    const bytes = Buffer.alloc(Number(before.size) + 1); let count = 0;
    while (count < bytes.length) { const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    const after = fs.lstatSync(name, {bigint: true}), end = fs.fstatSync(fd, {bigint: true});
    check(count === Number(before.size) && sameId(nodeId(before), nodeId(after)) &&
      [after, end].every(st => sameId(nodeId(before), nodeId(st)) && st.size === before.size &&
        st.mtimeNs === before.mtimeNs && st.ctimeNs === before.ctimeNs), 'MARKER_CHANGED');
    return bytes.subarray(0, count);
  } finally {fs.closeSync(fd);}
}
function syncDirectory(name: string): void {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
function insertFile(name: string, bytes: Buffer | string): void {
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  syncDirectory(path.dirname(name));
}
export class SyntheticPostgresArchiveDriver {
  #options: PgArchiveOptions;
  #lease: OfflineLeasePort;
  #authorization: TiAuthorizationPort;
  #busy = false;
  constructor(config: PgArchiveOptions, ports: {lease: OfflineLeasePort; authorization: TiAuthorizationPort}) {
    this.#options = options(config);
    check(ports && typeof ports.lease?.assertHeld === 'function' && typeof ports.authorization?.authorize === 'function', 'PORTS');
    this.#lease = ports.lease; this.#authorization = ports.authorization;
  }
  toJSON() { return {profile: PROFILE, driver: 'PG16_ARCHIVE_IO', ownerVerified: false, restored: false, backupAuthorized: false}; }
  [inspect.custom]() {return this.toJSON();}
  private marker() {
    const {root: _, ...o} = this.#options;
    return {schemaVersion: PG_IO_VERSION, ...o, database: 'fz_synthetic_' + o.databaseId.replace(/-/g, '')};
  }
  private root(): NodeId {
    check(os.platform() === 'linux', 'PLATFORM');
    ancestry(this.#options.root); const st = directory(this.#options.root, true);
    const raw = readMarker(this.#options.root), text = decode(raw), value = JSON.parse(text);
    equal(value, this.marker(), 'PG_IO_ROOT_MARKER');
    check(text === canonical(value) || text === canonical(value) + '\n', 'MARKER_CANONICAL');
    return nodeId(st);
  }
  private assertRoot(id: NodeId) {check(sameId(id, this.root()), 'ROOT_CHANGED');}
  private run(binary: string, args: string[], cwd: string, input?: Buffer): Buffer {
    // Exact replacement environment. No PATH, loader hooks, PG URLs, credentials or caller options.
    const env = {LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', HOME: cwd,
      PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null', PGSYSCONFDIR: cwd,
      PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'factuez-synthetic-archive-io',
      PGREQUIREPEER: PEER, PGCLIENTENCODING: 'UTF8',
      PGOPTIONS: '-c default_transaction_read_only=on -c statement_timeout=30000 -c lock_timeout=5000 -c search_path=pg_catalog'};
    try {
      const result = childProcess.execFileSync(binary, args, {cwd, env, input,
        encoding: 'buffer', timeout: 45000, killSignal: 'SIGKILL', maxBuffer: LIMITS.raw,
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      check(Buffer.isBuffer(result) && result.length > 0 && result.length <= LIMITS.raw, 'PROCESS_OUTPUT');
      return Buffer.from(result);
    } catch {throw new BackupError('PG_IO_PROCESS_FAILED');}
  }
  private inspectArchive(archive: Buffer, cwd: string, guard: () => void): PgArchiveInspection {
    check(Buffer.isBuffer(archive) && archive.length >= 32 && archive.length <= LIMITS.dump &&
      archive.subarray(0, 5).toString('ascii') === 'PGDMP', 'ARCHIVE');
    guard(); const toc = this.run(PG_BINARIES.restore, ['--format=custom', '--list'], cwd, archive);
    guard(); const entries = parsePgToc(toc);
    const schemaSql = this.run(PG_BINARIES.restore, ['--format=custom', '--schema-only', '--file=-'], cwd, archive);
    guard(); decode(schemaSql);
    // Consume every data block too; --list alone does not validate truncated data.
    const script = this.run(PG_BINARIES.restore, ['--format=custom', '--file=-'], cwd, archive);
    try {guard(); decode(script); return {entries, toc, schemaSql, scriptSha256: sha(script), archiveSha256: sha(archive)};}
    finally {script.fill(0);}
  }
  /**
   * Appends an exclusive quarantined capture attempt. On any uncertainty no receipt is returned.
   * Does not implement semantic source inventory, role capture, target allocation or restoration.
   */
  async capture(input: Context, proof: LeaseProof): Promise<PgArchiveCapture> {
    check(!this.#busy, 'BUSY'); this.#busy = true;
    let runDir: string | undefined, rootId: NodeId | undefined, runId: NodeId | undefined;
    let archive: Buffer | undefined;
    try {
      const c = context(input); check(c.deploymentId === this.#options.deploymentId, 'DEPLOYMENT');
      await this.#authorization.authorize({operation: 'BACKUP', context: {...c}, restoreId: null});
      this.#lease.assertHeld(proof, c); rootId = this.root();
      const candidate = path.join(this.#options.root, c.backupId);
      // Exclusive, nonrecursive: an existing attempt is never attached, overwritten or deleted.
      fs.mkdirSync(candidate, {mode: 0o700}); runDir = candidate; runId = nodeId(directory(candidate, true));
      const guard = () => {
        this.#lease.assertHeld(proof, c); this.assertRoot(rootId!);
        check(sameId(runId!, nodeId(directory(candidate, true))), 'ATTEMPT_CHANGED');
      };
      guard(); syncDirectory(this.#options.root);
      insertFile(path.join(candidate, '000-quarantine.json'), canonical({schemaVersion: PG_IO_VERSION,
        context: c, state: 'QUARANTINED', restored: false}));
      const connection = ['--host=' + SOCKET, '--port=55439', '--username=' + USER,
        '--dbname=' + this.marker().database, '--no-password'];
      const source = () => {
        guard();
        const raw = this.run(PG_BINARIES.psql, [...connection, '--no-psqlrc', '--no-align', '--tuples-only',
          '--quiet', '--set=ON_ERROR_STOP=1', '--command=' + PG_SOURCE_QUERY], candidate);
        const value = JSON.parse(decode(raw)); record(value, ['database', 'serverVersion', 'marker']);
        check(value.database === this.marker().database && typeof value.serverVersion === 'string' &&
          /^16[0-9]{4}$/.test(value.serverVersion), 'SOURCE_VERSION');
        equal(value.marker, this.marker(), 'PG_IO_DATABASE_MARKER'); guard();
      };
      source();
      archive = this.run(PG_BINARIES.dump, [...connection, '--format=custom', '--compress=0',
        '--quote-all-identifiers', '--lock-wait-timeout=5000'], candidate);
      guard(); const inspection = this.inspectArchive(archive, candidate, guard);
      source(); guard();
      insertFile(path.join(candidate, 'archive.dump'), archive); guard();
      insertFile(path.join(candidate, 'toc.dat'), inspection.toc); guard();
      insertFile(path.join(candidate, 'schema.dat'), inspection.schemaSql); guard();
      const receipt: PgArchiveCapture['receipt'] = {backupId: c.backupId, state: 'CAPTURED_QUARANTINED',
        archiveSha256: inspection.archiveSha256, ownerVerified: false, restored: false,
        backupAuthorized: false, globalUnmanagedWritersVerified: false};
      insertFile(path.join(candidate, '001-captured.json'), canonical({schemaVersion: PG_IO_VERSION, ...receipt,
        tocSha256: sha(inspection.toc), schemaSha256: sha(inspection.schemaSql), scriptSha256: inspection.scriptSha256}));
      guard(); return {archive: Buffer.from(archive), inspection, receipt};
    } catch {
      // Retain partial files and the initial quarantine record. Never follow a changed root to journal a failure.
      if (runDir && rootId && runId) {
        try {
          this.assertRoot(rootId);
          check(sameId(runId, nodeId(directory(runDir, true))), 'ATTEMPT_CHANGED');
          insertFile(path.join(runDir, '999-failed.json'), canonical({schemaVersion: PG_IO_VERSION, state: 'FAILED_QUARANTINED'}));
        } catch { /* A missing failure record is uncertain, never successful. External reconciliation required. */ }
      }
      throw new BackupError('PG_IO_CAPTURE_FAILED');
    } finally {archive?.fill(0); this.#busy = false;}
  }
}
