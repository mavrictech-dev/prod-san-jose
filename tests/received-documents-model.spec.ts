import { describe, expect, it, vi } from 'vitest';
import type { ReceivedDocumentRow, ReceivedUploadCommand } from '../packages/contracts/src/received-documents';
import type { Catalog, Company, User } from '../apps/web-pwa/features/workspace/types';
import {
  createReceivedOperation, EMPTY_RECEIVED_FILTERS, readReceivedFiles, receivedAmount,
  receivedFileError, receivedFilterError, receivedQuery, receivedRegistration,
  receivedRowInScope, receivedSelection, receivedTypeLabel, receivedUploadCommand,
  RECEIVED_FILE_COUNT, RECEIVED_FILE_LIMIT, RECEIVED_UPLOAD_LIMIT,
} from '../apps/web-pwa/features/workspace/received-documents-model';
import type {
  ReceivedFileKind, ReceivedFilters, ReceivedSelection,
} from '../apps/web-pwa/features/workspace/received-documents-model';

// All identities, metadata and bytes are synthetic; these tests never open files.
const companyA: Company = { id: 101, ruc: '00000000101', legalName: 'RECEPTOR FICTICIO A', environment: 'BETA' };
const companyB: Company = { id: 202, ruc: '00000000202', legalName: 'RECEPTOR FICTICIO B', environment: 'BETA' };
const branchA = { id: 'qa-a', companyId: companyA.id, code: 'A', name: 'SEDE FICTICIA A' };
const otherBranchA = { id: 'qa-a2', companyId: companyA.id, code: 'A2', name: 'OTRA SEDE FICTICIA A' };
const branchB = { id: 'qa-b', companyId: companyB.id, code: 'B', name: 'SEDE FICTICIA B' };
const catalog: Catalog = {
  companies: [companyA, companyB], branches: [branchA, otherBranchA, branchB],
  products: [], emissionPoints: [], capabilities: { demoData: true, fiscalTransmission: false },
};
const globalUser: User = {
  sub: 'qa-user', username: 'FICTICIO', roles: ['ADMIN'], permissions: [], exp: 9999999999,
  scope: { kind: 'GLOBAL' },
};
const assignedUser: User = {
  ...globalUser,
  scope: { kind: 'ASSIGNED', branchIds: [branchA.id, branchB.id], emissionPointIds: [], series: [] },
};
const selection: ReceivedSelection = { company: companyA, branchId: branchA.id };
const companySelection: ReceivedSelection = { company: companyA };
const row = (overrides: Partial<ReceivedDocumentRow> = {}): ReceivedDocumentRow => ({
  id: 'qa-document', companyId: companyA.id, recipientRuc: companyA.ruc, branchId: branchA.id,
  supplierRuc: '00000000303', supplierName: 'PROVEEDOR FICTICIO', documentType: '01',
  fullNumber: 'FQA1-1', issueDate: '2026-01-01', currencyCode: null, payableAmount: null,
  receivedAt: '2026-01-01T00:00:00Z', itemCount: 0, sunatStatus: 'NOT_CHECKED',
  lastVerifiedAt: null, registeredAt: null, erpReference: null, warnings: [], ...overrides,
});
const file = (name = 'synthetic.xml', size = 1, bytes = new Uint8Array([65])) => ({
  name, size, arrayBuffer: vi.fn(async (): Promise<ArrayBuffer> => bytes.slice().buffer),
});
const uploadFiles: ReceivedUploadCommand['files'] = [{ fileName: 'synthetic.xml', contentBase64: 'QQ==' }];
const deferredBuffer = () => {
  let resolve!: (value: ArrayBuffer) => void;
  const promise = new Promise<ArrayBuffer>(done => { resolve = done; });
  return { promise, resolve };
};
const parseQuery = (value: string) => new URL(value, 'https://fixtures.invalid');

