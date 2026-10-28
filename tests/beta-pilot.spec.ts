import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  BoundedSoapAdapter, LOCAL_QA_ENDPOINT, SUNAT_BETA_ENDPOINT,
  SUNAT_BETA_PUBLIC_CREDENTIAL, type SoapSunatConfig,
} from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
import { SOAP_NS, SERVICE_NS } from '../services/sunat-service/src/infrastructure/sunat/safe-xml';

// Esta suite aísla HTTP/WSSE; firma/ZIP/RUC reales se prueban en beta-package-validator.spec.ts.
vi.mock('../services/sunat-service/src/infrastructure/sunat/beta-package-validator', () => ({ validateBetaPackage: vi.fn() }));

// Sólo buffers ficticios y fetch simulado: no certificados, base de datos o red externa.
const require = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { zipSync } = require('fflate');
const ruc = '20615878481';
const config = (): SoapSunatConfig => ({ environment: 'BETA', ruc,
  solUser: SUNAT_BETA_PUBLIC_CREDENTIAL, solPassword: SUNAT_BETA_PUBLIC_CREDENTIAL });
const soap = (method: string, body: string) => `<s:Envelope xmlns:s="${SOAP_NS}"><s:Body><ser:${method}Response xmlns:ser="${SERVICE_NS}">${body}</ser:${method}Response></s:Body></s:Envelope>`;
const fakeZip = Buffer.from(zipSync({ 'LOCAL-TEST.xml': Buffer.from('<FictitiousFixture/>') }));
const pkg = (fileName = `${ruc}-01-FQ01-1.zip`) => ({
  documentId: '50000000-0000-4000-8000-000000000901', fileName, zip: fakeZip,
  sha256: createHash('sha256').update(fakeZip).digest('hex'),
});
const beta = () => { vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true'); return new BoundedSoapAdapter(config()); };

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('Preparación SOAP Beta: sin producción ni secretos privados', () => {
  it.each(['PRODUCTION', 'production', '', 'https://example.invalid'])('rechaza ambiente %s incluso con flags activos', environment => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn());
    expect(() => new BoundedSoapAdapter({ ...config(), environment: environment as never })).toThrow('deshabilitada');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requiere habilitación explícita y no la configura por sí mismo', () => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false');
    expect(() => new BoundedSoapAdapter(config())).toThrow('deshabilitada');
    expect(process.env.SUNAT_BETA_TRANSMISSION_ENABLED).toBe('false');
  });

  it.each([
    { solUser: 'QA_PRIVATE_USER' }, { solPassword: 'QA_PRIVATE_PASSWORD' },
    { solUser: `${ruc}MODDATOS` }, { solUser: 'moddatos' }, { solPassword: 'MODDATOS ' },
  ])('rechaza credenciales no públicas sin exponerlas (%j)', override => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    try { new BoundedSoapAdapter({ ...config(), ...override }); throw new Error('unexpected success'); }
    catch (error) {
      expect(String(error)).toContain('credenciales públicas');
      for (const value of Object.values(override)) expect(String(error)).not.toContain(value);
    }
  });

  it.each(['00000000000', '20615878480', '2061587848'])('rechaza RUC inválido %s', invalidRuc => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    expect(() => new BoundedSoapAdapter({ ...config(), ruc: invalidRuc })).toThrow();
  });

  it('no admite escenarios del emulador ni RUC real en LOCAL_QA', () => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true');
    expect(() => new BoundedSoapAdapter({ ...config(), qaScenario: 'ACCEPTED' })).toThrow('deshabilitada');
    expect(() => new BoundedSoapAdapter({ ...config(), environment: 'LOCAL_QA' })).toThrow('QA deshabilitado');
  });

  it.each(['MODDATOS', 'moddatos'])('admite la variante pública documentada %s sin reintentar', async solPassword => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    const api = new BoundedSoapAdapter({ ...config(), solPassword });
    const fetchMock = vi.fn(async () => new Response(soap('getStatus', '<status><statusCode>98</statusCode></status>')));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.getStatus('BETA-TEST-TICKET')).toEqual({ kind: 'PROCESSING' });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toContain(`>${solPassword}</wsse:Password>`);
  });

  it('construye sólo el endpoint Beta fijo y WSSE público, sin seguir redirecciones', async () => {
    const fetchMock = vi.fn(async () => new Response(soap('sendBill', `<applicationResponse>${fakeZip.toString('base64')}</applicationResponse>`)));
    vi.stubGlobal('fetch', fetchMock);
    expect((await beta().submit(pkg())).kind).toBe('CDR');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SUNAT_BETA_ENDPOINT);
    expect(init.redirect).toBe('error');
    expect(init.body).toContain(`<wsse:Username>${ruc}MODDATOS</wsse:Username>`);
    expect(init.body).toContain('>MODDATOS</wsse:Password>');
    expect(init.headers).not.toHaveProperty('X-Factuez-QA-Scenario');
  });

  it('congela una copia: mutar el objeto original no cambia RUC, secretos ni destino', async () => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    const original = config();
    const api = new BoundedSoapAdapter(original);
    Object.assign(original, { environment: 'PRODUCTION', ruc: '00000000000', solUser: 'QA_PRIVATE_USER', solPassword: 'QA_PRIVATE_PASSWORD', qaScenario: 'REJECTED' });
    const fetchMock = vi.fn(async () => new Response(soap('getStatus', '<status><statusCode>98</statusCode></status>')));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.getStatus('BETA-TEST-TICKET')).toEqual({ kind: 'PROCESSING' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(SUNAT_BETA_ENDPOINT);
    expect(init.body).toContain(`${ruc}MODDATOS`);
    expect(init.body).not.toContain('QA_PRIVATE');
  });

  it.each(['sendBill', 'sendSummary', 'getStatus'])('revocar Beta bloquea %s en instancias existentes', async method => {
    const api = beta();
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'false');
    vi.stubGlobal('fetch', vi.fn());
    const operation = method === 'sendBill' ? api.submit(pkg())
      : method === 'sendSummary' ? api.submitSummary(pkg(`${ruc}-RC-20261002-1.zip`))
      : api.getStatus('BETA-TEST-TICKET');
    await expect(operation).rejects.toThrow('deshabilitada');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('revocar QA detiene el emulador sin derivar la petición hacia Beta', async () => {
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'true');
    const api = new BoundedSoapAdapter({ environment: 'LOCAL_QA', ruc: '00000000000', solUser: 'LOCALONLY', solPassword: 'FIXTURE' });
    vi.stubEnv('FISCAL_CIRCUIT_QA_ENABLED', 'false');
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true');
    vi.stubGlobal('fetch', vi.fn());
    await expect(api.getStatus('LOCAL-TEST-TICKET')).rejects.toThrow('QA deshabilitado');
    expect(fetch).not.toHaveBeenCalled();
    expect(LOCAL_QA_ENDPOINT).not.toBe(SUNAT_BETA_ENDPOINT);
  });
});
