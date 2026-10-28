import { afterEach, describe, expect, it, vi } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { SireReadClient, SIRE_LIMITS, SireError, sireRecentPeriods, type SireCredentials } from '../services/received-documents-service/src/automation/sire-client';
import { fixtureSirePurchases } from '../services/received-documents-service/src/automation/sire-fixture';
import { parseSirePurchases, parseSirePurchaseBatch, SIRE_RCE_HEADERS } from '../services/received-documents-service/src/automation/sire-parser';
import { assertSireReadRequest, sireExportUrl, sireTokenUrl, SIRE_ORIGIN, SIRE_MASSIVE_PATH } from '../services/received-documents-service/src/automation/sire-http';
import { unpackSireZip } from '../services/received-documents-service/src/automation/sire-zip';

// All identities, credentials, tokens and bytes below are synthetic. No real I/O.
const ruc = '00000000001', period = '202610', ticket = '20260100000001';
const credentials: SireCredentials = { ruc, clientId: 'fixture-client', clientSecret: 'FAKE-client-secret', solUsername: 'FAKEUSER', solPassword: 'FAKE-sol-password' };
const token = 'FAKE-access-token';
const reportName = '00000000001-CPF-202610-01.zip';
const fixture = () => fixtureSirePurchases(ruc, period)[0];
function textFile(changes: Record<number, string> = {}, headers: readonly string[] = SIRE_RCE_HEADERS, delimiter = '|'): Buffer {
  const raw = fixture().rawRecord;
  const row = headers.map((header, i) => changes[i] ?? raw[header] ?? '');
  const quote = (value: string) => /[",;|\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  const line = (values: readonly string[]) => values.map(quote).join(delimiter);
  return Buffer.from(`${line(headers)}${delimiter === '|' ? '|' : ''}\r\n${line(row)}${delimiter === '|' ? '|' : ''}\r\n`);
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; }
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(files = [{ name: 'proposal.txt', bytes: textFile() }], deflated = false, descriptor = false): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name), data = deflated ? deflateRawSync(file.bytes) : file.bytes;
    const crc = crc32(file.bytes), local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(descriptor ? 8 : 0, 6); local.writeUInt16LE(deflated ? 8 : 0, 8);
    if (!descriptor) { local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(file.bytes.length, 22); }
    local.writeUInt16LE(name.length, 26);
    const tail = descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (descriptor) { tail.writeUInt32LE(0x08074b50); tail.writeUInt32LE(crc, 4); tail.writeUInt32LE(data.length, 8); tail.writeUInt32LE(file.bytes.length, 12); }
    locals.push(local, name, data, tail);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(descriptor ? 8 : 0, 8); dir.writeUInt16LE(deflated ? 8 : 0, 10); dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(file.bytes.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name); offset += local.length + name.length + data.length + tail.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const jsonResponse = (data: unknown, status = 200, headers?: ConstructorParameters<typeof Headers>[0]) => new Response(JSON.stringify(data), { status, headers });
