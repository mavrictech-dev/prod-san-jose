import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {SyntheticFilesOwner, FILES_ROOT_MARKER, FILES_ROOT_VERSION, FILES_SNAPSHOT_METADATA,
  type SyntheticFilesOwnerOptions} from '../infra/b2b/deployment-backup/files-owner';
import {canonical, LIMITS, sha} from '../infra/b2b/deployment-backup/model';
import {PROFILE, type OwnerSnapshot} from '../infra/b2b/deployment-backup/ports';

vi.setConfig({testTimeout: 60000, hookTimeout: 60000});
const Zip = createRequire(path.resolve('packages/received-core/package.json'))('adm-zip');
const owned: string[] = [];
const prefix = 'factuez-files-owner-tests-';
function cleanup(container: string): void {
  // Never move paths between shells. Verify the real, immediate tmp child before recursive removal on Windows.
  const parent = fs.realpathSync.native(tmpdir()); const target = fs.realpathSync.native(container);
  if (path.dirname(target) !== parent || !path.basename(target).startsWith(prefix) || target !== container) throw new Error('UNSAFE_TEST_CLEANUP');
  fs.rmSync(target, {recursive: true, force: true});
}
function fixture(owner: 'FILES' | 'ARTIFACTS' = 'FILES', purpose: SyntheticFilesOwnerOptions['purpose'] = 'NEW_SYNTHETIC') {
  const container = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), prefix)); owned.push(container);
  const rootId = randomUUID(), root = path.join(container, 'factuez-deployment-backup-files-' + rootId);
  fs.mkdirSync(root);
  const options: SyntheticFilesOwnerOptions = {owner, root, rootId, deploymentId: randomUUID(), profile: PROFILE,
    environment: 'BETA', datasetClass: 'SYNTHETIC', purpose};
  const {root: _, ...profile} = options;
  const rootMarker = {schemaVersion: FILES_ROOT_VERSION, ...profile, epoch: '1'};
  fs.writeFileSync(path.join(root, FILES_ROOT_MARKER), canonical(rootMarker));
  fs.writeFileSync(path.join(root, 'document.xml'), '<invoice><ruc>00000000123</ruc><total>12</total></invoice>');
  return {container, root, options, rootMarker, owner: new SyntheticFilesOwner(options),
    put: (name: string, data: string | Buffer) => { const dest = path.join(root, ...name.split('/')); fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.writeFileSync(dest, data); }};
}
const disposable: string[] = [];
function temporary(owner: 'FILES' | 'ARTIFACTS' = 'FILES') { const f = fixture(owner); disposable.push(f.container); return f; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of disposable.splice(0)) { cleanup(dir); owned.splice(owned.indexOf(dir), 1); } });
afterAll(() => { for (const dir of owned.splice(0)) cleanup(dir); });
function clone(s: OwnerSnapshot): OwnerSnapshot {
  return {inventory: structuredClone(s.inventory), payload: {format: s.payload.format, bytes: Buffer.from(s.payload.bytes)},
    files: s.files.map(f => ({path: f.path, bytes: Buffer.from(f.bytes)}))};
}
function manifest(s: OwnerSnapshot): any { return JSON.parse(s.files.find(f => f.path === FILES_SNAPSHOT_METADATA)!.bytes.toString()); }
function rehash(s: OwnerSnapshot): void {
  s.inventory.files = s.files.map(f => ({path: f.path, size: f.bytes.length, sha256: sha(f.bytes)})).sort((a, b) => a.path < b.path ? -1 : 1);
}
function zipFile(name: string, bytes: string): Buffer { const z = new Zip(); z.addFile(name, Buffer.from(bytes)); return z.toBuffer(); }

