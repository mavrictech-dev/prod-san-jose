import { describe, expect, it } from 'vitest';
import {
  HISTORY_PREVIEW_LIMITS as limits,
  HistoryPreviewValidationError,
  previewHistory,
  type HistoryAmounts,
  type HistoryArtifactKind,
  type HistoryArtifactMetadata,
  type HistoryPreviewRow,
  type NormalizedHistoryExport,
} from '../migration/history-preview';

// All identifiers and artifact metadata are invented in memory. No file, DB,
// environment, credential, process, network or SUNAT fixture is accessed here.
const uuid = (number: number) => `00000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}`;
const zero: HistoryAmounts = {
  taxableAmount: '0.00', exemptAmount: '0.00', unaffectedAmount: '0.00',
  freeAmount: '0.00', discountTotal: '0.00', igvAmount: '0.00', iscAmount: '0.00',
  otherTaxesAmount: '0.00', payableAmount: '0.00',
};
function artifact(kind: HistoryArtifactKind = 'CDR_ZIP'): HistoryArtifactMetadata {
  return { kind, originalName: `inventado-${kind}.zip`, sha256: 'a'.repeat(64), sizeBytes: 123 };
}
function row(overrides: Partial<HistoryPreviewRow> = {}): HistoryPreviewRow {
  const base = {
    issuerRuc: '00000000001', companyId: 1, type: '01' as const, series: 'FQ01',
    number: '1', issueDate: '2026-10-01T18:25:30.123-05:00', currencyCode: 'PEN' as const,
    originId: `inventado-${overrides.number ?? '1'}`,
    amounts: { ...zero, taxableAmount: '100.00', igvAmount: '18.00', payableAmount: '118.00' },
    tax: [{ taxSchemeId: '1000', taxName: 'IGV', taxableAmount: '100.00', taxAmount: '18.00' }],
    artifacts: [artifact()], ...overrides,
  };
  return {
    ...base,
    ownIssuerMapping: overrides.ownIssuerMapping ?? {
      issuerRuc: base.issuerRuc, companyId: base.companyId, type: base.type, series: base.series,
      branchId: uuid(base.companyId * 3 + 1), emissionPointId: uuid(base.companyId * 3 + 2),
      seriesCounterId: uuid(base.companyId * 100_000_000 + parseInt(base.series, 36) * 100 + Number(base.type)),
    },
  };
}
function exported(rows: readonly HistoryPreviewRow[] = [row()]): NormalizedHistoryExport {
  return { schemaVersion: 'factuez.history-normalized.v1', environment: 'BETA', originSystem: 'RESTOAPP', rows };
}
function rejected(value: unknown, code?: string, checkpoint?: unknown): void {
  let failure: unknown;
  try { previewHistory(value, checkpoint); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(HistoryPreviewValidationError);
  if (code) expect((failure as HistoryPreviewValidationError).code).toBe(code);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

describe('historical migration preview: BETA, pure metadata dry-run', () => {
  it('reports only declared consistency, never acceptance, issuance or transmission', () => {
    const result = previewHistory(exported());
    expect(result).toMatchObject({
      dryRun: true, fiscalWrites: 0, transmission: false, productionBlocked: true,
      environment: 'BETA', status: 'CONSISTENT_METADATA', rowCount: 1,
      artifacts: {
        assessment: 'DECLARED_METADATA_ONLY_NOT_VERIFIED', count: 1,
        declaredSizeBytes: '123', rowsWithCdrMetadata: 1, rowsRequiringCdrReview: 0,
      },
      plan: { purpose: 'VALIDATION_ONLY', rowCount: 1, batchSize: 500 },
    });
    const json = JSON.stringify(result);
    for (const forbidden of ['nextNumber', 'outbox', 'sendBill', 'reserveNumber', 'ACCEPTED', 'storageKey']) {
      expect(json).not.toContain(forbidden);
    }
    expect(result.plan.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.plan.planSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each(['01', '03', '07', '08'] as const)('accepts the explicitly normalized type %s', type => {
    const result = previewHistory(exported([row({ type, series: type === '03' ? 'BQ01' : 'FQ01' })]));
    expect(result.seriesRanges[0].type).toBe(type);
    expect(result.status).toBe('CONSISTENT_METADATA');
  });

  it('marks absent CDR for review, and PDF/XML/ZIP alone do not establish CDR evidence', () => {
    const result = previewHistory(exported([
      row({ artifacts: [] }),
      row({ number: '2', artifacts: [artifact('SIGNED_XML'), artifact('PDF_A4'), artifact('SUBMISSION_ZIP')] }),
      row({ number: '3', artifacts: [artifact('CDR_XML')] }),
    ]));
    expect(result.status).toBe('REVIEW_REQUIRED');
    expect(result.artifacts.rowsRequiringCdrReview).toBe(2);
    expect(result.diagnostics.byCode.CDR_ABSENT).toBe(2);
    expect(result.diagnostics.blockingCount).toBe(0);
    expect(result.diagnostics.examples[0].severity).toBe('REVIEW');
    expect(result.fiscalWrites).toBe(0);
    expect(result.transmission).toBe(false);
  });

  it('does not mutate frozen caller data and returns JSON-safe, repeatable output', () => {
    const input = frozen(exported());
    const before = JSON.stringify(input);
    const first = previewHistory(input);
    const second = previewHistory(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(second).toEqual(first);
    expect(() => JSON.stringify(first)).not.toThrow();
  });

  it('handles empty history explicitly without fabricating a range, batch or number', () => {
    const result = previewHistory(exported([]));
    expect(result.rowCount).toBe(0);
    expect(result.seriesRanges).toEqual([]);
    expect(result.totalsBySeries).toEqual([]);
    expect(result.plan.batches).toEqual([]);
    expect(result.resume).toMatchObject({ remainingBatches: 0, nextBatchIndex: null });
  });
});

describe('exact reconciliation and fiscal ownership', () => {
  it('sums decimal strings exactly, including aggregate totals beyond Decimal(18,2)', () => {
    const small = (number: string, amount: string) => row({
      number, amounts: { ...zero, exemptAmount: amount, payableAmount: amount }, tax: [],
    });
    const result = previewHistory(exported([small('1', '0.1'), small('2', '0.20')]));
    expect(result.totalsByIssuerCurrency[0].amounts.payableAmount).toBe('0.30');
    const large = previewHistory(exported([
      small('1', '9999999999999999.99'), small('2', '9999999999999999.99'),
    ]));
    expect(large.status).toBe('CONSISTENT_METADATA');
    expect(large.totalsBySeries[0].amounts.exemptAmount).toBe('19999999999999999.98');
  });

  it('reconciles all money fields using net bases, with informational discounts/free amounts', () => {
    const amounts: HistoryAmounts = {
      taxableAmount: '100.00', exemptAmount: '2.00', unaffectedAmount: '3.00', freeAmount: '50.00',
      discountTotal: '9.00', igvAmount: '18.00', iscAmount: '4.00', otherTaxesAmount: '1.00', payableAmount: '128.00',
    };
    const taxes = [
      { taxSchemeId: '1000', taxName: 'IGV', taxableAmount: '100', taxAmount: '18' },
      { taxSchemeId: '2000', taxName: 'ISC', taxableAmount: '100', taxAmount: '4' },
      { taxSchemeId: '9999', taxName: 'OTROS', taxableAmount: '100', taxAmount: '1' },
    ];
    const result = previewHistory(exported([row({ amounts, tax: taxes })]));
    expect(result.status).toBe('CONSISTENT_METADATA');
    expect(result.totalsByIssuerCurrency[0].amounts).toEqual(amounts);
    const bad = previewHistory(exported([row({ amounts: { ...amounts, payableAmount: '119.00' }, tax: [] })]));
    expect(bad.status).toBe('BLOCKED');
    expect(bad.diagnostics.byCode).toMatchObject({ PAYABLE_MISMATCH: 1, TAX_TOTAL_MISMATCH: 1 });
  });

  it('separates RUC, currency and type, and does not net credit notes', () => {
    const result = previewHistory(exported([
      row(), row({ number: '2', currencyCode: 'USD' }),
      row({ type: '07', originId: 'inventado-nota' }),
      row({ issuerRuc: '00000000002', companyId: 2, originId: 'inventado-otro-ruc' }),
    ]));
    expect(result.status).toBe('CONSISTENT_METADATA');
    expect(result.duplicates.fiscalIdentityGroups).toBe(0);
    expect(result.totalsByIssuerCurrency).toHaveLength(3);
    expect(result.totalsByIssuerCurrency.find(g => g.issuerRuc === '00000000001' && g.currencyCode === 'PEN')?.amounts.payableAmount).toBe('236.00');
    expect(result.totalsBySeries).toHaveLength(4);
    expect(result.totalsBasis).toBe('EXPORTED_ROWS_INCLUDING_DUPLICATES_UNSIGNED_NOT_NETTED');
  });

  it('detects fiscal duplicates across currencies and origin duplicates across numbers', () => {
    const result = previewHistory(exported([
      row(), row({ currencyCode: 'USD', originId: 'inventado-distinto' }),
      row({ number: '3', originId: 'inventado-1' }),
    ]));
    expect(result.status).toBe('BLOCKED');
    expect(result.duplicates).toMatchObject({
      fiscalIdentityGroups: 1, fiscalIdentityRows: 2, originIdGroups: 1, originIdRows: 2,
    });
    expect(result.totalsByIssuerCurrency.find(g => g.currencyCode === 'PEN')?.amounts.payableAmount).toBe('236.00');
    expect(result.seriesRanges[0]).toMatchObject({ rowCount: 3, distinctNumberCount: 2, minNumber: '1', maxNumber: '3' });
    expect(result.diagnostics.examples.find(e => e.code === 'DUPLICATE_FISCAL_IDENTITY')?.key).toBe('["00000000001","01","FQ01","1"]');
  });

  it('uses company/originSystem/originId uniqueness and flags cross-issuer reuse for review', () => {
    const result = previewHistory(exported([row(), row({ issuerRuc: '00000000002', companyId: 2 })]));
    expect(result.duplicates.originIdGroups).toBe(0);
    expect(result.duplicates.fiscalIdentityGroups).toBe(0);
    expect(result.duplicates.originIdsReusedAcrossIssuers).toBe(1);
    expect(result.diagnostics.byCode.ORIGIN_ID_REUSED_ACROSS_ISSUERS).toBe(1);
    expect(result.status).toBe('REVIEW_REQUIRED');
  });

  it('does not collide opaque origin IDs containing separators', () => {
    const result = previewHistory(exported([row({ originId: 'sale|1:2' }), row({ number: '2', originId: 'sale|1:2|' })]));
    expect(result.duplicates.originIdGroups).toBe(0);
  });

  it.each(['company', 'ruc', 'branch', 'point', 'counter', 'series'] as const)('blocks contradictory %s ownership declarations', scope => {
    const first = row();
    let second = row({ number: '2' });
    if (scope === 'company') second = row({ issuerRuc: '00000000002', number: '2' });
    if (scope === 'ruc') second = row({ companyId: 2, number: '2' });
    if (scope === 'branch') {
      const other = row({ issuerRuc: '00000000002', companyId: 2, number: '2' });
      second = { ...other, ownIssuerMapping: { ...other.ownIssuerMapping, branchId: first.ownIssuerMapping.branchId } };
    }
    if (scope === 'point') second = { ...second, ownIssuerMapping: { ...second.ownIssuerMapping, branchId: uuid(999) } };
    if (scope === 'counter') {
      const other = row({ type: '07', number: '2' });
      second = { ...other, ownIssuerMapping: { ...other.ownIssuerMapping, seriesCounterId: first.ownIssuerMapping.seriesCounterId } };
    }
    if (scope === 'series') second = { ...second, ownIssuerMapping: { ...second.ownIssuerMapping, seriesCounterId: uuid(999) } };
    const result = previewHistory(exported([first, second]));
    expect(result.status).toBe('BLOCKED');
    expect(result.diagnostics.byCode.MAPPING_CONFLICT).toBeGreaterThan(0);
  });
});

describe('bounded range and diagnostic summaries', () => {
  it('computes gaps across currencies rather than introducing false currency holes', () => {
    const result = previewHistory(exported([row(), row({ number: '2', currencyCode: 'USD' }), row({ number: '3' })]));
    expect(result.totalsBySeries).toHaveLength(2);
    expect(result.seriesRanges).toHaveLength(1);
    expect(result.seriesRanges[0].gaps).toEqual({ missingCount: '0', rangeCount: 0, ranges: [], truncated: false });
  });

  it('summarizes a huge gap as one range, without enumerating missing numbers', () => {
    const result = previewHistory(exported([row(), row({ number: limits.maxNumber })]));
    expect(result.seriesRanges[0].gaps).toEqual({
      missingCount: '99999997', rangeCount: 1,
      ranges: [{ from: '2', to: '99999998', count: '99999997' }], truncated: false,
    });
    expect(JSON.stringify(result).length).toBeLessThan(8_000);
  });

  it('does not assume a leading start at one or an authorized trailing number', () => {
    const result = previewHistory(exported([row({ number: '15' }), row({ number: '16' })]));
    expect(result.seriesRanges[0]).toMatchObject({ minNumber: '15', maxNumber: '16', gaps: { missingCount: '0' } });
  });

  it('caps gap examples while preserving exact missing and range counts', () => {
    const result = previewHistory(exported(Array.from({ length: 30 }, (_, i) => row({ number: String(2 * i + 1) }))));
    expect(result.seriesRanges[0].gaps).toMatchObject({ missingCount: '29', rangeCount: 29, truncated: true });
    expect(result.seriesRanges[0].gaps.ranges).toHaveLength(limits.maxGapRanges);
  });

  it('caps diagnostics and duplicate row examples, but retains complete counts', () => {
    const result = previewHistory(exported(Array.from({ length: 125 }, (_, i) => row({ number: String(i + 1), artifacts: [] }))));
    expect(result.diagnostics.reviewCount).toBe(125);
    expect(result.diagnostics.examples).toHaveLength(limits.maxDiagnosticExamples);
    expect(result.diagnostics.truncated).toBe(true);
    const duplicate = previewHistory(exported(Array.from({ length: 25 }, () => row())));
    expect(duplicate.duplicates.fiscalIdentityRows).toBe(25);
    expect(duplicate.diagnostics.examples[0]).toMatchObject({ affectedRows: 25 });
    expect(duplicate.diagnostics.examples[0].rowOrdinals).toHaveLength(limits.maxRowOrdinalsPerExample);
  });
});

describe('deterministic plans and validation-only checkpoints', () => {
  it('ignores JSON key ordering, row ordering and normalized decimal/artifact/tax ordering', () => {
    const firstRow = row({ artifacts: [artifact('SIGNED_XML'), artifact('CDR_ZIP')] });
    const first = exported([firstRow, row({ number: '2' })]);
    const reorderedRow = {
      ...firstRow, amounts: { ...firstRow.amounts, taxableAmount: '100', igvAmount: '18.0' },
      artifacts: [...firstRow.artifacts].reverse().map(a => ({ ...a, sha256: a.sha256.toUpperCase() })),
    };
    const reordered = Object.fromEntries(Object.entries(exported([row({ number: '2' }), reorderedRow])).reverse());
    expect(previewHistory(reordered)).toEqual(previewHistory(first));
    const taxRow = row({ tax: [
      { taxSchemeId: '9999', taxName: 'OTROS', taxableAmount: '0', taxAmount: '0' },
      ...firstRow.tax,
    ] });
    expect(previewHistory(exported([taxRow]))).toEqual(previewHistory(exported([{ ...taxRow, tax: [...taxRow.tax].reverse() }])));
  });

  it('binds input and plan hashes to amounts, mapping, names, hashes, sizes and dates', () => {
    const original = row();
    const base = previewHistory(exported([original])).plan;
    const mutations: HistoryPreviewRow[] = [
      row({ amounts: { ...original.amounts, payableAmount: '118.01' } }),
      row({ ownIssuerMapping: { ...original.ownIssuerMapping, branchId: uuid(999) } }),
      row({ artifacts: [{ ...artifact(), originalName: 'otro-inventado.zip' }] }),
      row({ artifacts: [{ ...artifact(), sha256: 'b'.repeat(64) }] }),
      row({ artifacts: [{ ...artifact(), sizeBytes: 124 }] }),
      row({ issueDate: '2026-10-02T18:25:30.123-05:00' }),
    ];
    for (const mutation of mutations) {
      const result = previewHistory(exported([mutation]));
      expect(result.plan.inputSha256).not.toBe(base.inputSha256);
      expect(result.plan.planSha256).not.toBe(base.planSha256);
      rejected(exported([mutation]), 'CHECKPOINT_HASH_MISMATCH', { inputSha256: base.inputSha256, planSha256: base.planSha256, completedBatches: 0 });
    }
  });

  it('describes resumable bounded batches and still validates the whole history', () => {
    const input = exported(Array.from({ length: 501 }, (_, i) => row({ number: String(i + 1), originId: i === 500 ? 'inventado-1' : `inventado-${i + 1}` })));
    const result = previewHistory(input);
    expect(result.plan.batches.map(b => [b.index, b.startOrdinal, b.endOrdinalExclusive, b.rowCount])).toEqual([[0, 0, 500, 500], [1, 500, 501, 1]]);
    const resumed = previewHistory(input, { ...result.resume.checkpoint, completedBatches: 1 });
    expect(resumed.plan).toEqual(result.plan);
    expect(resumed.resume).toMatchObject({ remainingBatches: 1, nextBatchIndex: 1 });
    expect(resumed.duplicates.originIdGroups).toBe(1);
    expect(resumed.status).toBe('BLOCKED');
    expect(resumed.totalsBySeries).toEqual(result.totalsBySeries);
    expect(previewHistory(input, { ...result.resume.checkpoint, completedBatches: 2 }).resume.nextBatchIndex).toBeNull();
    for (const completedBatches of [-1, 0.5, 3, '1', Number.NaN]) {
      rejected(input, 'INVALID_INTEGER', { ...result.resume.checkpoint, completedBatches });
    }
    rejected(input, 'UNKNOWN_OR_MISSING_KEYS', { ...result.resume.checkpoint, nextNumber: 2 });
    rejected(input, 'CHECKPOINT_HASH_MISMATCH', { ...result.resume.checkpoint, planSha256: '0'.repeat(64) });
  });
});

describe('fail-closed JSON contract', () => {
  it.each([null, undefined, [], true, 'export', 1])('rejects non-object input %s', value => rejected(value));

  it.each([
    { environment: 'PRODUCTION' }, { environment: 'beta' }, { originSystem: 'FACTUEZ' },
    { schemaVersion: 'v0' }, { rows: null }, { transmission: true },
  ])('rejects unsupported top-level data %j', change => rejected({ ...exported(), ...change }));

  it('rejects unknown or missing keys at every nested level', () => {
    const base = row();
    for (const change of [
      { extra: 1 }, { amounts: { ...base.amounts, extra: '0' } },
      { ownIssuerMapping: { ...base.ownIssuerMapping, extra: 1 } },
      { tax: [{ ...base.tax[0], extra: 1 }] },
      { artifacts: [{ ...base.artifacts[0], extra: 1 }] },
    ]) rejected({ ...exported(), rows: [{ ...base, ...change }] }, 'UNKNOWN_OR_MISSING_KEYS');
    const { ownIssuerMapping: _mapping, ...unmapped } = base;
    rejected({ ...exported(), rows: [unmapped] }, 'UNKNOWN_OR_MISSING_KEYS');
    const { exemptAmount: _exempt, ...incompleteAmounts } = base.amounts;
    rejected({ ...exported(), rows: [{ ...base, amounts: incompleteAmounts }] }, 'UNKNOWN_OR_MISSING_KEYS');
    rejected({ ...exported(), rows: [{ ...base, ownIssuerMapping: { ...base.ownIssuerMapping, companyId: 2 } }] }, 'OWN_ISSUER_MAPPING_MISMATCH');
  });

  it('rejects non-JSON prototypes, symbols, hidden fields and getters without invoking them', () => {
    rejected(Object.assign(new Date(), exported()), 'NON_JSON_OBJECT');
    rejected({ ...exported(), [Symbol('hidden')]: true }, 'UNKNOWN_OR_MISSING_KEYS');
    const hidden = { ...exported() };
    Object.defineProperty(hidden, 'extra', { value: 1, enumerable: false });
    rejected(hidden, 'UNKNOWN_OR_MISSING_KEYS');
    let invoked = false;
    const getter = { ...exported() };
    Object.defineProperty(getter, 'rows', { enumerable: true, get() { invoked = true; throw new Error('must not execute'); } });
    rejected(getter, 'NON_JSON_PROPERTY');
    expect(invoked).toBe(false);
    const sparse = new Array(1);
    rejected({ ...exported(), rows: sparse }, 'NON_JSON_ARRAY');
    const accessor: unknown[] = [row()];
    Object.defineProperty(accessor, '0', { enumerable: true, get() { invoked = true; return row(); } });
    rejected({ ...exported(), rows: accessor }, 'NON_JSON_ARRAY');
    expect(invoked).toBe(false);
    const polluted = [row()];
    Object.defineProperty(polluted, 'extra', { value: 1 });
    rejected({ ...exported(), rows: polluted }, 'NON_JSON_ARRAY');
  });

  it('rejects object and array proxies without executing their traps', () => {
    let invoked = false;
    const traps = {
      get() { invoked = true; throw new Error('proxy must not execute'); },
      getPrototypeOf() { invoked = true; throw new Error('proxy must not execute'); },
      ownKeys() { invoked = true; throw new Error('proxy must not execute'); },
    };
    rejected(new Proxy(exported(), traps), 'NON_JSON_OBJECT');
    rejected({ ...exported(), rows: new Proxy([row()], traps) }, 'NON_JSON_ARRAY');
    rejected({ ...exported(), rows: [new Proxy(row(), traps)] }, 'NON_JSON_OBJECT');
    rejected({ ...exported(), rows: [{ ...row(), amounts: new Proxy(row().amounts, traps) }] }, 'NON_JSON_OBJECT');
    const revokedObject = Proxy.revocable(exported(), {});
    revokedObject.revoke();
    rejected(revokedObject.proxy, 'NON_JSON_OBJECT');
    const revokedArray = Proxy.revocable([row()], {});
    revokedArray.revoke();
    rejected({ ...exported(), rows: revokedArray.proxy }, 'NON_JSON_ARRAY');
    expect(invoked).toBe(false);
  });

  it.each([0.1, null, '', '-1', '+1', '01.00', '1e2', 'NaN', 'Infinity', '1,00', '1.001', '1.', '.1', ' 1', '1\n', '10000000000000000.00', '9'.repeat(20_000)])('rejects non-exact or oversized money %s', value => {
    rejected({ ...exported(), rows: [{ ...row(), amounts: { ...row().amounts, taxableAmount: value } }] });
  });

  it.each([0, '0', '-1', '+1', '01', '1.0', '1e2', '100000000', '1 '.repeat(50_000)])('rejects malformed or excessive numbers %s', value => {
    rejected({ ...exported(), rows: [{ ...row(), number: value }] });
  });

  it.each([
    { issuerRuc: '123' }, { companyId: 0 }, { companyId: 1.5 }, { companyId: 2_147_483_648 },
    { type: '09' }, { type: '1' }, { currencyCode: 'EUR' }, { series: 'f001' },
    { series: 'F0001' }, { series: 'BQ01' }, { originId: '' }, { originId: 'a'.repeat(121) },
    { originId: 'x\u0000y' }, { ownIssuerMapping: null },
  ])('rejects malformed fiscal identity %j', change => rejected({ ...exported(), rows: [{ ...row(), ...change }] }));

  it.each([
    '2026-10-01', '2026-10-01T00:00:00', '2026-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z', '2026-13-01T00:00:00Z', '2026-00-01T00:00:00Z',
    '2026-01-00T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z',
    '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+14:01', '2026-01-01T00:00:00+05:60',
    '2026-01-01T00:00:00+15:00', '2026-01-01T00:00:00-00:00',
    '2026-01-01T00:00:00.1234Z', '1899-12-31T00:00:00Z',
  ])('rejects an invalid calendar/zone rather than rolling it over: %s', issueDate => rejected(exported([row({ issueDate })]), 'INVALID_DATE_WITH_ZONE'));

  it.each(['2024-02-29T23:59:59Z', '2000-02-29T01:01:01.1+14:00', '2026-10-01T10:00:00-05:00'])('accepts valid dates with an explicit zone %s', issueDate => {
    expect(previewHistory(exported([row({ issueDate })])).status).toBe('CONSISTENT_METADATA');
  });

  it('rejects malformed UUID mappings and repeated tax/artifact kinds', () => {
    for (const key of ['branchId', 'emissionPointId', 'seriesCounterId'] as const) {
      rejected(exported([row({ ownIssuerMapping: { ...row().ownIssuerMapping, [key]: 'F001' } })]), 'INVALID_FORMAT');
    }
    rejected(exported([row({ tax: [...row().tax, ...row().tax] })]), 'DUPLICATE_TAX_SCHEME');
    rejected(exported([row({ artifacts: [artifact(), artifact()] })]), 'DUPLICATE_ARTIFACT_KIND');
    rejected(exported([row({ tax: [{ ...row().tax[0], taxSchemeId: 'IGV' }] })]), 'INVALID_FORMAT');
    rejected(exported([row({ tax: [{ ...row().tax[0], taxName: 'x'.repeat(21) }] })]), 'INVALID_STRING');
  });

  it.each([
    { sha256: 'invalid' }, { sizeBytes: 0 }, { sizeBytes: '123' }, { sizeBytes: 1.5 },
    { sizeBytes: Number.MAX_SAFE_INTEGER }, { kind: 'CERTIFICATE' },
    { originalName: '../cdr.zip' }, { originalName: 'C:\\cdr.zip' }, { originalName: 'https://example.invalid/cdr.zip' },
    { originalName: '..' }, { originalName: 'CON.zip' }, { originalName: 'bad\u0000.zip' },
  ])('rejects invalid artifact metadata %j', change => rejected({ ...exported(), rows: [{ ...row(), artifacts: [{ ...artifact(), ...change }] }] }));
});

describe('resource limits without I/O', () => {
  it('rejects row, tax and artifact counts before iterating their entries', () => {
    rejected(exported(Array(limits.maxRows + 1).fill(row())), 'LIMIT_EXCEEDED');
    rejected(exported([row({ tax: Array(limits.maxTaxesPerRow + 1).fill(row().tax[0]) })]), 'LIMIT_EXCEEDED');
    rejected(exported([row({ artifacts: Array(limits.maxArtifactsPerRow + 1).fill(artifact()) })]), 'LIMIT_EXCEEDED');
  });

  it('rejects declared individual and aggregate byte sizes without opening artifacts', () => {
    rejected(exported([row({ artifacts: [{ ...artifact(), sizeBytes: limits.maxArtifactSizeBytes + 1 }] })]), 'INVALID_INTEGER');
    const large = Array.from({ length: 11 }, (_, i) => row({ number: String(i + 1), artifacts: [{ ...artifact(), sizeBytes: limits.maxArtifactSizeBytes }] }));
    rejected(exported(large), 'ARTIFACT_BYTES_LIMIT_EXCEEDED');
  });

  it('rejects excessive reconciliation dimensions', () => {
    const issuers = Array.from({ length: limits.maxGroups + 1 }, (_, i) => row({ issuerRuc: String(i + 1).padStart(11, '0'), companyId: i + 1 }));
    rejected(exported(issuers), 'GROUP_LIMIT_EXCEEDED');
    const series = Array.from({ length: limits.maxGroups + 1 }, (_, i) => row({ series: `F${i.toString(36).toUpperCase().padStart(3, '0')}` }));
    rejected(exported(series), 'GROUP_LIMIT_EXCEEDED');
  });

  it('accepts the maximum row count and keeps plan batches bounded', () => {
    const input = exported(Array.from({ length: limits.maxRows }, (_, i) => row({ number: String(i + 1) })));
    const result = previewHistory(input);
    expect(result.rowCount).toBe(limits.maxRows);
    expect(result.status).toBe('CONSISTENT_METADATA');
    expect(result.plan.batches).toHaveLength(limits.maxRows / limits.batchSize);
    expect(result.seriesRanges[0].gaps.rangeCount).toBe(0);
  }, 15_000);
});
