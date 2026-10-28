import { Injectable } from '@nestjs/common';
import { AccessError } from '@factuez/service-access';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type SmtpSecretContext = { companyId: number; ruc: string; field: 'configuration' | `corporate-test:${string}` | `corporate-document:${string}` };
export type SmtpKeyReadiness = 'READY' | 'MISSING' | 'INVALID';

function aad(context: SmtpSecretContext, version: number) {
  if (!Number.isSafeInteger(context.companyId) || context.companyId < 1 || !/^\d{11}$/.test(context.ruc) || (context.field !== 'configuration' && !/^(?:corporate-test|corporate-document):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(context.field)))
    throw new AccessError(400, 'Contexto de configuración SMTP inválido');
  return Buffer.from(`factuez.smtp.v1|${version}|${context.companyId}|${context.ruc}|${context.field}`, 'utf8');
}

/** Clave sólo desde archivo montado como secreto. Sin clave por defecto ni fallback. */
@Injectable()
export class SmtpConfigurationVault {
  private key() {
    const path = process.env.SMTP_SETTINGS_KEY_FILE;
    const version = Number(process.env.SMTP_SETTINGS_KEY_VERSION ?? '1');
    if (!path || !isAbsolute(path) || !Number.isInteger(version) || version < 1 || version > 10000)
      throw new AccessError(503, 'Cifrado SMTP no configurado');
    let descriptor: number | undefined;
    const bytes = Buffer.alloc(129);
    try {
      descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = fstatSync(descriptor);
      const qaMountedKey = process.env.LOCAL_MAIL_QA_ENABLED === 'true' && process.env.SMTP_QA_USE_APP_KEY === 'true' && path === '/run/secrets/app_master_key';
      if (!info.isFile() || info.size < 43 || info.size > 128 || (!qaMountedKey && process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error();
      const count = readSync(descriptor, bytes, 0, bytes.length, 0);
      const value = bytes.subarray(0, count).toString('utf8').trim();
      const decoded = /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : qaMountedKey && /^[A-Za-z0-9_+/=-]{43,44}$/.test(value) ? Buffer.from(value, 'base64url') : Buffer.alloc(0);
      if (decoded.length !== 32) throw new Error();
      return { bytes: decoded, version };
    } catch { throw new AccessError(503, 'Clave de cifrado SMTP no disponible o inválida'); }
    finally { bytes.fill(0); if (descriptor !== undefined) closeSync(descriptor); }
  }

  readiness(): SmtpKeyReadiness {
    if (!process.env.SMTP_SETTINGS_KEY_FILE) return 'MISSING';
    try { const key = this.key(); key.bytes.fill(0); return 'READY'; } catch { return 'INVALID'; }
  }

  seal(plaintext: Buffer, context: SmtpSecretContext): { cipher: string; keyVersion: number } {
    if (!Buffer.isBuffer(plaintext) || plaintext.length < 1 || plaintext.length > (context.field === 'configuration' ? 4096 : 12288)) throw new AccessError(400, 'Configuración SMTP demasiado grande');
    const key = this.key();
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key.bytes, iv, { authTagLength: 16 });
      cipher.setAAD(aad(context, key.version));
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { keyVersion: key.version, cipher: ['v1', String(key.version), iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.') };
    } finally { key.bytes.fill(0); }
  }

  open(envelope: string, context: SmtpSecretContext): Buffer {
    const key = this.key();
    try {
      if (typeof envelope !== 'string' || envelope.length > (context.field === 'configuration' ? 5700 : 17000)) throw new Error();
      const parts = envelope.split('.');
      if (parts.length !== 5 || parts[0] !== 'v1' || parts[1] !== String(key.version) || !parts.slice(2).every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
      const [iv, tag, encrypted] = parts.slice(2).map(part => Buffer.from(part, 'base64url'));
      if (iv.length !== 12 || tag.length !== 16 || !encrypted.length || encrypted.length > (context.field === 'configuration' ? 4096 : 12288) ||
        [iv, tag, encrypted].some((part, i) => part.toString('base64url') !== parts[i + 2])) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', key.bytes, iv, { authTagLength: 16 });
      decipher.setAAD(aad(context, key.version)); decipher.setAuthTag(tag);
      const provisional = decipher.update(encrypted);
      try { return Buffer.concat([provisional, decipher.final()]); }
      finally { provisional.fill(0); }
    } catch { throw new AccessError(503, 'Integridad de configuración SMTP no verificable'); }
    finally { key.bytes.fill(0); }
  }
}