describe('receivedSelection: explicit company and authorized branch', () => {
  it('allows an assigned branch in its own company', () => {
    expect(receivedSelection(catalog, assignedUser, '101', branchA.id)).toEqual(selection);
    expect(receivedSelection(catalog, assignedUser, '202', branchB.id)).toEqual({ company: companyB, branchId: branchB.id });
  });

  it.each(['', otherBranchA.id, 'unknown-branch', branchB.id])('rejects an unassigned or mismatched branch %j', branchId => {
    expect(receivedSelection(catalog, assignedUser, '101', branchId)).toBeUndefined();
  });

  it('does not grant a branch merely because it exists in the catalog', () => {
    const noAssignments: User = { ...assignedUser, scope: { kind: 'ASSIGNED', branchIds: [], emissionPointIds: [], series: [] } };
    expect(receivedSelection(catalog, noAssignments, '101', branchA.id)).toBeUndefined();
  });

  it('allows GLOBAL company-wide scope or a branch belonging to that company', () => {
    expect(receivedSelection(catalog, globalUser, '101', '')).toEqual(companySelection);
    expect(receivedSelection(catalog, globalUser, '101', otherBranchA.id)).toEqual({ company: companyA, branchId: otherBranchA.id });
    expect(receivedSelection(catalog, globalUser, '101', branchB.id)).toBeUndefined();
    expect(receivedSelection(catalog, globalUser, '101', 'missing')).toBeUndefined();
  });

  it.each(['', '999', companyA.ruc, '0', '-101', '0101', '101.0', '1e2', ' 101', '101 ', 'NaN'])('does not default to a company when the RUC selection has ID %j', companyId => {
    expect(receivedSelection(catalog, globalUser, companyId, '')).toBeUndefined();
  });

  it('requires both authenticated user and catalog', () => {
    expect(receivedSelection(undefined, globalUser, '101', branchA.id)).toBeUndefined();
    expect(receivedSelection(catalog, undefined, '101', branchA.id)).toBeUndefined();
  });

  it('rejects an unsafe numeric company ID even if it appears in the catalog', () => {
    const unsafe: Company = { ...companyA, id: Number.MAX_SAFE_INTEGER + 1 };
    expect(receivedSelection({ ...catalog, companies: [unsafe] }, globalUser, String(unsafe.id), '')).toBeUndefined();
  });
});

describe('receivedRowInScope: company, recipient RUC and branch isolation', () => {
  it('accepts the selected recipient and branch', () => {
    expect(receivedRowInScope(row(), selection)).toBe(true);
  });

  it.each([
    { companyId: companyB.id },
    { recipientRuc: companyB.ruc },
    { companyId: companyB.id, recipientRuc: companyB.ruc },
    { branchId: otherBranchA.id },
    { branchId: branchB.id },
    { branchId: null },
  ])('rejects an out-of-scope row %j', patch => {
    expect(receivedRowInScope(row(patch), selection)).toBe(false);
  });

  it('company-wide scope includes its branches and unassigned rows while still checking ID and RUC', () => {
    for (const branchId of [branchA.id, otherBranchA.id, null]) {
      expect(receivedRowInScope(row({ branchId }), companySelection)).toBe(true);
    }
    expect(receivedRowInScope(row({ companyId: companyB.id }), companySelection)).toBe(false);
    expect(receivedRowInScope(row({ recipientRuc: companyB.ruc }), companySelection)).toBe(false);
  });
});

describe('received queries and filters', () => {
  it('exports exactly the list scope and filters, excluding pagination', () => {
    const filters: ReceivedFilters = { q: '  FQA1 & proveedor / ñ?  ', type: ' 07 ', from: '2026-01-01', to: '2026-01-31', page: 7 };
    const list = parseQuery(receivedQuery(selection, filters));
    const exported = parseQuery(receivedQuery(selection, filters, true));
    expect(list.pathname).toBe('/api/v1/received-documents');
    expect(exported.pathname).toBe('/api/v1/received-documents/export.xlsx');
    expect(Object.fromEntries(list.searchParams)).toEqual({
      companyId: '101', branchId: branchA.id, q: 'FQA1 & proveedor / ñ?', type: '07',
      from: '2026-01-01', to: '2026-01-31', page: '7', dataSource: 'BUSINESS',
    });
    expect(exported.searchParams.has('page')).toBe(false);
    list.searchParams.delete('page');
    expect([...exported.searchParams]).toEqual([...list.searchParams]);
    expect(receivedQuery(selection, { ...filters, page: 100 }, true)).toBe(exported.pathname + exported.search);
  });

  it('omits branchId for company-wide scope and retains empty filters', () => {
    expect(Object.fromEntries(parseQuery(receivedQuery(companySelection, EMPTY_RECEIVED_FILTERS)).searchParams)).toEqual({
      companyId: '101', q: '', type: '', from: '', to: '', page: '1', dataSource: 'BUSINESS',
    });
    expect(EMPTY_RECEIVED_FILTERS).toEqual({ q: '', type: '', from: '', to: '', page: 1 });
  });

  it.each([[0, '1'], [-3, '1'], [NaN, '1'], [2.9, '2'], [1, '1']])('normalizes page %j to %s', (page, expected) => {
    expect(parseQuery(receivedQuery(selection, { ...EMPTY_RECEIVED_FILTERS, page })).searchParams.get('page')).toBe(expected);
  });

  it('rejects reversed dates and accepts equal, ascending and open date ranges', () => {
    expect(receivedFilterError({ ...EMPTY_RECEIVED_FILTERS, from: '2026-02-01', to: '2026-01-31' })).toContain('fecha');
    for (const [from, to] of [['2026-01-01', '2026-01-01'], ['2026-01-01', '2026-01-31'], ['', '2026-01-31'], ['2026-01-01', ''], ['', '']]) {
      expect(receivedFilterError({ ...EMPTY_RECEIVED_FILTERS, from, to })).toBeUndefined();
    }
  });
});