const authResponse = () => jsonResponse({ access_token: token, token_type: 'bearer', expires_in: 3600, refresh_token: 'FAKE-ignore-refresh-token' });
function ticketResponse(overrides: Record<string, unknown> = {}, reports?: unknown[]) {
  return jsonResponse({ paginacion: { page: 1, perPage: 20, totalRegistros: 1 }, registros: [{
    perTributario: period, numTicket: ticket, codProceso: '10', codEstadoProceso: '06',
    detalleTicket: { numTicket: ticket }, archivoReporte: reports ?? [{ nomArchivoReporte: reportName, codTipoAchivoReporte: '01' }], ...overrides,
  }] });
}
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  return vi.fn<typeof fetch>(async () => {
    const next = responses.shift(); if (!next) throw new Error('FAKE unexpected request'); return next();
  });
}
function flow(options: { bytes?: Buffer; ticket?: () => Response; extra?: (() => Response)[] } = {}) {
  const fetcher = fakeFetch([authResponse, () => jsonResponse({ numTicket: ticket }), ...(options.extra ?? []),
    options.ticket ?? (() => ticketResponse()), () => new Response(new Uint8Array(options.bytes ?? zip()))]);
  return { fetcher, client: new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }) };
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('SIRE synthetic fixture and RCE parser', () => {
  it('exports the agreed projection with configurable fictional recipient and no invented fiscal evidence', () => {
    const purchase = fixtureSirePurchases('00000000999', '202402')[0];
    expect(purchase).toMatchObject({ recipientRuc: '00000000999', period: '202402', supplierRuc: '00000000002',
      documentType: '01', series: 'FZ01', number: '202402', fullNumber: 'FZ01-202402', issueDate: '2024-02-01', currencyCode: 'PEN', amount: '118.00' });
    expect(Object.keys(purchase).sort()).toEqual(['recipientRuc', 'period', 'supplierRuc', 'supplierName', 'documentType', 'series', 'number', 'fullNumber', 'issueDate', 'currencyCode', 'amount', 'rawRecord'].sort());
    expect(Object.isFrozen(purchase.rawRecord)).toBe(true);
    expect(purchase.rawRecord['CAR SUNAT']).toBe('0000000000201FZ010000202402');
    expect(JSON.parse(JSON.stringify(purchase.rawRecord))).toMatchObject({ RUC: '00000000999', 'Total CP': '118.00' });
  });
  it.each(['20123456789', '001', '00../secret', '0000000000x'])('refuses non-fictional/invalid fixture identity %s', identity => {
    expect(() => fixtureSirePurchases(identity, period)).toThrow(SireError);
  });
  it.each(['202600', '202613', '../url', '2026-10'])('rejects invalid period %s', value => expect(() => fixtureSirePurchases(ruc, value)).toThrow(SireError));
  it.each(['|', ',', ';'])('reads official headers and positions in %s files including quoted fields', delimiter => {
    const supplierName = 'FICTICIO, "A"; B|C\nSAC';
    expect(parseSirePurchases(textFile({ 13: supplierName, 9: '000001' }, SIRE_RCE_HEADERS, delimiter), ruc, period)[0])
      .toMatchObject({ supplierName, number: '000001', fullNumber: 'FZ01-000001', amount: '118.00' });
  });
  it('supports BOM, documented header aliases and ISO date without guessing missing money/currency', () => {
    const headers = [...SIRE_RCE_HEADERS]; headers[1] = 'Apellidos y Nombres o Razón social'; headers[23] = 'Otros Tributos';
    const bytes = textFile({ 4: '2026-10-01', 13: '', 24: '', 25: '' }, headers);
    expect(parseSirePurchases(Buffer.concat([Buffer.from('\uFEFF'), bytes]), ruc, period)[0]).toMatchObject({
      issueDate: '2026-10-01', supplierName: null, amount: null, currencyCode: null,
    });
  });
  it('allows a header-only proposal and preserves extra status columns solely in rawRecord', () => {
    expect(parseSirePurchases(Buffer.from(SIRE_RCE_HEADERS.join('|') + '|\n'), ruc, period)).toEqual([]);
    const headers = [...SIRE_RCE_HEADERS, 'Tipo de Cambio', 'Estado del Comprobante de Pago', 'CDR'];
    const purchase = parseSirePurchases(textFile({ 27: 'ACEPTADO', 28: 'FAKE-CDR' }, headers), ruc, period)[0];
    expect(purchase.rawRecord['Estado del Comprobante de Pago']).toBe('ACEPTADO');
    expect(purchase).not.toHaveProperty('sunatStatus'); expect(purchase).not.toHaveProperty('cdr'); expect(purchase).not.toHaveProperty('items');
  });
  it('keeps signed exact decimal strings without Number conversion', () => {
    expect(parseSirePurchases(textFile({ 6: '07', 24: '-999999999999.99' }), ruc, period)[0].amount).toBe('-999999999999.99');
  });
  it.each([
    [{ 0: '00000000999' }, 'IDENTITY'], [{ 2: '202609' }, 'IDENTITY'],
    [{ 11: '1', 12: '12345678' }, 'UNSUPPORTED_RECORD'], [{ 10: '2' }, 'UNSUPPORTED_RECORD'],
    [{ 4: '31/02/2026' }, 'UNSUPPORTED_RECORD'], [{ 4: '01/10/26' }, 'UNSUPPORTED_RECORD'],
    [{ 24: '1,000.00' }, 'UNSUPPORTED_RECORD'], [{ 24: '1e2' }, 'UNSUPPORTED_RECORD'], [{ 24: '1.234' }, 'UNSUPPORTED_RECORD'],
    [{ 25: 'S/' }, 'UNSUPPORTED_RECORD'], [{ 7: '../FZ01' }, 'UNSUPPORTED_RECORD'], [{ 9: '' }, 'UNSUPPORTED_RECORD'],
  ])('rejects malformed/foreign/unsupported records without leaking record values', (changes, code) => {
    try { parseSirePurchases(textFile(changes as Record<number, string>), ruc, period); throw new Error('expected rejection'); }
    catch (error) { expect(error).toMatchObject({ name: 'SireError', code, message: `SIRE ${code}` }); }
  });
  it('rejects wrong positions, duplicate headers, truncated rows, headerless and malformed CSV', () => {
    const swapped = [...SIRE_RCE_HEADERS]; [swapped[0], swapped[12]] = [swapped[12], swapped[0]];
    const duplicate = [...SIRE_RCE_HEADERS]; duplicate[25] = 'RUC';
    for (const bytes of [textFile({}, swapped), textFile({}, duplicate),
      Buffer.from(SIRE_RCE_HEADERS.join('|') + '\n' + Object.values(fixture().rawRecord).slice(0, 25).join('|')),
      Buffer.from(Object.values(fixture().rawRecord).join('|')), Buffer.from(textFile().toString().replace('PROVEEDOR FICTICIO', '"unclosed'))]) {
      expect(() => parseSirePurchases(bytes, ruc, period)).toThrow(SireError);
    }
  });
  it('reports unsupported DNI/RH/ranges/record values with visible raw data while advancing supported purchases', () => {
    const row = (changes: Record<number, string>) => textFile(changes).toString().split('\r\n')[1];
    const bytes = Buffer.from(SIRE_RCE_HEADERS.join('|') + '|\n' + [
      row({}), row({ 6: '02', 11: '1', 12: '12345678' }), row({ 10: '9' }),
      row({ 7: '', 9: '' }), row({ 24: 'bad FAKE amount' }), row({ 9: 'NEXT' }),
    ].join('\n'));
    const batch = parseSirePurchaseBatch(bytes, ruc, period);
    expect(batch.purchases.map(p => p.fullNumber)).toEqual(['FZ01-202610', 'FZ01-NEXT']);
    expect(batch.incidents.map(i => [i.ordinal, i.code])).toEqual([[2, 'SUPPLIER_IDENTITY_NOT_RUC'], [3, 'CONSOLIDATED_RANGE'], [4, 'DOCUMENT_IDENTITY'], [5, 'RECORD_VALUE']]);
    expect(batch.incidents[0].rawRecord['Nro Doc Identidad']).toBe('12345678');
    expect(batch.incidents.every(i => Object.isFrozen(i.rawRecord))).toBe(true);
    expect(() => parseSirePurchases(bytes, ruc, period)).toThrow('SIRE UNSUPPORTED_RECORD');
  });
  it.each(['R1', 'R7', '02'])('preserves %s and non-UBL 20-character alphanumeric identities for discovery', type => {
    const batch = parseSirePurchaseBatch(textFile({ 6: type, 7: 'ABCDEFGHIJ1234567890', 9: 'ABCDEFGHIJ1234567890' }), ruc, period);
    expect(batch.incidents).toEqual([]); expect(batch.purchases[0]).toMatchObject({ documentType: type, series: 'ABCDEFGHIJ1234567890', number: 'ABCDEFGHIJ1234567890' });
  });
  it('batch API still fails closed for foreign recipient/period or structurally ambiguous records', () => {
    for (const bytes of [textFile({ 0: '00000000999' }), textFile({ 2: '202609' }), textFile({}, SIRE_RCE_HEADERS.slice(1))])
      expect(() => parseSirePurchaseBatch(bytes, ruc, period)).toThrow(SireError);
  });
  it('rejects invalid UTF-8, control characters, oversized fields, too many columns/rows/bytes', () => {
    const header = SIRE_RCE_HEADERS.join('|'), row = Object.values(fixture().rawRecord).join('|');
    const excessiveRows = Buffer.from(`${header}\n${`${row}\n`.repeat(SIRE_LIMITS.rows + 1)}`);
    for (const bytes of [Buffer.from([0xff]), textFile({ 13: 'FAKE\0SECRET' }), textFile({ 13: 'A'.repeat(SIRE_LIMITS.fieldChars + 1) }),
      textFile({}, [...SIRE_RCE_HEADERS, ...Array.from({ length: 55 }, (_, i) => `Extra${i}`)]),
      excessiveRows, Buffer.alloc(SIRE_LIMITS.entryBytes + 1)]) {
      expect(() => parseSirePurchases(bytes, ruc, period)).toThrow(SireError);
    }
  });
});

