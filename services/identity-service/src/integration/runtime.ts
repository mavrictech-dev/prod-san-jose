import { request } from 'node:https';
import { readFileSync } from 'node:fs';
import { createHash, createPublicKey, X509Certificate } from 'node:crypto';
import { PermissionCodes, RoleCodes } from '@factuez/contracts';
import type { IntegrationGrantV1 } from '@factuez/contracts/integration';
import { AuthService } from '../application/auth.service';
import { fail, type AdminAuthority, type GrantCatalogue } from './model';
import { validateCatalogue } from './catalogue';

export class HumanIntegrationAdministrator implements AdminAuthority {
  constructor(private readonly auth: Pick<AuthService, 'verifyAccessToken' | 'assertActive'>) {}
  async verify(bearer: string) {
    let claims;
    try { claims = this.auth.verifyAccessToken(bearer); }
    catch { return fail(401, 'invalid_token'); }
    // Revocation/browser-session freshness cannot be skipped for privileged administration.
    try { await this.auth.assertActive(claims); }
    catch (error) {
      if (error && typeof error === 'object' && 'getStatus' in error &&
          typeof error.getStatus === 'function' && error.getStatus() === 401) return fail(401, 'invalid_token');
      return fail(503, 'temporarily_unavailable');
    }
    if (!claims.roles.includes(RoleCodes.ADMIN) || claims.scope.kind !== 'GLOBAL' ||
        ![PermissionCodes.SETUP_MANAGE, PermissionCodes.USER_MANAGE, PermissionCodes.DOCUMENT_VIEW].every(p => claims.permissions.includes(p)))
      return fail(403, 'FORBIDDEN');
    return { id: claims.sub };
  }
}
export class HttpsBillingCatalogue implements GrantCatalogue {
  private readonly origin: URL;
  constructor(origin: string, private readonly transport: { ca: Buffer; cert: Buffer; key: Buffer }) {
    this.origin = new URL(origin);
    if (this.origin.protocol !== 'https:' || this.origin.username || this.origin.password || this.origin.search || this.origin.hash || this.origin.pathname !== '/')
      throw new Error('Private Billing HTTPS origin required');
  }
  async validate(bearer: string, grants: IntegrationGrantV1[]) {
    if (!/^[A-Za-z0-9_.-]{1,8192}$/.test(bearer)) return fail(401, 'invalid_token');
    const payload = await new Promise<unknown>((resolve, reject) => {
      const req = request(new URL('/api/v1/documents/catalog/issuance', this.origin), {
        method: 'GET', ...this.transport, rejectUnauthorized: true, timeout: 5000,
        headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json' },
      }, response => {
        let length = 0; const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 2 * 1024 * 1024) req.destroy(new Error('Catalogue size limit'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          if (response.statusCode !== 200) return reject(new Error('Catalogue unavailable'));
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Catalogue malformed')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Catalogue timeout')));
      req.on('error', reject); req.end();
    }).catch(() => fail(503, 'CATALOGUE_UNAVAILABLE'));
    validateCatalogue(payload, grants);
  }
}
export function integrationRuntimeConfig(env: NodeJS.ProcessEnv) {
  if (env.INTEGRATION_IDENTITY_ENABLED !== 'true') return null;
  if (env.INTEGRATION_ENVIRONMENT !== 'BETA' || (env.INTEGRATION_HOST && env.INTEGRATION_HOST !== '127.0.0.1'))
    throw new Error('Phase-3 runtime is loopback and BETA only');
  const required = (name: string) => { const value = env[name]; if (!value) throw new Error('Missing ' + name); return value; };
  const pem = (name: string) => readFileSync(required(name));
  const signingKey = pem('INTEGRATION_SIGNING_KEY_FILE');
  const integrationPublic = createPublicKey(signingKey).export({ type: 'spki', format: 'der' });
  const humanPublic = createPublicKey(pem('JWT_PUBLIC_KEY_FILE')).export({ type: 'spki', format: 'der' });
  if (integrationPublic.equals(humanPublic)) throw new Error('Integration and human signing keys must be different');
  const pepper = pem('INTEGRATION_PEPPER_FILE');
  if (pepper.length !== 32) throw new Error('Integration pepper must contain 32 raw random bytes');
  const port = Number(env.INTEGRATION_PORT ?? '3108');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid integration port');
  const cert = pem('INTEGRATION_TLS_CERT_FILE'), key = pem('INTEGRATION_TLS_KEY_FILE'), ca = pem('INTEGRATION_TLS_CA_FILE');
  if (createHash('sha256').update(createPublicKey(key).export({ type: 'spki', format: 'der' })).digest('hex') ===
      createHash('sha256').update(integrationPublic).digest('hex')) throw new Error('TLS and token signing keys must be different');
  const x509 = new X509Certificate(cert);
  if (!x509.publicKey.export({ type: 'spki', format: 'der' }).equals(createPublicKey(key).export({ type: 'spki', format: 'der' })))
    throw new Error('TLS key/certificate mismatch');
  const peerList = (name: string) => {
    const ids = required(name).split(',');
    if (!ids.length || ids.length > 100 || ids.some(v => !/^[a-f0-9]{64}$/.test(v)) || new Set(ids).size !== ids.length)
      throw new Error('Invalid private peer list');
    return ids;
  };
  return { signingKey, pepper, issuer: required('INTEGRATION_TOKEN_ISSUER'), port, cert, key, ca,
    peers: { token: peerList('INTEGRATION_TOKEN_PEERS'), admin: peerList('INTEGRATION_ADMIN_PEERS'), resource: peerList('INTEGRATION_RESOURCE_PEERS') },
    billingOrigin: required('INTEGRATION_BILLING_HTTPS_ORIGIN'),
    billingTransport: { ca: pem('INTEGRATION_BILLING_CA_FILE'), cert: pem('INTEGRATION_BILLING_CLIENT_CERT_FILE'), key: pem('INTEGRATION_BILLING_CLIENT_KEY_FILE') } };
}
