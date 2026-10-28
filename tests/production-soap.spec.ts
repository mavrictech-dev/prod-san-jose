import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedPackage } from '../services/sunat-service/src/domain/ports/sunat-adapter.port';
import { BoundedSoapAdapter, SUNAT_PRODUCTION_ENDPOINT, type SoapSunatConfig } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
import { createProductionSoapAuthorization, revokeProductionSoapAuthorization, type ProductionSoapAuthorization, type ProductionSoapOperation, type ProductionSoapRequest } from '../services/sunat-service/src/infrastructure/sunat/production-soap-authorization';
import { XmlSignerService, type XmlRootKind } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { CAC_NS, CBC_NS, SERVICE_NS, SOAP_NS } from '../services/sunat-service/src/infrastructure/sunat/safe-xml';
import { SAC_NS } from '../services/sunat-service/src/infrastructure/sunat/notes-transport-qa-validator';
import { RESPONSE_NS } from '../services/sunat-service/src/infrastructure/sunat/cdr-parser';
import { betaSigningFixture } from './helpers/beta-signing.fixture';

// No validator mocks: actual ephemeral signature, ZIP decompression, XML parsing and CRC checks.
const { zipSync } = createRequire(new URL('../services/sunat-service/package.json', import.meta.url))('fflate') as typeof import('fflate');
const ruc = '20615878481', otherRuc = '20450819230';
const config = (): SoapSunatConfig => ({ environment: 'PRODUCTION', ruc, solUser: 'SYNTHETICUSER', solPassword: 'SYNTHETIC<&"PASSWORD' });
const all: ProductionSoapOperation[] = ['sendBill', 'sendSummary', 'getStatus'];
const soap = (method: string, body: string) => `<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><ser:${method}Response xmlns:ser="${SERVICE_NS}">${body}</ser:${method}Response></s:Body></s:Envelope>`;
const processing = () => new Response(soap('getStatus', '<status><statusCode>98</statusCode></status>'));
const packageOf = (xml: string | Buffer, fileName: string, extra: Record<string, Uint8Array> = {}): SignedPackage => {
  const zip = Buffer.from(zipSync({ [fileName.replace(/\.zip$/, '.xml')]: Buffer.from(xml), ...extra }, { level: 0 }));
  return { documentId: '50000000-0000-4000-8000-000000000981', fileName, zip, sha256: createHash('sha256').update(zip).digest('hex') };
};
const rehash = (pkg: SignedPackage): SignedPackage => ({ ...pkg, sha256: createHash('sha256').update(pkg.zip).digest('hex') });
let keys: ReturnType<typeof betaSigningFixture>;
const packages = {} as Record<'01' | '07' | '08' | 'RC' | 'RA', SignedPackage>;
const unsigned = {} as Record<keyof typeof packages, string>;
function receipt(reference = 'FQ01-1', suffix = `01-${reference}`, receiver = ruc, code = '0') {
  const xml = `<ApplicationResponse xmlns="${RESPONSE_NS}" xmlns:cbc="${CBC_NS}" xmlns:cac="${CAC_NS}"><cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${receiver}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ResponseCode>${code}</cbc:ResponseCode><cbc:Description>SYNTHETIC ONLY</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>${reference}</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
  return Buffer.from(zipSync({ 'dummy/': Buffer.alloc(0), [`R-${ruc}-${suffix}.xml`]: Buffer.from(xml) }));
}
function fixture(operations = all, assertCurrent = vi.fn<(request: ProductionSoapRequest) => void | Promise<void>>(() => {})) {
  const authorization = createProductionSoapAuthorization({ ruc, operations }, assertCurrent);
  const fetchMock = vi.fn<typeof fetch>(async () => { throw new Error('UNCONFIGURED_SYNTHETIC_RESPONSE'); });
  vi.stubGlobal('fetch', fetchMock);
  return { authorization, assertCurrent, fetchMock, adapter: new BoundedSoapAdapter(config(), authorization) };
}
const invoke = (adapter: BoundedSoapAdapter, operation: ProductionSoapOperation) => operation === 'sendBill' ? adapter.submit(packages['01'])
  : operation === 'sendSummary' ? adapter.submitSummary(packages.RC) : adapter.getStatus('SYNTHETIC-TICKET');

beforeAll(() => {
  keys = betaSigningFixture(ruc);
  for (const type of ['01', '07', '08', 'RC', 'RA'] as const) {
    const batch = type === 'RC' || type === 'RA';
    const root: XmlRootKind = type === '01' ? 'Invoice' : type === '07' ? 'CreditNote' : type === '08' ? 'DebitNote' : type === 'RC' ? 'SummaryDocuments' : 'VoidedDocuments';
    const ns = batch ? `urn:sunat:names:specification:ubl:peru:schema:xsd:${root}-1` : `urn:oasis:names:specification:ubl:schema:xsd:${root}-2`;
    const reference = batch ? `${type}-20261002-1` : 'FQ01-1';
    const supplier = batch ? `<cbc:CustomerAssignedAccountID>${ruc}</cbc:CustomerAssignedAccountID><cbc:AdditionalAccountID>6</cbc:AdditionalAccountID>`
      : `<cac:Party><cac:PartyIdentification><cbc:ID>${ruc}</cbc:ID></cac:PartyIdentification></cac:Party>`;
    const lines = type === 'RC' ? '<sac:SummaryDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>03</cbc:DocumentTypeCode><cbc:ID>BQ01-1</cbc:ID><cac:Status><cbc:ConditionCode>1</cbc:ConditionCode></cac:Status></sac:SummaryDocumentsLine>'
      : type === 'RA' ? '<sac:VoidedDocumentsLine><cbc:LineID>1</cbc:LineID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode><sac:DocumentSerialID>FQ01</sac:DocumentSerialID><sac:DocumentNumberID>1</sac:DocumentNumberID><sac:VoidReasonDescription>SYNTHETIC</sac:VoidReasonDescription></sac:VoidedDocumentsLine>' : '';
    const note = type === '07' || type === '08' ? '<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>FQ01-9</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference><cac:DiscrepancyResponse><cbc:ReferenceID>FQ01-9</cbc:ReferenceID><cbc:ResponseCode>01</cbc:ResponseCode></cac:DiscrepancyResponse>' : '';
    unsigned[type] = `<${root} xmlns="${ns}" xmlns:cbc="${CBC_NS}" xmlns:cac="${CAC_NS}" xmlns:sac="${SAC_NS}" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2"><ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension></ext:UBLExtensions><cbc:ID>${reference}</cbc:ID><cbc:IssueDate>2026-10-02</cbc:IssueDate>${batch ? '<cbc:ReferenceDate>2026-10-02</cbc:ReferenceDate>' : type === '01' ? '<cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>' : ''}<cac:AccountingSupplierParty>${supplier}</cac:AccountingSupplierParty>${note}${lines}</${root}>`;
    const xml = new XmlSignerService().sign(unsigned[type], keys.p12, keys.password, root).xml;
    packages[type] = packageOf(xml, `${ruc}-${batch ? reference : `${type}-${reference}`}.zip`);
  }
});
beforeEach(() => {
  // Flags remain off even inside this process. No production runtime is registered.
  vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false');
  vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'false');
  vi.stubEnv('SUNAT_PRODUCTION_TRANSMISSION_ENABLED', 'false');
  vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '1');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
