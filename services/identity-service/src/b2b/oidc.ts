import { request } from 'node:https';
import { inspect } from 'node:util';
import { B2bAudience } from '@factuez/contracts/b2b';
import { B2bEnabledIdentityScopes } from '@factuez/contracts/b2b-security';
import { fail, plain, scopeText, uuid, type DelegatedUser, type DelegationVerifier } from './model';
export interface OidcLink {
  clientId: string; clientRevision: number; userId: string; userAuthRevision: number; enabled: boolean;
}
export interface LinkedUsers {
  link(issuer: string, subject: string, oidcClientId: string): Promise<OidcLink | null>;
  current(userId: string): Promise<{ active: boolean; authVersion: number; permissions: string[]; scope: DelegatedUser['scope'] }>;
}
export interface ProviderIntrospection { introspect(token: string): Promise<unknown> }
/** Authenticated introspection, NOT a decoder of unverified JWT payloads. */
export class OidcDelegationVerifier implements DelegationVerifier {
  constructor(private readonly issuer: string, private readonly provider: ProviderIntrospection,
    private readonly users: LinkedUsers, private readonly now = () => Math.floor(Date.now()/1000)) {
    const url = new URL(issuer);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Fixed OIDC issuer required');
  }
  async verify(token: string): Promise<DelegatedUser> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9._~-]{16,8192}$/.test(token)) return fail(401,'INVALID_TOKEN');
    const value = await this.provider.introspect(token);
    if (!plain(value) || value.active !== true || value.iss !== this.issuer ||
      !(value.aud === B2bAudience || (Array.isArray(value.aud) && value.aud.every((aud: unknown) => typeof aud === 'string') && value.aud.includes(B2bAudience))) ||
      value.token_type !== 'Bearer' || typeof value.sub !== 'string' || !value.sub || value.sub.length > 255 ||
      typeof value.client_id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.client_id) ||
      ![value.iat,value.exp].every(Number.isSafeInteger) || value.iat > this.now() || value.exp <= this.now() ||
      value.exp <= value.iat || value.exp-value.iat>300 || (value.nbf !== undefined && (!Number.isSafeInteger(value.nbf) || value.nbf > this.now()))) return fail(401,'INVALID_TOKEN');
    if (typeof value.scope !== 'string' || value.scope.length > 300 || value.scope.trim() !== value.scope || value.scope.includes('  ')) return fail(401,'INVALID_TOKEN');
    const words = value.scope.split(' ');
    if (new Set(words).size !== words.length || words.some(scope => !['openid','profile','email',...B2bEnabledIdentityScopes].includes(scope as any))) return fail(401,'INVALID_TOKEN');
    const selected = scopeText(words.filter(scope => scope.startsWith('b2b:')).join(' '));
    const link = await this.users.link(this.issuer,value.sub,value.client_id);
    if (!link?.enabled || !uuid(link.clientId) || !uuid(link.userId) || !Number.isSafeInteger(link.clientRevision) || link.clientRevision < 1) return fail(401,'USER_LINK_REQUIRED');
    const user = await this.users.current(link.userId);
    if (!user.active || user.authVersion !== link.userAuthRevision || !Array.isArray(user.permissions) ||
      (user.scope.kind !== 'GLOBAL' && (user.scope.kind !== 'ASSIGNED' || ![user.scope.branchIds,user.scope.emissionPointIds,user.scope.series].every(ids => Array.isArray(ids) && ids.every(uuid))))) return fail(401,'USER_ACCESS_CHANGED');
    return { clientId: link.clientId, clientRevision: link.clientRevision, oidcClientId:value.client_id,userId:link.userId,
      authRevision:user.authVersion,tokenScopes:selected,permissions:[...user.permissions],scope:structuredClone(user.scope) };
  }
}
/** No discovery from token data, no redirects, no TLS bypass, no token logging. */
export class HttpsOidcIntrospection implements ProviderIntrospection {
  toJSON(){return {service:'HttpsOidcIntrospection',credentials:'PRIVATE'};}
  [inspect.custom](){return 'HttpsOidcIntrospection { credentials: [PRIVATE] }';}
  private readonly endpoint: URL;
  constructor(endpoint: string, private readonly basicCredential: string,
    private readonly tls: { ca: Buffer; cert: Buffer; key: Buffer }) {
    this.endpoint = new URL(endpoint);
    if (this.endpoint.protocol !== 'https:' || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash ||
      !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(basicCredential)) throw new Error('Fixed authenticated HTTPS introspection endpoint required');
  }
  async introspect(token: string) {
    const body = new URLSearchParams({ token, token_type_hint:'access_token' }).toString();
    return new Promise<unknown>((resolve,reject) => {
      const req = request(this.endpoint,{...this.tls,method:'POST',rejectUnauthorized:true,minVersion:'TLSv1.2',timeout:5000,
        headers:{Authorization:this.basicCredential,'Content-Type':'application/x-www-form-urlencoded','Content-Length':Buffer.byteLength(body),Accept:'application/json'}},res=>{
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>65536)req.destroy(new Error('OIDC response limit'));else chunks.push(chunk);});
        res.on('error',reject);res.on('aborted',()=>reject(new Error('OIDC incomplete response')));
        res.on('end',()=>{if(res.statusCode!==200)return reject(new Error('OIDC unavailable'));try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('OIDC invalid response'));}});
      });
      req.on('timeout',()=>req.destroy(new Error('OIDC timeout')));req.on('error',reject);req.end(body);
    });
  }
}