describe('real synthetic filesystem owner', () => {
  let source: ReturnType<typeof fixture>, saved: OwnerSnapshot;
  beforeAll(async () => {
    source = fixture();
    source.put('reports/table.csv', 'ruc,total\n00000000123,12\n');
    source.put('records/data.json', '{"ruc":"00000000123","total":12}');
    source.put('records/rows.jsonl', '{"id":1}\n{"id":2}\n');
    source.put('records/rows.ndjson', '{"id":1}\n');
    source.put('artifact.pdf', '%PDF-1.4\n% synthetic fixture\n%%EOF\n');
    source.put('opaque.dat', 'FACTUEZ_SYNTHETIC_FILE_V1\nsynthetic application bytes');
    source.put('bundle.zip', zipFile('invoice.xml', '<invoice>synthetic</invoice>'));
    fs.mkdirSync(path.join(source.root, 'empty'));
    await source.owner.inventory(); saved = await source.owner.snapshot();
  });
  it('reads actual files, no fake PGDMP, complete file/directory/disk identity and derived metadata', async () => {
    expect(saved.payload).toEqual({format: 'NONE', bytes: Buffer.alloc(0)});
    expect(saved.inventory.tables).toEqual([]); expect(saved.inventory.sequences).toEqual([]);
    const m = manifest(saved);
    expect(m.marker).toEqual(source.rootMarker); expect(m.rootPathSha256).toBe(sha(source.root));
    expect(m.nodes.some((n: any) => n.path === 'empty' && n.kind === 'DIRECTORY')).toBe(true);
    expect(m.disk.device).toBe(String(fs.statSync(source.root, {bigint: true}).dev));
    expect(m.disk.platform).toBe(process.platform); expect(m.disk.blocks).toMatch(/^[1-9][0-9]*$/);
    if (process.platform === 'win32') expect(m.disk.format).toMatch(/^(NTFS|ReFS)$/);
    for (const n of m.nodes.filter((n: any) => n.kind === 'FILE')) {
      const absolute = path.join(source.root, ...n.path.split('/')), stat = fs.statSync(absolute, {bigint: true});
      const data = saved.files.find(f => f.path === n.path)!.bytes;
      expect(data.equals(fs.readFileSync(absolute))).toBe(true);
      expect(n.identity.inode).toBe(String(stat.ino)); expect(n.identity.mtimeNs).toBe(String(stat.mtimeNs)); expect(n.identity.ctimeNs).toBe(String(stat.ctimeNs));
      expect(saved.inventory.files.find(f => f.path === n.path)).toEqual({path: n.path, size: data.length, sha256: sha(data)});
    }
    expect(saved.inventory.checkpoints.find(c => c.name === 'Filesystem')!.sha256).toBe(sha(canonical({disk: m.disk, nodes: m.nodes})));
    expect(saved.inventory.checkpoints.find(c => c.name === 'WriterEpoch')!.sha256).toBe(sha('1'));
    expect(saved.inventory.state.sha256).toBe(sha(canonical(m)));
    await source.owner.verify(saved);
    expect(fs.existsSync(path.join(source.root, 'backup-metadata'))).toBe(false);
  });
  it('verifies only supplied bytes with source offline and every filesystem/process API forbidden', async () => {
    const f = temporary(); await f.owner.inventory(); const portable = await f.owner.snapshot();
    // Rename, do not delete, the source under the owned tmp container. The original root no longer exists.
    const moved = path.join(f.container, 'source-offline'); fs.renameSync(f.root, moved);
    try {
      for (const name of ['openSync', 'readFileSync', 'readdirSync', 'lstatSync', 'statSync', 'statfsSync', 'realpathSync',
        'writeFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'chmodSync', 'renameSync'] as const) {
        vi.spyOn(fs, name as any).mockImplementation(() => { throw new Error('FORBIDDEN_FS_CALL'); });
      }
      vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('FORBIDDEN_PROCESS'); });
      await new SyntheticFilesOwner(f.options).verify(portable);
    } finally { vi.restoreAllMocks(); fs.renameSync(moved, f.root); }
  });
  it('snapshot reads only O_RDONLY handles and creates no files or directories', async () => {
    const open = vi.spyOn(fs, 'openSync'); const write = vi.spyOn(fs, 'writeFileSync');
    const mkdir = vi.spyOn(fs, 'mkdirSync'); const remove = vi.spyOn(fs, 'rmSync');
    const second = await source.owner.snapshot();
    expect(second).toEqual(saved); expect(open).toHaveBeenCalled();
    for (const call of open.mock.calls) expect(Number(call[1]) & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)).toBe(0);
    expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
  });
  it('supports ARTIFACTS and explicitly marked synthetic copy, but never auto-provisions a marker', async () => {
    const f = fixture('ARTIFACTS', 'MARKED_SYNTHETIC_COPY'); disposable.push(f.container);
    const inv = await f.owner.inventory(), snap = await f.owner.snapshot(); await f.owner.verify(snap);
    expect(inv.owner).toBe('ARTIFACTS'); expect(manifest(snap).marker.purpose).toBe('MARKED_SYNTHETIC_COPY');
    expect(f.owner.toJSON()).toEqual({owner: 'ARTIFACTS', profile: PROFILE, access: 'READ_ONLY', backupAuthorized: false, globalUnmanagedWritersVerified: false});
  });
  it.each(['payload', 'file-bytes', 'missing-file', 'missing-manifest', 'checkpoint', 'schema', 'owner', 'profile', 'inventory-size'])('rejects modified snapshot %s', async mode => {
    const bad = clone(saved);
    if (mode === 'payload') bad.payload.bytes = Buffer.from('PGDMP-fake');
    if (mode === 'file-bytes') bad.files.find(f => f.path === 'document.xml')!.bytes[1] ^= 1;
    if (mode === 'missing-file') { bad.files = bad.files.filter(f => f.path !== 'document.xml'); rehash(bad); }
    if (mode === 'missing-manifest') { bad.files = bad.files.filter(f => f.path !== FILES_SNAPSHOT_METADATA); rehash(bad); }
    if (mode === 'checkpoint') bad.inventory.checkpoints[0].sha256 = 'a'.repeat(64);
    if (mode === 'schema') bad.inventory.schemaSha256 = 'a'.repeat(64);
    if (mode === 'owner') bad.inventory.owner = 'ARTIFACTS';
    if (mode === 'profile') (bad.inventory as any).profile = 'REAL';
    if (mode === 'inventory-size') bad.inventory.files[0].size++;
    await expect(source.owner.verify(bad)).rejects.toThrow();
  });
  it.each(['inode-duplicate', 'symlink-mode', 'hardlink', 'orphan-directory', 'disk', 'disk-number-limit', 'device', 'root-binding', 'epoch', 'marker-binding', 'extra-node'])('validates derived metadata semantics even if outer file hashes are recomputed: %s', async mode => {
    const bad = clone(saved), m = manifest(bad), node = m.nodes.find((n: any) => n.path === 'document.xml');
    if (mode === 'inode-duplicate') node.identity.inode = m.nodes[0].identity.inode;
    if (mode === 'symlink-mode') node.identity.mode = String(0xa1ff);
    if (mode === 'hardlink') node.identity.links = '2';
    if (mode === 'orphan-directory') m.nodes.find((n: any) => n.path === 'empty').path = 'absent/empty';
    if (mode === 'disk') m.disk.format = 'UNKNOWN';
    if (mode === 'disk-number-limit') m.disk.blockSize = '9'.repeat(100);
    if (mode === 'device') node.identity.device = '0';
    if (mode === 'root-binding') m.rootPathSha256 = 'a'.repeat(64);
    if (mode === 'epoch') m.marker.epoch = '0';
    if (mode === 'marker-binding') m.marker.rootId = randomUUID();
    if (mode === 'extra-node') m.nodes.push({...node, path: 'unlisted.xml', identity: {...node.identity, inode: '999'}});
    bad.files.find(f => f.path === FILES_SNAPSHOT_METADATA)!.bytes = Buffer.from(canonical(m)); rehash(bad);
    await expect(source.owner.verify(bad)).rejects.toThrow();
  });
  it('returns independent byte and metadata copies', () => {
    const copy = clone(saved); copy.files[0].bytes.fill(0); copy.inventory.files[0].sha256 = 'a'.repeat(64);
    expect(copy).not.toEqual(saved); expect(saved.files[0].bytes.some(b => b !== 0)).toBe(true);
  });
});

