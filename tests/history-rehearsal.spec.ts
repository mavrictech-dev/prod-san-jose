import { describe, expect, it, vi } from 'vitest';
import { prepareHistoryExport, prepareHistoryRow, previewHistory } from '../migration/history-preview';
import { HistoryRehearsalError, rehearseHistoryArchive } from '../migration/history-rehearsal';
import { historyRow as row, historyExport as exported, cloneHistory as clone } from './helpers/history-stage3-fixtures';

describe('fase 3: normalización separada e inmutable', () => {
  it('conserva el hash del contrato anterior y ordena sin mutar el input', () => {
    const input = exported([row(3), row(1)]), original = clone(input);
    const prepared = prepareHistoryExport(input);
    expect(prepared.report).toEqual(previewHistory(input));
    expect(prepared.source.rows.map(r => r.number)).toEqual(['1', '3']);
    expect(previewHistory(prepared.source).plan.inputSha256).toBe(prepared.report.plan.inputSha256);
    expect(input).toEqual(original);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.source.rows[0].artifacts[0])).toBe(true);
    (input.rows[0].amounts as any).payableAmount = '999.00';
    expect(prepared.source.rows[1].amounts.payableAmount).toBe('1.18');
  });
  it('rechaza getters sin ejecutarlos', () => {
    const getter = vi.fn(), input = { ...exported() };
    Object.defineProperty(input, 'rows', { enumerable: true, get: getter });
    expect(() => prepareHistoryExport(input)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('rechaza proxies sin activar trampas', () => {
    const trap = vi.fn();
    expect(() => prepareHistoryExport(new Proxy(exported(), { ownKeys: trap }))).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
  it('comparación de fila usa la misma normalización estricta y detachment', () => {
    const input = row(), normalized = prepareHistoryRow(input);
    expect(normalized).toEqual(prepareHistoryExport(exported([input])).source.rows[0]);
    (input.amounts as any).payableAmount = '2.00';
    expect(normalized.amounts.payableAmount).toBe('1.18'); expect(Object.isFrozen(normalized)).toBe(true);
    expect(() => prepareHistoryRow({ ...row(), issueCommand: 'NO' })).toThrow();
  });
});

describe('fase 3: archivo candidato en memoria, no importador fiscal', () => {
  it('no declara persistencia, confianza CDR, emisión o copias', () => {
    const result = rehearseHistoryArchive(exported());
    expect(result).toMatchObject({ simulationOnly: true, persisted: false, environment: 'BETA',
      productionBlocked: true, databaseWrites: 0, fiscalWrites: 0, artifactCopies: 0,
      transmission: false, cdrAuthenticityVerified: false, countersChanged: false,
      checkpointPurpose: 'IN_MEMORY_REHEARSAL_NOT_DATABASE_COMMIT', complete: true,
      candidateRowCount: 1, addedRows: 1, remainingBatches: 0 });
    expect(result.state.records[0]).toMatchObject({ disposition: 'QUARANTINED_PENDING_FISCAL_REVIEW', row: row() });
    expect(result.state.records[0].archiveKey).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(result.state.records[0].row.amounts)).toBe(true);
    for (const field of ['nextNumber', 'outbox', 'reserveNumber', 'ACCEPTED']) expect(JSON.stringify(result)).not.toContain(field);
  });
  it('mantiene el valor de notas positivo y separado, sin netear ventas', () => {
    const credit = row(1, { type: '07', series: 'BQ02', originId: 'FICTICIO-NOTA',
      ownIssuerMapping: { ...row().ownIssuerMapping, type: '07', series: 'BQ02',
        seriesCounterId: '90000000-0000-4000-8000-000000000004' } });
    const result = rehearseHistoryArchive(exported([row(), credit]));
    expect(result.state.records).toHaveLength(2);
    expect(result.state.records[1].row.amounts.payableAmount).toBe('1.18');
    expect(result.state.records[0].archiveKey).not.toBe(result.state.records[1].archiveKey);
  });
  it('permite ensayo de filas sin CDR pero las mantiene en cuarentena', () => {
    expect(rehearseHistoryArchive(exported([row(1, { artifacts: [] })]))).toMatchObject({
      metadataStatus: 'REVIEW_REQUIRED', cdrAuthenticityVerified: false, persisted: false });
  });
  it('un export vacío no simula registros ni escrituras', () => {
    const result = rehearseHistoryArchive(exported([]));
    expect(result).toMatchObject({ complete: true, candidateRowCount: 0, addedRows: 0, remainingBatches: 0 });
    expect(result.state.records).toEqual([]); expect(result.state.receipts).toEqual([]);
  });
  it.each([1, 499, 500, 501, 1_001])('reanuda %i filas por lotes sin duplicar prefijos', count => {
    const input = exported(Array.from({ length: count }, (_, i) => row(i + 1)));
    const before = JSON.stringify(input);
    let result = rehearseHistoryArchive(input);
    expect(result.candidateRowCount).toBe(Math.min(500, count));
    while (!result.complete) {
      const previous = result;
      result = rehearseHistoryArchive(input, clone(result.state));
      expect(result.state.records.slice(0, previous.candidateRowCount)).toEqual(previous.state.records);
      expect(result.addedRows).toBe(Math.min(500, count - previous.candidateRowCount));
    }
    const replay = rehearseHistoryArchive(input, clone(result.state));
    expect(replay).toMatchObject({ deduplicated: true, addedRows: 0, candidateRowCount: count });
    expect(replay.state).toEqual(result.state);
    expect(new Set(result.state.records.map(r => r.archiveKey)).size).toBe(count);
    expect(JSON.stringify(input)).toBe(before);
  });
  it('presupuesto de dos lotes termina un export de 501 filas', () => {
    expect(rehearseHistoryArchive(exported(Array.from({ length: 501 }, (_, i) => row(i + 1))), undefined, 2))
      .toMatchObject({ candidateRowCount: 501, complete: true, addedRows: 501 });
  });
  it('orden original del export no afecta la reanudación', () => {
    const input = exported([row(3), row(1)]), first = rehearseHistoryArchive(input);
    const next = rehearseHistoryArchive(exported([...input.rows].reverse()), clone(first.state));
    expect(next.state).toEqual(first.state); expect(next.addedRows).toBe(0);
  });
  it.each([0, -1, 21, 1.5, NaN, Infinity, '1', null, {}, undefined].map(value => ({ value })))
    ('comprueba límites y default del presupuesto %#', ({ value }) => {
      // undefined explicitly defaults to 1 in the JS API and is not invalid.
      if (value === undefined) { expect(rehearseHistoryArchive(exported(), undefined, value).complete).toBe(true); return; }
      expect(() => rehearseHistoryArchive(exported(), undefined, value as any)).toThrow(HistoryRehearsalError);
    });
  it.each([
    (input: any) => { input.rows.push(clone(input.rows[0])); },
    (input: any) => { input.rows[0].amounts.payableAmount = '2.00'; },
    (input: any) => { input.rows[0].tax[0].taxAmount = '0.19'; },
    (input: any) => { input.rows[0].ownIssuerMapping.companyId = 998; },
  ])('bloquea inconsistencias antes de producir candidatos %#', mutate => {
    const input = clone(exported()); mutate(input);
    expect(() => rehearseHistoryArchive(input)).toThrow(/BLOCKED_METADATA|OWN_ISSUER_MAPPING_MISMATCH/);
  });
  it.each(['PRODUCTION', 'production', 'TEST', undefined])('sólo BETA, no %s', environment => {
    expect(() => rehearseHistoryArchive({ ...exported(), environment })).toThrow();
  });
  it.each([
    (input: any) => { input.rows[0].originId = 'OTRO'; },
    (input: any) => { input.rows[0].artifacts[0].sha256 = 'b'.repeat(64); },
    (input: any) => { input.rows[0].ownIssuerMapping.branchId = '90000000-0000-4000-8000-000000000005'; },
    (input: any) => { input.rows[0].issueDate = '2026-10-01T11:00:00-05:00'; },
  ])('invalida estado al cambiar el export %#', mutate => {
    const first = rehearseHistoryArchive(exported());
    const input = clone(exported()); mutate(input);
    expect(() => rehearseHistoryArchive(input, first.state)).toThrow(/STATE_PLAN_MISMATCH/);
  });
  const mutations = [
    (s: any) => { s.schemaVersion = 'otro'; },
    (s: any) => { s.inputSha256 = 'b'.repeat(64); },
    (s: any) => { s.planSha256 = 'b'.repeat(64); },
    (s: any) => { s.extra = 'no permitido'; },
    (s: any) => { s.completedBatches = -1; },
    (s: any) => { s.completedBatches = 2; },
    (s: any) => { s.completedBatches = '1'; },
    (s: any) => { s.records.pop(); },
    (s: any) => { s.records.push(clone(s.records[0])); },
    (s: any) => { s.records.reverse(); },
    (s: any) => { s.records[0].row = clone(s.records[1].row); },
    (s: any) => { s.records[0].row.amounts.payableAmount = '2.00'; },
    (s: any) => { s.records[0].row.command = 'issue'; },
    (s: any) => { s.records[0].archiveKey = 'b'.repeat(64); },
    (s: any) => { s.records[0].originIdentity = 'inventado'; },
    (s: any) => { s.records[0].fiscalIdentity = 'inventado'; },
    (s: any) => { s.records[0].rowSha256 = 'b'.repeat(64); },
    (s: any) => { s.records[0].disposition = 'ACCEPTED'; },
    (s: any) => { s.records[0].extra = true; },
    (s: any) => { s.receipts.pop(); },
    (s: any) => { s.receipts[0].index = 1; },
    (s: any) => { s.receipts[0].rowCount = 1; },
    (s: any) => { s.receipts[0].recordsSha256 = 'b'.repeat(64); },
    (s: any) => { s.receipts[0].extra = true; },
    (s: any) => { delete s.records[0]; },
    (s: any) => { Object.setPrototypeOf(s, { extra: 'no' }); },
  ];
  it.each(mutations)('rechaza alteración del estado %# sin avanzar', mutate => {
    const input = exported([row(1), row(2)]), result = rehearseHistoryArchive(input);
    const state = clone(result.state); mutate(state);
    expect(() => rehearseHistoryArchive(input, state)).toThrow();
    expect(rehearseHistoryArchive(input, result.state).addedRows).toBe(0);
  });
  it.each(['state', 'records', 'row', 'receipt'])('rechaza accessor en %s sin ejecutarlo', location => {
    const input = exported(), state = clone(rehearseHistoryArchive(input).state), getter = vi.fn();
    const [target, key] = location === 'state' ? [state, 'inputSha256'] : location === 'records' ? [state.records, '0'] :
      location === 'row' ? [state.records[0].row, 'amounts'] : [state.receipts[0], 'index'];
    Object.defineProperty(target, key, { enumerable: true, get: getter });
    expect(() => rehearseHistoryArchive(input, state)).toThrow(); expect(getter).not.toHaveBeenCalled();
  });
  it('rechaza proxy de estado sin activar trampas', () => {
    const trap = vi.fn(), input = exported();
    expect(() => rehearseHistoryArchive(input, new Proxy(rehearseHistoryArchive(input).state, { ownKeys: trap }))).toThrow();
    expect(trap).not.toHaveBeenCalled();
  });
});
