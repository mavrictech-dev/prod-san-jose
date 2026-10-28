import { Catch, Controller, HttpException, Inject, Module, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule, type ExceptionFilter } from '@nestjs/common';
import { B2bSecurityError, b2bBindingsContain, type B2bPrincipal } from '@factuez/contracts/b2b-security';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { b2bPrivatePeer, newB2bRequestId } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { fiscalSnapshotSha256 as hash } from '@factuez/sunat-core/dist/fiscal-note';
import type { FiscalBatchInput } from '@factuez/sunat-core/dist/fiscal-batch';
import { validateFiscalSupplementCommand } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { B2bBatchMemberAuthority, type BatchJournal, type BatchMemberPlan, type BatchMemberRequest, type BatchSubject } from './batch-member-authority';
import { PostgresBatchMemberOwner } from './batch-member-postgres';
import { createDurableBatchMemberProducer } from './batch-member-durable-producer';
import type { BatchMemberEvidencePort, BatchMemberIdentityPort, BatchMemberPolicyAdminPort, BatchSqlPool } from './batch-member-postgres.types';

type Kind = 'SERVICE' | 'USER';
type WithoutAsOf<T> = T extends unknown ? Omit<T, 'asOf'> : never;
export type BillingBatchHttpRequest = WithoutAsOf<BatchMemberRequest>;
export type BillingBatchOperationView = {
  schemaVersion: 'factuez.b2b.batch-operation.v1'; operationId: string; identifier: string;
  kind: 'RC' | 'RA'; scope: BatchMemberRequest['scope']; state: 'PREPARED' | 'COMPLETED' | 'UNKNOWN';
  memberCount: number; commandSha256: string; replayed: boolean; candidateOnly: true; localOnly: true;
  fiscalExecutionEnabled: false; transmissionAuthorized: false; officialAcceptance: false;
};
export type BillingBatchArtifactOwner = Omit<BillingBatchOperationView, 'schemaVersion' | 'replayed'> & {
  schemaVersion: 'factuez.b2b.batch-artifact-owner.v1'; permission: 'READ' | 'WRITE'; subject: BatchSubject;
  command: BatchJournal['command']; requestSha256: string; authorizationSha256: string; checkedAt: string;
};
export type BillingBatchArtifactScope = BatchMemberRequest['scope'] & { batchId: string };
export type BillingBatchArtifactOwned = Pick<BillingBatchArtifactOwner, 'command' | 'authorizationSha256'>;
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_BATCH_REQUEST'); }
function bounded(value: unknown): any {
  try {
    const result = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(result)) > 32768) throw new Error();
    return result;
  } catch { return invalid(); }
}
function exact(value: any, keys: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))) invalid();
}
function request(value: unknown, now: string): BatchMemberRequest {
  const v = bounded(value);
  exact(v, ['schemaVersion', 'scope', 'idempotencyKey', 'issueDate', 'referenceDate', 'kind', 'entries']);
  // The authority validates every reference, date and condition. No public asOf, identity,
  // snapshot, acceptance, not-delivered assertion or grant enters this boundary.
  return { ...v, asOf: now };
}
function normalizedInput(value: BatchMemberPlan['input']): unknown {
  const result = structuredClone(value) as FiscalBatchInput;
  for (const entry of result.entries) {
    if (entry.document.noteContext) entry.document.noteContext.asOf = '2000-01-01T00:00:00Z';
    if ('previous' in entry && entry.previous?.document.noteContext) entry.previous.document.noteContext.asOf = '2000-01-01T00:00:00Z';
  }
  return result;
}
/** Private local assembly. READ uses a READ plan + the owner's serialized transaction;
 * it never calls reserveIdentity, persist, appendJournal or the WRITE coordinator. */
