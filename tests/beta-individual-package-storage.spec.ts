import 'reflect-metadata';
import {createHash} from 'node:crypto';
import {describe,it,expect,vi} from 'vitest';
import {BetaIssuanceService} from '../services/sunat-service/src/application/beta-issuance.service';
import {prepareBetaXml} from '../services/sunat-service/src/infrastructure/crypto/beta-xml-pipeline';
import {batchMemberTestPki} from './helpers/batch-member-evidence.fixture';
import {supplementCommandFixture} from './helpers/fiscal-supplement.fixture';
import {unzipSync} from './helpers/guide-sidecar-ephemeral-pki.fixture';

describe('persistencia separada de paquetes de boleta Beta',()=>{
 it('guarda ZIP individual en el manifiesto y conserva RC como paquete de envío',async()=>{
  const pki=batchMemberTestPki(),snapshot=supplementCommandFixture('RC').doc,prepared=prepareBetaXml(snapshot,pki.issuer.pkcs12,pki.password,'RC-20261003-1');
  const writes=new Map<string,Buffer>(),store={put:vi.fn(async(id:string,name:string,b:Buffer)=>{
   const key=`${id}/${name}`,copy=Buffer.from(b);writes.set(key,copy);return {storageKey:key,sha256:createHash('sha256').update(copy).digest('hex'),sizeBytes:copy.length};
  })};
  const credentials={certificateCipher:'fixture',certificatePasswordCipher:'fixture',certificateFingerprint:pki.issuer.fingerprint,revision:1};
  const vault={open:()=>Buffer.from('synthetic')},inspection={inspect:async()=>({fingerprint:credentials.certificateFingerprint})};
  const trust={evaluate:async()=>({chainValid:true,identityMatched:true,revocation:'VERIFIED_OFFLINE_CRL'})};
  const signer={prepare:async()=>prepared},xsd={validate:async(xml:string)=>({xmlSha256:createHash('sha256').update(xml).digest('hex')})};
  const repo={reserveSummary:async()=> 'RC-20261003-1',owns:async()=>true};
  const svc=new BetaIssuanceService({} as never,repo as never,store as never,vault as never,inspection as never,trust as never,signer as never,xsd as never,{} as never);
  const internal=svc as any;internal.context=async()=>credentials;
  const result=await internal.prepare({id:'synthetic',documentId:snapshot.documentId,snapshot});
  const manifest=internal.manifests.get('synthetic');
  expect(Buffer.from(result.zip)).toEqual(prepared.zip);
  expect(manifest.individualXmlZip.storageKey).toContain(`${prepared.documentFileName}.zip`);
  expect(Buffer.from(Object.values(unzipSync(writes.get(manifest.individualXmlZip.storageKey)!))[0]).toString()).toBe(prepared.document.xml);
  expect(Buffer.from(Object.values(unzipSync(writes.get(manifest.zip.storageKey)!))[0]).toString()).toBe(prepared.request.xml);
  expect(manifest.individualXmlZip.sha256).not.toBe(manifest.zip.sha256);
 });
});
