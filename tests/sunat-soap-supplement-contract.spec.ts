import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignedPackage } from '../services/sunat-service/src/domain/ports/sunat-adapter.port';
import { BoundedSoapAdapter, LOCAL_QA_ENDPOINT, SoapSubmissionError } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
import { CAC_NS, CBC_NS, SERVICE_NS, SOAP_NS } from '../services/sunat-service/src/infrastructure/sunat/safe-xml';

const localRequire = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { zipSync } = localRequire('fflate');
const ruc = '00000000001';
const ticket = 'LOCAL-PREPARED-TICKET_1';
const responseZip = Buffer.from(zipSync({ 'LOCAL-RESPONSE.xml': Buffer.from('<SyntheticResponse/>') }));
const soap = (method: string, body: string) => `<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><ser:${method}Response xmlns:ser="${SERVICE_NS}">${body}</ser:${method}Response></s:Body></s:Envelope>`;
const status = (body: string) => soap('getStatus', `<status>${body}</status>`);
const fault = '<s:Envelope xmlns:s="' + SOAP_NS + '"><s:Body><s:Fault><faultcode>soap:Client.2335</faultcode><faultstring>EXTERNAL_DIAGNOSTIC</faultstring></s:Fault></s:Body></s:Envelope>';

function packageOf(type: '07' | '08' | 'RC' | 'RA'): SignedPackage {
  const reference = type === 'RC' || type === 'RA' ? `${type}-20261002-1` : 'FQ01-1';
  const fileName = `${ruc}-${type === '07' || type === '08' ? `${type}-` : ''}${reference}.zip`;
  const root = type === '07' ? 'CreditNote' : 'DebitNote';
  // QA route fixtures only: no signature, private key, XSD or fiscal acceptance claim.
  const xml = type === 'RC' || type === 'RA' ? '<SyntheticBatch/>' :
    `<${root} xmlns="urn:oasis:names:specification:ubl:schema:xsd:${root}-2" xmlns:cbc="${CBC_NS}" xmlns:cac="${CAC_NS}"><cbc:ID>${reference}</cbc:ID><cac:AccountingSupplierParty><cac:Party><cac:PartyIdentification><cbc:ID>${ruc}</cbc:ID></cac:PartyIdentification></cac:Party></cac:AccountingSupplierParty><cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>FQ01-9</cbc:ID><cbc:DocumentTypeCode>01</cbc:DocumentTypeCode></cac:InvoiceDocumentReference></cac:BillingReference><cac:DiscrepancyResponse><cbc:ReferenceID>FQ01-9</cbc:ReferenceID><cbc:ResponseCode>${type === '07' ? '01' : '02'}</cbc:ResponseCode></cac:DiscrepancyResponse></${root}>`;
  const zip = Buffer.from(zipSync({ [fileName.replace(/\.zip$/, '.xml')]: Buffer.from(xml) }));
  return { documentId: '50000000-0000-4000-8000-000000000951', fileName, zip, sha256: createHash('sha256').update(zip).digest('hex') };
}

function fixture() {
  const fetchDouble = vi.fn<typeof fetch>(async () => { throw new Error('UNCONFIGURED_MEMORY_RESPONSE'); });
  vi.stubGlobal('fetch', fetchDouble);
  const adapter = new BoundedSoapAdapter({ environment: 'LOCAL_QA', ruc, solUser: 'LOCALONLY', solPassword: 'SYNTHETIC_ONLY' });
  const reply = (xml: string, httpStatus = 200) => fetchDouble.mockResolvedValueOnce(new Response(xml, { status: httpStatus }));
  return { adapter, fetchDouble, reply };
}

