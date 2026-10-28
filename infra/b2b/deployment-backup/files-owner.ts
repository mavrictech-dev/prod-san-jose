import fs from 'node:fs';
import * as path from 'node:path';
import childProcess from 'node:child_process';
import {inflateRawSync} from 'node:zlib';
import {TextDecoder} from 'node:util';
import {BackupError, LIMITS, UUID, canonical, equal, inventory, list, portablePath, record,
  requireThat, sha, snapshot as normalizeSnapshot} from './model';
import {PROFILE, type FileEntry, type Inventory, type OwnerPort, type OwnerSnapshot} from './ports';

export const FILES_ROOT_MARKER = 'root-profile.json';
export const FILES_SNAPSHOT_METADATA = 'backup-metadata/filesystem.json';
export const FILES_ROOT_VERSION = 'factuez.b2b.deployment-files-root.v1';
const SNAPSHOT_VERSION = 'factuez.b2b.deployment-files-snapshot.v1';
const MAX_NODES = LIMITS.files * 8;
const decimal = /^(0|[1-9][0-9]*)$/;
const digest = /^[a-f0-9]{64}$/;
const sensitive = /(^|[-_.\/])(vault|passwords?|passphrases?|secrets?|credentials?|private|certificates?|certs?|p12|pfx|pkcs12|pem|keystores?|keyrings?|keys?|tokens?)([-_.\/]|$)/i;
const sensitiveField = /password|passphrase|clientsecret|privatekey|secret|credentials|token|vault|apikey|authorization|cookie|pkcs12/i;
const linuxFormats: Readonly<Record<string, bigint>> = {ext4: 0xef53n, xfs: 0x58465342n, btrfs: 0x9123683en, tmpfs: 0x01021994n, overlay: 0x794c7630n};
export interface SyntheticFilesOwnerOptions {
  owner: 'FILES' | 'ARTIFACTS'; root: string; rootId: string; deploymentId: string;
  profile: typeof PROFILE; environment: 'BETA'; datasetClass: 'SYNTHETIC';
  purpose: 'NEW_SYNTHETIC' | 'MARKED_SYNTHETIC_COPY';
}
export type SyntheticFilesRootMarker = Omit<SyntheticFilesOwnerOptions, 'root'> & {
  schemaVersion: typeof FILES_ROOT_VERSION; epoch: string;
};
const statKeys = ['device', 'inode', 'mode', 'uid', 'gid', 'links', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs'] as const;
type Identity = Record<typeof statKeys[number], string>;
interface NodeEntry {path: string; kind: 'DIRECTORY' | 'FILE'; identity: Identity}
interface Disk {
  platform: 'win32' | 'linux'; device: string; format: string; id: string; mountSha256: string;
  nativeType: string; blockSize: string; blocks: string;
}
interface Manifest {
  schemaVersion: typeof SNAPSHOT_VERSION; rootPathSha256: string; marker: SyntheticFilesRootMarker;
  nodes: NodeEntry[]; disk: Disk; files: FileEntry[];
}
function check(ok: unknown, code: string): asserts ok { requireThat(ok, 'FILES_' + code); }
function config(value: SyntheticFilesOwnerOptions): SyntheticFilesOwnerOptions {
  record(value, ['owner', 'root', 'rootId', 'deploymentId', 'profile', 'environment', 'datasetClass', 'purpose']);
  check(value.owner === 'FILES' || value.owner === 'ARTIFACTS', 'OWNER');
  check(value.profile === PROFILE && value.environment === 'BETA' && value.datasetClass === 'SYNTHETIC' &&
    ['NEW_SYNTHETIC', 'MARKED_SYNTHETIC_COPY'].includes(value.purpose), 'PROFILE');
  check(typeof value.rootId === 'string' && UUID.test(value.rootId) && typeof value.deploymentId === 'string' && UUID.test(value.deploymentId), 'UUID');
  check(typeof value.root === 'string' && path.isAbsolute(value.root) && path.resolve(value.root) === value.root &&
    !value.root.startsWith('\\\\') && !value.root.includes('\0') &&
    path.basename(value.root) === 'factuez-deployment-backup-files-' + value.rootId, 'ROOT');
  const portableRoot = value.root.replace(/\\/g, '/');
  check(!sensitive.test(portableRoot) && !/^\/(?:proc|sys|dev|etc|boot)(?:\/|$)/i.test(portableRoot) &&
    !/^[a-z]:\/(?:windows|program files(?: \(x86\))?|programdata|system volume information|\$recycle\.bin)(?:\/|$)/i.test(portableRoot), 'UNSAFE_ROOT');
  return {...value};
}
function json(bytes: Buffer): any {
  const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  const value = JSON.parse(text);
  check(text === canonical(value) || text === canonical(value) + '\n', 'CANONICAL_METADATA');
  return value;
}
function marker(value: SyntheticFilesRootMarker, c: SyntheticFilesOwnerOptions): void {
  record(value, ['owner', 'rootId', 'deploymentId', 'profile', 'environment', 'datasetClass', 'purpose', 'schemaVersion', 'epoch']);
  const {root: _root, ...expected} = c;
  const {schemaVersion, epoch, ...actual} = value;
  equal(actual, expected, 'FILES_MARKER_PROFILE');
  check(schemaVersion === FILES_ROOT_VERSION && typeof epoch === 'string' && /^[1-9][0-9]{0,18}$/.test(epoch) &&
    BigInt(epoch) <= 9223372036854775807n, 'MARKER_EPOCH');
}
function identity(st: fs.BigIntStats): Identity {
  check(!st.isSymbolicLink() && (st.isFile() || st.isDirectory()), 'NODE_TYPE');
  check(st.dev > 0n && st.ino > 0n && st.mtimeNs > 0n && st.ctimeNs > 0n, 'UNKNOWN_IDENTITY');
  check(!st.isFile() || st.nlink === 1n, 'HARDLINK');
  return {device: String(st.dev), inode: String(st.ino), mode: String(st.mode), uid: String(st.uid), gid: String(st.gid),
    links: String(st.nlink), size: String(st.size), mtimeNs: String(st.mtimeNs), ctimeNs: String(st.ctimeNs), birthtimeNs: String(st.birthtimeNs)};
}
function ancestry(root: string): void {
  let current = root;
  for (;;) {
    check(fs.lstatSync(current).isDirectory() && !fs.lstatSync(current).isSymbolicLink(), 'ROOT_ANCESTRY');
    check(fs.realpathSync.native(current) === current, 'ROOT_REALPATH');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
function logical(name: string, directory = false): void {
  portablePath(directory ? name + '/probe.dat' : name);
  check(!sensitive.test(name) && name.split('/')[0] !== 'backup-metadata', 'SENSITIVE_PATH');
}
function tree(root: string): NodeEntry[] {
  const entries: NodeEntry[] = [], seen = new Set<string>(); let bytes = 0, files = 0;
  const visit = (name: string) => {
    check(entries.length < MAX_NODES, 'NODE_LIMIT');
    const absolute = name ? path.join(root, ...name.split('/')) : root;
    const st = fs.lstatSync(absolute, {bigint: true}); const id = identity(st);
    check(fs.realpathSync.native(absolute) === absolute, 'REALPATH');
    if (entries.length) check(id.device === entries[0].identity.device, 'NESTED_DISK');
    const key = id.device + ':' + id.inode; check(!seen.has(key), 'DUPLICATE_IDENTITY'); seen.add(key);
    if (name) logical(name, st.isDirectory());
    if (st.isFile()) {
      check(st.size > 0n && st.size <= BigInt(LIMITS.file), 'FILE_LIMIT');
      bytes += Number(st.size); files++;
      check(files + 1 <= LIMITS.files && bytes <= LIMITS.raw, 'BACKUP_LIMIT');
    }
    entries.push({path: name, kind: st.isDirectory() ? 'DIRECTORY' : 'FILE', identity: id});
    if (st.isDirectory()) for (const child of fs.readdirSync(absolute).sort()) visit(name ? name + '/' + child : child);
  };
  visit(''); check(entries.some(e => e.path === FILES_ROOT_MARKER && e.kind === 'FILE'), 'MARKER_MISSING');
  return entries;
}
function read(root: string, node: NodeEntry): Buffer {
  ancestry(root); const absolute = path.join(root, ...node.path.split('/'));
  equal(identity(fs.lstatSync(absolute, {bigint: true})), node.identity, 'FILES_CHANGED');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    equal(identity(fs.fstatSync(fd, {bigint: true})), node.identity, 'FILES_CHANGED');
    const result = Buffer.alloc(Number(node.identity.size) + 1); let length = 0;
    while (length < result.length) { const n = fs.readSync(fd, result, length, result.length - length, null); if (!n) break; length += n; }
    check(length === Number(node.identity.size), 'READ_SIZE');
    equal(identity(fs.fstatSync(fd, {bigint: true})), node.identity, 'FILES_CHANGED');
    equal(identity(fs.lstatSync(absolute, {bigint: true})), node.identity, 'FILES_CHANGED');
    ancestry(root); return result.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
// Only metadata queries. Input is JSON on stdin; no interpolation into shell code and no scripts on disk.
const windowsMetadata = `
$ErrorActionPreference='Stop'; if ($PSVersionTable.PSVersion -lt [version]'7.2') {throw 'Version'}
$inputMetadata = [Console]::In.ReadToEnd() | ConvertFrom-Json
$volumes = @(Get-Volume -FilePath $inputMetadata.root -ErrorAction Stop)
if ($volumes.Count -ne 1) {throw 'Volume'}; $v=$volumes[0]
if ([string]$v.DriveType -ne 'Fixed' -or [string]$v.HealthStatus -ne 'Healthy') {throw 'Unknown disk'}
foreach ($p in $inputMetadata.paths) {
  foreach ($s in @(Get-Item -LiteralPath $p -Stream * -ErrorAction Stop)) {
    if ($s.Stream -ne ':$DATA' -and $s.Stream -ne '::$DATA') {throw 'Alternate stream'}
  }
}
@{format=[string]$v.FileSystemType;id=[string]$v.UniqueId;mount=[string]$v.Path} | ConvertTo-Json -Compress
`;
function disk(root: string, nodes: NodeEntry[]): Disk {
  const st = fs.statfsSync(root, {bigint: true});
  check(st.bsize > 0n && st.blocks > 0n && st.type >= 0n, 'UNKNOWN_DISK');
  const common = {device: nodes[0].identity.device, nativeType: String(st.type), blockSize: String(st.bsize), blocks: String(st.blocks)};
  if (process.platform === 'win32') {
    const raw = childProcess.execFileSync('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsMetadata, 'utf16le').toString('base64')], {
      input: canonical({root, paths: nodes.map(n => n.path ? path.join(root, ...n.path.split('/')) : root)}), encoding: 'utf8',
      timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const value = JSON.parse(raw.trim()); record(value, ['format', 'id', 'mount']);
    check(['NTFS', 'ReFS'].includes(value.format) && typeof value.id === 'string' &&
      /^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\$/i.test(value.id) && typeof value.mount === 'string' && value.mount.length > 0, 'UNKNOWN_DISK');
    return {...common, platform: 'win32', format: value.format, id: value.id, mountSha256: sha(value.mount)};
  }
  check(process.platform === 'linux', 'UNSUPPORTED_PLATFORM');
  const raw = childProcess.execFileSync('findmnt', ['--json', '--list', '--submounts', '--target', root, '--output', 'TARGET,SOURCE,FSTYPE'],
    {encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  const mounts = JSON.parse(raw).filesystems;
  check(Array.isArray(mounts) && mounts.length > 0, 'UNKNOWN_DISK');
  for (const m of mounts) check(typeof m.target === 'string' && typeof m.source === 'string' && typeof m.fstype === 'string', 'UNKNOWN_DISK');
  const contains = (parent: string, child: string) => child === parent || child.startsWith(parent === '/' ? '/' : parent + '/');
  check(!mounts.some((m: any) => m.target !== root && contains(root, m.target)), 'NESTED_MOUNT');
  const selected = mounts.filter((m: any) => contains(m.target, root)).sort((a: any, b: any) => b.target.length - a.target.length)[0];
  check(selected && Object.hasOwn(linuxFormats, selected.fstype) && linuxFormats[selected.fstype] === st.type && selected.source.length > 0, 'UNKNOWN_DISK');
  return {...common, platform: 'linux', format: selected.fstype, id: sha(selected.source), mountSha256: sha(selected.target)};
}
function text(bytes: Buffer): string { return new TextDecoder('utf-8', {fatal: true}).decode(bytes); }
function inspectJson(value: unknown, depth = 0, budget = {n: 0}): void {
  check(depth <= 32 && ++budget.n <= LIMITS.tables * 512, 'CONTENT_LIMIT');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    check(!sensitiveField.test(key.replace(/[-_]/g, '')), 'PRIVATE_FIELD'); inspectJson(child, depth + 1, budget);
  }
}
const crcTable = Array.from({length: 256}, (_, n) => { let c = n; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); return c >>> 0; });
function crc32(bytes: Buffer): number { let c = 0xffffffff; for (const b of bytes) c = (c >>> 8) ^ crcTable[(c ^ b) & 255]; return (c ^ 0xffffffff) >>> 0; }
interface ExpansionBudget {bytes: number; members: number}
function zip(bytes: Buffer, budget: ExpansionBudget): void {
  // Strict subset: single disk, no ZIP64, comments, descriptors, extras, directories or nested archives.
  check(bytes.length >= 22, 'ZIP'); const end = bytes.length - 22;
  check(bytes.readUInt32LE(end) === 0x06054b50 && bytes.readUInt16LE(end + 20) === 0 &&
    bytes.readUInt16LE(end + 4) === 0 && bytes.readUInt16LE(end + 6) === 0, 'ZIP');
  const count = bytes.readUInt16LE(end + 10), central = bytes.readUInt32LE(end + 16);
  check(count > 0 && count <= LIMITS.files && bytes.readUInt16LE(end + 8) === count &&
    central + bytes.readUInt32LE(end + 12) === end, 'ZIP');
  let cursor = central, localEnd = 0, total = 0; const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    check(cursor + 46 <= end && bytes.readUInt32LE(cursor) === 0x02014b50, 'ZIP');
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16);
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), n = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32), offset = bytes.readUInt32LE(cursor + 42);
    check((flags === 0 || flags === 0x800) && (method === 0 || method === 8) && extra === 0 && comment === 0 &&
      bytes.readUInt16LE(cursor + 34) === 0 && cursor + 46 + n <= end && size > 0 && size <= LIMITS.file && offset === localEnd, 'ZIP');
    const name = text(bytes.subarray(cursor + 46, cursor + 46 + n)); logical(name);
    check(!seen.has(name) && !name.endsWith('.zip'), 'ZIP_MEMBERS'); seen.add(name);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    check((mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000, 'ZIP_LINK');
    check(offset + 30 + n <= central && bytes.readUInt32LE(offset) === 0x04034b50 &&
      bytes.readUInt16LE(offset + 6) === flags && bytes.readUInt16LE(offset + 8) === method &&
      bytes.readUInt32LE(offset + 14) === crc && bytes.readUInt32LE(offset + 18) === compressed && bytes.readUInt32LE(offset + 22) === size &&
      bytes.readUInt16LE(offset + 26) === n && bytes.readUInt16LE(offset + 28) === 0 &&
      bytes.subarray(offset + 30, offset + 30 + n).equals(bytes.subarray(cursor + 46, cursor + 46 + n)), 'ZIP');
    localEnd = offset + 30 + n + compressed;
    check(localEnd <= central && (total += size) <= LIMITS.raw && (budget.bytes += size) <= LIMITS.raw && ++budget.members <= LIMITS.files, 'ZIP_LIMIT');
    const encoded = bytes.subarray(offset + 30 + n, localEnd);
    const decoded = method === 0 ? encoded : inflateRawSync(encoded, {maxOutputLength: LIMITS.file});
    check(decoded.length === size && crc32(decoded) === crc, 'ZIP_CRC'); content(name, decoded, budget);
    cursor += 46 + n;
  }
  check(cursor === end && localEnd === central, 'ZIP_COVERAGE');
  for (const name of seen) check(![...seen].some(other => other.startsWith(name + '/')), 'ZIP_MEMBERS');
}
function content(name: string, bytes: Buffer, budget: ExpansionBudget): void {
  check(bytes.length > 0 && bytes.length <= LIMITS.file, 'FILE_LIMIT');
  const raw = bytes.toString('utf8');
  check(!/-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)-----|PuTTY-User-Key-File|ssh-(?:rsa|ed25519)\s/i.test(raw), 'PRIVATE_MATERIAL');
  // Opaque ASN.1/PFX and arbitrary DAT blobs cannot be identified as safe application data.
  check(!(bytes[0] === 0x30 && (bytes[1] === 0x80 || (bytes[1] & 0x80) !== 0)), 'OPAQUE_MATERIAL');
  check(!/\b(?:password|passphrase|private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[=:]\s*["']?[^\s"'<>]/i.test(raw), 'PRIVATE_MATERIAL');
  if (name.endsWith('.zip')) { zip(bytes, budget); return; }
  if (name.endsWith('.pdf')) { check(bytes.subarray(0, 5).toString() === '%PDF-', 'PDF'); return; }
  const utf8 = text(bytes);
  if (name.endsWith('.json')) inspectJson(JSON.parse(utf8));
  else if (name.endsWith('.jsonl') || name.endsWith('.ndjson')) {
    const budget = {n: 0}; for (const line of utf8.trimEnd().split('\n')) inspectJson(JSON.parse(line), 0, budget);
  } else if (name.endsWith('.xml')) {
    check(utf8.trimStart().startsWith('<') && !/<!DOCTYPE|<!ENTITY/i.test(utf8), 'XML');
    check(!/<\/?(?:[a-z0-9_-]+:)?(?:password|passphrase|privatekey|clientsecret|secret|credentials|token|vault)\b/i.test(utf8), 'PRIVATE_FIELD');
  } else if (name.endsWith('.csv')) {
    check(!utf8.split(/\r?\n/, 1)[0].split(',').some(k => sensitiveField.test(k.replace(/["\s_-]/g, ''))), 'PRIVATE_FIELD');
  } else check(name.endsWith('.dat') && utf8.startsWith('FACTUEZ_SYNTHETIC_FILE_V1\n'), 'OPAQUE_DAT');
}
function validateManifest(m: Manifest, c: SyntheticFilesOwnerOptions): void {
  record(m, ['schemaVersion', 'rootPathSha256', 'marker', 'nodes', 'disk', 'files']);
  check(m.schemaVersion === SNAPSHOT_VERSION && m.rootPathSha256 === sha(c.root), 'MANIFEST_PROFILE'); marker(m.marker, c);
  list(m.nodes, MAX_NODES, 2); list(m.files, LIMITS.files - 1, 1);
  const seen = new Map<string, NodeEntry>(), identities = new Set<string>();
  for (const n of m.nodes) {
    record(n, ['path', 'kind', 'identity']); record(n.identity, [...statKeys]);
    check(typeof n.path === 'string' && (n.kind === 'DIRECTORY' || n.kind === 'FILE') && !seen.has(n.path), 'MANIFEST_NODES');
    if (n.path) { logical(n.path, n.kind === 'DIRECTORY'); const p = path.posix.dirname(n.path); check(seen.get(p === '.' ? '' : p)?.kind === 'DIRECTORY', 'MANIFEST_PARENT'); }
    else check(seen.size === 0 && n.kind === 'DIRECTORY', 'MANIFEST_ROOT');
    check(statKeys.every(k => typeof n.identity[k] === 'string' && decimal.test(n.identity[k]) && n.identity[k].length <= 30), 'MANIFEST_IDENTITY');
    check(BigInt(n.identity.device) > 0n && BigInt(n.identity.inode) > 0n && BigInt(n.identity.mtimeNs) > 0n && BigInt(n.identity.ctimeNs) > 0n &&
      n.identity.device === m.nodes[0].identity.device, 'MANIFEST_IDENTITY');
    const mode = Number(BigInt(n.identity.mode) & 0xf000n);
    check(mode === (n.kind === 'FILE' ? 0x8000 : 0x4000) && (n.kind !== 'FILE' || n.identity.links === '1'), 'MANIFEST_IDENTITY');
    const id = n.identity.device + ':' + n.identity.inode; check(!identities.has(id), 'MANIFEST_IDENTITY'); identities.add(id); seen.set(n.path, n);
  }
  record(m.disk, ['platform', 'device', 'format', 'id', 'mountSha256', 'nativeType', 'blockSize', 'blocks']);
  check(m.disk.device === m.nodes[0].identity.device && digest.test(m.disk.mountSha256) &&
    ['nativeType', 'blockSize', 'blocks'].every(k => typeof (m.disk as any)[k] === 'string' && (m.disk as any)[k].length <= 30 && decimal.test((m.disk as any)[k])) &&
    BigInt(m.disk.blockSize) > 0n && BigInt(m.disk.blocks) > 0n, 'MANIFEST_DISK');
  check((m.disk.platform === 'win32' && ['NTFS', 'ReFS'].includes(m.disk.format) && /^\\\\\?\\Volume\{[a-f0-9-]{36}\}\\$/i.test(m.disk.id)) ||
    (m.disk.platform === 'linux' && Object.hasOwn(linuxFormats, m.disk.format) && linuxFormats[m.disk.format] === BigInt(m.disk.nativeType) && digest.test(m.disk.id)), 'MANIFEST_DISK');
  const files = m.nodes.filter(n => n.kind === 'FILE'); check(files.length === m.files.length, 'MANIFEST_COVERAGE');
  const paths = new Set<string>(); let total = Buffer.byteLength(canonical(m));
  for (const f of m.files) {
    record(f, ['path', 'size', 'sha256']); const node = seen.get(f.path);
    check(node?.kind === 'FILE' && typeof f.size === 'number' && Number.isSafeInteger(f.size) && f.size > 0 && f.size <= LIMITS.file &&
      String(f.size) === node.identity.size && typeof f.sha256 === 'string' && digest.test(f.sha256) && !paths.has(f.path), 'MANIFEST_COVERAGE');
    paths.add(f.path); total += f.size;
  }
  check(paths.has(FILES_ROOT_MARKER) && total <= LIMITS.raw && Buffer.byteLength(canonical(m)) <= LIMITS.file, 'BACKUP_LIMIT');
}
function receipt(m: Manifest, c: SyntheticFilesOwnerOptions): Inventory {
  validateManifest(m, c);
  const metadata = Buffer.from(canonical(m));
  const files = [...m.files, {path: FILES_SNAPSHOT_METADATA, size: metadata.length, sha256: sha(metadata)}];
  const schema = {profile: m.marker, disk: m.disk, layout: m.nodes.map(n => ({path: n.path, kind: n.kind,
    mode: n.identity.mode, uid: n.identity.uid, gid: n.identity.gid}))};
  return inventory({owner: c.owner, profile: PROFILE, schemaSha256: sha(canonical(schema)),
    state: {count: m.nodes.length, sha256: sha(canonical(m))}, tables: [], sequences: [], files,
    checkpoints: [ {name: 'RootProfile', sha256: sha(canonical(m.marker))}, {name: 'Filesystem', sha256: sha(canonical({disk: m.disk, nodes: m.nodes}))},
      {name: 'WriterEpoch', sha256: sha(m.marker.epoch)}, {name: 'Manifest', sha256: sha(metadata)} ]});
}

/** Read-only owner for explicitly provisioned synthetic roots. Does not establish a global offline lease. */
export class SyntheticFilesOwner implements OwnerPort {
  readonly #config: SyntheticFilesOwnerOptions;
  #baseline?: Manifest; #epoch = 0n; #busy = false;
  constructor(options: SyntheticFilesOwnerOptions) { this.#config = config(options); }
  get owner(): 'FILES' | 'ARTIFACTS' { return this.#config.owner; }
  private scan(retain: boolean): {manifest: Manifest; files: OwnerSnapshot['files']} {
    const c = this.#config; ancestry(c.root); const nodes = tree(c.root);
    if (this.#baseline) equal({device: nodes[0].identity.device, inode: nodes[0].identity.inode},
      {device: this.#baseline.nodes[0].identity.device, inode: this.#baseline.nodes[0].identity.inode}, 'FILES_ROOT_REPLACED');
    const markBytes = read(c.root, nodes.find(n => n.path === FILES_ROOT_MARKER)!);
    const profile = json(markBytes); marker(profile, c); check(BigInt(profile.epoch) >= this.#epoch, 'EPOCH_REGRESSION');
    const entries: FileEntry[] = [], payload: OwnerSnapshot['files'] = [], expansion = {bytes: 0, members: 0};
    for (const n of nodes.filter(n => n.kind === 'FILE')) {
      const bytes = n.path === FILES_ROOT_MARKER ? markBytes : read(c.root, n); content(n.path, bytes, expansion);
      entries.push({path: n.path, size: bytes.length, sha256: sha(bytes)});
      if (retain) payload.push({path: n.path, bytes}); else bytes.fill(0);
    }
    const physical = disk(c.root, nodes);
    equal(tree(c.root), nodes, 'FILES_TREE_CHANGED'); ancestry(c.root);
    // Recheck bytes as well as metadata, including changes during the disk query.
    for (const n of nodes.filter(n => n.kind === 'FILE')) {
      const bytes = read(c.root, n); check(sha(bytes) === entries.find(f => f.path === n.path)!.sha256, 'CONTENT_CHANGED'); bytes.fill(0);
    }
    equal(tree(c.root), nodes, 'FILES_TREE_CHANGED');
    const st = fs.statfsSync(c.root, {bigint: true});
    equal({nativeType: String(st.type), blockSize: String(st.bsize), blocks: String(st.blocks)},
      {nativeType: physical.nativeType, blockSize: physical.blockSize, blocks: physical.blocks}, 'FILES_DISK_CHANGED');
    const manifest: Manifest = {schemaVersion: SNAPSHOT_VERSION, rootPathSha256: sha(c.root), marker: profile, nodes, disk: physical, files: entries};
    validateManifest(manifest, c); return {manifest, files: payload};
  }
  private async guarded<T>(work: () => T): Promise<T> {
    check(!this.#busy, 'BUSY'); this.#busy = true;
    try { return work(); } catch (error) { throw error instanceof BackupError ? error : new BackupError('FILES_IO_OR_METADATA_REJECTED'); }
    finally { this.#busy = false; }
  }
  async inventory(): Promise<Inventory> {
    return this.guarded(() => { const {manifest} = this.scan(false); const inv = receipt(manifest, this.#config);
      this.#baseline = manifest; this.#epoch = BigInt(manifest.marker.epoch); return inv; });
  }
  async snapshot(): Promise<OwnerSnapshot> {
    return this.guarded(() => { check(this.#baseline, 'INVENTORY_REQUIRED'); const {manifest, files} = this.scan(true);
      equal(manifest, this.#baseline, 'FILES_INVENTORY_CHANGED');
      return normalizeSnapshot({inventory: receipt(manifest, this.#config), payload: {format: 'NONE', bytes: Buffer.alloc(0)},
        files: [...files, {path: FILES_SNAPSHOT_METADATA, bytes: Buffer.from(canonical(manifest))}]}); });
  }
  async verify(value: OwnerSnapshot): Promise<void> {
    // No source access and no writes. This verifies supplied bytes, not their external provenance/authorization.
    return this.guarded(() => { const s = normalizeSnapshot(value);
      check(s.inventory.owner === this.owner && s.payload.format === 'NONE', 'OWNER');
      const metadata = s.files.find(f => f.path === FILES_SNAPSHOT_METADATA); check(metadata, 'MANIFEST_MISSING');
      const m: Manifest = json(metadata.bytes); validateManifest(m, this.#config);
      const actual = s.files.filter(f => f.path !== FILES_SNAPSHOT_METADATA);
      equal(actual.map(f => ({path: f.path, size: f.bytes.length, sha256: sha(f.bytes)})).sort((a, b) => a.path.localeCompare(b.path)),
        [...m.files].sort((a, b) => a.path.localeCompare(b.path)), 'FILES_MANIFEST_COVERAGE');
      const expansion = {bytes: 0, members: 0};
      for (const f of actual) { logical(f.path); content(f.path, f.bytes, expansion); }
      const mark = actual.find(f => f.path === FILES_ROOT_MARKER); check(mark, 'MARKER_MISSING'); equal(json(mark.bytes), m.marker, 'FILES_MARKER_MISMATCH');
      equal(s.inventory, receipt(m, this.#config), 'FILES_FINGERPRINT_MISMATCH');
    });
  }
  toJSON() { return {owner: this.owner, profile: PROFILE, access: 'READ_ONLY', backupAuthorized: false, globalUnmanagedWritersVerified: false}; }
}
