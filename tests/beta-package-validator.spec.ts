import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { calculateDocumentTotals, buildInvoiceUbl, buildReceiptSummary } from '../packages/sunat-core/src';
import { XmlSignerService } from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import { validateBetaPackage } from '../services/sunat-service/src/infrastructure/sunat/beta-package-validator';
import { BoundedSoapAdapter } from '../services/sunat-service/src/infrastructure/sunat/bounded-soap.adapter';
import { betaSigningFixture } from './helpers/beta-signing.fixture';
import type { FiscalDocumentSnapshot } from '../packages/contracts/src';
const localRequire = createRequire(new URL('../services/sunat-service/package.json', import.meta.url));
const { zipSync } = localRequire('fflate');
const keys = betaSigningFixture(), ruc = '20615878481';
const snapshot = (type: '01' | '03' = '01'): FiscalDocumentSnapshot => ({ documentId: randomUUID(), environment: 'BETA',
  documentTypeCode: type, series: type === '01' ? 'FP01' : 'BP01', number: '1', fullNumber: `${type === '01' ? 'FP01' : 'BP01'}-1`,
  issueDate: '2026-10-02T12:00:00-05:00', currencyCode: 'PEN', operationTypeCode: '0101', paymentTerms: { type: 'CONTADO' },
  issuer: { identityType: '6', identityNumber: ruc, legalName: 'FICTICIO', address: 'DIRECCION FICTICIA QA', ubigeo: '150101', establishmentCode: '0000' },
  customer: { identityType: '6', identityNumber: ruc, legalName: 'FICTICIO' },
  ...calculateDocumentTotals([{ description: 'TEST', quantity: '1', unitCode: 'NIU', unitPriceWithTax: '1.18', igvRate: '18', taxAffectationCode: '10' }]) });
const packageOf = (xml: string, fileName: string) => { const zip = Buffer.from(zipSync({ [fileName.replace(/\.zip$/, '.xml')]: Buffer.from(xml) }));
  return { documentId: randomUUID(), zip, fileName, sha256: createHash('sha256').update(zip).digest('hex') }; };
const signedInvoice = new XmlSignerService().sign(buildInvoiceUbl(snapshot(), { mode: 'REAL_PREPARATION' }), keys.p12, keys.password).xml;
const signedRc = new XmlSignerService().sign(buildReceiptSummary(snapshot('03'), 'RC-20261002-1', 'REAL_PREPARATION'), keys.p12, keys.password, 'SummaryDocuments').xml;
afterAll(() => keys.p12.fill(0)); afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('Paquetes Beta reales con firma ficticia, sin red ni datos del usuario', () => {
  it('vincula XML firmado, ZIP, nombre, RUC y referencia de factura', () => {
    expect(validateBetaPackage(packageOf(signedInvoice, `${ruc}-01-FP01-1.zip`), ruc, 'sendBill')).toMatchObject({ rootName: 'Invoice', reference: 'FP01-1' });
  });
  it('RC usa ID de proveedor UBL 2.0 y valida cada boleta', () => {
    expect(validateBetaPackage(packageOf(signedRc, `${ruc}-RC-20261002-1.zip`), ruc, 'sendSummary')).toMatchObject({ rootName: 'SummaryDocuments', reference: 'RC-20261002-1' });
  });
  it.each([
    [signedInvoice.replace('FP01-1', 'FP01-2'), `${ruc}-01-FP01-1.zip`, 'sendBill'],
    [signedInvoice.replace('>TEST<', '>MANIPULADO<'), `${ruc}-01-FP01-1.zip`, 'sendBill'],
    [signedInvoice, `${ruc}-07-FP01-1.zip`, 'sendBill'],
    [signedInvoice, `${ruc}-01-FP01-1.zip`, 'sendSummary'],
    [signedRc, `${ruc}-RC-20260230-1.zip`, 'sendSummary'],
    [signedRc.replace('<cbc:CustomerAssignedAccountID>20615878481', '<cbc:CustomerAssignedAccountID>20450819230'), `${ruc}-RC-20261002-1.zip`, 'sendSummary'],
  ])('rechaza cambio %s', (xml, name, method) => expect(() => validateBetaPackage(packageOf(xml, name), ruc, method as 'sendBill')).toThrow());
  it('bloquea ZIP ambiguo y sin firma', () => {
    const plain = buildInvoiceUbl(snapshot(), { mode: 'REAL_PREPARATION' });
    expect(() => validateBetaPackage(packageOf(plain, `${ruc}-01-FP01-1.zip`), ruc, 'sendBill')).toThrow('Firma');
    const pkg = packageOf(signedInvoice, `${ruc}-01-FP01-1.zip`);
    pkg.zip = Buffer.from(zipSync({ [`${ruc}-01-FP01-1.xml`]: Buffer.from(signedInvoice), 'extra.xml': Buffer.from('<x/>') }));
    pkg.sha256 = createHash('sha256').update(pkg.zip).digest('hex');
    expect(() => validateBetaPackage(pkg, ruc, 'sendBill')).toThrow();
  });
  it('adaptador no realiza POST si el paquete falla aunque Beta esté habilitado sólo en el test', async () => {
    vi.stubEnv('SUNAT_BETA_TRANSMISSION_ENABLED', 'true'); const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const adapter = new BoundedSoapAdapter({ environment: 'BETA', ruc, solUser: 'MODDATOS', solPassword: 'MODDATOS' });
    await expect(adapter.submit(packageOf('<Invalid/>', `${ruc}-07-FP01-1.zip`))).rejects.toThrow(); expect(fetchMock).not.toHaveBeenCalled();
  });
});