beforeEach(() => {
  // Never enable BETA, even when the invoking shell has it configured.
  vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false');
  vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true');
  vi.stubEnv('NOTES_QA_ENABLED', 'true');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('NETWORK_FORBIDDEN'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Existing SOAP adapter contract for supplements, HTTP replaced in memory', () => {
  it.each(['07', '08'] as const)('sendBill %s returns CDR bytes without interpreting acceptance', async type => {
    const f = fixture(), pkg = packageOf(type);
    f.reply(soap('sendBill', `<applicationResponse>${responseZip.toString('base64')}</applicationResponse>`));
    expect(await f.adapter.submit(pkg)).toEqual({ kind: 'CDR', cdrZip: responseZip });
    expect(f.fetchDouble).toHaveBeenCalledExactlyOnceWith(LOCAL_QA_ENDPOINT, expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({ SOAPAction: 'sendBill' }),
      body: expect.stringContaining(`<fileName>${pkg.fileName}</fileName><contentFile>${pkg.zip.toString('base64')}</contentFile>`),
    }));
  });

  it.each(['RC', 'RA'] as const)('sendSummary %s and getStatus preserve the same ticket and package', async type => {
    const f = fixture(), pkg = packageOf(type), original = Buffer.from(pkg.zip);
    f.reply(soap('sendSummary', `<ticket>${ticket}</ticket>`));
    expect(await f.adapter.submitSummary(pkg)).toBe(ticket);
    f.reply(status('<statusCode>98</statusCode>'));
    expect(await f.adapter.getStatus(ticket)).toEqual({ kind: 'PROCESSING' });
    f.reply(status(`<statusCode>0</statusCode><content>${responseZip.toString('base64')}</content>`));
    expect(await f.adapter.getStatus(ticket)).toEqual({ kind: 'CDR', cdrZip: responseZip });
    expect(pkg.zip.equals(original)).toBe(true);
    expect(f.fetchDouble.mock.calls.map(([url, init]) => [url, (init?.headers as Record<string, string>).SOAPAction])).toEqual([
      [LOCAL_QA_ENDPOINT, 'sendSummary'], [LOCAL_QA_ENDPOINT, 'getStatus'], [LOCAL_QA_ENDPOINT, 'getStatus'],
    ]);
    for (const [, init] of f.fetchDouble.mock.calls.slice(1)) expect(init?.body).toContain(`<ticket>${ticket}</ticket>`);
  });

  it.each(['', '<ticket/>', '<ticket>first</ticket><ticket>second</ticket>', '<ticket><nested>value</nested></ticket>', '<ticket>bad/ticket</ticket>', `<ticket>${'a'.repeat(121)}</ticket>`])('lost or ambiguous ticket %# is UNKNOWN with one call', async body => {
    const f = fixture(); f.reply(soap('sendSummary', body));
    await expect(f.adapter.submitSummary(packageOf('RC'))).rejects.toMatchObject({ kind: 'UNKNOWN', code: 'INVALID_TICKET' });
    expect(f.fetchDouble).toHaveBeenCalledOnce();
  });

  it.each([
    '<statusCode>99</statusCode>', '<statusCode>0</statusCode>',
    '<statusCode>0</statusCode><statusCode>99</statusCode>',
    '<statusCode><nested>98</nested></statusCode>',
    '<statusCode>0</statusCode><content>%%%INVALID%%%</content>',
    '<statusCode>unrecognized</statusCode>',
  ])('incomplete/ambiguous status %# cannot become acceptance', async body => {
    const f = fixture(); f.reply(status(body));
    await expect(f.adapter.getStatus(ticket)).rejects.toMatchObject({ kind: 'UNKNOWN', code: 'INVALID_STATUS' });
    expect(f.fetchDouble).toHaveBeenCalledOnce();
  });

  it('99 with content returns raw CDR, leaving business status and trust to the existing verifier', async () => {
    const f = fixture(); f.reply(status(`<statusCode>99</statusCode><content>${responseZip.toString('base64')}</content>`));
    expect(await f.adapter.getStatus(ticket)).toEqual({ kind: 'CDR', cdrZip: responseZip });
  });

  it('98 with unexpected content is a non-retryable reconciliation result', async () => {
    const f = fixture(); f.reply(status('<statusCode>98</statusCode><content>eA==</content>'));
    expect(await f.adapter.getStatus(ticket)).toMatchObject({ kind: 'ERROR', retryable: false, code: '98' });
    expect(f.fetchDouble).toHaveBeenCalledOnce();
  });

  it.each(['42', 'unknown'])('unrecognized status %s is a non-retryable reconciliation result', async code => {
    const f = fixture(); f.reply(status(`<statusCode>${code}</statusCode>`));
    expect(await f.adapter.getStatus(ticket)).toMatchObject({ kind: 'ERROR', retryable: false, code: code === '42' ? code : 'INVALID_STATUS' });
    expect(f.fetchDouble).toHaveBeenCalledOnce();
  });

  it.each(['RC', 'RA'] as const)('%s distinguishes a business fault from an HTTP/transport ambiguity', async type => {
    const f = fixture(); f.reply(fault, 500);
    await expect(f.adapter.submitSummary(packageOf(type))).rejects.toMatchObject({ kind: 'BUSINESS', code: '2335' });
    f.reply(fault, 200);
    await expect(f.adapter.submitSummary(packageOf(type))).rejects.toMatchObject({ kind: 'UNKNOWN', code: 'TRANSPORT_OR_RESPONSE' });
    expect(f.fetchDouble).toHaveBeenCalledTimes(2);
  });

  it.each(['RC', 'RA'] as const)('%s response loss makes no automatic second request and leaks no diagnostic', async type => {
    const f = fixture(); f.fetchDouble.mockRejectedValueOnce(new Error('EXTERNAL_DIAGNOSTIC'));
    const error = await f.adapter.submitSummary(packageOf(type)).catch(value => value);
    expect(error).toBeInstanceOf(SoapSubmissionError); expect(error).toMatchObject({ kind: 'UNKNOWN' });
    expect(String(error)).not.toContain('EXTERNAL_DIAGNOSTIC'); expect(f.fetchDouble).toHaveBeenCalledOnce();
  });

  it.each(['', '../ticket', 'a'.repeat(121), '<ticket/>'])('invalid ticket %# fails before the HTTP double', async value => {
    const f = fixture(); await expect(f.adapter.getStatus(value)).rejects.toThrow('Ticket inválido');
    expect(f.fetchDouble).not.toHaveBeenCalled();
  });

  it.each(['07', '08', 'RC', 'RA'] as const)('%s rejects changed checksum before the HTTP double', async type => {
    const f = fixture(), pkg = { ...packageOf(type), sha256: '0'.repeat(64) };
    await expect(type === 'RC' || type === 'RA' ? f.adapter.submitSummary(pkg) : f.adapter.submit(pkg)).rejects.toThrow('Paquete inconsistente');
    expect(f.fetchDouble).not.toHaveBeenCalled();
  });

  it('BETA constructor remains disabled before package, credential or HTTP work', () => {
    expect(() => new BoundedSoapAdapter({ environment: 'BETA', ruc: '20615878481', solUser: 'MODDATOS', solPassword: 'MODDATOS' })).toThrow('deshabilitada');
    expect(fetch).not.toHaveBeenCalled();
  });
});
