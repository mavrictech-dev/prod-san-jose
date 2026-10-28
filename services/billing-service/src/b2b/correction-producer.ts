import {
  B2bSecurityError, b2bCorrectionBindingKey, validB2bCorrectionBinding, type B2bCorrectionBinding,
} from '@factuez/contracts/b2b-security';
import { correctionEvidenceFreeze, correctionEvidenceHash } from '@factuez/service-access/dist/b2b-correction-evidence-wire';
import { fiscalDecimal, fiscalText, fiscalTimestamp, type FiscalNoteInput } from '@factuez/sunat-core/dist/fiscal-note';
import { validateFiscalSupplementCommand, type FiscalSupplementCommand } from '@factuez/sunat-core/dist/fiscal-supplement-command';
import { supplementActor, type SupplementActor } from '../application/supplement-actor';

type Kind = 'SERVICE' | 'USER';
export type B2bCorrectionCreateRequest = {
  schemaVersion: 'factuez.b2b.correction-create.v1';
  binding: B2bCorrectionBinding;
  originalDocumentId: string;
  idempotencyKey: string;
  externalReference: { namespace: string; value: string };
  note: FiscalNoteInput;
  issueDate: string;
};
export type CorrectionCreateRequest = B2bCorrectionCreateRequest;
export interface B2bCorrectionProducerAuthority {
  current(token: string, kind: Kind, binding: B2bCorrectionBinding): Promise<{
    actor: SupplementActor; grantRevision: number; clientRevision: number;
  }>;
}
export interface B2bCorrectionProducerDrafts {
  /** Read-only owner preflight: owns idempotency/external-reference checks and selects point/series/number server-side.
   * May retain a transient immutable plan; persist its receipt atomically with note/counter/Outbox in reserve,
   * not as separate writes here. Must not issue a document or enqueue transmission during preparation. */
  prepare(request: B2bCorrectionCreateRequest, actor: SupplementActor): Promise<FiscalSupplementCommand>;
  /** An exact prior request may replay; reuse with a different request MUST fail, not silently return the old command. */
  replay?(request: B2bCorrectionCreateRequest, actor: SupplementActor): Promise<FiscalSupplementCommand | null>;
  /** REQUIRED canonical ownership check for a planned OR reserved operation: exact pair (including point/series IDs)
   * AND actor/client ownership. The fiscal command only carries series labels, not these catalogue UUIDs.
   * Throw on absence/mismatch; never implement this as a caller-supplied binding echo. */
  operation(binding: B2bCorrectionBinding, operationId: string, actor: SupplementActor): Promise<void>;
}
export interface B2bCorrectionProducerExecution {
  /** Must independently reauthorize inside its reservation transaction. The facade is not the transaction gate. */
  reserve(command: FiscalSupplementCommand): Promise<unknown>;
  /** Must independently reauthorize when committing a financial outcome; no permission to transmit is implied. */
  settle(operationId: string): Promise<unknown>;
  status(operationId: string): Promise<unknown>;
}
export type B2bCorrectionProducerReceipt = {
  operationId: string; binding: B2bCorrectionBinding; result: unknown;
  candidateOnly: true; fiscalExecutionEnabled: false; transmissionAuthorized: false;
};

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
function fail(status: number, code: string): never { throw new B2bSecurityError(status, code); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some(key => !Object.hasOwn(value, key))) fail(400, 'INVALID_CORRECTION_CREATE_REQUEST');
}
function detach<T>(value: T, status = 400, code = 'INVALID_CORRECTION_CREATE_REQUEST'): T {
  try { return correctionEvidenceFreeze(value); } catch { return fail(status, code); }
}
function bindingValue(value: unknown): B2bCorrectionBinding {
  const binding = detach(value);
  try { if (!validB2bCorrectionBinding(binding)) fail(400, 'INVALID_CORRECTION_BINDING'); }
  catch { return fail(400, 'INVALID_CORRECTION_BINDING'); }
  return binding as B2bCorrectionBinding;
}
function credentials(token: string, kind: Kind): void {
  if (typeof token !== 'string' || !token.length || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token) ||
    !['SERVICE', 'USER'].includes(kind)) fail(401, 'INVALID_CORRECTION_CREDENTIALS');
}
function profile(binding: B2bCorrectionBinding): void {
  // B-series require the separate RC producer; never wrap them in an individual sendBill command.
  if (binding.reference.documentType !== '01') fail(409, 'CORRECTION_PROFILE_NOT_ENABLED');
}
function noteValue(value: unknown, binding: B2bCorrectionBinding): asserts value is FiscalNoteInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_CORRECTION_CREATE_REQUEST');
  const note = value as Record<string, unknown>, credit = note.documentTypeCode === '07', debit = note.documentTypeCode === '08';
  if (note.documentTypeCode !== binding.noteType) fail(400, 'CORRECTION_NOTE_TYPE_MISMATCH');
  if (!(credit && ['01', '06', '07', '05', '09'].includes(String(note.reasonCode))) &&
    !(debit && ['01', '02'].includes(String(note.reasonCode)))) fail(409, 'CORRECTION_PROFILE_NOT_ENABLED');
  const full = credit && ['01', '06'].includes(String(note.reasonCode)), mora = debit && note.reasonCode === '01';
  exact(note, ['documentTypeCode', 'reasonCode', 'reasonDescription', ...(!full ? ['lines'] : []),
    ...(mora ? ['interestNature', 'interestBasis'] : [])]);
  try {
    fiscalText(note.reasonDescription, 250, 'reasonDescription');
    if (mora) {
      if (note.interestNature !== 'MORATORIO') throw new Error();
      fiscalText(note.interestBasis, 500, 'interestBasis');
    }
    if (!full) {
      if (!Array.isArray(note.lines) || note.lines.length < 1 || note.lines.length > 100) throw new Error();
      const seen = new Set<number>();
      for (const line of note.lines) {
        const field = mora ? 'interestAmount' : credit && note.reasonCode === '07' ? 'quantity' : 'unitPriceAdjustmentWithTax';
        exact(line, ['originalLineNumber', field]);
        if (!Number.isSafeInteger(line.originalLineNumber) || Number(line.originalLineNumber) < 1 ||
          Number(line.originalLineNumber) > 100 || seen.has(Number(line.originalLineNumber))) throw new Error();
        seen.add(Number(line.originalLineNumber)); fiscalDecimal(line[field], mora ? 2 : 6, true, field);
      }
    }
  } catch { fail(400, 'INVALID_CORRECTION_CREATE_REQUEST'); }
}
export function parseCorrectionCreateRequest(value: unknown): B2bCorrectionCreateRequest {
  const request = detach(value);
  exact(request, ['schemaVersion', 'binding', 'originalDocumentId', 'idempotencyKey', 'externalReference', 'note', 'issueDate']);
  if (request.schemaVersion !== 'factuez.b2b.correction-create.v1' || typeof request.originalDocumentId !== 'string' ||
    !UUID.test(request.originalDocumentId) || typeof request.idempotencyKey !== 'string' ||
    request.idempotencyKey.length < 16 || request.idempotencyKey.length > 128 || !SAFE_KEY.test(request.idempotencyKey))
    fail(400, 'INVALID_CORRECTION_CREATE_REQUEST');
  const binding = bindingValue(request.binding); profile(binding);
  exact(request.externalReference, ['namespace', 'value']);
  const ref = request.externalReference;
  if (typeof ref.namespace !== 'string' || ref.namespace.length < 1 || ref.namespace.length > 64 || !SAFE_KEY.test(ref.namespace) ||
    typeof ref.value !== 'string' || !ref.value.length || ref.value.length > 200 || ref.value.trim() !== ref.value ||
    /[\x00-\x1f\x7f]/.test(ref.value)) fail(400, 'INVALID_CORRECTION_CREATE_REQUEST');
  try { fiscalTimestamp(request.issueDate, 'issueDate'); } catch { fail(400, 'INVALID_CORRECTION_CREATE_REQUEST'); }
  noteValue(request.note, binding);
  return request as B2bCorrectionCreateRequest;
}