export class BillingBatchOperations {
  private readonly authority: B2bBatchMemberAuthority<any>;
  private readonly producer: ReturnType<typeof createDurableBatchMemberProducer>;
  constructor(private readonly owner: PostgresBatchMemberOwner, private readonly identity: B2bIdentityPort,
    private readonly now = () => new Date().toISOString()) {
    this.authority = new B2bBatchMemberAuthority(owner, now);
    this.producer = createDurableBatchMemberProducer(owner, now);
  }
  private bindings(plan: BatchMemberPlan, p: B2bPrincipal) {
    for (const mark of plan.members) {
      const b = mark.record.binding;
      if (mark.grant.clientRevision !== p.revision || mark.grant.userAuthRevision !== p.userAuthRevision)
        throw new B2bSecurityError(403, 'BATCH_MEMBER_DENIED');
      // 07/08 retain independent full-series local grants. Their original 01/03 is
      // recursively loaded and checked here too; an anchor alone never grants a note.
      if ((b.documentType === '01' || b.documentType === '03') && !b2bBindingsContain(p.bindings, {
        issuerId: b.companyId, issuerRuc: b.issuerRuc, environment: b.environment,
        branchId: b.branchId, pointId: b.pointId, seriesId: b.seriesId, documentType: b.documentType,
      })) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    }
  }
  private view(journal: BatchJournal, plan: BatchMemberPlan, replayed: boolean): BillingBatchOperationView {
    const command = validateFiscalSupplementCommand(journal.command), envelope = command.payload.envelope;
    if (hash(journal.subject) !== hash(plan.subject) || hash(journal.scope) !== hash(plan.request.scope) ||
      journal.idempotencyKey !== plan.request.idempotencyKey || journal.requestSha256 !== plan.requestSha256 ||
      journal.commandSha256 !== hash(command) || envelope.kind !== 'BATCH' ||
      envelope.batch.kind !== plan.request.kind || envelope.batch.issueDate !== plan.request.issueDate ||
      envelope.batch.referenceDate !== plan.request.referenceDate ||
      hash(normalizedInput(envelope.batch.input)) !== hash(normalizedInput(plan.input)) ||
      !['PREPARED', 'COMPLETED', 'UNKNOWN'].includes(journal.state)) throw new B2bSecurityError(409, 'BATCH_JOURNAL_CONFLICT');
    return {
      schemaVersion: 'factuez.b2b.batch-operation.v1', operationId: envelope.batch.documentId,
      identifier: envelope.batch.identifier, kind: plan.request.kind, scope: plan.request.scope,
      state: journal.state, memberCount: plan.request.entries.length, commandSha256: journal.commandSha256,
      replayed, candidateOnly: true, localOnly: true, fiscalExecutionEnabled: false,
      transmissionAuthorized: false, officialAcceptance: false,
    };
  }
  async execute(token: string, kind: Kind, action: 'PREPARE' | 'RECOVER', value: unknown): Promise<BillingBatchOperationView> {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (!['PREPARE', 'RECOVER'].includes(action)) invalid();
    const input = request(value, this.now()), frame = new B2bOwnerReadFrame(this.identity, kind);
    const required = [action === 'PREPARE' ? 'b2b:batches:write' : 'b2b:batches:read'] as const;
    const principal = await frame.principal(token, [...required]);
    const subject: BatchSubject = { kind: principal.kind, clientId: principal.clientId, subjectId: principal.subjectId };
    const plan = action === 'PREPARE' ? await this.producer.plan(input, subject) : await this.authority.plan(input, subject, 'READ');
    this.bindings(plan, principal);
    let output: BillingBatchOperationView;
    if (action === 'PREPARE') {
      // Authenticate before coordination and after returning. The owner separately
      // rechecks member/grant epochs at every transaction-local checkpoint.
      await frame.principal(token, [...required]);
      const result = await this.producer.coordinate(plan, 'CREATE');
      output = this.view(result.journal as BatchJournal, plan, result.reused);
    } else {
      output = await this.owner.transaction(plan, async tx => {
        await tx.fence(plan);
        await frame.principal(token, [...required]);
        const journal = await tx.journal(subject, input.scope, input.idempotencyKey);
        if (!journal) throw new B2bSecurityError(404, 'BATCH_JOURNAL_MISSING');
        const response = this.view(journal, plan, true);
        await tx.fence(plan);
        await frame.principal(token, [...required]);
        return response;
      });
    }
    const after = await frame.principal(token, [...required]); this.bindings(plan, after);
    return output;
  }
  /** Private signer capability. The command comes ONLY from the existing durable
   * journal. All versions, previous versions, originals and credit history are
   * freshly authorized and fenced, using WRITE for preparation, READ for retrieval.
   * No reservation or outbox append is reachable from this method. */
  async artifactOwner(token: string, kind: Kind, value: unknown, permission: 'READ' | 'WRITE'): Promise<BillingBatchArtifactOwner> {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (!['READ', 'WRITE'].includes(permission)) invalid();
    const input = request(value, this.now()), frame = new B2bOwnerReadFrame(this.identity, kind);
    const scopes = [permission === 'WRITE' ? 'b2b:batches:write' : 'b2b:batches:read'] as const;
    const principal = await frame.principal(token, [...scopes]);
    const subject: BatchSubject = { kind: principal.kind, clientId: principal.clientId, subjectId: principal.subjectId };
    const plan = await this.authority.plan(input, subject, permission); this.bindings(plan, principal);
    const result = await this.owner.transaction(plan, async tx => {
      await tx.fence(plan); await frame.principal(token, [...scopes]);
      const journal = await tx.journal(subject, input.scope, input.idempotencyKey);
      if (!journal) throw new B2bSecurityError(404, 'BATCH_JOURNAL_MISSING');
      const { schemaVersion: _schema, replayed: _replay, ...view } = this.view(journal, plan, true);
      const response: BillingBatchArtifactOwner = { ...view, schemaVersion: 'factuez.b2b.batch-artifact-owner.v1',
        permission, subject, command: structuredClone(journal.command), requestSha256: plan.requestSha256,
        authorizationSha256: hash({ subject, principal, members: plan.members, permission, commandSha256: journal.commandSha256 }), checkedAt: this.now() };
      await tx.fence(plan); await frame.principal(token, [...scopes]); return response;
    });
    const after = await frame.principal(token, [...scopes]); this.bindings(plan, after); return result;
  }
  async artifactOwnerById(token: string, kind: Kind, value: unknown, permission: 'READ' | 'WRITE'): Promise<BillingBatchArtifactOwner> {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (!['READ', 'WRITE'].includes(permission)) invalid();
    const scope = bounded(value); exact(scope, ['environment', 'issuerRuc', 'companyId', 'branchId', 'batchId']);
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (scope.environment !== 'BETA' || typeof scope.issuerRuc !== 'string' || !/^\d{11}$/.test(scope.issuerRuc) ||
      !Number.isSafeInteger(scope.companyId) || scope.companyId < 1 || scope.companyId > 2147483647 ||
      typeof scope.branchId !== 'string' || !uuid.test(scope.branchId) || typeof scope.batchId !== 'string' || !uuid.test(scope.batchId)) invalid();
    const frame = new B2bOwnerReadFrame(this.identity, kind);
    const scopes = [permission === 'WRITE' ? 'b2b:batches:write' : 'b2b:batches:read'] as const;
    const principal = await frame.principal(token, [...scopes]);
    if (!principal.bindings.some(b => b.issuerId === scope.companyId && b.issuerRuc === scope.issuerRuc &&
      b.environment === scope.environment && b.branchId === scope.branchId)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    const subject: BatchSubject = { kind: principal.kind, clientId: principal.clientId, subjectId: principal.subjectId };
    const stored = await this.owner.loadArtifactRequest(scope, subject);
    if (!stored) throw new B2bSecurityError(404, 'BATCH_JOURNAL_MISSING');
    const { asOf: _asOf, ...request } = stored;
    const result = await this.artifactOwner(token, kind, request, permission);
    if (result.operationId !== scope.batchId) throw new B2bSecurityError(409, 'BATCH_JOURNAL_CONFLICT');
    await frame.principal(token, [...scopes]);
    // Preserve the complete private verification view. A remote adapter must validate
    // schema, permission, subject, scope, hashes, freshness and closed flags BEFORE
    // projecting the two-field SUNAT capability; never validate after discarding them.
    return result;
  }
}

/** Creates the concrete PostgreSQL owner and real durable producer. No memory/default
 * grants, caller snapshots, legacy user coercion, runtime installation or fiscal dispatch. */
export function createBillingBatchOperations(options: {
  pool: BatchSqlPool; evidence: BatchMemberEvidencePort; memberIdentity: BatchMemberIdentityPort;
  policyAdmin: BatchMemberPolicyAdminPort; identity: B2bIdentityPort; now?: () => string;
}) {
  const now = options.now ?? (() => new Date().toISOString());
  const owner = new PostgresBatchMemberOwner(options.pool, options.evidence, options.memberIdentity, options.policyAdmin, now);
  return { owner, operations: new BillingBatchOperations(owner, options.identity, now) };
}

@Catch()
export class BillingBatchHttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    const codes: Record<number, string> = { 400: 'INVALID_BATCH_REQUEST', 401: 'INVALID_TOKEN', 403: 'BATCH_MEMBER_DENIED',
      404: 'RESOURCE_NOT_FOUND', 409: 'BATCH_CONFLICT', 413: 'INVALID_BATCH_REQUEST', 429: 'RATE_LIMITED', 503: 'OWNER_UNAVAILABLE' };
    let status = error instanceof B2bSecurityError ? error.status : error instanceof HttpException ? error.getStatus() : 503;
    if (error && typeof error === 'object') {
      const type = Object.getOwnPropertyDescriptor(error, 'type')?.value;
      if (type === 'entity.too.large') status = 413;
      if (type === 'entity.parse.failed') status = 400;
    }
    if (!Object.hasOwn(codes, status)) status = 503;
    response.setHeader('Cache-Control', 'private, no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    response.status(status).json({ schemaVersion: 'factuez.b2b.v1', requestId: newB2bRequestId(), code: codes[status], message: codes[status], retryable: status === 503 || status === 429 });
  }
}
const CORE = Symbol('Durable batch operations'), PEERS = Symbol('Batch operation peers');
@Controller('internal/b2b')
@UseFilters(BillingBatchHttpErrorFilter)
export class BillingBatchOperationsController {
  constructor(@Inject(CORE) private readonly core: Pick<BillingBatchOperations,'execute'|'artifactOwnerById'>, @Inject(PEERS) private readonly peers: readonly string[]) {}
  @Post('batch-operations')
  async call(@Req() req: any, @Res() res: any) {
    res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    b2bPrivatePeer(req, this.peers);
    const names: string[] = (req.rawHeaders ?? []).filter((_v: string, i: number) => i % 2 === 0).map((v: string) => v.toLowerCase());
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(authorization) || names.filter(n => n === 'authorization').length !== 1)
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (new Set(names).size !== names.length || names.some(n => n.replace(/[-_]/g, '') === 'authorization' && n !== 'authorization') ||
      req.url.includes('?') || Object.keys(req.query ?? {}).length) invalid();
    const body = bounded(req.body);
    exact(body, body?.action === 'ARTIFACT_OWNER' ? ['kind', 'action', 'scope', 'permission'] : ['kind', 'action', 'request']);
    if (!['SERVICE', 'USER'].includes(body.kind) || !['PREPARE', 'RECOVER', 'ARTIFACT_OWNER'].includes(body.action)) invalid();
    const result = body.action === 'ARTIFACT_OWNER'
      ? await this.core.artifactOwnerById(authorization.slice(7), body.kind, body.scope, body.permission)
      : await this.core.execute(authorization.slice(7), body.kind, body.action, body.request);
    return res.status(200).json(result);
  }
}
@Module({})
export class BillingBatchOperationsModule {
  static isolated(core: Pick<BillingBatchOperations,'execute'|'artifactOwnerById'>, peers: readonly string[]): DynamicModule {
    if (!core || typeof core.execute !== 'function' || typeof core.artifactOwnerById !== 'function' || !Array.isArray(peers) || !peers.length || peers.length > 100 ||
      new Set(peers).size !== peers.length || peers.some(p => !/^[a-f0-9]{64}$/.test(p))) throw new Error('EXPLICIT_BATCH_OWNER_AND_PEERS_REQUIRED');
    return { module: BillingBatchOperationsModule, controllers: [BillingBatchOperationsController], providers: [BillingBatchHttpErrorFilter,
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }] };
  }
}