describe('SIRE bounded TXT/CSV ZIP', () => {
  it.each([[false, false], [true, false], [true, true]])('accepts stored/deflate and checked data descriptors (%s, %s)', (compressed, descriptor) => {
    const data = textFile(); expect(unpackSireZip(zip([{ name: 'proposal.csv', bytes: data }], compressed, descriptor)))
      .toEqual([{ fileName: 'proposal.csv', bytes: data }]);
  });
  it.each(['../proposal.txt', 'dir/proposal.txt', 'dir\\proposal.csv', 'proposal.xml', 'proposal.pdf', 'nested.zip', 'CON.txt', 'proposal%2ftxt'])('refuses unsafe/non-RCE flat filename %s', name => {
    expect(() => unpackSireZip(zip([{ name, bytes: textFile() }]))).toThrow(SireError);
  });
  it('rejects nested ZIP bytes even renamed as TXT, duplicates, empty files and empty ZIP', () => {
    for (const bytes of [zip([{ name: 'nested.txt', bytes: zip() }]), zip([{ name: 'A.txt', bytes: textFile() }, { name: 'a.TXT', bytes: textFile() }]),
      zip([{ name: 'empty.txt', bytes: Buffer.alloc(0) }]), zip([])]) expect(() => unpackSireZip(bytes)).toThrow(SireError);
  });
  it('rejects encryption, symlinks, unsupported methods, multidisk, ZIP64, CRC/local mismatch and truncation', () => {
    const original = zip(), central = original.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    const mutations: ((b: Buffer) => void)[] = [
      b => { b.writeUInt16LE(1, 6); b.writeUInt16LE(1, central + 8); },
      b => b.writeUInt32LE((0xa000 << 16) >>> 0, central + 38),
      b => { b.writeUInt16LE(99, 8); b.writeUInt16LE(99, central + 10); },
      b => b.writeUInt16LE(1, b.length - 22 + 4), b => b.writeUInt32LE(0xffffffff, central + 24),
      b => { b[45] ^= 1; }, b => b.writeUInt32LE(12, 22),
      b => b.writeUInt16LE(101, b.length - 22 + 10),
    ];
    for (const mutate of mutations) { const bad = Buffer.from(original); mutate(bad); expect(() => unpackSireZip(bad)).toThrow(SireError); }
    expect(() => unpackSireZip(original.subarray(0, original.length - 1))).toThrow(SireError);
    expect(() => unpackSireZip(Buffer.concat([original, Buffer.from('hidden')]))).toThrow(SireError);
  });
  it('preflights compression bombs and declarations, bounds actual inflate, and applies remaining global budget', () => {
    expect(() => unpackSireZip(zip([{ name: 'bomb.txt', bytes: Buffer.alloc(100_000, 65) }], true))).toThrow(SireError);
    const bad = zip(undefined, true), central = bad.indexOf(Buffer.from([0x50, 0x4b, 1, 2]));
    bad.writeUInt32LE(100, 22); bad.writeUInt32LE(100, central + 24);
    expect(() => unpackSireZip(bad)).toThrow(SireError);
    expect(() => unpackSireZip(zip(), { maxEntries: 0, maxExpandedBytes: SIRE_LIMITS.expandedBytes })).toThrow(SireError);
    expect(() => unpackSireZip(zip(), { maxEntries: 100, maxExpandedBytes: 1 })).toThrow(SireError);
    expect(() => unpackSireZip(Buffer.alloc(SIRE_LIMITS.downloadBytes + 1))).toThrow(SireError);
  });
});