/** Independently injectable enterprise candidate. NOT a registered controller, fiscal activation or bootstrap.
 * All three ports are trusted owner adapters, never public JSON. No evidence or number is accepted from a caller. */
export class B2bCorrectionProducer {
  constructor(
    private readonly authority: B2bCorrectionProducerAuthority,
    private readonly drafts: B2bCorrectionProducerDrafts,
    private readonly execution: B2bCorrectionProducerExecution,
  ) {
    if (typeof drafts.operation !== 'function') throw new Error('Billing-owned correction operation port required');
  }

  private async authorize(token: string, kind: Kind, binding: B2bCorrectionBinding) {
    const current = detach(await this.authority.current(token, kind, binding), 503, 'INVALID_CORRECTION_AUTHORITY_RESPONSE');
    try {
      const actor = detach(supplementActor(current.actor)), p = actor.b2b, scope = actor.scope;
      if (!Number.isSafeInteger(current.grantRevision) || current.grantRevision < 1 || !Number.isSafeInteger(current.clientRevision) ||
        current.clientRevision < 1 || !p || p.kind !== kind || p.revision !== current.clientRevision || scope.kind !== 'ASSIGNED' ||
        scope.branchIds.length !== 1 || scope.branchIds[0] !== binding.reference.branchId ||
        scope.emissionPointIds.length !== 1 || scope.emissionPointIds[0] !== binding.reference.pointId ||
        scope.series.length !== 2 || new Set(scope.series).size !== 2 ||
        ![binding.reference.seriesId, binding.noteSeriesId].every(id => scope.series.includes(id))) throw new Error();
      // Ignore optional capability flags on an authority response; none activates this producer.
      return detach({ actor, grantRevision: current.grantRevision, clientRevision: current.clientRevision });
    } catch { return fail(503, 'INVALID_CORRECTION_AUTHORITY_RESPONSE'); }
  }

