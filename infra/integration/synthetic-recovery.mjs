/** New synthetic rehearsal ONLY. Not a backup importer for a customer database. */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bad = () => { throw new Error('SYNTHETIC_RECOVERY_INTEGRITY_FAILED'); };
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const maximum = 32 * 1024 * 1024;
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) bad();
}
function validate(input) {
  exact(input, ['runId', 'sourceMode', 'environment', 'epoch', 'counts', 'databaseDump', 'originals']);
  if (!uuid(input.runId) || !uuid(input.epoch) || input.sourceMode !== 'SYNTHETIC' || input.environment !== 'BETA') bad();
  exact(input.counts, ['history', 'exports', 'exportAudits', 'deliveries', 'deliveryAudits']);
  if (Object.values(input.counts).some(n => !Number.isSafeInteger(n) || n < 0 || n > 10000)) bad();
  if (!Buffer.isBuffer(input.databaseDump) || input.databaseDump.length < 1 || input.databaseDump.length > 16 * 1024 * 1024 ||
      input.databaseDump.subarray(0, 5).toString('ascii') !== 'PGDMP') bad();
  if (!Array.isArray(input.originals) || input.originals.length < 1 || input.originals.length > 32) bad();
  const names = new Set(); let size = input.databaseDump.length;
  for (const file of input.originals) {
    exact(file, ['name', 'bytes']);
    if (typeof file.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}\.(xml|zip|pdf)$/.test(file.name) || names.has(file.name) ||
        !Buffer.isBuffer(file.bytes) || file.bytes.length < 1 || file.bytes.length > 10 * 1024 * 1024) bad();
    names.add(file.name); size += file.bytes.length;
  }
  if (size > maximum) bad();
  return input;
}
export function sealSyntheticRecovery(input, key) {
  const c = validate(input); if (!Buffer.isBuffer(key) || key.length !== 32) bad();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv), aad = 'factuez.synthetic-recovery.v1:' + c.runId;
  cipher.setAAD(Buffer.from(aad));
  const data = { ...c, schemaVersion: 'factuez.synthetic-recovery.v1', databaseDump: c.databaseDump.toString('base64'),
    databaseSha256: sha(c.databaseDump), originals: c.originals.map(f => ({ name: f.name, content: f.bytes.toString('base64'), sha256: sha(f.bytes) })) };
  const plaintext = Buffer.from(JSON.stringify(data));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}
export function openSyntheticRecovery(bytes, key, expectedRunId) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 30 || bytes.length > 48 * 1024 * 1024 || bytes[0] !== 1 ||
      !Buffer.isBuffer(key) || key.length !== 32 || !uuid(expectedRunId)) bad();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
    decipher.setAAD(Buffer.from('factuez.synthetic-recovery.v1:' + expectedRunId)); decipher.setAuthTag(bytes.subarray(13, 29));
    const data = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8'));
    exact(data, ['runId', 'sourceMode', 'environment', 'epoch', 'counts', 'databaseDump', 'originals', 'schemaVersion', 'databaseSha256']);
    if (data.schemaVersion !== 'factuez.synthetic-recovery.v1' || data.runId !== expectedRunId || typeof data.databaseDump !== 'string' ||
        !Array.isArray(data.originals)) bad();
    const decode = value => { if (typeof value !== 'string') bad(); const b = Buffer.from(value, 'base64'); if (b.toString('base64') !== value) bad(); return b; };
    const dump = decode(data.databaseDump); if (sha(dump) !== data.databaseSha256) bad();
    const originals = data.originals.map(f => { exact(f, ['name', 'content', 'sha256']); const b = decode(f.content);
      if (sha(b) !== f.sha256) bad(); return { name: f.name, bytes: b }; });
    return validate({ runId: data.runId, sourceMode: data.sourceMode, environment: data.environment, epoch: data.epoch,
      counts: data.counts, databaseDump: dump, originals });
  } catch { bad(); }
}