describe('SIRE read-only fake HTTP integration', () => {
  it('does zero network activity by default, even with injected fetch and with recent-period synchronization', async () => {
    const fetcher = vi.fn<typeof fetch>(), real = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', real);
    for (const client of [new SireReadClient(credentials), new SireReadClient(credentials, { fetch: fetcher }),
      new SireReadClient(credentials, { fetch: fetcher, liveAllowed: false })]) {
      await expect(client.readPeriod(period)).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
      await expect(client.readRecentPeriods()).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
      await expect(client.readPeriodDetailed(period)).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
      await expect(client.readRecentPeriodsDetailed()).rejects.toMatchObject({ code: 'LIVE_DISABLED' });
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(real).not.toHaveBeenCalled();
  });
  it('executes token -> GET proposal -> GET ticket -> GET ZIP with exact official URLs and private credentials', async () => {
    const globalFetch = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', globalFetch);
    const { client, fetcher } = flow(); expect(await client.readPeriod(period)).toEqual([fixture()]);
    expect(globalFetch).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(4);
    const [auth, proposal, state, download] = fetcher.mock.calls;
    expect(auth[0]).toBe(sireTokenUrl(credentials.clientId)); expect(auth[1]?.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(auth[1]!.body as string))).toEqual({ grant_type: 'password', scope: SIRE_ORIGIN,
      client_id: credentials.clientId, client_secret: credentials.clientSecret, username: ruc + credentials.solUsername, password: credentials.solPassword });
    expect(proposal[0]).toBe(sireExportUrl(period));
    expect(state[0]).toBe(`${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}consultaestadotickets?perIni=${period}&perFin=${period}&page=1&perPage=20&numTicket=${ticket}&codLibro=080000&codOrigenEnvio=2`);
    expect(download[0]).toBe(`${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}archivoreporte?nomArchivoReporte=${reportName}&codTipoArchivoReporte=01&perTributario=${period}&codProceso=10&numTicket=${ticket}&codLibro=080000`);
    for (const call of fetcher.mock.calls) {
      expect(call[1]).toMatchObject({ redirect: 'manual', credentials: 'omit', cache: 'no-store' });
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(String(call[0])).not.toContain(credentials.clientSecret); expect(String(call[0])).not.toContain(token);
    }
    for (const call of [proposal, state, download]) {
      expect(call[1]?.method).toBe('GET'); expect(call[1]?.body).toBeUndefined();
      expect(new Headers(call[1]?.headers).get('authorization')).toBe(`Bearer ${token}`);
    }
    expect(Object.keys(client)).toEqual([]); expect(JSON.stringify(client)).toBe('{}');
  });
  it('handles pending tickets, then multiple partition ZIPs and null report type without discarding records', async () => {
    vi.useFakeTimers();
    const first = 'part1.zip', second = 'part2.zip';
    const fetcher = fakeFetch([authResponse, () => jsonResponse({ numTicket: ticket }),
      () => ticketResponse({ codEstadoProceso: '05' }), () => ticketResponse({}, [
        { nomArchivoReporte: first, codTipoArchivoReporte: null }, { nomArchivoReporte: second, codTipoAchivoReporte: '01' },
      ]), () => new Response(new Uint8Array(zip([{ name: 'part1.txt', bytes: textFile() }], true))),
      () => new Response(new Uint8Array(zip([{ name: 'part2.csv', bytes: textFile({ 9: '2' }, SIRE_RCE_HEADERS, ',') }], true)))]);
    const pending = new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period);
    await vi.advanceTimersByTimeAsync(SIRE_LIMITS.pollDelayMs);
    expect((await pending).map(p => p.fullNumber)).toEqual(['FZ01-202610', 'FZ01-2']);
    expect(new URL(String(fetcher.mock.calls[4][0])).searchParams.get('codTipoArchivoReporte')).toBe('null');
  });
  it('uses Lima current period and previous two across year boundaries, synchronizing sequentially', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T03:00:00Z'));
    expect(sireRecentPeriods()).toEqual(['202512', '202511', '202510']);
    expect(sireRecentPeriods('202601')).toEqual(['202601', '202512', '202511']);
    const client = new SireReadClient(credentials, { fetch: vi.fn<typeof fetch>(), liveAllowed: true });
    const read = vi.spyOn(client, 'readPeriod').mockImplementation(async value => fixtureSirePurchases(ruc, value));
    expect((await client.readRecentPeriods('202601')).map(p => p.period)).toEqual(['202601', '202512', '202511']);
    expect(read.mock.calls.map(c => c[0])).toEqual(['202601', '202512', '202511']);
  });
  it('detailed fake HTTP preserves supported records and incident ordinals across ZIP partitions', async () => {
    const mixed = Buffer.from(textFile().toString() + textFile({ 11: '1', 12: '12345678' }).toString().split('\r\n')[1] + '\n');
    const { client } = flow({ bytes: zip([{ name: 'part1.txt', bytes: mixed }, { name: 'part2.txt', bytes: textFile({ 10: '9' }) }]) });
    const batch = await client.readPeriodDetailed(period);
    expect(batch.purchases).toEqual([fixture()]);
    expect(batch.incidents.map(i => [i.ordinal, i.code])).toEqual([[2, 'SUPPLIER_IDENTITY_NOT_RUC'], [3, 'CONSOLIDATED_RANGE']]);
    expect(batch.incidents[0].rawRecord['Nro Doc Identidad']).toBe('12345678');
    const legacy = flow({ bytes: zip([{ name: 'mixed.txt', bytes: mixed }]) });
    await expect(legacy.client.readPeriod(period)).rejects.toMatchObject({ code: 'UNSUPPORTED_RECORD' });
  });
  it('keeps credentials/tokens isolated per RUC and snapshots credentials without duplicate SOL prefix', async () => {
    const other = '00000000999', copy = { ...credentials };
    const a = flow(); const b = fakeFetch([authResponse, () => jsonResponse({ numTicket: ticket }), () => ticketResponse(),
      () => new Response(new Uint8Array(zip([{ name: 'other.txt', bytes: textFile({ 0: other }) }])))]);
    const client = new SireReadClient({ ...copy, ruc: other }, { fetch: b, liveAllowed: true }); copy.solUsername = 'CHANGED';
    expect((await a.client.readPeriod(period))[0].recipientRuc).toBe(ruc);
    expect((await client.readPeriod(period))[0].recipientRuc).toBe(other);
    expect(new URLSearchParams(b.mock.calls[0][1]!.body as string).get('username')).toBe(other + credentials.solUsername);
    expect(() => new SireReadClient({ ...credentials, solUsername: ruc + credentials.solUsername })).toThrow(SireError);
    expect(() => new SireReadClient({ ...credentials, solUsername: other + credentials.solUsername })).toThrow(SireError);
    expect(() => new SireReadClient({ ...credentials, clientId: '../FAKE' })).toThrow(SireError);
  });
  it.each(['202613', '../202610', '2026-10'])('rejects invalid period %s before injected HTTP', async value => {
    const { client, fetcher } = flow(); await expect(client.readPeriod(value)).rejects.toMatchObject({ code: 'INPUT' }); expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { codProceso: '2' }, { codEstadoProceso: '03' }, { codEstadoProceso: '99' }, { detalleTicket: { numTicket: '20260100000002' } },
  ])('refuses non-export/error/mismatched tickets %j', async overrides => {
    const { client, fetcher } = flow({ ticket: () => ticketResponse(overrides) });
    await expect(client.readPeriod(period)).rejects.toBeInstanceOf(SireError); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds polling and never downloads another period/ticket', async () => {
    vi.useFakeTimers();
    const fetcher = fakeFetch([authResponse, () => jsonResponse({ numTicket: ticket }),
      ...Array.from({ length: SIRE_LIMITS.ticketPolls }, () => () => ticketResponse({ perTributario: '202609' }))]);
    const pending = new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TICKET_PENDING' });
    await vi.advanceTimersByTimeAsync(SIRE_LIMITS.pollDelayMs * SIRE_LIMITS.ticketPolls); await assertion;
    expect(fetcher).toHaveBeenCalledTimes(2 + SIRE_LIMITS.ticketPolls);
  });
  it.each(['https://evil.invalid/file.zip', '../secret.zip', 'directory/file.zip'])('rejects server-controlled report paths %s before download', async name => {
    const { client, fetcher } = flow({ ticket: () => ticketResponse({}, [{ nomArchivoReporte: name, codTipoAchivoReporte: '01' }]) });
    await expect(client.readPeriod(period)).rejects.toMatchObject({ code: 'ARCHIVE' }); expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects duplicate report/entry names, conflicting aliases, too many reports and foreign ZIP records', async () => {
    const variants = [
      flow({ ticket: () => ticketResponse({}, [{ nomArchivoReporte: reportName, codTipoAchivoReporte: '01', codTipoArchivoReporte: '02' }]) }),
      flow({ ticket: () => ticketResponse({}, Array.from({ length: 11 }, () => ({ nomArchivoReporte: reportName, codTipoAchivoReporte: '01' }))) }),
      flow({ ticket: () => ticketResponse({}, Array.from({ length: 2 }, () => ({ nomArchivoReporte: reportName, codTipoAchivoReporte: '01' }))) }),
      flow({ bytes: zip([{ name: 'foreign.txt', bytes: textFile({ 0: '00000000999' }) }]) }),
    ];
    for (const { client } of variants) await expect(client.readPeriod(period)).rejects.toBeInstanceOf(SireError);
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('allowlist refuses %s on every SIRE read endpoint', method => {
    for (const address of [sireExportUrl(period), `${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}consultaestadotickets`, `${SIRE_ORIGIN}${SIRE_MASSIVE_PATH}archivoreporte`])
      expect(() => assertSireReadRequest(address, method)).toThrow(SireError);
  });
  it.each([
    'http://api-sire.sunat.gob.pe/', 'https://api-sire.sunat.gob.pe.evil.invalid/', 'https://evil.invalid/',
    'https://user@api-sire.sunat.gob.pe/', 'https://api-sire.sunat.gob.pe:8443/',
    `${SIRE_ORIGIN}/v1/contribuyente/migeigv/libros/rce/propuesta/web/registroslibros/${period}/aceptarpropuesta`,
    `${sireExportUrl(period)}&callback=https%3A%2F%2Fevil.invalid`, `${sireExportUrl(period)}&codTipoArchivo=1`,
    `${sireExportUrl(period)}#FAKE`,
  ])('refuses arbitrary/write/ambiguous URL %s', address => expect(() => assertSireReadRequest(address, 'GET')).toThrow(SireError));
  it.each([301, 302, 303, 307, 308])('rejects HTTP %s redirects without following', async status => {
    const fetcher = fakeFetch([() => new Response('FAKE-secret-body', { status, headers: { location: 'https://evil.invalid/' } })]);
    await expect(new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period)).rejects.toMatchObject({ code: 'REDIRECT', message: 'SIRE REDIRECT' });
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0][1]?.redirect).toBe('manual');
  });
  it('also refuses already-followed redirects and a changed response URL', async () => {
    for (const props of [{ redirected: true }, { url: 'https://evil.invalid/' }]) {
      const response = authResponse(); for (const [key, value] of Object.entries(props)) Object.defineProperty(response, key, { value });
      const fetcher = fakeFetch([() => response]);
      await expect(new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period)).rejects.toMatchObject({ code: 'REDIRECT' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('backs off twice on 429 using bounded Retry-After and no retries for other HTTP errors', async () => {
    vi.useFakeTimers();
    const fetcher = fakeFetch([() => jsonResponse({ secret: token }, 429, { 'retry-after': '999999' }),
      () => jsonResponse({}, 429), authResponse, () => jsonResponse({ numTicket: ticket }), () => ticketResponse(),
      () => new Response(new Uint8Array(zip()))]);
    const pending = new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period);
    await vi.advanceTimersByTimeAsync(4999); expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999); expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual([fixture()]);
    const fail = fakeFetch([() => jsonResponse({ secret: token }, 503)]);
    await expect(new SireReadClient(credentials, { fetch: fail, liveAllowed: true }).readPeriod(period)).rejects.toMatchObject({ code: 'HTTP', status: 503 });
    expect(fail).toHaveBeenCalledTimes(1);
  });
  it('stops after three 429 attempts with sanitized error', async () => {
    vi.useFakeTimers(); const fetcher = fakeFetch(Array.from({ length: 3 }, () => () => jsonResponse({ token }, 429)));
    const pending = new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'RATE_LIMIT', status: 429, message: 'SIRE RATE_LIMIT (HTTP 429)' });
    await vi.advanceTimersByTimeAsync(1500); await assertion; expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('times out fetch and stalled response bodies, aborting even non-cooperative injected HTTP', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    for (const stalled of [() => new Promise<Response>(() => {}), () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start() {}, cancel })))]) {
      const fetcher = vi.fn<typeof fetch>(stalled);
      const pending = new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period);
      const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT', message: 'SIRE TIMEOUT' });
      await vi.advanceTimersByTimeAsync(SIRE_LIMITS.requestTimeoutMs); await assertion;
      expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    }
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('bounds declared and streamed JSON/download sizes without trusting Content-Length', async () => {
    for (const response of [new Response('x', { headers: { 'content-length': String(SIRE_LIMITS.jsonBytes + 1) } }),
      new Response(new Uint8Array(SIRE_LIMITS.jsonBytes + 1)), new Response('x', { headers: { 'content-length': '-1' } })]) {
      const fetcher = fakeFetch([() => response]);
      await expect(new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true }).readPeriod(period)).rejects.toMatchObject({ code: 'SIZE' });
    }
    const { client } = flow({ bytes: Buffer.alloc(SIRE_LIMITS.downloadBytes + 1) });
    await expect(client.readPeriod(period)).rejects.toMatchObject({ code: 'SIZE' });
  });
  it('sanitizes HTTP/network/JSON/error-envelope failures and performs no logging or token persistence', async () => {
    const secret = `${credentials.clientSecret} ${credentials.solPassword} ${token} https://evil.invalid/private`;
    const logging = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const failures = [
      fakeFetch([() => jsonResponse({ msg: secret, exc: secret }, 401)]),
      vi.fn<typeof fetch>(async () => { throw new Error(secret); }),
      fakeFetch([() => new Response(`malformed ${secret}`)]),
      fakeFetch([() => jsonResponse({ cod: '500', msg: secret, access_token: secret })]),
      fakeFetch([authResponse, () => jsonResponse({ error: secret })]),
    ];
    for (const fetcher of failures) {
      const client = new SireReadClient(credentials, { fetch: fetcher, liveAllowed: true });
      try { await client.readPeriod(period); throw new Error('expected rejection'); }
      catch (error) {
        expect(error).toBeInstanceOf(SireError); const failure = error as SireError;
        for (const value of [credentials.clientSecret, credentials.solPassword, token, 'https://', 'private']) {
          expect(failure.message + JSON.stringify(failure)).not.toContain(value);
        }
        expect(failure).not.toHaveProperty('cause'); expect(JSON.stringify(client)).toBe('{}');
      }
    }
    for (const spy of logging) expect(spy).not.toHaveBeenCalled();
  });
});
