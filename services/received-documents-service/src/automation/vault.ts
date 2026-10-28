import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { AccessError } from '@factuez/service-access';
export type ReceptionSecretContext = { companyId: number; ruc: string; revision: number };
function context(c: ReceptionSecretContext) {
  if (!Number.isSafeInteger(c.companyId) || c.companyId < 1 || !/^\d{11}$/.test(c.ruc) || !Number.isInteger(c.revision) || c.revision < 1) throw new AccessError(400, 'Contexto de cifrado inválido');
  return Buffer.from(`factuez.reception.v1|${c.companyId}|${c.ruc}|${c.revision}`);
}
/** Domain-separated AES-GCM; never serialize encrypted data or keys into API responses. */
export class ReceptionVault {
  private key() {
    const path = process.env.RECEIVED_SETTINGS_KEY_FILE;
    if (!path || !isAbsolute(path)) throw new AccessError(503, 'TI debe configurar el secreto de cifrado de recepción');
    let fd: number | undefined; const data = Buffer.alloc(129);
    try {
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const stat = fstatSync(fd);
      const qaMounted = process.env.RECEIVED_LOCAL_FIXTURE_ENABLED === 'true' && process.env.RECEIVED_QA_USE_APP_KEY === 'true' && path === '/run/secrets/app_master_key';
      if (!stat.isFile() || stat.size > 128 || stat.size < 43 || !qaMounted && process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error();
      const value = data.subarray(0, readSync(fd, data, 0, data.length, 0)).toString('utf8').trim();
      const master = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : /^[A-Za-z0-9_+/=-]{43,44}$/.test(value) ? Buffer.from(value, 'base64url') : Buffer.alloc(0);
      if (master.length !== 32) throw new Error();
      try { return Buffer.from(hkdfSync('sha256', master, 'factuez.received', 'reception-settings-v1', 32)); } finally { master.fill(0); }
    } catch { throw new AccessError(503, 'Secreto de cifrado de recepción no disponible o inválido'); }
    finally { data.fill(0); if (fd !== undefined) closeSync(fd); }
  }
  seal(value: Record<string, string>, c: ReceptionSecretContext) {
    const key = this.key(), bytes = Buffer.from(JSON.stringify(value));
    try { if (bytes.length > 8192) throw new Error(); const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(context(c)); const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]); return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.'); }
    finally { key.fill(0); bytes.fill(0); }
  }
  open(envelope: string | null, c: ReceptionSecretContext): Record<string, string> {
    if (!envelope) return {};
    const key = this.key(); let plaintext: Buffer | undefined, provisional: Buffer | undefined;
    try {
      const parts = envelope.split('.'); if (envelope.length > 11500 || parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(p => !/^[A-Za-z0-9_-]+$/.test(p))) throw new Error();
      const [iv, tag, ciphertext] = parts.slice(1).map(p => Buffer.from(p, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 8192 || [iv, tag, ciphertext].some((p, i) => p.toString('base64url') !== parts[i + 1])) throw new Error();
      const cipher = createDecipheriv('aes-256-gcm', key, iv); cipher.setAAD(context(c)); cipher.setAuthTag(tag);
      provisional = cipher.update(ciphertext); plaintext = Buffer.concat([provisional, cipher.final()]); const decoded = JSON.parse(plaintext.toString());
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || Object.entries(decoded).some(([k, v]) => !['mailPassword', 'sireClientSecret', 'solPassword'].includes(k) || typeof v !== 'string' || v.length > 1024)) throw new Error();
      return decoded;
    } catch { throw new AccessError(503, 'Integridad de credenciales de recepción no verificable'); }
    finally { key.fill(0); provisional?.fill(0); plaintext?.fill(0); }
  }
}
