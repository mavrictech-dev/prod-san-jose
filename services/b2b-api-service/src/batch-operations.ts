import { Catch, Controller, HttpException, Inject, Module, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from '@nestjs/common';
import { B2bSecurityError } from '@factuez/contracts/b2b-security';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { b2bPrivatePeer, newB2bRequestId, type B2bPrivateHttp } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze, correctionEvidenceHash } from '@factuez/service-access/dist/b2b-correction-evidence-wire';

type Kind = 'SERVICE' | 'USER';
export type B2bBatchMemberRef = { documentId: string; version: number; snapshotSha256: string };
export type B2bBatchRequest = {
  schemaVersion: 'factuez.b2b.batch-members.v1';
  scope: { environment: 'BETA'; issuerRuc: string; companyId: number; branchId: string };
  idempotencyKey: string; issueDate: string; referenceDate: string;
} & ({ kind: 'RC'; entries: ({ member: B2bBatchMemberRef } & ({ conditionCode: '1' } | { conditionCode: '2' | '3'; previous: B2bBatchMemberRef }))[] }
  | { kind: 'RA'; entries: { member: B2bBatchMemberRef; reasonDescription: string }[] });
export type B2bBatchOperationView = {
  schemaVersion: 'factuez.b2b.batch-operation.v1'; operationId: string; identifier: string; kind: 'RC' | 'RA';
  scope: B2bBatchRequest['scope']; state: 'PREPARED' | 'COMPLETED' | 'UNKNOWN'; memberCount: number;
  commandSha256: string; replayed: boolean; candidateOnly: true; localOnly: true;
  fiscalExecutionEnabled: false; transmissionAuthorized: false; officialAcceptance: false;
};
export interface B2bBatchOperationsOwner {
  execute(token: string, kind: Kind, action: 'PREPARE' | 'RECOVER', request: B2bBatchRequest): Promise<unknown>;
}
export class HttpB2bBatchOperationsOwner implements B2bBatchOperationsOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  execute(token: string, kind: Kind, action: 'PREPARE' | 'RECOVER', request: B2bBatchRequest) {
    return this.http.post('/internal/b2b/batch-operations', { kind, action, request }, token);
  }
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_BATCH_REQUEST'); }
function bounded(value: unknown): any {
  try {
    const result = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw new Error();
    return result;
  } catch { return invalid(); }
}
function exact(value: any, keys: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
function ref(value: any) {
  exact(value, ['documentId', 'version', 'snapshotSha256']);
  if (typeof value.documentId !== 'string' || !UUID.test(value.documentId) || !Number.isSafeInteger(value.version) || value.version < 1 ||
    typeof value.snapshotSha256 !== 'string' || !HASH.test(value.snapshotSha256)) invalid();
}
export function validateB2bBatchRequest(input: unknown): B2bBatchRequest {
  const v = bounded(input);
  exact(v, ['schemaVersion', 'scope', 'idempotencyKey', 'issueDate', 'referenceDate', 'kind', 'entries']);
  exact(v.scope, ['environment', 'issuerRuc', 'companyId', 'branchId']);
  if (v.schemaVersion !== 'factuez.b2b.batch-members.v1' || v.scope.environment !== 'BETA' ||
    typeof v.scope.issuerRuc !== 'string' || !/^\d{11}$/.test(v.scope.issuerRuc) ||
    !Number.isSafeInteger(v.scope.companyId) || v.scope.companyId < 1 || v.scope.companyId > 2147483647 ||
    typeof v.scope.branchId !== 'string' || !UUID.test(v.scope.branchId) ||
    typeof v.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(v.idempotencyKey) ||
    !['RC', 'RA'].includes(v.kind) || !Array.isArray(v.entries) || v.entries.length < 1 || v.entries.length > 100) invalid();
  for (const date of [v.issueDate, v.referenceDate]) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date) invalid();
  }
  const seen = new Set<string>();
  for (const entry of v.entries) {
    if (v.kind === 'RC') {
      if (!entry || !['1', '2', '3'].includes(entry.conditionCode)) invalid();
      exact(entry, ['member', 'conditionCode', ...(entry.conditionCode === '1' ? [] : ['previous'])]);
      if (entry.conditionCode !== '1') { ref(entry.previous); if (entry.previous.documentId !== entry.member?.documentId) invalid(); }
    } else {
      exact(entry, ['member', 'reasonDescription']);
      if (typeof entry.reasonDescription !== 'string' || !entry.reasonDescription.trim() || entry.reasonDescription.length > 100 || /[\x00-\x1f\x7f]/.test(entry.reasonDescription)) invalid();
    }
    ref(entry.member); if (seen.has(entry.member.documentId)) invalid(); seen.add(entry.member.documentId);
  }
  return v;
}
function response(value: unknown, request: B2bBatchRequest, recover: boolean): B2bBatchOperationView {
  try {
    const v = bounded(value);
    exact(v, ['schemaVersion', 'operationId', 'identifier', 'kind', 'scope', 'state', 'memberCount', 'commandSha256', 'replayed',
      'candidateOnly', 'localOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized', 'officialAcceptance']);
    if (v.schemaVersion !== 'factuez.b2b.batch-operation.v1' || typeof v.operationId !== 'string' || !UUID.test(v.operationId) ||
      typeof v.identifier !== 'string' || !new RegExp(`^${request.kind}-${request.issueDate.replaceAll('-', '')}-[1-9][0-9]{0,14}$`).test(v.identifier) ||
      v.kind !== request.kind || correctionEvidenceHash(v.scope) !== correctionEvidenceHash(request.scope) ||
      !['PREPARED', 'COMPLETED', 'UNKNOWN'].includes(v.state) || v.memberCount !== request.entries.length ||
      typeof v.commandSha256 !== 'string' || !HASH.test(v.commandSha256) || typeof v.replayed !== 'boolean' || v.replayed !== recover ||
      v.candidateOnly !== true || v.localOnly !== true || v.fiscalExecutionEnabled !== false ||
      v.transmissionAuthorized !== false || v.officialAcceptance !== false) throw new Error();
    return v;
  } catch { throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE'); }
}
/** The edge has no Billing import and no fiscal evidence constructors. The private
 * owner authenticates again, resolves exact versions, and checks the complete closure. */
export class B2bBatchOperations {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bBatchOperationsOwner) {}
  async execute(token: string, kind: Kind, action: 'PREPARE' | 'RECOVER', input: unknown) {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (!['PREPARE', 'RECOVER'].includes(action)) invalid();
    const request = validateB2bBatchRequest(input), frame = new B2bOwnerReadFrame(this.identity, kind);
    const required = [action === 'PREPARE' ? 'b2b:batches:write' : 'b2b:batches:read'] as const;
    const check = async () => {
      const p = await frame.principal(token, [...required]);
      if (!p.bindings.some(b => b.issuerId === request.scope.companyId && b.issuerRuc === request.scope.issuerRuc &&
        b.environment === request.scope.environment && b.branchId === request.scope.branchId)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    };
    await check();
    const view = response(await this.owner.execute(token, kind, action, request), request, action === 'RECOVER');
    await check(); return view;
  }
}
@Catch()
export class B2bBatchOperationsHttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    const codes: Record<number, string> = { 400: 'INVALID_BATCH_REQUEST', 401: 'INVALID_TOKEN', 403: 'BATCH_MEMBER_DENIED',
      404: 'RESOURCE_NOT_FOUND', 409: 'BATCH_CONFLICT', 413: 'INVALID_BATCH_REQUEST', 429: 'RATE_LIMITED', 503: 'OWNER_UNAVAILABLE' };
    let status = error instanceof B2bSecurityError ? error.status : error instanceof HttpException ? error.getStatus() : 503;
    if (error && typeof error === 'object') {
      const type = Object.getOwnPropertyDescriptor(error, 'type')?.value;
      if (type === 'entity.too.large') status = 413;
      if (type === 'entity.parse.failed') status = 400;
    }
    if (!Object.hasOwn(codes, status)) status = 503;
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(status).json({ schemaVersion: 'factuez.b2b.v1', requestId: newB2bRequestId(), code: codes[status], message: codes[status], retryable: status === 503 || status === 429 });
  }
}
const CORE = Symbol('B2B durable batches'), PEERS = Symbol('B2B batch peers');
@Controller('b2b/v1')
@UseFilters(B2bBatchOperationsHttpErrorFilter)
export class B2bBatchOperationsController {
  constructor(@Inject(CORE) private readonly core: B2bBatchOperations, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private async invoke(req: any, res: any, action: 'PREPARE' | 'RECOVER') {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    b2bPrivatePeer(req, this.peers);
    const names: string[] = (req.rawHeaders ?? []).filter((_v: string, i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
    const authorization = req.headers.authorization, kind = req.headers['x-factuez-actor-kind'];
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) || !['SERVICE', 'USER'].includes(kind) ||
      ['authorization', 'x-factuez-actor-kind'].some(n => names.filter(k => n === k).length !== 1)) throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (new Set(names).size !== names.length || names.some(n => ['authorization', 'xfactuezactorkind'].includes(n.replace(/[-_]/g, '')) &&
      !['authorization', 'x-factuez-actor-kind'].includes(n)) || req.url.includes('?') || Object.keys(req.query ?? {}).length) invalid();
    const result = await this.core.execute(authorization.slice(7), kind, action, req.body);
    res.setHeader('X-Operation-Id', result.operationId); res.setHeader('X-Idempotent-Replay', String(result.replayed));
    return res.status(200).json(result);
  }
  @Post('batches/prepare')
  prepare(@Req() req: any, @Res() res: any) { return this.invoke(req, res, 'PREPARE'); }
  @Post('batches/recover')
  recover(@Req() req: any, @Res() res: any) { return this.invoke(req, res, 'RECOVER'); }
}
@Module({})
export class B2bBatchOperationsModule {
  static isolated(core: B2bBatchOperations, peers: readonly string[]): DynamicModule {
    if (!core || typeof core.execute !== 'function' || !Array.isArray(peers) || !peers.length || peers.length > 100 ||
      new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('EXPLICIT_BATCH_FACADE_AND_PEERS_REQUIRED');
    return { module: B2bBatchOperationsModule, controllers: [B2bBatchOperationsController], providers: [B2bBatchOperationsHttpErrorFilter,
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }] };
  }
}
