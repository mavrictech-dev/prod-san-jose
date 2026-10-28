import { describe, expect, it, vi } from 'vitest';
import { B2bSecurityError } from '../packages/contracts/src/b2b-security';
import { buildFiscalNoteSnapshot } from '../packages/sunat-core/src/fiscal-note';
import { buildFiscalSupplementCommand } from '../packages/sunat-core/src/fiscal-supplement-command';
import {
  B2bCorrectionProducer, parseCorrectionCreateRequest,
  type B2bCorrectionCreateRequest, type B2bCorrectionProducerAuthority,
  type B2bCorrectionProducerDrafts, type B2bCorrectionProducerExecution,
} from '../services/billing-service/src/b2b/correction-producer';
import { supplementCommandFixture, supplementUuid as id } from './helpers/fiscal-supplement.fixture';

/** All authority/owner/execution ports are local test doubles. No PKI, DB, transport or official CDR is asserted. */
function fixture(kind: 'SERVICE' | 'USER' = 'SERVICE', noteType: '07' | '08' = '07') {
  const f = supplementCommandFixture();
  const binding = { reference: { issuerId: f.doc.companyId!, issuerRuc: f.doc.issuer.identityNumber,
    environment: 'BETA' as const, branchId: f.doc.branchId!, pointId: id(101), seriesId: id(102), documentType: '01' as const },
    noteSeriesId: id(103), noteType };
  const note = noteType === '07' ? f.note : buildFiscalNoteSnapshot(f.context,
    { documentTypeCode: '08', reasonCode: '02', reasonDescription: 'AUMENTO FICTICIO', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1' }] },
    { documentId: id(3), series: 'FD01', number: '1', issueDate: f.note.issueDate });
  const command = buildFiscalSupplementCommand({ kind: 'NOTE', note, context: f.context },
    { eventId: id(7), correlationId: id(8), occurredAt: f.context.asOf });
  const request: B2bCorrectionCreateRequest = { schemaVersion: 'factuez.b2b.correction-create.v1', binding,
    originalDocumentId: f.doc.documentId, idempotencyKey: 'correction-fixture-0001',
    externalReference: { namespace: 'fixture.erp', value: 'credit-0001' }, note: note.adjustment, issueDate: note.issueDate };
  const state: Awaited<ReturnType<B2bCorrectionProducerAuthority['current']>> = {
    actor: { userId: kind === 'USER' ? id(104) : null,
      scope: { kind: 'ASSIGNED', branchIds: [binding.reference.branchId], emissionPointIds: [binding.reference.pointId],
        series: [binding.reference.seriesId, binding.noteSeriesId] },
      b2b: { kind, clientId: id(105), revision: 3, subjectId: kind === 'USER' ? id(104) : null,
        userAuthRevision: kind === 'USER' ? 2 : null } }, grantRevision: 2, clientRevision: 3,
  };
  const authority = { current: vi.fn<B2bCorrectionProducerAuthority['current']>(async () => structuredClone(state)) };
  const drafts = { prepare: vi.fn<B2bCorrectionProducerDrafts['prepare']>(async () => command),
    replay: vi.fn<NonNullable<B2bCorrectionProducerDrafts['replay']>>(async () => null),
    operation: vi.fn<B2bCorrectionProducerDrafts['operation']>(async () => {}) };
  const receipt = { operationId: command.payload.operationId, binding: structuredClone(binding), state: 'RESERVED',
    candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false };
  const execution = { reserve: vi.fn<B2bCorrectionProducerExecution['reserve']>(async () => receipt),
    settle: vi.fn<B2bCorrectionProducerExecution['settle']>(async () => ({ ...receipt, state: 'SETTLED' })),
    status: vi.fn<B2bCorrectionProducerExecution['status']>(async () => receipt) };
  const core = new B2bCorrectionProducer(authority, drafts, execution);
  return { ...f, kind, binding, request, command, state, receipt, authority, drafts, execution, core,
    create: (value: unknown = request) => core.create('synthetic-token', kind, value) };
}

describe('enterprise correction producer candidate; independent owner ports, never bootstrapped', () => {
  it.each(['SERVICE', 'USER'] as const)('authorizes %s with a paired grant, returns only candidate capabilities', async kind => {
    const f = fixture(kind), r = await f.create();
    expect(r).toMatchObject({ operationId: f.command.payload.operationId, binding: f.binding,
      candidateOnly: true, fiscalExecutionEnabled: false, transmissionAuthorized: false });
    expect(f.drafts.prepare).toHaveBeenCalledWith(f.request, f.state.actor);
    expect(f.execution.reserve).toHaveBeenCalledTimes(1);
    expect(f.drafts.operation).toHaveBeenCalledTimes(2);
    expect(f.authority.current).toHaveBeenCalledTimes(5);
    expect(f.authority.current.mock.calls.every(([token, k, b]) => token === 'synthetic-token' && k === kind && JSON.stringify(b) === JSON.stringify(f.binding))).toBe(true);
    expect(f.state.actor.userId).toBe(kind === 'SERVICE' ? null : id(104));
    expect(Object.isFrozen(r)).toBe(true); expect(Object.isFrozen(r.binding.reference)).toBe(true);
  });

  it.each(['07', '08'] as const)('accepts server-produced note %s and never takes a number from the request', async type => {
    const f = fixture('SERVICE', type); await f.create();
    expect(f.execution.reserve.mock.calls[0][0].payload.envelope).toMatchObject({ kind: 'NOTE', note: { documentTypeCode: type } });
    expect(f.drafts.prepare.mock.calls[0][0]).not.toHaveProperty('number');
  });

  it.each([
    { documentTypeCode: '07', reasonCode: '01', reasonDescription: 'ANULACION FICTICIA' },
    { documentTypeCode: '07', reasonCode: '06', reasonDescription: 'DEVOLUCION TOTAL FICTICIA' },
    { documentTypeCode: '07', reasonCode: '05', reasonDescription: 'DESCUENTO FICTICIO', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.25' }] },
    { documentTypeCode: '07', reasonCode: '09', reasonDescription: 'DISMINUCION FICTICIA', lines: [{ originalLineNumber: 1, unitPriceAdjustmentWithTax: '1.25' }] },
    { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'MORA FICTICIA', interestNature: 'MORATORIO', interestBasis: 'SUSTENTO FICTICIO', lines: [{ originalLineNumber: 1, interestAmount: '1.25' }] },
  ])('parses supported adjustment $documentTypeCode/$reasonCode without requesting evidence/number', input => {
    const f = fixture(), r: any = structuredClone(f.request); r.binding.noteType = input.documentTypeCode; r.note = input;
    expect(parseCorrectionCreateRequest(r).note).toEqual(input);
  });

  it.each(['wrong-nature', 'missing-basis', 'too-precise', 'zero', 'unknown-field', 'full-with-lines'])('rejects incomplete or injected profile fields: %s', async mode => {
    const f = fixture(), r: any = structuredClone(f.request);
    r.binding.noteType = '08'; r.note = { documentTypeCode: '08', reasonCode: '01', reasonDescription: 'MORA FICTICIA',
      interestNature: 'MORATORIO', interestBasis: 'SUSTENTO FICTICIO', lines: [{ originalLineNumber: 1, interestAmount: '1.25' }] };
    if (mode === 'wrong-nature') r.note.interestNature = 'COMPENSATORIO';
    if (mode === 'missing-basis') delete r.note.interestBasis;
    if (mode === 'too-precise') r.note.lines[0].interestAmount = '1.001';
    if (mode === 'zero') r.note.lines[0].interestAmount = '0';
    if (mode === 'unknown-field') r.note.lines[0].evidence = true;
    if (mode === 'full-with-lines') { r.binding.noteType = '07'; r.note = { documentTypeCode: '07', reasonCode: '06', reasonDescription: 'TOTAL FICTICIO', lines: [] }; }
    await expect(f.create(r)).rejects.toMatchObject({ status: 400 }); expect(f.drafts.prepare).not.toHaveBeenCalled();
  });

  it.each(['number', 'series', 'command', 'evidence', 'actor', 'operationId', 'candidateOnly', 'clientRevision', 'unknown'])('rejects public field %s before any owner work', async field => {
    const f = fixture(); await expect(f.create({ ...f.request, [field]: 'injected' })).rejects.toMatchObject({ status: 400 });
    expect(f.authority.current).not.toHaveBeenCalled(); expect(f.drafts.prepare).not.toHaveBeenCalled(); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it.each(['binding', 'reference', 'externalReference', 'note', 'line'])('rejects unknown nested fields in %s', async where => {
    const f = fixture(), r: any = structuredClone(f.request);
    const target = where === 'binding' ? r.binding : where === 'reference' ? r.binding.reference :
      where === 'externalReference' ? r.externalReference : where === 'note' ? r.note : r.note.lines[0];
    target.injected = true;
    await expect(f.create(r)).rejects.toMatchObject({ status: 400 }); expect(f.drafts.prepare).not.toHaveBeenCalled();
  });

  it.each([null, [], '', 1, true, undefined])('rejects non-request JSON %s', async value => {
    const f = fixture(); await expect(f.core.create('synthetic-token', 'SERVICE', value)).rejects.toMatchObject({ status: 400 });
    expect(f.authority.current).not.toHaveBeenCalled();
  });

  it.each(['getter', 'proxy', 'cycle', 'toJSON', 'hidden', 'sparse', 'huge', 'depth', 'symbol', 'prototype'])('rejects executable/non-bounded JSON: %s', async mode => {
    const f = fixture(), r: any = structuredClone(f.request), trap = vi.fn(() => { throw new Error('MUST_NOT_RUN'); });
    let value: unknown = r;
    if (mode === 'getter') Object.defineProperty(r, 'note', { get: trap, enumerable: true });
    if (mode === 'proxy') value = new Proxy(r, { ownKeys: trap });
    if (mode === 'cycle') r.loop = r;
    if (mode === 'toJSON') r.toJSON = trap;
    if (mode === 'hidden') Object.defineProperty(r, 'hidden', { value: true, enumerable: false });
    if (mode === 'sparse') r.note.lines = new Array(2);
    if (mode === 'huge') r.externalReference.value = 'x'.repeat(2 * 1024 * 1024 + 1);
    if (mode === 'depth') { let at = r; for (let i = 0; i < 40; i++) at = at.child = {}; }
    if (mode === 'symbol') r[Symbol('hidden')] = true;
    if (mode === 'prototype') Object.setPrototypeOf(r, { injected: true });
    await expect(f.create(value)).rejects.toMatchObject({ status: 400 }); expect(trap).not.toHaveBeenCalled();
    expect(f.authority.current).not.toHaveBeenCalled();
  });

  it.each(['short-key', 'long-key', 'unsafe-key', 'bad-uuid', 'bad-date', 'bad-calendar', 'unknown-schema', 'namespace', 'reference-whitespace', 'reference-control', 'reference-long', 'zero-quantity', 'duplicate-lines', 'extra-lines', 'empty-lines', 'reason', 'type', 'missing'])('rejects malformed request %s before prepare', async mode => {
    const f = fixture(), r: any = structuredClone(f.request);
    if (mode === 'short-key') r.idempotencyKey = 'short';
    if (mode === 'long-key') r.idempotencyKey = 'x'.repeat(129);
    if (mode === 'unsafe-key') r.idempotencyKey = 'x'.repeat(16) + '/';
    if (mode === 'bad-uuid') r.originalDocumentId = '1';
    if (mode === 'bad-date') r.issueDate = '2026-10-02';
    if (mode === 'bad-calendar') r.issueDate = '2026-02-30T17:00:00Z';
    if (mode === 'unknown-schema') r.schemaVersion = 'new-schema';
    if (mode === 'namespace') r.externalReference.namespace = 'contains spaces';
    if (mode === 'reference-whitespace') r.externalReference.value = ' padded ';
    if (mode === 'reference-control') r.externalReference.value = 'line\nfeed';
    if (mode === 'reference-long') r.externalReference.value = 'x'.repeat(201);
    if (mode === 'zero-quantity') r.note.lines[0].quantity = '0';
    if (mode === 'duplicate-lines') r.note.lines.push(structuredClone(r.note.lines[0]));
    if (mode === 'extra-lines') r.note.lines = Array.from({ length: 101 }, (_, i) => ({ originalLineNumber: i + 1, quantity: '1' }));
    if (mode === 'empty-lines') r.note.lines = [];
    if (mode === 'reason') r.note.reasonCode = '99';
    if (mode === 'type') r.note.documentTypeCode = '08';
    if (mode === 'missing') delete r.issueDate;
    await expect(f.create(r)).rejects.toBeInstanceOf(B2bSecurityError); expect(f.drafts.prepare).not.toHaveBeenCalled(); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it('rejects the unsupported B-series/RC profile even before authorization or number planning', async () => {
    const f = fixture(), r = structuredClone(f.request); r.binding.reference.documentType = '03';
    await expect(f.create(r)).rejects.toMatchObject({ code: 'CORRECTION_PROFILE_NOT_ENABLED' });
    expect(f.authority.current).not.toHaveBeenCalled(); expect(f.drafts.replay).not.toHaveBeenCalled(); expect(f.drafts.prepare).not.toHaveBeenCalled();
  });

  it.each(['SERVICE', 'USER'] as const)('does not prepare or execute when %s authority rejects', async kind => {
    const f = fixture(kind); f.authority.current.mockRejectedValue(new B2bSecurityError(403, 'DENIED'));
    await expect(f.create()).rejects.toMatchObject({ code: 'DENIED' });
    expect(f.drafts.replay).not.toHaveBeenCalled(); expect(f.drafts.prepare).not.toHaveBeenCalled(); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it.each(['kind', 'clientRevision', 'grantRevision', 'actor', 'scope', 'branch', 'point', 'series', 'duplicate-series'])('refuses invalid authority %s', async mode => {
    const f = fixture(), s: any = f.state;
    if (mode === 'kind') s.actor.b2b.kind = 'USER';
    if (mode === 'clientRevision') s.clientRevision = 0;
    if (mode === 'grantRevision') s.grantRevision = 0;
    if (mode === 'actor') s.actor = null;
    if (mode === 'scope') s.actor.scope = { kind: 'GLOBAL' };
    if (mode === 'branch') s.actor.scope.branchIds = [id(999)];
    if (mode === 'point') s.actor.scope.emissionPointIds = [id(999)];
    if (mode === 'series') s.actor.scope.series = [id(998), id(999)];
    if (mode === 'duplicate-series') s.actor.scope.series = [f.binding.reference.seriesId, f.binding.reference.seriesId];
    await expect(f.create()).rejects.toMatchObject({ code: 'INVALID_CORRECTION_AUTHORITY_RESPONSE' });
    expect(f.drafts.prepare).not.toHaveBeenCalled(); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it.each(['grant', 'client', 'subject', 'user-auth', 'client-id'])('rechecks authority after preparation and aborts on changed %s', async mode => {
    const f = fixture('USER');
    f.drafts.prepare.mockImplementationOnce(async () => {
      if (mode === 'grant') f.state.grantRevision++;
      if (mode === 'client') { f.state.clientRevision++; f.state.actor.b2b!.revision++; }
      if (mode === 'subject') { f.state.actor.userId = id(998); f.state.actor.b2b!.subjectId = id(998); }
      if (mode === 'user-auth') f.state.actor.b2b!.userAuthRevision!++;
      if (mode === 'client-id') f.state.actor.b2b!.clientId = id(999);
      return f.command;
    });
    await expect(f.create()).rejects.toMatchObject({ code: 'CORRECTION_AUTHORITY_CHANGED' }); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it('reauthorizes after the owner guard, before executing a reserved plan', async () => {
    const f = fixture(); f.drafts.operation.mockImplementationOnce(async () => { f.state.grantRevision++; });
    await expect(f.create()).rejects.toMatchObject({ code: 'CORRECTION_AUTHORITY_CHANGED' }); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it.each(['original', 'company', 'branch', 'ruc', 'note-type', 'date', 'adjustment', 'batch', 'hash', 'production'])('rejects a prepared command inconsistent with request: %s', async mode => {
    const f = fixture(), request: any = structuredClone(f.request);
    if (mode === 'original') request.originalDocumentId = id(999);
    if (mode === 'company') request.binding.reference.issuerId++;
    if (mode === 'branch') { request.binding.reference.branchId = id(999); (f.state.actor.scope as any).branchIds = [id(999)]; }
    if (mode === 'ruc') request.binding.reference.issuerRuc = '20131312955';
    if (mode === 'note-type') { request.binding.noteType = '08'; request.note = fixture('SERVICE', '08').request.note; }
    if (mode === 'date') request.issueDate = '2026-10-02T17:01:00Z';
    if (mode === 'adjustment') request.note.lines[0].quantity = '0.5';
    if (mode === 'batch') f.drafts.prepare.mockResolvedValueOnce(supplementCommandFixture('RA').command);
    if (mode === 'hash') { const c = structuredClone(f.command); c.payload.envelopeSha256 = 'f'.repeat(64); f.drafts.prepare.mockResolvedValueOnce(c); }
    if (mode === 'production') { const c: any = structuredClone(f.command); c.payload.environment = 'PRODUCTION'; f.drafts.prepare.mockResolvedValueOnce(c); }
    await expect(f.create(request)).rejects.toMatchObject({ code: 'INVALID_CORRECTION_PREPARED_COMMAND' }); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it('requires the operation owner to validate catalogue IDs absent from the fiscal snapshot', async () => {
    const f = fixture(), otherPair = structuredClone(f.binding); otherPair.noteSeriesId = id(999);
    const r = { ...f.request, binding: otherPair }; (f.state.actor.scope as any).series = [otherPair.reference.seriesId, otherPair.noteSeriesId];
    f.drafts.operation.mockRejectedValueOnce(new B2bSecurityError(404, 'OPERATION_NOT_OWNED'));
    await expect(f.create(r)).rejects.toMatchObject({ code: 'OPERATION_NOT_OWNED' }); expect(f.execution.reserve).not.toHaveBeenCalled();
    expect(f.drafts.operation).toHaveBeenCalledWith(otherPair, f.command.payload.operationId, f.state.actor);
  });

  it('uses immutable detached request, actor and command snapshots across awaited owner calls', async () => {
    const f = fixture();
    f.drafts.prepare.mockImplementationOnce(async (r, actor) => {
      expect(Object.isFrozen(r.note)).toBe(true); expect(Object.isFrozen(actor.scope)).toBe(true);
      f.request.note.reasonDescription = 'CALLER MUTATION'; f.command.correlationId = id(998);
      return structuredClone(f.command);
    });
    const r = await f.create(); expect(r.result).toMatchObject({ state: 'RESERVED' });
    expect(f.execution.reserve.mock.calls[0][0].payload.envelope.kind).toBe('NOTE');
    expect(Object.isFrozen(f.execution.reserve.mock.calls[0][0].payload.envelope)).toBe(true);
    expect((f.execution.reserve.mock.calls[0][0].payload.envelope as any).note.adjustment.reasonDescription).not.toBe('CALLER MUTATION');
  });

  it('supports a missing optional replay port but never an absent owner-operation guard', async () => {
    const f = fixture(), core = new B2bCorrectionProducer(f.authority, { prepare: f.drafts.prepare, operation: f.drafts.operation }, f.execution);
    await core.create('synthetic-token', 'SERVICE', f.request); expect(f.drafts.prepare).toHaveBeenCalledTimes(1);
    expect(() => new B2bCorrectionProducer(f.authority, { prepare: f.drafts.prepare } as any, f.execution)).toThrow('operation port required');
  });

  it('replays the owned immutable command instead of preparing/allocating again', async () => {
    const f = fixture(); f.drafts.replay.mockResolvedValue(f.command);
    await f.create(); await f.create(); expect(f.drafts.prepare).not.toHaveBeenCalled();
    expect(f.execution.reserve).toHaveBeenCalledTimes(2);
    expect(f.execution.reserve.mock.calls[0][0]).toEqual(f.execution.reserve.mock.calls[1][0]);
  });

  it('propagates the owner idempotency/external-reference conflict, without fallback preparation', async () => {
    const f = fixture(); f.drafts.replay.mockRejectedValueOnce(new B2bSecurityError(409, 'IDEMPOTENCY_CONFLICT'));
    await expect(f.create()).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(f.drafts.prepare).not.toHaveBeenCalled(); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it.each(['prepare', 'reserve'] as const)('does not manufacture success after %s failure', async stage => {
    const f = fixture(), error = new Error('OWNER_UNAVAILABLE');
    (stage === 'prepare' ? f.drafts.prepare : f.execution.reserve).mockRejectedValueOnce(error);
    await expect(f.create()).rejects.toBe(error);
    expect(f.execution.settle).not.toHaveBeenCalled(); expect(f.execution.status).not.toHaveBeenCalled();
  });

  it.each(['grant', 'ownership'] as const)('withholds a reserve result when %s changes during execution', async mode => {
    const f = fixture(); f.execution.reserve.mockImplementationOnce(async () => {
      if (mode === 'grant') f.state.grantRevision++;
      else f.drafts.operation.mockRejectedValueOnce(new B2bSecurityError(404, 'OPERATION_NOT_OWNED'));
      return f.receipt;
    });
    await expect(f.create()).rejects.toBeInstanceOf(B2bSecurityError); expect(f.execution.reserve).toHaveBeenCalledTimes(1);
  });

  it.each(['SERVICE', 'USER'] as const)('guards status and settlement for %s before and after owner execution', async kind => {
    const f = fixture(kind);
    for (const method of ['status', 'settle'] as const) {
      f.authority.current.mockClear(); f.drafts.operation.mockClear();
      const r = await f.core[method]('synthetic-token', kind, f.binding, f.command.payload.operationId);
      expect(r.transmissionAuthorized).toBe(false); expect(r.fiscalExecutionEnabled).toBe(false);
      expect(f.execution[method]).toHaveBeenCalledWith(f.command.payload.operationId);
      expect(f.drafts.operation).toHaveBeenCalledTimes(2); expect(f.authority.current).toHaveBeenCalledTimes(4);
    }
    expect(f.drafts.prepare).not.toHaveBeenCalled(); expect(f.execution.reserve).not.toHaveBeenCalled();
  });

  it.each(['status', 'settle'] as const)('does not expose %s for another operation/owner even with a valid paired grant', async method => {
    const f = fixture(); f.drafts.operation.mockRejectedValueOnce(new B2bSecurityError(404, 'OPERATION_NOT_OWNED'));
    await expect(f.core[method]('synthetic-token', 'SERVICE', f.binding, id(999))).rejects.toMatchObject({ status: 404 });
    expect(f.execution[method]).not.toHaveBeenCalled(); expect(f.authority.current).toHaveBeenCalledTimes(1);
  });

  it.each(['status', 'settle'] as const)('reauthorizes before %s and withholds stale results', async method => {
    const f = fixture(); f.drafts.operation.mockImplementationOnce(async () => { f.state.grantRevision++; });
    await expect(f.core[method]('synthetic-token', 'SERVICE', f.binding, id(3))).rejects.toMatchObject({ code: 'CORRECTION_AUTHORITY_CHANGED' });
    expect(f.execution[method]).not.toHaveBeenCalled();
    f.drafts.operation.mockReset(); f.drafts.operation.mockResolvedValue(undefined);
    f.execution[method].mockImplementationOnce(async () => { f.state.grantRevision++; return f.receipt; });
    await expect(f.core[method]('synthetic-token', 'SERVICE', f.binding, id(3))).rejects.toMatchObject({ code: 'CORRECTION_AUTHORITY_CHANGED' });
  });

  it.each(['status', 'settle'] as const)('does not release %s after an owner failure or post-read ownership loss', async method => {
    const f = fixture(); f.execution[method].mockRejectedValueOnce(new Error('OWNER_UNAVAILABLE'));
    await expect(f.core[method]('synthetic-token', 'SERVICE', f.binding, id(3))).rejects.toThrow('OWNER_UNAVAILABLE');
    f.drafts.operation.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new B2bSecurityError(404, 'NOT_OWNED'));
    await expect(f.core[method]('synthetic-token', 'SERVICE', f.binding, id(3))).rejects.toMatchObject({ status: 404 });
    expect(f.execution[method]).toHaveBeenCalledTimes(2);
  });

  it.each(['operationId', 'binding', 'candidateOnly', 'fiscalExecutionEnabled', 'transmissionAuthorized', 'getter'])('refuses an execution receipt with inconsistent %s', async mode => {
    const f = fixture(), r: any = structuredClone(f.receipt);
    if (mode === 'operationId') r.operationId = id(999);
    if (mode === 'binding') r.binding.noteSeriesId = id(999);
    if (mode === 'candidateOnly') r.candidateOnly = false;
    if (mode === 'fiscalExecutionEnabled') r.fiscalExecutionEnabled = true;
    if (mode === 'transmissionAuthorized') r.transmissionAuthorized = true;
    if (mode === 'getter') Object.defineProperty(r, 'secret', { get: () => { throw new Error('DO_NOT_RUN'); }, enumerable: true });
    f.execution.reserve.mockResolvedValueOnce(r);
    await expect(f.create()).rejects.toMatchObject({ code: 'INVALID_CORRECTION_EXECUTION_RESPONSE' });
  });

  it('accepts an identity-free JSON result only because the owner operation guard is required on both sides', async () => {
    const f = fixture(); f.execution.status.mockResolvedValueOnce({ state: 'UNKNOWN' });
    expect(await f.core.status('synthetic-token', 'SERVICE', f.binding, id(3))).toMatchObject({ operationId: id(3), result: { state: 'UNKNOWN' }, candidateOnly: true });
    expect(f.drafts.operation).toHaveBeenCalledTimes(2);
  });

  it.each(['', 'two tokens', 'x\nheader', 'x'.repeat(8193)])('rejects malformed token before owner calls (length %i)', async token => {
    const f = fixture(); await expect(f.core.create(token, 'SERVICE', f.request)).rejects.toMatchObject({ status: 401 });
    expect(f.authority.current).not.toHaveBeenCalled();
  });

  it('rejects an invalid kind, malformed operation ID and production binding without reaching execution', async () => {
    const f = fixture(); await expect(f.core.create('token', 'ADMIN' as any, f.request)).rejects.toMatchObject({ status: 401 });
    await expect(f.core.status('token', 'SERVICE', f.binding, 'not-uuid')).rejects.toMatchObject({ status: 400 });
    await expect(f.core.settle('token', 'SERVICE', { ...f.binding, reference: { ...f.binding.reference, environment: 'PRODUCTION' } }, id(3))).rejects.toMatchObject({ status: 400 });
    expect(f.authority.current).not.toHaveBeenCalled(); expect(f.execution.settle).not.toHaveBeenCalled();
  });

  it('exports a detached strict parser for the request-scoped factory', () => {
    const f = fixture(), parsed = parseCorrectionCreateRequest(f.request);
    expect(parsed).toEqual(f.request); expect(parsed).not.toBe(f.request); expect(Object.isFrozen(parsed.note)).toBe(true);
    f.request.externalReference.value = 'changed'; expect(parsed.externalReference.value).toBe('credit-0001');
  });
});
