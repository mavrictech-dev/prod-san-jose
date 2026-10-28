import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify, type KeyObject } from 'node:crypto';
import { Audience, fail, plain, scopeText, uuid, type Client } from './model';

export interface Claims {
  iss: string; aud: typeof Audience; sub: string; client_id: string; jti: string;
  iat: number; nbf: number; exp: number; scope: string; client_revision: number;
  principal_type: 'integration_client'; environment: 'BETA';
}
const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) return fail(401, 'invalid_token');
  const bytes = Buffer.from(part, 'base64url');
  if (bytes.toString('base64url') !== part) return fail(401, 'invalid_token');
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { return fail(401, 'invalid_token'); }
  // Own issuer emits canonical JSON. This also rejects duplicate property names.
  if (!plain(value) || encode(value) !== part) return fail(401, 'invalid_token');
  return value;
}
export class IntegrationTokenCodec {
  private readonly key: KeyObject;
  private readonly publicKey: KeyObject;
  readonly kid: string;
  constructor(privatePem: Buffer, readonly issuer: string, private readonly ttl = 300,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !Number.isInteger(ttl) || ttl < 30 || ttl > 300) throw new Error('Invalid integration signer configuration');
    this.key = createPrivateKey(privatePem);
    if (this.key.asymmetricKeyType !== 'rsa' || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error('Dedicated RSA key of at least 2048 bits required');
    this.publicKey = createPublicKey(this.key);
    this.kid = createHash('sha256').update(this.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  }
  mint(client: Client, requested: string[]): { token: string; expiresIn: number } {
    const now = this.now();
    const claims: Claims = { iss: this.issuer, aud: Audience, sub: client.id, client_id: client.id,
      jti: randomUUID(), iat: now, nbf: now, exp: now + this.ttl, scope: requested.join(' '),
      client_revision: client.revision, principal_type: 'integration_client', environment: 'BETA' };
    const input = encode({ alg: 'RS256', typ: 'at+jwt', kid: this.kid }) + '.' + encode(claims);
    return { token: input + '.' + sign('RSA-SHA256', Buffer.from(input), this.key).toString('base64url'), expiresIn: this.ttl };
  }
  verify(token: unknown): Claims {
    if (typeof token !== 'string' || token.length > 8192) return fail(401, 'invalid_token');
    const parts = token.split('.');
    if (parts.length !== 3) return fail(401, 'invalid_token');
    const header = decode(parts[0]);
    if (Object.keys(header).sort().join(',') !== 'alg,kid,typ' || header.alg !== 'RS256' ||
        header.typ !== 'at+jwt' || header.kid !== this.kid || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return fail(401, 'invalid_token');
    const signature = Buffer.from(parts[2], 'base64url');
    if (signature.toString('base64url') !== parts[2] || !verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), this.publicKey, signature))
      return fail(401, 'invalid_token');
    const c = decode(parts[1]);
    if (Object.keys(c).sort().join(',') !== 'aud,client_id,client_revision,environment,exp,iat,iss,jti,nbf,principal_type,scope,sub' ||
        c.iss !== this.issuer || c.aud !== Audience || !uuid(c.sub) || c.client_id !== c.sub || !uuid(c.jti) ||
        c.principal_type !== 'integration_client' || c.environment !== 'BETA' ||
        ![c.iat, c.nbf, c.exp, c.client_revision].every(Number.isSafeInteger)) return fail(401, 'invalid_token');
    const claims = c as unknown as Claims;
    if (claims.client_revision < 1 || claims.nbf !== claims.iat || claims.iat > this.now() || claims.exp <= this.now() ||
        claims.exp <= claims.iat || claims.exp - claims.iat > 300) return fail(401, 'invalid_token');
    try { scopeText(claims.scope); } catch { return fail(401, 'invalid_token'); }
    return claims;
  }
  jwks() {
    return { keys: [{ ...this.publicKey.export({ format: 'jwk' }), kid: this.kid, use: 'sig', alg: 'RS256' }] };
  }
}
