import { IntegrationScopes, IntegrationPatterns, validIntegrationGrant,
  type IntegrationGrantV1, type IntegrationScope } from '@factuez/contracts/integration';

export const Audience = 'factuez-integration-v1';
export class IntegrationIdentityError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const fail = (status: number, code: string): never => { throw new IntegrationIdentityError(status, code); };
export const uuid = (value: unknown): value is string => typeof value === 'string' && new RegExp(IntegrationPatterns.uuid).test(value);
export const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' &&
  !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export function scopes(value: unknown): IntegrationScope[] {
  if (!Array.isArray(value) || !value.length || value.length > IntegrationScopes.length ||
      value.some(v => !IntegrationScopes.includes(v)) || new Set(value).size !== value.length) return fail(400, 'invalid_scope');
  const result = [...value].sort() as IntegrationScope[];
  if (result.some(v => ['integration:artifacts:read', 'integration:exports:create', 'integration:exports:read', 'integration:changes:read'].includes(v)) &&
      !result.includes('integration:documents:read')) return fail(400, 'invalid_scope');
  return result;
}
export function scopeText(value: unknown): IntegrationScope[] {
  if (typeof value !== 'string' || value.length > 250 || value.trim() !== value || value.includes('  ')) return fail(400, 'invalid_scope');
  return scopes(value.split(' '));
}
export function grants(value: unknown): IntegrationGrantV1[] {
  if (!Array.isArray(value) || !value.length || value.length > 100 || !value.every(validIntegrationGrant) ||
      value.some(g => /^00/.test(g.issuerRuc))) return fail(400, 'INVALID_GRANTS');
  return structuredClone(value);
}
export interface Client {
  id: string; label: string; enabled: boolean; revision: number; secretHash: string;
  scopes: IntegrationScope[]; grants: IntegrationGrantV1[];
  createdAt: string; updatedAt: string; secretRotatedAt: string;
}
export type ClientView = Omit<Client, 'secretHash'>;
export const view = ({ secretHash: _secretHash, ...client }: Client): ClientView => structuredClone(client);
export interface Audit {
  id: string; clientId: string | null; actorId: string | null; requestId: string; peerHash: string;
  action: 'CREATE' | 'UPDATE' | 'ROTATE' | 'TOKEN' | 'AUTHENTICATE';
  outcome: string; revision: number | null; at: string;
}
export interface Transaction {
  get(id: string): Promise<Client | null>;
  create(client: Client): Promise<void>;
  save(client: Client, expectedRevision: number): Promise<void>;
  audit(event: Audit): Promise<void>;
  rate(keyHash: string, window: number, limit: number): Promise<boolean>;
}
export interface Store {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  rate(keyHash: string, window: number, limit: number): Promise<boolean>;
  list(): Promise<ClientView[]>;
}
export interface Admin { id: string }
export interface AdminAuthority { verify(bearer: string): Promise<Admin> }
export interface GrantCatalogue { validate(bearer: string, values: IntegrationGrantV1[]): Promise<void> }
export interface RequestContext { requestId: string; peer: string }
export interface Principal { clientId: string; revision: number; environment: 'BETA'; scopes: IntegrationScope[]; grants: IntegrationGrantV1[] }