afterAll(() => keys?.p12.fill(0));

describe('Production SOAP: private capability, no runtime or real transmission', () => {
  it.each([undefined, true, { enabled: true }, { productionAuthorized: true }, {}])('rejects missing/forged capability %# even with DTO and env booleans', capability => {
    vi.stubEnv('SUNAT_PRODUCTION_TRANSMISSION_ENABLED', 'true');
    const dto = { ...config(), enabled: true, productionAuthorized: true, authorization: capability };
    expect(() => new BoundedSoapAdapter(dto, capability as ProductionSoapAuthorization)).toThrow('deshabilitada');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects serialized, cloned and wrong-RUC grants', () => {
    const f = fixture();
    for (const capability of [JSON.parse(JSON.stringify(f.authorization)), { ...f.authorization }, createProductionSoapAuthorization({ ruc: otherRuc, operations: all }, () => {})])
      expect(() => new BoundedSoapAdapter(config(), capability)).toThrow('deshabilitada');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(all)('checks exact RUC/operation on every %s and observes owner revocation', async operation => {
    const f = fixture();
    f.assertCurrent.mockImplementationOnce(() => { throw new Error('PRIVATE POLICY DETAIL'); });
    await expect(invoke(f.adapter, operation)).rejects.toThrow('autorización privada');
    expect(f.assertCurrent).toHaveBeenCalledExactlyOnceWith({ environment: 'PRODUCTION', ruc, operation });
    expect(f.fetchMock).not.toHaveBeenCalled();
    f.fetchMock.mockResolvedValueOnce(processing());
    await expect(f.adapter.getStatus('SYNTHETIC-TICKET')).resolves.toEqual({ kind: 'PROCESSING' });
    f.assertCurrent.mockImplementationOnce(() => { throw new Error('REVOKED'); });
    await expect(f.adapter.getStatus('SYNTHETIC-TICKET')).rejects.toThrow('autorización privada');
    expect(f.fetchMock).toHaveBeenCalledOnce();
  });
  it.each(all)('scope excludes %s before HTTP', async operation => {
    const f = fixture(all.filter(value => value !== operation));
    await expect(invoke(f.adapter, operation)).rejects.toThrow('autorización privada');
    expect(f.assertCurrent).not.toHaveBeenCalled(); expect(f.fetchMock).not.toHaveBeenCalled();
  });
  it.each([true, false, { authorized: true }])('rejects non-void policy result %#', async result => {
    const f = fixture(all, vi.fn(() => result) as never);
    await expect(f.adapter.getStatus('SYNTHETIC')).rejects.toThrow('autorización privada'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(all)('revocation of an existing capability blocks %s', async operation => {
    const f = fixture(); revokeProductionSoapAuthorization(f.authorization);
    await expect(invoke(f.adapter, operation)).rejects.toThrow('autorización privada'); expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks revocation and TLS after asynchronous owner policy', async () => {
    const f = fixture();
    f.assertCurrent.mockImplementationOnce(async () => { await Promise.resolve(); revokeProductionSoapAuthorization(f.authorization); });
    await expect(f.adapter.getStatus('SYNTHETIC')).rejects.toThrow('autorización privada');
    const g = fixture(); g.assertCurrent.mockImplementationOnce(async () => { vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0'); });
    await expect(g.adapter.getStatus('SYNTHETIC')).rejects.toThrow('TLS'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ solUser: 'MODDATOS' }, { solUser: 'moddatos' }, { solPassword: 'MODDATOS' }, { solPassword: 'moddatos' }, { solUser: `${ruc}MODDATOS` }, { solUser: `${ruc}SYNTHETICUSER` }, { solUser: ' ' }, { solPassword: ' ' }, { qaScenario: 'ACCEPTED' }])('rejects public/invalid credentials or QA scenario %#', override => {
    const f = fixture(); expect(() => new BoundedSoapAdapter({ ...config(), ...override } as SoapSunatConfig, f.authorization)).toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects invalid RUC/scopes and disabled TLS without HTTP', () => {
    for (const scope of [{ ruc: '20615878480', operations: all }, { ruc, operations: [] }, { ruc, operations: ['unknown'] }, { ruc, operations: ['sendBill', 'sendBill'] }])
      expect(() => createProductionSoapAuthorization(scope as never, () => {})).toThrow();
    const f = fixture(); vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    expect(() => new BoundedSoapAdapter(config(), f.authorization)).toThrow('TLS'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['01', '07', '08'] as const)('validates signed %s and sends original bytes to the fixed production endpoint', async type => {
    const f = fixture(), pkg = packages[type], cdr = receipt('FQ01-1', `${type}-FQ01-1`);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    f.fetchMock.mockResolvedValueOnce(new Response(soap('sendBill', `<applicationResponse>${cdr.toString('base64')}</applicationResponse>`)));
    await expect(f.adapter.submit(pkg)).resolves.toEqual({ kind: 'CDR', cdrZip: cdr });
    expect(f.fetchMock).toHaveBeenCalledExactlyOnceWith(SUNAT_PRODUCTION_ENDPOINT, expect.objectContaining({ method: 'POST', redirect: 'error', headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: 'sendBill', Accept: 'text/xml' }, body: expect.stringContaining(`<contentFile>${pkg.zip.toString('base64')}</contentFile>`) }));
    const body = f.fetchMock.mock.calls[0][1]?.body as string;
    expect(body).toContain(`<wsse:Username>${ruc}SYNTHETICUSER</wsse:Username>`);
    expect(body).toContain('SYNTHETIC&lt;&amp;&quot;PASSWORD'); expect(body).not.toContain('MODDATOS'); expect(timeout).toHaveBeenCalledWith(15000);
    expect(JSON.stringify(f.adapter)).not.toContain('SYNTHETIC');
  });
  it.each(['RC', 'RA'] as const)('signed %s gets a ticket, processing, then raw CDR without asserting acceptance', async type => {
    const f = fixture(), cdr = receipt(`${type}-20261002-1`, `${type}-20261002-1`, ruc, '2335');
    f.fetchMock.mockResolvedValueOnce(new Response(soap('sendSummary', '<ticket>SYNTHETIC-TICKET</ticket>')))
      .mockResolvedValueOnce(processing())
      .mockResolvedValueOnce(new Response(soap('getStatus', `<status><statusCode>99</statusCode><content>${cdr.toString('base64')}</content></status>`)));
    expect(await f.adapter.submitSummary(packages[type])).toBe('SYNTHETIC-TICKET');
    expect(await f.adapter.getStatus('SYNTHETIC-TICKET')).toEqual({ kind: 'PROCESSING' });
    expect(await f.adapter.getStatus('SYNTHETIC-TICKET')).toEqual({ kind: 'CDR', cdrZip: cdr });
    expect(f.assertCurrent.mock.calls.map(([request]) => request.operation)).toEqual(['sendSummary', 'getStatus', 'getStatus']);
    expect(f.fetchMock.mock.calls.every(([url]) => url === SUNAT_PRODUCTION_ENDPOINT)).toBe(true);
  });
  it('freezes config/scope and captures package bytes before asynchronous policy', async () => {
    const scope = { ruc, operations: [...all] }, authorization = createProductionSoapAuthorization(scope, async () => { await Promise.resolve(); });
    const original = config(), adapter = new BoundedSoapAdapter(original, authorization);
    Object.assign(original, { environment: 'LOCAL_QA', solUser: 'MODDATOS', endpoint: 'http://invalid.test' }); scope.ruc = otherRuc; scope.operations.length = 0;
    const pkg = { ...packages['01'], zip: Buffer.from(packages['01'].zip) }, encoded = pkg.zip.toString('base64'), cdr = receipt();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(soap('sendBill', `<applicationResponse>${cdr.toString('base64')}</applicationResponse>`))); vi.stubGlobal('fetch', fetchMock);
    const pending = adapter.submit(pkg); pkg.zip.fill(0); pkg.fileName = 'changed.zip';
    await expect(pending).resolves.toMatchObject({ kind: 'CDR' });
    expect(fetchMock.mock.calls[0][0]).toBe(SUNAT_PRODUCTION_ENDPOINT); expect(fetchMock.mock.calls[0][1]?.body).toContain(encoded);
  });
  it.each(['unsigned', 'checksum', 'wrong-ruc', 'wrong-id', 'signature', 'extra-entry', 'truncated', 'crc', 'central-local', 'zip-bomb', 'DTD', 'UTF8', 'boleta'] as const)('rejects actual malformed package %s before policy and fetch', async change => {
    let pkg = { ...packages['01'], zip: Buffer.from(packages['01'].zip) };
    if (change === 'unsigned') pkg = packageOf(unsigned['01'], pkg.fileName);
    if (change === 'checksum') pkg.sha256 = '0'.repeat(64);
    if (change === 'wrong-ruc') pkg.fileName = pkg.fileName.replace(ruc, otherRuc);
    if (change === 'wrong-id') pkg.fileName = pkg.fileName.replace('FQ01-1', 'FQ01-2');
    if (change === 'signature') { const index = pkg.zip.indexOf(Buffer.from('FQ01-1')); pkg.zip[index + 5] = 50; pkg = rehash(pkg); }
    if (change === 'extra-entry') pkg = packageOf(unsigned['01'], pkg.fileName, { 'extra.xml': Buffer.from('<extra/>') });
    if (change === 'truncated') { pkg.zip = pkg.zip.subarray(0, pkg.zip.length - 8); pkg = rehash(pkg); }
    if (change === 'crc') { pkg.zip.writeUInt32LE(0, 14); pkg = rehash(pkg); }
    if (change === 'central-local') { pkg.zip[30] = 88; pkg = rehash(pkg); }
    if (change === 'zip-bomb') {
      pkg.zip = Buffer.from(zipSync({ [pkg.fileName.replace('.zip', '.xml')]: Buffer.alloc(2 * 1024 * 1024 + 1, 65) })); pkg = rehash(pkg);
    }
    if (change === 'DTD') pkg = packageOf('<!DOCTYPE x>' + unsigned['01'], pkg.fileName);
    if (change === 'UTF8') pkg = packageOf(Buffer.concat([Buffer.from(unsigned['01']), Buffer.from([0xff])]), pkg.fileName);
    if (change === 'boleta') pkg.fileName = `${ruc}-03-BQ01-1.zip`;
    const f = fixture(); await expect(f.adapter.submit(pkg)).rejects.toThrow(); expect(f.assertCurrent).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('verifies XML signature mathematics after valid ZIP and CRC', async () => {
    const { productionTransportXml } = await import('../services/sunat-service/src/infrastructure/sunat/production-transport-zip');
    const xml = productionTransportXml(packages['01'].zip).xml.toString().replace('<cbc:IssueDate>2026-10-02', '<cbc:IssueDate>2026-10-03');
    const f = fixture(); await expect(f.adapter.submit(packageOf(xml, packages['01'].fileName))).rejects.toThrow('Paquete de producción inválido'); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['sendBill', 'sendSummary'] as const)('rejects wrong route for %s', async operation => {
    const f = fixture(); await expect(operation === 'sendBill' ? f.adapter.submit(packages.RC) : f.adapter.submitSummary(packages['01'])).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['redirect', 'timeout', 'TLS', 'malformed', 'DTD', 'too-large-header', 'too-large-stream', 'bad-cdr', 'wrong-cdr-ruc', 'wrong-cdr-reference'] as const)('transport %s stays UNKNOWN, bounded and without retry/secret leak', async failure => {
    const f = fixture();
    if (['redirect', 'timeout', 'TLS'].includes(failure)) f.fetchMock.mockRejectedValueOnce(new Error(config().solPassword));
    else if (failure === 'too-large-header') f.fetchMock.mockResolvedValueOnce(new Response('x', { headers: { 'content-length': String(8 * 1024 * 1024) } }));
    else if (failure === 'too-large-stream') f.fetchMock.mockResolvedValueOnce(new Response('x'.repeat(7 * 1024 * 1024 + 1)));
    else if (failure === 'malformed') f.fetchMock.mockResolvedValueOnce(new Response('<broken>'));
    else if (failure === 'DTD') f.fetchMock.mockResolvedValueOnce(new Response('<!DOCTYPE x>' + soap('sendBill', '')));
    else {
      const cdr = failure === 'wrong-cdr-ruc' ? receipt('FQ01-1', '01-FQ01-1', otherRuc) : failure === 'wrong-cdr-reference' ? receipt('FQ01-2') : Buffer.from('PK\x03\x04fake');
      f.fetchMock.mockResolvedValueOnce(new Response(soap('sendBill', `<applicationResponse>${cdr.toString('base64')}</applicationResponse>`)));
    }
    const error = await f.adapter.submit(packages['01']).catch(value => value);
    expect(error).toMatchObject({ kind: 'UNKNOWN' }); expect(String(error)).not.toContain(config().solPassword); expect(f.fetchMock).toHaveBeenCalledOnce();
  });
  it('retains business faults and redacts the SOAP diagnostic', async () => {
    const f = fixture(); f.fetchMock.mockResolvedValueOnce(new Response(`<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><s:Fault><faultcode>soap:Client.2335</faultcode><faultstring>PRIVATE DIAGNOSTIC</faultstring></s:Fault></s:Body></s:Envelope>`, { status: 500 }));
    const error = await f.adapter.submit(packages['01']).catch(value => value); expect(error).toMatchObject({ kind: 'BUSINESS', code: '2335' }); expect(String(error)).not.toContain('PRIVATE DIAGNOSTIC'); expect(f.fetchMock).toHaveBeenCalledOnce();
  });
});
