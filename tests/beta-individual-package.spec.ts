import {describe,it,expect,beforeAll} from 'vitest';
import {prepareBetaXml} from '../services/sunat-service/src/infrastructure/crypto/beta-xml-pipeline';
import {batchMemberTestPki} from './helpers/batch-member-evidence.fixture';
import {supplementCommandFixture} from './helpers/fiscal-supplement.fixture';
import {unzipSync} from './helpers/guide-sidecar-ephemeral-pki.fixture';
let pki:ReturnType<typeof batchMemberTestPki>;
beforeAll(()=>{pki=batchMemberTestPki();},60000);
describe('paquetes firmados Beta con certificado efímero',()=>{
 it('separa el XML de boleta del resumen RC que se envía',()=>{
  const doc=supplementCommandFixture('RC').doc,result=prepareBetaXml(doc,pki.issuer.pkcs12,pki.password,'RC-20261003-1');
  const individual=unzipSync(result.individualZip!),submitted=unzipSync(result.zip);
  expect(Object.keys(individual)).toEqual([`${result.documentFileName}.xml`]);
  expect(Buffer.from(Object.values(individual)[0]).toString()).toBe(result.document.xml);
  expect(Object.keys(submitted)).toEqual([`${result.fileName}.xml`]);
  expect(Buffer.from(Object.values(submitted)[0]).toString()).toBe(result.request.xml);
  expect(Buffer.from(result.individualZip!).equals(result.zip)).toBe(false);
 });
 it('conserva el paquete individual de la factura como paquete de envío',()=>{
  const doc=supplementCommandFixture('NOTE').doc,result=prepareBetaXml(doc,pki.issuer.pkcs12,pki.password);
  expect(result.individualZip).toBeUndefined();expect(Buffer.from(Object.values(unzipSync(result.zip))[0]).toString()).toBe(result.document.xml);
 });
});
