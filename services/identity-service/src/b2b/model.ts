import { B2bEnabledIdentityScopes, B2bSecurityError, b2bBindingKey, validB2bBinding, type B2bBinding, type B2bIdentityScope, type B2bPrincipal } from '@factuez/contracts/b2b-security';
export type { B2bBinding, B2bIdentityScope, B2bPrincipal };
export { B2bSecurityError as B2bIdentityError };
export function fail(status: number, code: string): never { throw new B2bSecurityError(status, code); }
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
export const plain = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
export function scopes(value: unknown, allowed: readonly string[] = B2bEnabledIdentityScopes): B2bIdentityScope[] {
  if (!Array.isArray(value) || !value.length || value.length > B2bEnabledIdentityScopes.length || new Set(value).size !== value.length ||
    value.some(scope => !allowed.includes(scope))) return fail(400, 'INVALID_SCOPE');
  if (value.includes('b2b:artifacts:read') && !value.includes('b2b:documents:read')) return fail(400, 'INVALID_SCOPE');
  if (value.includes('b2b:received:artifacts:read') && !value.includes('b2b:received:read')) return fail(400, 'INVALID_SCOPE');
  if (value.some(scope=>['b2b:exports:create','b2b:exports:read','b2b:changes:read'].includes(scope)) && !value.includes('b2b:documents:read')) return fail(400, 'INVALID_SCOPE');
  return [...value].sort();
}
export function scopeText(value: unknown) {
  if (typeof value !== 'string' || value.length > B2bEnabledIdentityScopes.join(' ').length || value.trim() !== value || value.includes('  ')) return fail(400, 'INVALID_SCOPE');
  return scopes(value.split(' '));
}
export function bindings(value: unknown): B2bBinding[] {
  if (!Array.isArray(value) || !value.length || value.length > 500 || !value.every(validB2bBinding) ||
    new Set(value.map(b2bBindingKey)).size !== value.length) return fail(400, 'INVALID_BINDINGS');
  return structuredClone(value);
}
export interface Client {
  id: string; label: string; kind: 'SERVICE' | 'USER'; enabled: boolean; revision: number;
  secretHash: string | null; oidcClientId: string | null;
  scopes: B2bIdentityScope[]; bindings: B2bBinding[];
}
/** Explicit metadata projection: stored credential fields never cross the owner boundary. */
export type ClientMetadata = Omit<Client, 'secretHash'>;
export const clientView = (client: ClientMetadata): ClientMetadata => structuredClone({
  id: client.id, label: client.label, kind: client.kind, enabled: client.enabled, revision: client.revision,
  oidcClientId: client.oidcClientId, scopes: client.scopes, bindings: client.bindings,
});
export interface ClientPageQuery { environment: 'BETA'; limit: number; after?: string }
export interface ClientPage { items: ClientMetadata[]; nextAfter: string | null }
export function clientPageQuery(value: unknown): ClientPageQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).some(key => !['environment', 'limit', 'after'].includes(key))) return fail(400, 'INVALID_QUERY');
  const q = value as Record<string, unknown>, limit = q.limit === undefined ? 25 :
    typeof q.limit === 'string' && /^[1-9][0-9]?$/.test(q.limit) ? Number(q.limit) : q.limit;
  if (q.environment !== 'BETA' || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50 ||
    (q.after !== undefined && !uuid(q.after))) return fail(400, 'INVALID_QUERY');
  return { environment: 'BETA', limit: Number(limit), ...(q.after === undefined ? {} : { after: q.after as string }) };
}
export interface Audit { id: string; requestId: string; clientId: string | null; actorId: string | null; action: string; outcome: string; revision: number | null; peerHash: string; at: string }
export interface Transaction {
  /** Optional only for compatibility with older command-only stores; listing fails closed without it. */
  list?(query: ClientPageQuery): Promise<ClientMetadata[]>;
  get(id: string): Promise<Client | null>;
  create(client: Client): Promise<void>;
  save(client: Client, expectedRevision: number): Promise<void>;
  audit(event: Audit): Promise<void>;
}
export interface Store {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  rate(keyHash: string, window: number, limit: number): Promise<boolean>;
}
export interface RequestContext { requestId: string; peer: string }
export interface AdminAuthority { verify(bearer: string): Promise<{ id: string; stepUpVerified: true }> }
export interface BindingCatalogue { validate(bindings: B2bBinding[]): Promise<void> }
export interface DelegatedUser {
  clientId: string; clientRevision: number; oidcClientId: string; userId: string; authRevision: number; tokenScopes: B2bIdentityScope[];
  permissions: string[]; scope: { kind: 'GLOBAL' } | { kind: 'ASSIGNED'; branchIds: string[]; emissionPointIds: string[]; series: string[] };
}
export interface DelegationVerifier { verify(token: string): Promise<DelegatedUser> }
