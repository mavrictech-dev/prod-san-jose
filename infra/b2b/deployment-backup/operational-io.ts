/** Native IO restricted to private, explicitly provisioned SYNTHETIC Linux roots. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import childProcess from 'node:child_process';
import {TextDecoder, inspect} from 'node:util';
import {PROFILE, type Context} from './ports';
import {BackupError, LIMITS, UUID, canonical, equal, requireThat} from './model';
export const OPERATIONAL_ROOT_VERSION = 'factuez.synthetic-operational-root.v1';
export const OPERATIONAL_MARKER = 'operational-root.json';
export const NATIVE = Object.freeze({
  initdb: '/usr/lib/postgresql/16/bin/initdb', ctl: '/usr/lib/postgresql/16/bin/pg_ctl',
  createdb: '/usr/lib/postgresql/16/bin/createdb', psql: '/usr/lib/postgresql/16/bin/psql',
  restore: '/usr/lib/postgresql/16/bin/pg_restore',
  redis: '/usr/bin/redis-server', cli: '/usr/bin/redis-cli', check: '/usr/bin/redis-check-rdb',
});
export const ioCheck: (ok: unknown, code: string) => asserts ok = (ok, code) => requireThat(ok, 'OPERATIONAL_' + code);
export function utf8(bytes: Buffer): string {
  ioCheck(Buffer.isBuffer(bytes) && bytes.length <= LIMITS.raw, 'TEXT');
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  ioCheck(!text.includes('\0'), 'NUL'); return text;
}
export function native(binary: string, args: string[], cwd: string, input?: Buffer, secret?: Buffer): Buffer {
  ioCheck(Object.values(NATIVE).some(candidate => candidate === binary), 'BINARY');
  const env: NodeJS.ProcessEnv = {LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', HOME: cwd,
    PGPASSFILE: '/dev/null', PGSERVICEFILE: '/dev/null', PGSYSCONFDIR: cwd,
    PGCONNECT_TIMEOUT: '5', PGAPPNAME: 'factuez-synthetic-new-target', PGCLIENTENCODING: 'UTF8',
    PGREQUIREPEER: 'factuez_synthetic_backup', REDISCLI_HISTFILE: '/dev/null', REDISCLI_RCFILE: '/dev/null'};
  try {
    if (secret) {
      ioCheck(Buffer.isBuffer(secret) && /^[a-f0-9]{64}$/.test(utf8(secret)), 'REDIS_CREDENTIAL');
      env.REDISCLI_AUTH = secret.toString('ascii');
    }
    const result = childProcess.execFileSync(binary, args, {cwd, env, input, encoding: 'buffer', shell: false,
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 45000, killSignal: 'SIGKILL', maxBuffer: LIMITS.raw, windowsHide: true});
    ioCheck(Buffer.isBuffer(result) && result.length <= LIMITS.raw, 'OUTPUT'); return Buffer.from(result);
  } catch {throw new BackupError('OPERATIONAL_PROCESS_FAILED');}
  finally {delete env.REDISCLI_AUTH;}
}
interface Id {dev: bigint; ino: bigint}
function id(s: fs.BigIntStats): Id {return {dev: s.dev, ino: s.ino};}
function same(a: Id, b: Id) {return a.dev === b.dev && a.ino === b.ino;}
function dir(name: string, owned: boolean): fs.BigIntStats {
  const s = fs.lstatSync(name, {bigint: true});
  ioCheck(s.isDirectory() && !s.isSymbolicLink() && s.dev > 0n && s.ino > 0n && fs.realpathSync.native(name) === name, 'DIRECTORY');
  if (owned) ioCheck(s.uid === BigInt(process.getuid!()) && (s.mode & 0o077n) === 0n, 'PRIVATE_DIRECTORY');
  else ioCheck((s.mode & 0o022n) === 0n || (s.uid === 0n && (s.mode & 0o1000n) !== 0n), 'ANCESTRY');
  return s;
}
export function syncDir(name: string) {
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
}
export function readPrivate(name: string, max = LIMITS.dump): Buffer {
  const s = fs.lstatSync(name, {bigint: true});
  ioCheck(s.isFile() && !s.isSymbolicLink() && s.nlink === 1n && s.uid === BigInt(process.getuid!()) &&
    (s.mode & 0o077n) === 0n && s.size > 0n && s.size <= BigInt(max), 'PRIVATE_FILE');
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const initial = fs.fstatSync(fd, {bigint: true}); ioCheck(same(id(s), id(initial)), 'FILE_IDENTITY');
    const bytes = Buffer.alloc(Number(s.size) + 1); let count = 0;
    while (count < bytes.length) {const n = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n;}
    for (const st of [fs.fstatSync(fd, {bigint: true}), fs.lstatSync(name, {bigint: true})])
      ioCheck(same(id(s), id(st)) && s.size === st.size && s.mtimeNs === st.mtimeNs && s.ctimeNs === st.ctimeNs, 'FILE_CHANGED');
    ioCheck(count === Number(s.size), 'FILE_LENGTH'); return bytes.subarray(0, count);
  } finally {fs.closeSync(fd);}
}
export function insertExclusive(name: string, bytes: Buffer | string) {
  const fd = fs.openSync(name, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  syncDir(path.posix.dirname(name));
}
export interface OperationalRootOptions {
  root: string; rootId: string; deploymentId: string; kind: 'REDIS_SOURCE' | 'RESTORE_TARGET';
  profile: typeof PROFILE; environment: 'BETA'; datasetClass: 'SYNTHETIC'; purpose: 'NEW_SYNTHETIC' | 'MARKED_SYNTHETIC_COPY';
}
export class SyntheticWorkspace {
  #o: OperationalRootOptions; #id?: Id;
  constructor(o: OperationalRootOptions) {
    ioCheck(o && Object.keys(o).sort().join(',') === ['root', 'rootId', 'deploymentId', 'kind', 'profile', 'environment', 'datasetClass', 'purpose'].sort().join(','), 'OPTIONS');
    ioCheck(UUID.test(o.rootId) && UUID.test(o.deploymentId) && o.profile === PROFILE && o.environment === 'BETA' &&
      o.datasetClass === 'SYNTHETIC' && ['NEW_SYNTHETIC', 'MARKED_SYNTHETIC_COPY'].includes(o.purpose), 'PROFILE');
    ioCheck(['REDIS_SOURCE', 'RESTORE_TARGET'].includes(o.kind) && o.root ===
      (o.kind === 'RESTORE_TARGET' ? '/var/lib/fz-syn/' : '/var/lib/fz-rdb/') + o.rootId, 'ROOT');
    this.#o = {...o};
  }
  get root() {return this.#o.root;}
  marker() {const {root: _, ...rest} = this.#o; return {schemaVersion: OPERATIONAL_ROOT_VERSION, ...rest};}
  assert() {
    ioCheck(os.platform() === 'linux' && typeof process.getuid === 'function' && process.getuid() !== 0, 'LINUX_UID');
    let current = this.root;
    for (;;) {dir(current, current === this.root); const parent = path.posix.dirname(current); if (parent === current) break; current = parent;}
    const currentId = id(dir(this.root, true));
    if (this.#id) ioCheck(same(this.#id, currentId), 'ROOT_REPLACED');
    const text = utf8(readPrivate(this.root + '/' + OPERATIONAL_MARKER, 8192)), value = JSON.parse(text);
    equal(value, this.marker(), 'OPERATIONAL_MARKER'); ioCheck(text === canonical(value) || text === canonical(value) + '\n', 'CANONICAL_MARKER');
    this.#id = currentId;
  }
  claim(idValue: string, c: Context, kind: 'RDB_CAPTURE' | 'RESTORE', restoreId: string | null): WorkspaceAttempt {
    this.assert(); ioCheck(UUID.test(idValue), 'CLAIM_ID');
    const name = this.root + '/' + idValue;
    // No catch/reuse: a colliding or failed id remains burned on disk.
    fs.mkdirSync(name, {mode: 0o700});
    const attempt = new WorkspaceAttempt(this, name);
    syncDir(this.root);
    attempt.event({kind, context: c, restoreId, phase: 'QUARANTINED'});
    return attempt;
  }
  toJSON() {return {profile: PROFILE, access: 'EXCLUSIVE_SYNTHETIC_ONLY'};}
  [inspect.custom]() {return this.toJSON();}
}
export class WorkspaceAttempt {
  #workspace: SyntheticWorkspace; #name: string; #dirs = new Map<string, Id>(); #counter = 0;
  constructor(workspace: SyntheticWorkspace, name: string) {
    this.#workspace = workspace; this.#name = name; this.#dirs.set('', id(dir(name, true)));
  }
  get root() {return this.#name;}
  assert() {
    this.#workspace.assert();
    for (const [relative, expected] of this.#dirs) ioCheck(same(expected, id(dir(this.at(relative), true))), 'RESOURCE_REPLACED');
  }
  at(relative = '') {
    ioCheck(relative === '' || (relative.length <= 240 && relative.split('/').every(p => /^[a-z0-9][a-z0-9_.-]{0,119}$/.test(p) &&
      p !== '.' && p !== '..')), 'RELATIVE_PATH');
    return this.#name + (relative ? '/' + relative : '');
  }
  mkdir(relative: string) {
    this.assert(); const parent = path.posix.dirname(relative);
    ioCheck(this.#dirs.has(parent === '.' ? '' : parent), 'PARENT_NOT_OWNED');
    fs.mkdirSync(this.at(relative), {mode: 0o700}); this.#dirs.set(relative, id(dir(this.at(relative), true)));
    syncDir(path.posix.dirname(this.at(relative))); this.assert();
  }
  insert(relative: string, bytes: Buffer | string) {
    this.assert(); const parent = path.posix.dirname(relative);
    ioCheck(this.#dirs.has(parent === '.' ? '' : parent), 'PARENT_NOT_OWNED');
    insertExclusive(this.at(relative), bytes); this.assert();
  }
  event(metadata: unknown) {
    this.insert('j' + String(++this.#counter).padStart(6, '0') + '.json', canonical(metadata));
  }
  fail() {try {this.event({phase: 'FAILED_QUARANTINED'});} catch { /* No success on journal uncertainty. */ }}
  toJSON() {return {state: 'QUARANTINED', pathsRedacted: true};}
  [inspect.custom]() {return this.toJSON();}
}
