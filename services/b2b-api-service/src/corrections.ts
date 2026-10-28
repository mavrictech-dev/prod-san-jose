import { Catch, Controller, Get, HttpException, Inject, Module, Param, Post, Req, Res, UseFilters, type ArgumentsHost, type DynamicModule } from '@nestjs/common';
import {
  B2bSecurityError, b2bBindingsContain, b2bCorrectionBindingKey, validB2bCorrectionBinding,
  type B2bCorrectionBinding, type B2bIdentityScope,
} from '@factuez/contracts/b2b-security';
import { b2bIssuerId, b2bQuery, b2bUuid } from '@factuez/contracts/b2b-read-query';
import { B2bOwnerReadFrame, type B2bIdentityPort } from '@factuez/service-access/dist/b2b-read-adapter';
import { B2bPrivateHttp, b2bPrivatePeer } from '@factuez/service-access/dist/b2b';
import { correctionEvidenceFreeze } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { B2bReadErrorFilter, b2bReadHeaders } from './http';

type Kind = 'SERVICE' | 'USER';
export type B2bCorrectionAction = 'CREATE' | 'STATUS' | 'SETTLE';
export interface B2bCorrectionOwner {
  execute(token: string, kind: Kind, action: B2bCorrectionAction, args: unknown): Promise<unknown>;
}
/** Fixed mTLS transport. No URL, endpoint, credentials or fiscal command can be selected in a public body. */
export class HttpB2bCorrectionOwner implements B2bCorrectionOwner {
  constructor(private readonly http: Pick<B2bPrivateHttp, 'post'>) {}
  execute(token: string, kind: Kind, action: B2bCorrectionAction, args: unknown) {
    return this.http.post('/internal/b2b/correction-producer', { action, kind, args }, token);
  }
}
function invalid(): never { throw new B2bSecurityError(400, 'INVALID_CORRECTION_REQUEST'); }
function bounded<T>(value: T, response = false): T {
  try {
    const body = correctionEvidenceFreeze(value);
    if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) invalid();
    return body;
  } catch { if (response) throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE'); return invalid(); }
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function pair(value: unknown): B2bCorrectionBinding {
  const result = bounded(value);
  try { if (!validB2bCorrectionBinding(result)) invalid(); } catch { invalid(); }
  const binding = result as B2bCorrectionBinding;
  if (binding.reference.documentType !== '01') throw new B2bSecurityError(409, 'CORRECTION_PROFILE_NOT_ENABLED');
  return binding;
}
function createArgs(value: unknown) {
  const request = bounded(value);
  exact(request, ['schemaVersion', 'binding', 'originalDocumentId', 'idempotencyKey', 'externalReference', 'note', 'issueDate']);
  const binding = pair(request.binding);
  if (request.schemaVersion !== 'factuez.b2b.correction-create.v1' || !b2bUuid(request.originalDocumentId) ||
    typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(request.idempotencyKey) ||
    typeof request.issueDate !== 'string' || request.issueDate.length > 35 ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(request.issueDate) ||
    !Number.isFinite(Date.parse(request.issueDate))) invalid();
  exact(request.externalReference, ['namespace', 'value']);
  const ref = request.externalReference;
  if (typeof ref.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(ref.namespace) ||
    typeof ref.value !== 'string' || !ref.value.length || ref.value.length > 200 || ref.value.trim() !== ref.value || /[\x00-\x1f\x7f]/.test(ref.value)) invalid();
  // Only an adjustment input, never the owned command/context/evidence. Billing performs the complete fiscal validation.
  if (!request.note || typeof request.note !== 'object' || Array.isArray(request.note)) invalid();
  const note = request.note as Record<string, unknown>, credit = note.documentTypeCode === '07';
  if (note.documentTypeCode !== binding.noteType || typeof note.reasonCode !== 'string' ||
    !(credit ? ['01', '06', '07', '05', '09'] : ['01', '02']).includes(note.reasonCode)) invalid();
  const full = credit && ['01', '06'].includes(note.reasonCode), mora = !credit && note.reasonCode === '01';
  exact(note, ['documentTypeCode', 'reasonCode', 'reasonDescription', ...(!full ? ['lines'] : []), ...(mora ? ['interestNature', 'interestBasis'] : [])]);
  if (typeof note.reasonDescription !== 'string' || !note.reasonDescription.trim() || note.reasonDescription.length > 250 ||
    mora && (note.interestNature !== 'MORATORIO' || typeof note.interestBasis !== 'string' || !note.interestBasis.trim() || note.interestBasis.length > 500)) invalid();
  if (!full) {
    if (!Array.isArray(note.lines) || !note.lines.length || note.lines.length > 100) invalid();
    const seen = new Set<number>(), field = mora ? 'interestAmount' : credit && note.reasonCode === '07' ? 'quantity' : 'unitPriceAdjustmentWithTax';
    for (const line of note.lines) {
      exact(line, ['originalLineNumber', field]);
      if (!Number.isSafeInteger(line.originalLineNumber) || Number(line.originalLineNumber) < 1 || Number(line.originalLineNumber) > 100 ||
        seen.has(Number(line.originalLineNumber)) || typeof line[field] !== 'string' ||
        !new RegExp(`^(?:0|[1-9]\\d{0,11})(?:\\.\\d{1,${mora ? 2 : 6}})?$`).test(line[field] as string) || /^0(?:\.0+)?$/.test(line[field] as string)) invalid();
      seen.add(Number(line.originalLineNumber));
    }
  }
  return { request, binding };
}

/** Candidate public facade. Identity.authenticate is the existing quota-enforced introspection port (300/minute),
 * not a cached principal. The owner separately enforces its paired correction grant and transactional authority. */
export class B2bCorrections {
  constructor(private readonly identity: B2bIdentityPort, private readonly owner: B2bCorrectionOwner) {}
  async call(token: string, kind: Kind, action: B2bCorrectionAction, input: unknown) {
    if (!['SERVICE', 'USER'].includes(kind) || typeof token !== 'string' || !/^[A-Za-z0-9._~-]{1,8192}$/.test(token))
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    if (!['CREATE', 'STATUS', 'SETTLE'].includes(action)) invalid();
    let args: unknown, binding: B2bCorrectionBinding, operationId: string | null = null;
    if (action === 'CREATE') { const parsed = createArgs(input); args = parsed.request; binding = parsed.binding; }
    else {
      const parsed = bounded(input); exact(parsed, ['binding', 'operationId']);
      binding = pair(parsed.binding); if (!b2bUuid(parsed.operationId)) invalid(); operationId = parsed.operationId; args = parsed;
    }
    // The current paired owner authority also requires issue/write for reads; fail fast here, not after forwarding.
    const required: B2bIdentityScope[] = action === 'STATUS' ? ['b2b:corrections:read', 'b2b:corrections:write', 'b2b:documents:read', 'b2b:documents:issue'] :
      ['b2b:corrections:write', 'b2b:documents:read', 'b2b:documents:issue'];
    const frame = new B2bOwnerReadFrame(this.identity, kind), principal = await frame.principal(token, required);
    if (!b2bBindingsContain(principal.bindings, binding.reference)) throw new B2bSecurityError(404, 'RESOURCE_NOT_FOUND');
    const response = bounded(await this.owner.execute(token, kind, action, args), true);
    try {
      exact(response, ['operationId', 'binding', 'result', 'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized']);
      if (!b2bUuid(response.operationId) || operationId !== null && response.operationId !== operationId ||
        !validB2bCorrectionBinding(response.binding) || b2bCorrectionBindingKey(response.binding) !== b2bCorrectionBindingKey(binding) ||
        response.candidateOnly !== true || response.fiscalExecutionEnabled !== false || response.transmissionAuthorized !== false) throw new Error();
      if (response.result && typeof response.result === 'object' && !Array.isArray(response.result)) {
        const r = response.result as Record<string, unknown>;
        if (Object.hasOwn(r, 'operationId') && r.operationId !== response.operationId ||
          Object.hasOwn(r, 'binding') && (!validB2bCorrectionBinding(r.binding) || b2bCorrectionBindingKey(r.binding) !== b2bCorrectionBindingKey(binding)) ||
          Object.hasOwn(r, 'candidateOnly') && r.candidateOnly !== true ||
          Object.hasOwn(r, 'fiscalExecutionEnabled') && r.fiscalExecutionEnabled !== false ||
          Object.hasOwn(r, 'transmissionAuthorized') && r.transmissionAuthorized !== false) throw new Error();
      }
    } catch { throw new B2bSecurityError(503, 'INCONSISTENT_OWNER_RESPONSE'); }
    await frame.principal(token, required); // includes revision, delegated user and scopes; changed authority withholds the result
    return response;
  }
  create(token: string, kind: Kind, request: unknown) { return this.call(token, kind, 'CREATE', request); }
  status(token: string, kind: Kind, binding: unknown, operationId: string) { return this.call(token, kind, 'STATUS', { binding, operationId }); }
  settle(token: string, kind: Kind, binding: unknown, operationId: string) { return this.call(token, kind, 'SETTLE', { binding, operationId }); }
}

const CORE = Symbol('B2B correction facade'), PEERS = Symbol('B2B correction facade peers');
const QUERY = ['issuerId', 'issuerRuc', 'environment', 'branchId', 'pointId', 'seriesId', 'documentType', 'noteSeriesId', 'noteType'] as const;
/** Candidate host may install this globally to classify body-parser failures before controller filters run.
 * Never serializes parser messages/body fragments. Existing app/global filters are deliberately not modified. */
@Catch()
export class B2bCorrectionHttpErrorFilter extends B2bReadErrorFilter {
  catch(error: unknown, host: ArgumentsHost) {
    if (error instanceof Error) {
      const parser = error as Error & { type?: unknown; status?: unknown };
      if (parser.type === 'entity.too.large' && parser.status === 413)
        return super.catch(new HttpException('INVALID_REQUEST', 413), host);
      if (parser.type === 'entity.parse.failed' && parser.status === 400)
        return super.catch(new HttpException('INVALID_REQUEST', 400), host);
    }
    return super.catch(error, host);
  }
}
@Controller('b2b/v1')
@UseFilters(B2bCorrectionHttpErrorFilter)
export class B2bCorrectionController {
  constructor(@Inject(CORE) private readonly core: B2bCorrections, @Inject(PEERS) private readonly peers: readonly string[]) {}
  private context(req: any, res: any) {
    b2bReadHeaders(res); b2bPrivatePeer(req, this.peers);
    const header = req.headers.authorization, kind = req.headers['x-factuez-actor-kind'] ?? 'SERVICE';
    if (!['SERVICE', 'USER'].includes(kind) || typeof header !== 'string' || !/^Bearer [A-Za-z0-9._~-]{1,8192}$/.test(header) ||
      (req.rawHeaders?.filter((value: string, i: number) => i % 2 === 0 && value.toLowerCase() === 'authorization').length ?? 1) !== 1)
      throw new B2bSecurityError(401, 'INVALID_TOKEN');
    return { token: header.slice(7), kind: kind as Kind };
  }
  @Post('correction-notes')
  async create(@Req() req: any, @Res({ passthrough: true }) res: any) {
    const c = this.context(req, res); b2bQuery(bounded(req.query), []);
    const response = await this.core.create(c.token, c.kind, req.body); res.status(202); return response;
  }
  @Get('correction-notes/:id')
  status(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) {
    const c = this.context(req, res);
    if (req.headers['transfer-encoding'] || req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0' || req.body !== undefined) invalid();
    const q = b2bQuery(bounded(req.query), QUERY, QUERY);
    const binding = pair({ reference: { issuerId: b2bIssuerId(q.issuerId), issuerRuc: q.issuerRuc, environment: q.environment,
      branchId: q.branchId, pointId: q.pointId, seriesId: q.seriesId, documentType: q.documentType }, noteSeriesId: q.noteSeriesId, noteType: q.noteType });
    return this.core.status(c.token, c.kind, binding, id);
  }
  @Post('correction-notes/:id/settle')
  async settle(@Req() req: any, @Res({ passthrough: true }) res: any, @Param('id') id: string) {
    const c = this.context(req, res); b2bQuery(bounded(req.query), []);
    const body = bounded(req.body); exact(body, ['binding']);
    const response = await this.core.settle(c.token, c.kind, body.binding, id); res.status(200); return response;
  }
}
@Module({})
export class B2bCorrectionModule {
  static isolated(core: B2bCorrections, peers: string[]): DynamicModule {
    if (!core || !Array.isArray(peers) || !peers.length || peers.length > 100 || new Set(peers).size !== peers.length ||
      peers.some(peer => !/^[a-f0-9]{64}$/.test(peer))) throw new Error('Explicit correction facade and mTLS peers required');
    return { module: B2bCorrectionModule, controllers: [B2bCorrectionController], providers: [
      { provide: CORE, useValue: core }, { provide: PEERS, useValue: Object.freeze([...peers]) }, B2bCorrectionHttpErrorFilter,
    ] };
  }
}
