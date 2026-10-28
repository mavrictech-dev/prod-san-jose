import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { BoundedSoapAdapter, SoapSubmissionError, base64Zip } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
import { parseCdrZip, RESPONSE_NS } from '../services/sunat-service/src/infrastructure/sunat/cdr-parser';
import { SOAP_NS, SERVICE_NS, CBC_NS, CAC_NS, safeXml } from '../services/sunat-service/src/infrastructure/sunat/safe-xml';
import { buildLocalSummary } from '../services/sunat-service/src/infrastructure/crypto/local-summary';
import { FiscalCircuitQaService } from '../services/sunat-service/src/application/fiscal-circuit-qa.service';
import { calculateDocumentTotals } from '../packages/sunat-core/src/tax';
import { renderLocalDocumentPdf } from '../packages/pdf-renderer/src';
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url)); const { zipSync } = require('fflate');
const ruc = '00000000000'; const reference = 'FA01-1'; const fileName = `R-${ruc}-01-${reference}.xml`;
function receipt(code = '0', notes = '', issuer = ruc, ref = reference) {
  return `<ApplicationResponse xmlns="${RESPONSE_NS}" xmlns:cbc="${CBC_NS}" xmlns:cac="${CAC_NS}">${notes}<cac:ReceiverParty><cac:PartyIdentification><cbc:ID>${issuer}</cbc:ID></cac:PartyIdentification></cac:ReceiverParty><cac:DocumentResponse><cac:Response><cbc:ResponseCode>${code}</cbc:ResponseCode><cbc:Description>SIMULADO</cbc:Description></cac:Response><cac:DocumentReference><cbc:ID>${ref}</cbc:ID></cac:DocumentReference></cac:DocumentResponse></ApplicationResponse>`;
}
const zipped = (xml = receipt(), name = fileName) => Buffer.from(zipSync({ [name]: Buffer.from(xml) }));
const expected = { fileName, issuerRuc: ruc, reference };
const soap = (method: string, xml: string) => `<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><ser:${method}Response xmlns:ser="${SERVICE_NS}">${xml}</ser:${method}Response></s:Body></s:Envelope>`;
const pkg = () => { const zip = zipped(); return { documentId: '50000000-0000-4000-8000-000000000021', fileName: `${ruc}-01-${reference}.zip`, zip, sha256: createHash('sha256').update(zip).digest('hex') }; };
const adapter = () => { vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED','true'); return new BoundedSoapAdapter({ environment: 'LOCAL_QA', ruc, solUser: 'LOCALONLY', solPassword: 'NO-REAL-SECRET' }); };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe('CDR seguro y vinculado, sin afirmar confianza fiscal', () => {
  it('admite sólo dummy/ vacío adicional, sin extraer directorios ni perder vinculación', () => {
    const betaZip = Buffer.from(zipSync({ 'dummy/': Buffer.alloc(0), [fileName]: Buffer.from(receipt()) }));
    expect(parseCdrZip(betaZip, expected).status).toBe('ACCEPTED');
    for (const [name, value] of [['otro/', Buffer.alloc(0)], ['dummy/', Buffer.from('x')], ['../dummy/', Buffer.alloc(0)]] as const) {
      expect(() => parseCdrZip(Buffer.from(zipSync({ [name]: value, [fileName]: Buffer.from(receipt()) })), expected)).toThrow();
    }
    expect(() => parseCdrZip(Buffer.from(zipSync({ 'dummy/': Buffer.alloc(0) })), expected)).toThrow();
  });
  it.each([['0','','ACCEPTED'],['0','<cbc:Note>Observación</cbc:Note>','ACCEPTED_WITH_OBSERVATIONS'],['2335','','REJECTED']])('interpreta %s', (code,notes,status) => expect(parseCdrZip(zipped(receipt(code,notes)), expected).status).toBe(status));
  it.each(['../R.xml','R-otro.xml','R-otro.pdf'])('rechaza ZIP con nombre %s', name => expect(() => parseCdrZip(zipped(receipt(),name), expected)).toThrow());
  it('rechaza RUC o referencia ajenos, código inválido, nodos repetidos y DTD', () => {
    for (const xml of [receipt('0','','20450819230'),receipt('0','',ruc,'FA01-2'),receipt('hola'),receipt().replace('<cbc:ResponseCode>0</cbc:ResponseCode>', '<cbc:ResponseCode>0</cbc:ResponseCode><cbc:ResponseCode>0</cbc:ResponseCode>'), '<!DOCTYPE x>'+receipt()]) expect(() => parseCdrZip(zipped(xml),expected)).toThrow();
  });
  it('rechaza entradas extra y XML profundo', () => {
    expect(() => parseCdrZip(Buffer.from(zipSync({ [fileName]: Buffer.from(receipt()), 'extra.xml': Buffer.from('x') })),expected)).toThrow();
    expect(() => safeXml('<a>'.repeat(42)+'</a>'.repeat(42))).toThrow();
  });
  it('rechaza ZIP vacío, base64 no canónico y respuesta HTML', () => {
    for (const text of ['%%%','eA==','AAAAA']) expect(() => base64Zip(text)).toThrow();
    expect(() => parseCdrZip(Buffer.from(zipSync({})),expected)).toThrow();
  });
});
describe('SOAP acotado, sin producción ni reenvíos implícitos', () => {
  it('bloquea Beta sin flag, producción, RUC real QA y escenario en Beta', () => {
    for (const environment of ['BETA','PRODUCTION']) expect(() => new BoundedSoapAdapter({ environment: environment as never,ruc,solUser:'USER',solPassword:'P' })).toThrow();
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED','true'); expect(() => new BoundedSoapAdapter({ environment:'LOCAL_QA',ruc:'20450819230',solUser:'USER',solPassword:'P' })).toThrow();
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED','true'); expect(() => new BoundedSoapAdapter({ environment:'BETA',ruc,solUser:'USER',solPassword:'P',qaScenario:'ACCEPTED' })).toThrow();
  });
  it('serializa base64 y WSSE, destino fijo y no redirecciones', async () => {
    const fetchMock = vi.fn(async () => new Response(soap('sendBill',`<applicationResponse>${zipped().toString('base64')}</applicationResponse>`))); vi.stubGlobal('fetch',fetchMock);
    const result = await adapter().submit(pkg()); expect(result.kind).toBe('CDR'); expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string,RequestInit]; expect(url).toBe('http://sunat-emulator:3006/billService'); expect(init.redirect).toBe('error'); expect(init.body).toContain('<contentFile>UEs'); expect(init.body).toContain('00000000000LOCALONLY');
  });
  it('no admite boleta sendBill, checksum alterado ni otro RUC', async () => {
    const api = adapter(); vi.stubGlobal('fetch',vi.fn());
    for (const p of [{...pkg(),fileName:`${ruc}-03-BA01-1.zip`},{...pkg(),sha256:'wrong'},{...pkg(),fileName:'20450819230-01-FA01-1.zip'}]) await expect(api.submit(p)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('getStatus 98 espera; 99 con CDR devuelve rechazo, nunca retryable', async () => {
    const api = adapter(); vi.stubGlobal('fetch',vi.fn(async () => new Response(soap('getStatus','<status><statusCode>98</statusCode></status>')))); expect(await api.getStatus('LOCAL-1')).toEqual({kind:'PROCESSING'});
    vi.stubGlobal('fetch',vi.fn(async () => new Response(soap('getStatus',`<status><statusCode>99</statusCode><content>${zipped(receipt('2335')).toString('base64')}</content></status>`)))); expect((await api.getStatus('LOCAL-1')).kind).toBe('CDR');
    vi.stubGlobal('fetch',vi.fn(async () => new Response(soap('getStatus','<status><statusCode>42</statusCode></status>')))); expect(await api.getStatus('LOCAL-1')).toMatchObject({kind:'ERROR',retryable:false});
  });
  it('timeout/red/malformed = UNKNOWN; no filtra error externo ni repite POST', async () => {
    const mock = vi.fn(async () => { throw new Error('NO-REAL-SECRET'); }); vi.stubGlobal('fetch',mock);
    await expect(adapter().submit(pkg())).rejects.toMatchObject({kind:'UNKNOWN'}); expect(mock).toHaveBeenCalledOnce();
    try { await adapter().submit(pkg()); } catch (e) { expect(String(e)).not.toContain('NO-REAL-SECRET'); }
  });
  it('fault de negocio conocido no se clasifica transitorio ni guarda faultstring', async () => {
    vi.stubGlobal('fetch',vi.fn(async () => new Response(`<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><s:Fault><faultcode>soap:Client.2335</faultcode><faultstring>NO-REAL-SECRET</faultstring></s:Fault></s:Body></s:Envelope>`,{status:500})));
    await expect(adapter().submit(pkg())).rejects.toMatchObject({kind:'BUSINESS',code:'2335'});
  });
  it('rechaza respuesta sobredimensionada, namespace falso y DTD', async () => {
    const api=adapter();
    for (const response of [new Response('x',{headers:{'content-length':String(8*1024*1024)}}),new Response(soap('sendBill','<applicationResponse>x</applicationResponse>').replace(SOAP_NS,'http://evil.test')),new Response('<!DOCTYPE x>'+soap('sendBill',''))]) {
      vi.stubGlobal('fetch',vi.fn(async()=>response)); await expect(api.submit(pkg())).rejects.toBeInstanceOf(SoapSubmissionError);
    }
  });
});
describe('Persistencia QA y aislamiento', () => {
  it.each(['SENDING','POLLING','ACCEPTED','UNKNOWN','REJECTED','BLOCKED'])('no reenvía en estado %s', async state => {
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED','true'); const updateMany=vi.fn();
    const service=new FiscalCircuitQaService({fiscalCircuitQa:{findUnique:async()=>({id:'qa',state}),updateMany}} as never,{} as never,{} as never,{} as never,{} as never,{} as never);
    await service.process('qa'); expect(updateMany).not.toHaveBeenCalled();
  });
  it('un worker que pierde el claim no toca transporte ni artefactos', async()=>{
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED','true'); const store={read:vi.fn()};
    const service=new FiscalCircuitQaService({fiscalCircuitQa:{findUnique:async()=>({id:'qa',state:'QUEUED',pollAttempts:0}),updateMany:async()=>({count:0})}} as never,{} as never,store as never,{} as never,{} as never,{} as never);
    await service.process('qa'); expect(store.read).not.toHaveBeenCalled();
  });
  it.each(['XSD','ZIP','EXTRA_ZIP','INVOICE_XML'])('bloquea preflight %s antes de todo POST', async failure => {
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED','true'); const fetchMock = vi.fn(); vi.stubGlobal('fetch',fetchMock);
    const xml = Buffer.from('SIGNED-FICTITIOUS-XML'); const name = `${ruc}-01-FA01-1.xml`;
    const row = { id:'qa',documentId:snapshot.documentId,state:'QUEUED',pollAttempts:0,credentialRevision:1,scenario:'ACCEPTED',requestFileName:name.replace('.xml','.zip'),
      requestArtifact:{storageKey:'zip'},signedXmlArtifact:{storageKey:'xml'},documentXmlArtifact:{storageKey:'document'} };
    const updateMany = vi.fn(async()=>({count:1}));
    const prisma = { fiscalCircuitQa:{findUnique:async()=>row,updateMany},
      fiscalDocument:{findUniqueOrThrow:async()=>({environment:'BETA',issuerRuc:ruc,status:'BUILDING',immutablePayload:{...snapshot,documentTypeCode:'01'}})},
      sunatCredentials:{findUnique:async()=>({revision:1,certificateSelfSigned:true,certificateExpiresAt:new Date(Date.now()+86400000)})} };
    const store = { read: async (_id:string,artifact:{storageKey:string}) => artifact.storageKey==='zip'
      ? Buffer.from(zipSync({[failure==='ZIP'?'wrong.xml':name]:xml,...(failure==='EXTRA_ZIP'?{'extra.xml':xml}:{})}))
      : failure==='INVOICE_XML'&&artifact.storageKey==='document' ? Buffer.from('OTHER XML') : xml };
    const xsd = { validate:vi.fn(async()=>{throw new Error('FAKE PRIVATE ERROR - NOT PUBLIC');}) };
    const service = new FiscalCircuitQaService(prisma as never,{} as never,store as never,{} as never,{} as never,xsd as never);
    await service.process('qa'); expect(fetchMock).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenLastCalledWith(expect.objectContaining({data:expect.objectContaining({state:'BLOCKED',responseCode:'QA_PREFLIGHT_FAILED'})}));
    expect(JSON.stringify(updateMany.mock.calls)).not.toContain('FAKE PRIVATE ERROR');
  });
});
const snapshot = { documentId:'50000000-0000-4000-8000-000000000021',environment:'BETA' as const,documentTypeCode:'03' as const,series:'BA01',number:'1',fullNumber:'BA01-1',issueDate:'2026-10-01T10:00:00-05:00',currencyCode:'PEN' as const,operationTypeCode:'0101',issuer:{identityType:'6',identityNumber:ruc,legalName:'FICTICIO QA',ubigeo:'200101',establishmentCode:'QA'},customer:{identityType:'0',identityNumber:'0',legalName:'CLIENTE QA'},...calculateDocumentTotals([{description:'Diésel QA',unitCode:'GLL',quantity:'2.5',unitPriceWithTax:'18.50',taxAffectationCode:'10',igvRate:'18'}]) };
describe('Resumen 2.0 y representación con digest real, exclusivamente QA',()=>{
  it('RC de alta incluye identidad, fecha, importes y referencia XMLDSig',()=>{
    const xml=buildLocalSummary(snapshot,'RC-20261001-1'); expect(xml).toContain('<cbc:UBLVersionID>2.0');expect(xml).toContain('<cbc:ReferenceDate>2026-10-01');expect(xml).toContain('<cbc:ConditionCode>1');expect(xml).toContain('46.25');expect(xml).toContain('#signatureFactuEz');
  });
  it('no mezcla RUC real, facturas o USD en RC QA',()=>{
    for(const doc of [{...snapshot,issuer:{...snapshot.issuer,identityNumber:'20450819230'}},{...snapshot,documentTypeCode:'01' as const},{...snapshot,currencyCode:'USD' as const}]) expect(()=>buildLocalSummary(doc,'RC-20261001-1')).toThrow();
  });
  it.each(['ticket','a4'] as const)('PDF %s con QR requiere digest verificado y sigue siendo prueba',async format=>{
    const digestValue=createHash('sha256').update('real signed xml fixture').digest('base64');const bytes=await renderLocalDocumentPdf(snapshot,format,{digestValue,status:'ACCEPTED'});expect(bytes.subarray(0,5).toString()).toBe('%PDF-');
    await expect(renderLocalDocumentPdf(snapshot,format,{digestValue:'fake',status:'ACCEPTED'})).rejects.toThrow();
    await expect(renderLocalDocumentPdf({...snapshot,environment:'PRODUCTION'},format,{digestValue,status:'ACCEPTED'})).rejects.toThrow();
  });
});