describe('fail closed source roots, content and bounds', () => {
  it.each(['relative', 'filesystem-root', 'trailing-separator', 'wrong-name', 'vault-parent', 'unknown-profile', 'production', 'real-data', 'bad-uuid', 'unknown-purpose', 'foreign-owner'])('rejects unsafe/unknown configuration %s without I/O', mode => {
    const f = temporary(), options: any = {...f.options};
    if (mode === 'relative') options.root = 'relative';
    if (mode === 'filesystem-root') options.root = path.parse(f.root).root;
    if (mode === 'trailing-separator') options.root += path.sep;
    if (mode === 'wrong-name') options.root = path.dirname(f.root);
    if (mode === 'vault-parent') options.root = path.join(path.dirname(f.root), 'vault', path.basename(f.root));
    if (mode === 'unknown-profile') options.profile = 'UNKNOWN';
    if (mode === 'production') options.environment = 'PRODUCTION';
    if (mode === 'real-data') options.datasetClass = 'CLIENT';
    if (mode === 'bad-uuid') options.rootId = '123';
    if (mode === 'unknown-purpose') options.purpose = 'EXISTING_DATA';
    if (mode === 'foreign-owner') options.owner = 'IDENTITY';
    const stat = vi.spyOn(fs, 'lstatSync'); expect(() => new SyntheticFilesOwner(options)).toThrow(); expect(stat).not.toHaveBeenCalled();
  });
  it('requires inventory before snapshot and does not probe paths in the constructor', async () => {
    const f = temporary(), stat = vi.spyOn(fs, 'lstatSync');
    const owner = new SyntheticFilesOwner(f.options); expect(stat).not.toHaveBeenCalled();
    await expect(owner.snapshot()).rejects.toThrow('FILES_INVENTORY_REQUIRED'); expect(stat).not.toHaveBeenCalled();
  });
  it.each(['missing', 'uuid', 'owner', 'purpose', 'profile', 'epoch', 'duplicate-key', 'noncanonical'])('rejects root marker %s', async mode => {
    const f = temporary(); const markerPath = path.join(f.root, FILES_ROOT_MARKER); const m: any = {...f.rootMarker};
    if (mode === 'missing') fs.renameSync(markerPath, path.join(f.container, 'unmounted-marker.json'));
    else {
      if (mode === 'uuid') m.rootId = randomUUID(); if (mode === 'owner') m.owner = 'ARTIFACTS';
      if (mode === 'purpose') m.purpose = 'EXISTING'; if (mode === 'profile') m.datasetClass = 'CLIENT'; if (mode === 'epoch') m.epoch = '-1';
      const bytes = mode === 'duplicate-key' ? canonical(m).replace('"epoch":"1"', '"epoch":"0","epoch":"1"') : mode === 'noncanonical' ? JSON.stringify(m, null, 2) : canonical(m);
      fs.writeFileSync(markerPath, bytes);
    }
    await expect(f.owner.inventory()).rejects.toThrow();
  });
  it.each(['hardlink', 'junction', 'root-link', 'ancestor-link'])('rejects real filesystem link %s', async mode => {
    const f = temporary();
    if (mode === 'hardlink') fs.linkSync(path.join(f.root, 'document.xml'), path.join(f.root, 'alias.xml'));
    if (mode === 'junction') { const dest = path.join(f.container, 'target'); fs.mkdirSync(dest); fs.symlinkSync(dest, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    let owner = f.owner;
    if (mode === 'root-link') { const dest = path.join(f.container, 'real-root'); fs.renameSync(f.root, dest); fs.symlinkSync(dest, f.root, process.platform === 'win32' ? 'junction' : 'dir'); }
    if (mode === 'ancestor-link') { const alias = path.join(f.container, 'alias'); fs.symlinkSync(f.container, alias, process.platform === 'win32' ? 'junction' : 'dir'); owner = new SyntheticFilesOwner({...f.options, root: path.join(alias, path.basename(f.root))}); }
    await expect(owner.inventory()).rejects.toThrow();
  });
  it.each(['.hidden.json', 'upper.JSON', 'certificate.p12', 'vault/data.json', 'password.json', 'keys/data.json', 'backup-metadata/data.json', 'con.json', 'deep/a/b/c/d/e/f/g/file.json'])('rejects rather than silently skipping %s', async name => {
    const f = temporary(); f.put(name, '{"id":1}'); await expect(f.owner.inventory()).rejects.toThrow();
  });
  it.each([
    ['private.xml', '<data>-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----</data>'],
    ['doc.pdf', '%PDF-1.4\n-----BEGIN CERTIFICATE-----\nfixture'],
    ['record.json', '{"pass\\u0077ord":"synthetic-secret"}'],
    ['record.json', '{"nested":{"private_key":"synthetic"}}'],
    ['record.jsonl', '{"id":1}\n{"access_token":"synthetic"}\n'],
    ['doc.xml', '<data><password>synthetic</password></data>'],
    ['doc.xml', '<!DOCTYPE data [<!ENTITY external SYSTEM "file:///not-read">]><data/>'],
    ['data.csv', 'id,password\n1,synthetic\n'],
    ['data.csv', 'id,smtp_password\n1,synthetic\n'],
    ['doc.xml', '<data password="synthetic"/>'],
    ['doc.pdf', '%PDF-1.4\npassword=synthetic\n'],
    ['data.dat', 'unclassified opaque blob'],
    ['doc.pdf', 'not a pdf'],
    ['record.json', '{invalid json}'],
  ])('rejects sensitive/unsupported bytes in %s (%#)', async (name, data) => {
    const f = temporary(); f.put(name, data); await expect(f.owner.inventory()).rejects.toThrow();
  });
  it('rejects renamed PFX/DER content', async () => {
    const f = temporary(); f.put('data.dat', Buffer.from([0x30, 0x82, 0, 5, 1, 2, 3])); await expect(f.owner.inventory()).rejects.toThrow('FILES_OPAQUE_MATERIAL');
  });
  it.each(['secret', 'nested', 'crc', 'encrypted', 'trailing', 'bad-protocol'])('rejects ZIP dangerous member/unsupported protocol %s', async mode => {
    const f = temporary(); let bytes = zipFile('invoice.xml', '<invoice>synthetic</invoice>');
    if (mode === 'secret') bytes = zipFile('record.json', '{"password":"synthetic"}');
    if (mode === 'nested') { const z = new Zip(); z.addFile('nested.zip', zipFile('invoice.xml', '<data/>')); bytes = z.toBuffer(); }
    if (mode === 'crc') { bytes = Buffer.from(bytes); bytes.writeUInt32LE(123, 14); }
    if (mode === 'encrypted') { bytes = Buffer.from(bytes); bytes.writeUInt16LE(1, 6); }
    if (mode === 'trailing') bytes = Buffer.concat([bytes, Buffer.from('extra')]);
    if (mode === 'bad-protocol') bytes = Buffer.from('PK-not-a-zip');
    f.put('bundle.zip', bytes); await expect(f.owner.inventory()).rejects.toThrow();
  });
  it.each(['traversal', 'link', 'duplicate', 'global-member-limit'])('checks real ZIP archive structure %s', async mode => {
    const f = temporary(); let bytes = zipFile('good.xml', '<data/>');
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    if (mode === 'traversal') {
      Buffer.from('../x.xml').copy(bytes, 30); Buffer.from('../x.xml').copy(bytes, central + 46);
    }
    if (mode === 'link') bytes.writeUInt32LE(0xa1ff0000, central + 38);
    if (mode === 'duplicate') {
      const z = new Zip(); z.addFile('aaaa.xml', Buffer.from('<data/>')); z.addFile('bbbb.xml', Buffer.from('<data/>')); bytes = z.toBuffer();
      for (let at = bytes.indexOf('bbbb.xml'); at >= 0; at = bytes.indexOf('bbbb.xml', at + 8)) Buffer.from('aaaa.xml').copy(bytes, at);
    }
    if (mode === 'global-member-limit') {
      const z = new Zip(); for (let i = 0; i < 70; i++) z.addFile('item-' + i + '.json', Buffer.from('{}'));
      bytes = z.toBuffer(); f.put('other.zip', bytes);
    }
    f.put('bundle.zip', bytes); await expect(f.owner.inventory()).rejects.toThrow();
  });
  it('bounds JSON nesting and aggregate expanded ZIP bytes, before trusting disk metadata', async () => {
    const f = temporary(); f.put('deep.json', '['.repeat(34) + '1' + ']'.repeat(34));
    await expect(f.owner.inventory()).rejects.toThrow('FILES_CONTENT_LIMIT');
    fs.renameSync(path.join(f.root, 'deep.json'), path.join(f.container, 'deep-rejected.json'));
    const z = new Zip(); const body = Buffer.alloc(LIMITS.file, 0x20); body.write('FACTUEZ_SYNTHETIC_FILE_V1\n');
    for (let i = 0; i < 5; i++) z.addFile('item-' + i + '.dat', body);
    const bytes = z.toBuffer(); f.put('one.zip', bytes); f.put('two.zip', bytes);
    await expect(f.owner.inventory()).rejects.toThrow('FILES_ZIP_LIMIT');
  });
  it.each(['zero-byte', 'oversized', 'file-count', 'total-bytes', 'node-count'])('enforces existing LIMITS including metadata %s', async mode => {
    const f = temporary();
    if (mode === 'zero-byte') f.put('data.dat', Buffer.alloc(0));
    if (mode === 'oversized') f.put('data.dat', Buffer.alloc(LIMITS.file + 1));
    if (mode === 'file-count') for (let i = 0; i < LIMITS.files - 1; i++) f.put('item-' + i + '.json', '{}');
    if (mode === 'total-bytes') { const bytes = Buffer.alloc(LIMITS.file, 0x20); bytes.write('FACTUEZ_SYNTHETIC_FILE_V1\n'); for (let i = 0; i < 8; i++) f.put('item-' + i + '.dat', bytes); }
    if (mode === 'node-count') for (let i = 0; i < LIMITS.files * 8; i++) fs.mkdirSync(path.join(f.root, 'dir-' + i));
    await expect(f.owner.inventory()).rejects.toThrow();
  });
  it('rejects alternate data streams on Windows instead of omitting them', async () => {
    if (process.platform !== 'win32') return;
    const f = temporary(); fs.writeFileSync(path.join(f.root, 'document.xml:hidden'), 'synthetic-hidden-stream');
    await expect(f.owner.inventory()).rejects.toThrow('FILES_IO_OR_METADATA_REJECTED');
  });
});

describe('inventory/snapshot and mid-read consistency', () => {
  it.each(['same-size-content', 'same-size-restored-mtime', 'new-file', 'new-empty-directory', 'renamed', 'inode-replaced', 'marker-epoch'])('blocks changes between inventory and snapshot: %s', async mode => {
    const f = temporary(); await f.owner.inventory(); const file = path.join(f.root, 'document.xml'); const before = fs.statSync(file);
    if (mode.startsWith('same-size')) { const bytes = fs.readFileSync(file); bytes[10] ^= 1; fs.writeFileSync(file, bytes); if (mode.endsWith('mtime')) fs.utimesSync(file, before.atime, before.mtime); }
    if (mode === 'new-file') f.put('new.json', '{}');
    if (mode === 'new-empty-directory') fs.mkdirSync(path.join(f.root, 'empty'));
    if (mode === 'renamed') fs.renameSync(file, path.join(f.root, 'renamed.xml'));
    if (mode === 'inode-replaced') { fs.renameSync(file, path.join(f.container, 'old.xml')); fs.writeFileSync(file, fs.readFileSync(path.join(f.container, 'old.xml'))); }
    if (mode === 'marker-epoch') f.put(FILES_ROOT_MARKER, canonical({...f.rootMarker, epoch: '2'}));
    await expect(f.owner.snapshot()).rejects.toThrow();
  });
  it('fresh inventory updates state and checkpoints and refuses writer epoch regression', async () => {
    const f = temporary(); const first = await f.owner.inventory(); f.put('added.json', '{"id":1}');
    f.put(FILES_ROOT_MARKER, canonical({...f.rootMarker, epoch: '2'})); const second = await f.owner.inventory();
    expect(second.state.sha256).not.toBe(first.state.sha256); expect(second.schemaSha256).not.toBe(first.schemaSha256);
    expect(second.checkpoints).not.toEqual(first.checkpoints); const current = await f.owner.snapshot(); await f.owner.verify(current);
    f.put(FILES_ROOT_MARKER, canonical(f.rootMarker)); await expect(f.owner.inventory()).rejects.toThrow('FILES_EPOCH_REGRESSION');
  });
  it('detects a real file write during read, even with identical bytes and size', async () => {
    const f = temporary(); const file = path.join(f.root, 'document.xml'), bytes = fs.readFileSync(file);
    const originalOpen = fs.openSync, originalRead = fs.readSync; let target = -1, changed = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((...args: any[]) => { const fd = (originalOpen as any)(...args); if (args[0] === file) target = fd; return fd; }) as any);
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: any[]) => { const n = (originalRead as any)(...args); if (args[0] === target && !changed) { changed = true; fs.writeFileSync(file, bytes); } return n; }) as any);
    await expect(f.owner.inventory()).rejects.toThrow('FILES_CHANGED'); expect(changed).toBe(true);
  });
  it('detects added directories during real disk metadata inspection', async () => {
    const f = temporary(), original = childProcess.execFileSync; let changed = false;
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(((...args: any[]) => { const result = (original as any)(...args); if (!changed) { changed = true; fs.mkdirSync(path.join(f.root, 'new-empty')); } return result; }) as any);
    await expect(f.owner.inventory()).rejects.toThrow('FILES_TREE_CHANGED'); expect(changed).toBe(true);
  });
  it('rejects a replaced source root even when both roots are marked synthetic', async () => {
    const f = temporary(); await f.owner.inventory();
    fs.renameSync(f.root, path.join(f.container, 'original-root')); fs.mkdirSync(f.root);
    f.put(FILES_ROOT_MARKER, canonical(f.rootMarker)); f.put('document.xml', '<invoice>synthetic</invoice>');
    await expect(f.owner.inventory()).rejects.toThrow('FILES_ROOT_REPLACED');
  });
  it('rejects a file removed after inventory', async () => {
    const f = temporary(); await f.owner.inventory();
    fs.renameSync(path.join(f.root, 'document.xml'), path.join(f.container, 'removed.xml'));
    await expect(f.owner.snapshot()).rejects.toThrow();
  });
  it('fails unknown disk metadata and sanitizes source paths/child errors', async () => {
    const f = temporary(); vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => { throw new Error('sensitive-path-' + f.root); });
    await expect(f.owner.inventory()).rejects.toThrow(/^FILES_IO_OR_METADATA_REJECTED$/);
  });
});
