import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, realpath, lstat} from 'node:fs/promises';
import path from 'node:path';

// Local synthetic rehearsal only. PostgreSQL archive bytes are opaque, never executed.
const MAX_ITEM = 4 * 1024 * 1024, MAX_TOTAL = 16 * 1024 * 1024, MAX_FILES = 64;
const digest = b => createHash('sha256').update(b).digest('hex');
const validName = s => typeof s === 'string' && /^(?!\.)(?!.*\.\.)[a-z0-9][a-z0-9_-]{0,79}\.(?:xml|json|txt|dat)$/.test(s);
function fail() { throw new Error('INVALID_SYNTHETIC_BUNDLE'); }
function validate(bundle) {
  if (!bundle || Object.keys(bundle).sort().join(',') !== 'archive,files,format' || bundle.format !== 'factuez.synthetic.local.v1' || !Array.isArray(bundle.files) || bundle.files.length > MAX_FILES) fail();
  let total = 0; const seen = new Set();
  function bytes(item, file) {
    if (!item || Object.keys(item).sort().join(',') !== (file ? 'data,name,sha256' : 'data,sha256') ||
      typeof item.data !== 'string' || item.data.length > Math.ceil(MAX_ITEM / 3) * 4 || !/^[a-f0-9]{64}$/.test(item.sha256)) fail();
    const b = Buffer.from(item.data, 'base64');
    if (b.toString('base64') !== item.data || b.length > MAX_ITEM || digest(b) !== item.sha256) fail();
    total += b.length; if (total > MAX_TOTAL) fail(); return b;
  }
  const archive = bytes(bundle.archive, false);
  const files = bundle.files.map(item => {
    if (!validName(item?.name) || seen.has(item.name)) fail();
    seen.add(item.name); return {name: item.name, bytes: bytes(item, true)};
  });
  return {archive, files};
}
export function createSyntheticBundle(archive, files) {
  if (!Buffer.isBuffer(archive) || !Array.isArray(files) || files.length > MAX_FILES || archive.length > MAX_ITEM) fail();
  const encode = b => {if (!Buffer.isBuffer(b) || b.length > MAX_ITEM) fail(); return {data: b.toString('base64'), sha256: digest(b)};};
  const bundle = {format: 'factuez.synthetic.local.v1', archive: encode(archive), files: files.map(f => ({name: f?.name, ...encode(f?.bytes)}))};
  validate(bundle); return bundle;
}
export async function restoreSyntheticFiles(bundle, parent) {
  // Validate all members before any filesystem mutation.
  const decoded = validate(bundle);
  if (typeof parent !== 'string' || !path.isAbsolute(parent) || path.resolve(parent) !== parent || await realpath(parent) !== parent) fail();
  const st = await lstat(parent); if (!st.isDirectory() || st.isSymbolicLink()) fail();
  const target = path.join(parent, 'factuez-synthetic-restore-' + randomUUID());
  await mkdir(target, {mode: 0o700});
  async function write(name, contents) {
    const h = await open(path.join(target, name), 'wx', 0o600);
    try { await h.writeFile(contents); } finally { await h.close(); }
  }
  // archive.dump is preserved for review only; no database connection or restore command.
  await write('archive.dump', decoded.archive);
  for (const f of decoded.files) await write(f.name, f.bytes);
  return {directory: target, state: 'SYNTHETIC_FILES_ONLY', postgresRestored: false};
}