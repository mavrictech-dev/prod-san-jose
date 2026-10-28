import 'reflect-metadata';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const files = vi.hoisted(() => ({ key: 'a1'.repeat(32) }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>(),
  openSync: () => 123, fstatSync: () => ({ isFile: () => true, size: 64, mode: 0o600 }),
  readSync: (_fd: number, buffer: Buffer) => { buffer.write(files.key); return 64; }, closeSync: () => {},
}));
import { SmtpConfigurationVault } from '../services/mailer-worker/src/smtp-configuration.crypto';
beforeEach(() => { vi.stubEnv('SMTP_SETTINGS_KEY_FILE', resolve('smtp-synthetic-key')); vi.stubEnv('SMTP_SETTINGS_KEY_VERSION', '1'); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('payload temporal de trabajo con AES-GCM y AAD separado', () => {
  it('cifra destinatario/token ligados al ID/RUC y no permite convertirlo a configuración o intercambiar trabajos', () => {
    const vault = new SmtpConfigurationVault(), id = randomUUID(), issuer = { companyId: 1, ruc: '00000000001' };
    const context = { ...issuer, field: ('corporate-test:' + id) as `corporate-test:${string}` };
    const bytes = Buffer.from(JSON.stringify({ authorization: 'Bearer synthetic', recipient: 'recipient@example.invalid' }));
    const sealed = vault.seal(bytes, context); expect(sealed.cipher).not.toMatch(/Bearer|recipient|example/);
    expect(vault.open(sealed.cipher, context)).toEqual(bytes);
    for (const wrong of [{ ...issuer, field: 'configuration' }, { ...context, field: 'corporate-test:' + randomUUID() }, { ...context, ruc: '00000000002' }])
      expect(() => vault.open(sealed.cipher, wrong as never)).toThrow();
    expect(() => vault.seal(bytes, { ...issuer, field: 'corporate-test:invalid' } as never)).toThrow();
  });
});