  private async fresh(token: string, kind: Kind, binding: B2bCorrectionBinding, initial: Awaited<ReturnType<B2bCorrectionProducer['authorize']>>) {
    const current = await this.authorize(token, kind, binding);
    if (correctionEvidenceHash(current) !== correctionEvidenceHash(initial)) fail(409, 'CORRECTION_AUTHORITY_CHANGED');
  }

  private command(value: unknown, request: B2bCorrectionCreateRequest): FiscalSupplementCommand {
    try {
      const command = validateFiscalSupplementCommand(detach(value)), p = command.payload, e = p.envelope, b = request.binding.reference;
      if (p.environment !== 'BETA' || p.companyId !== b.issuerId || p.issuerRuc !== b.issuerRuc || p.branchId !== b.branchId ||
        p.operationKind !== 'NOTE' || e.kind !== 'NOTE') throw new Error();
      const n = e.note, original = e.context.original;
      if (original.documentId !== request.originalDocumentId || original.documentTypeCode !== b.documentType ||
        original.companyId !== b.issuerId || original.branchId !== b.branchId || original.issuer.identityNumber !== b.issuerRuc ||
        original.environment !== 'BETA' || n.environment !== 'BETA' || n.companyId !== b.issuerId || n.branchId !== b.branchId ||
        n.issuer.identityNumber !== b.issuerRuc || n.documentTypeCode !== request.binding.noteType ||
        n.reference.documentId !== request.originalDocumentId || n.issueDate !== request.issueDate ||
        correctionEvidenceHash(n.adjustment) !== correctionEvidenceHash(request.note)) throw new Error();
      return detach(command);
    } catch { return fail(503, 'INVALID_CORRECTION_PREPARED_COMMAND'); }
  }

  private result(result: unknown, binding: B2bCorrectionBinding, operationId: string): B2bCorrectionProducerReceipt {
    const receipt = detach(result, 503, 'INVALID_CORRECTION_EXECUTION_RESPONSE');
    // The owner guard is mandatory even when a receipt has no identity fields. If supplied, identities/flags must agree.
    if (receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt)) {
      const r = receipt as Record<string, unknown>;
      try {
        if (Object.hasOwn(r, 'operationId') && r.operationId !== operationId ||
          Object.hasOwn(r, 'binding') && (!validB2bCorrectionBinding(r.binding) ||
            b2bCorrectionBindingKey(r.binding) !== b2bCorrectionBindingKey(binding)) ||
          Object.hasOwn(r, 'candidateOnly') && r.candidateOnly !== true ||
          Object.hasOwn(r, 'fiscalExecutionEnabled') && r.fiscalExecutionEnabled !== false ||
          Object.hasOwn(r, 'transmissionAuthorized') && r.transmissionAuthorized !== false) throw new Error();
      } catch { fail(503, 'INVALID_CORRECTION_EXECUTION_RESPONSE'); }
    }
    return detach({ operationId, binding, result: receipt,
      candidateOnly: true as const, fiscalExecutionEnabled: false as const, transmissionAuthorized: false as const });
  }

  async create(token: string, kind: Kind, value: unknown): Promise<B2bCorrectionProducerReceipt> {
    credentials(token, kind);
    const request = parseCorrectionCreateRequest(value), binding = request.binding, initial = await this.authorize(token, kind, binding);
    const prior = this.drafts.replay ? await this.drafts.replay(request, initial.actor) : null;
    const command = this.command(prior === null ? await this.drafts.prepare(request, initial.actor) : prior, request);
    await this.fresh(token, kind, binding, initial);
    await this.drafts.operation(binding, command.payload.operationId, initial.actor);
    await this.fresh(token, kind, binding, initial);
    const result = await this.execution.reserve(command);
    await this.fresh(token, kind, binding, initial);
    await this.drafts.operation(binding, command.payload.operationId, initial.actor);
    await this.fresh(token, kind, binding, initial);
    return this.result(result, binding, command.payload.operationId);
  }

  private async operation(action: 'settle' | 'status', token: string, kind: Kind, value: unknown, operationId: string) {
    credentials(token, kind);
    const binding = bindingValue(value); profile(binding);
    if (typeof operationId !== 'string' || !UUID.test(operationId)) fail(400, 'INVALID_CORRECTION_OPERATION_ID');
    const initial = await this.authorize(token, kind, binding);
    await this.drafts.operation(binding, operationId, initial.actor);
    await this.fresh(token, kind, binding, initial);
    const result = await this.execution[action](operationId);
    await this.fresh(token, kind, binding, initial);
    await this.drafts.operation(binding, operationId, initial.actor);
    await this.fresh(token, kind, binding, initial);
    return this.result(result, binding, operationId);
  }

  settle(token: string, kind: Kind, binding: unknown, operationId: string): Promise<B2bCorrectionProducerReceipt> {
    return this.operation('settle', token, kind, binding, operationId);
  }
  status(token: string, kind: Kind, binding: unknown, operationId: string): Promise<B2bCorrectionProducerReceipt> {
    return this.operation('status', token, kind, binding, operationId);
  }
}