describe('received file validation: root XML/ZIP, provider PDF and CDR', () => {
  it('uses exact 10-file, 4 MiB and 12 MiB limits', () => {
    expect(RECEIVED_FILE_COUNT).toBe(10);
    expect(RECEIVED_FILE_LIMIT).toBe(4 * 1024 * 1024);
    expect(RECEIVED_UPLOAD_LIMIT).toBe(12 * 1024 * 1024);
  });

  it.each(['UPLOAD', 'PROVIDER_PDF', 'CDR'] as const)('requires at least one %s file', kind => {
    expect(receivedFileError([], kind)).toContain('al menos');
  });

  it('accepts exactly 10 root files and rejects 11 without reading them', () => {
    const files = Array.from({ length: 11 }, (_, index) => file(`synthetic-${index}.xml`));
    expect(receivedFileError(files.slice(0, 10))).toBeUndefined();
    expect(receivedFileError(files)).toContain('10');
    for (const candidate of files) expect(candidate.arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ['UPLOAD', 'synthetic.XML'], ['UPLOAD', 'synthetic.ZiP'],
    ['CDR', 'synthetic.XML'], ['CDR', 'synthetic.ZIP'], ['PROVIDER_PDF', 'synthetic.PdF'],
  ] as const)('accepts %s extension %s at exactly 4 MiB', (kind, name) => {
    expect(receivedFileError([file(name, RECEIVED_FILE_LIMIT)], kind)).toBeUndefined();
    expect(receivedFileError([file(name, RECEIVED_FILE_LIMIT + 1)], kind)).toContain('4 MiB');
  });

  it.each([
    ['UPLOAD', 'synthetic.pdf'], ['UPLOAD', 'synthetic.xml.exe'], ['UPLOAD', 'synthetic'],
    ['CDR', 'synthetic.pdf'], ['CDR', 'synthetic.zip.exe'],
    ['PROVIDER_PDF', 'synthetic.xml'], ['PROVIDER_PDF', 'synthetic.zip'], ['PROVIDER_PDF', 'synthetic.pdf.exe'],
  ] as const)('rejects %s extension %s', (kind, name) => {
    expect(receivedFileError([file(name)], kind)).toMatch(kind === 'PROVIDER_PDF' ? /PDF/ : /XML o ZIP/);
  });

  it.each(['PROVIDER_PDF', 'CDR'] as const)('allows only one %s attachment per request', kind => {
    const name = kind === 'PROVIDER_PDF' ? 'synthetic.pdf' : 'synthetic.zip';
    expect(receivedFileError([file(name)], kind)).toBeUndefined();
    expect(receivedFileError([file(name), file(name)], kind)).toContain('un solo');
  });

  it('accepts exactly 12 MiB in aggregate and rejects one additional byte', () => {
    const files = Array.from({ length: 3 }, (_, index) => file(`synthetic-${index}.xml`, RECEIVED_FILE_LIMIT));
    expect(receivedFileError(files)).toBeUndefined();
    expect(receivedFileError([...files, file('extra.zip', 1)])).toContain('12 MiB');
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid declared size %j', size => {
    expect(receivedFileError([file('synthetic.xml', size)])).toContain('tamaño inválido');
  });
});

describe('readReceivedFiles: validation before reads and in-memory byte fidelity', () => {
  it.each(['extension', 'size', 'aggregate', 'count'] as const)('validates the entire batch before reading when the last file violates %s', violation => {
    const files = violation === 'aggregate'
      ? Array.from({ length: 3 }, (_, index) => file(`synthetic-${index}.xml`, RECEIVED_FILE_LIMIT))
      : violation === 'count'
        ? Array.from({ length: 10 }, (_, index) => file(`synthetic-${index}.xml`))
        : [file()];
    files.push(file(violation === 'extension' ? 'invalid.pdf' : 'extra.xml', violation === 'size' ? RECEIVED_FILE_LIMIT + 1 : 1));
    return expect(readReceivedFiles(files, 'UPLOAD', new AbortController().signal)).rejects.toThrow().then(() => {
      for (const candidate of files) expect(candidate.arrayBuffer).not.toHaveBeenCalled();
    });
  });

  it.each(['PROVIDER_PDF', 'CDR'] as const)('enforces %s attachment count before any read', async kind => {
    const name = kind === 'PROVIDER_PDF' ? 'synthetic.pdf' : 'synthetic.xml';
    const files = [file(name), file(name)];
    await expect(readReceivedFiles(files, kind, new AbortController().signal)).rejects.toThrow('un solo');
    for (const candidate of files) expect(candidate.arrayBuffer).not.toHaveBeenCalled();
  });

  it('preserves every byte across base64 chunk boundaries and keeps file order', async () => {
    const bytes = Uint8Array.from({ length: 65539 }, (_, index) => index % 256);
    const files = [file('synthetic.XML', bytes.length, bytes), file('synthetic.zip', 5, new Uint8Array([0, 255, 128, 13, 10]))];
    const result = await readReceivedFiles(files, 'UPLOAD', new AbortController().signal);
    expect(result).toEqual(files.map((candidate, index) => ({
      fileName: candidate.name,
      contentBase64: Buffer.from(index === 0 ? bytes : new Uint8Array([0, 255, 128, 13, 10])).toString('base64'),
    })));
    expect([...Buffer.from(result[0].contentBase64, 'base64')]).toEqual([...bytes]);
    expect(result.map(value => Object.keys(value).sort())).toEqual([
      ['contentBase64', 'fileName'], ['contentBase64', 'fileName'],
    ]);
    for (const candidate of files) expect(candidate.arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['PROVIDER_PDF', 'synthetic.pdf'], ['CDR', 'synthetic.xml'], ['CDR', 'synthetic.zip'],
  ] as const)('reads a valid %s attachment %s', async (kind, name) => {
    expect(await readReceivedFiles([file(name)], kind, new AbortController().signal)).toEqual([{ fileName: name, contentBase64: 'QQ==' }]);
  });

  it.each([1, 3])('rejects content length %i when the declared size is 2 and stops later reads', async actualSize => {
    const first = file('changed.xml', 2, new Uint8Array(actualSize));
    const later = file('later.xml');
    await expect(readReceivedFiles([first, later], 'UPLOAD', new AbortController().signal)).rejects.toThrow('cambió durante la lectura');
    expect(later.arrayBuffer).not.toHaveBeenCalled();
  });

  it('propagates a read failure without reading later files', async () => {
    const failure = new Error('synthetic read failure');
    const first = file();
    first.arrayBuffer.mockRejectedValueOnce(failure);
    const later = file('later.xml');
    await expect(readReceivedFiles([first, later], 'UPLOAD', new AbortController().signal)).rejects.toBe(failure);
    expect(later.arrayBuffer).not.toHaveBeenCalled();
  });

  it('does not read anything if the request is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('synthetic cancellation');
    controller.abort(reason);
    const files = [file(), file('later.xml')];
    await expect(readReceivedFiles(files, 'UPLOAD', controller.signal)).rejects.toBe(reason);
    for (const candidate of files) expect(candidate.arrayBuffer).not.toHaveBeenCalled();
  });

  it('rejects a late read completion after abort and never starts the next file', async () => {
    const controller = new AbortController();
    const pending = deferredBuffer();
    const first = file();
    first.arrayBuffer.mockReturnValueOnce(pending.promise);
    const later = file('later.xml');
    const result = readReceivedFiles([first, later], 'UPLOAD', controller.signal);
    expect(first.arrayBuffer).toHaveBeenCalledTimes(1);
    const reason = new Error('cancel pending read');
    controller.abort(reason);
    const rejected = expect(result).rejects.toBe(reason);
    pending.resolve(new Uint8Array([65]).buffer);
    await rejected;
    expect(later.arrayBuffer).not.toHaveBeenCalled();
  });
});

describe('received upload command and registration semantics', () => {
  it('keeps companyId numeric and includes only the selected optional branch', () => {
    const withBranch: ReceivedUploadCommand = receivedUploadCommand(selection, uploadFiles);
    expect(withBranch).toEqual({ companyId: 101, branchId: branchA.id, files: uploadFiles });
    expect(typeof withBranch.companyId).toBe('number');
    const withoutBranch: ReceivedUploadCommand = receivedUploadCommand(companySelection, uploadFiles);
    expect(withoutBranch).toEqual({ companyId: 101, files: uploadFiles });
    expect(withoutBranch).not.toHaveProperty('branchId');
    expect(withBranch.files).toBe(uploadFiles);
    expect(companySelection).toEqual({ company: companyA });
  });

  it('rejects an upload without an authorized selection', () => {
    expect(() => receivedUploadCommand(undefined, uploadFiles)).toThrow('Selecciona un RUC');
  });

  it('trims an ERP reference only when registering and allows a blank reference', () => {
    expect(receivedRegistration(true, '  ERP-QA-1 \n')).toEqual({ registered: true, erpReference: 'ERP-QA-1' });
    expect(receivedRegistration(true, ' \t ')).toEqual({ registered: true, erpReference: '' });
  });

  it('unregistering omits the previous ERP reference entirely', () => {
    expect(receivedRegistration(false, ' ERP-QA-1 ')).toEqual({ registered: false });
    expect(receivedRegistration(false, '')).not.toHaveProperty('erpReference');
  });
});

describe('received operation cancellation', () => {
  it('starting a replacement aborts the previous request and rejects its completion', () => {
    const operation = createReceivedOperation();
    const first = operation.start();
    expect(operation.current(first)).toBe(true);
    const second = operation.start();
    expect(second).not.toBe(first);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(operation.current(first)).toBe(false);
    expect(operation.current(second)).toBe(true);
    expect(operation.current(new AbortController())).toBe(false);
  });

  it('cancel is idempotent, clears the current operation and permits a fresh start', () => {
    const operation = createReceivedOperation();
    operation.cancel();
    const first = operation.start();
    operation.cancel();
    operation.cancel();
    expect(first.signal.aborted).toBe(true);
    expect(operation.current(first)).toBe(false);
    const fresh = operation.start();
    expect(operation.current(fresh)).toBe(true);
    expect(fresh.signal.aborted).toBe(false);
  });

  it('does not accept an externally aborted current controller', () => {
    const operation = createReceivedOperation();
    const controller = operation.start();
    controller.abort();
    expect(operation.current(controller)).toBe(false);
  });

  it('a replacement operation blocks stale file content and subsequent reads', async () => {
    const operation = createReceivedOperation();
    const old = operation.start();
    const pending = deferredBuffer();
    const first = file();
    first.arrayBuffer.mockReturnValueOnce(pending.promise);
    const later = file('later.xml');
    const result = readReceivedFiles([first, later], 'UPLOAD', old.signal);
    const current = operation.start();
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    pending.resolve(new Uint8Array([65]).buffer);
    await rejected;
    expect(later.arrayBuffer).not.toHaveBeenCalled();
    expect(operation.current(old)).toBe(false);
    expect(operation.current(current)).toBe(true);
  });
});

describe('received document presentation preserves unknown and nullable values', () => {
  it.each([
    ['01', 'Factura · 01'], ['03', 'Boleta · 03'], ['07', 'Nota de crédito · 07'],
    ['08', 'Nota de débito · 08'], ['09', 'Guía remitente · 09'], ['31', 'Guía transportista · 31'],
    ['99', 'Tipo 99'], ['UNKNOWN', 'Tipo UNKNOWN'], ['', 'Tipo '],
  ])('labels document type %j as %j', (type, label) => {
    expect(receivedTypeLabel(type)).toBe(label);
  });

  it.each([
    [null, null, '—'], [null, 'PEN', '—'], ['', 'USD', '—'],
    ['0', null, '0'], ['0.00', 'PEN', '0.00 PEN'], ['12345678901234567890.1234', 'USD', '12345678901234567890.1234 USD'],
    ['-12.3400', '', '-12.3400'],
  ] as const)('renders amount %j with currency %j as %j', (amount, currency, expected) => {
    expect(receivedAmount(amount, currency)).toBe(expected);
  });

  it('uses the default null currency without changing the amount', () => {
    expect(receivedAmount('12.3400')).toBe('12.3400');
    expect(receivedAmount(row().payableAmount, row().currencyCode)).toBe('—');
  });
});
