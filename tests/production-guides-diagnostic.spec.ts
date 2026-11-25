import {beforeAll,describe,it,expect} from 'vitest';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {randomUUID,X509Certificate} from 'node:crypto';
import {resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tlsFixture} from './production-guides.fixture';
const local=createRequire(import.meta.url),{run,publicFile}=local('./production-guides-readonly-diagnostic.cjs');
const serviceLocal=createRequire(resolve('services/sunat-service/package.json')),forge=serviceLocal('node-forge');
const evidence=resolve('output/gre-repair/diagnostic-followup');
let tls:ReturnType<typeof tlsFixture>;
beforeAll(()=>{tls=tlsFixture();mkdirSync(evidence,{recursive:true});writeFileSync(resolve(evidence,'synthetic-diagnostic-public.cer'),new X509Certificate(tls.cert).raw);});
describe('administrator diagnostic is explicit, read-only and secret-free',()=>{
 it('requires explicit public targets and refuses private/relative paths before opening them',()=>{
  expect(()=>run([])).toThrow('REQUIRES_READ_ONLY');expect(()=>run(['--read-only'])).toThrow('EXPLICIT_TARGET_REQUIRED');
  for(const name of ['.env','private.key','issuer.p12','issuer.pfx'])expect(()=>publicFile(resolve(name),true)).toThrow('PUBLIC_FILE_PATH_INVALID');
  expect(()=>publicFile('relative.cer',true)).toThrow('PUBLIC_FILE_PATH_INVALID');
 });
 it('reports only public certificate OIDs and matching DER hash',()=>{
  const path=resolve(evidence,'synthetic-diagnostic-public.cer'),report=publicFile(path,true);
  expect(report).toMatchObject({exists:true,readable:true,trustDecision:'NOT_EVALUATED'});
  expect(report.publicCertificate.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(report)).not.toContain('PRIVATE KEY');expect(report.sha256).toBe(report.publicCertificate.fingerprint);
 });
 it.each([
  {name:'exact-ou',attributes:[{type:'2.5.4.11',value:'FACTURA ELECTRONICA RUC 20000000001'}],candidates:['20000000001']},
  {name:'conflicting-ou',attributes:[{type:'2.5.4.11',value:'FACTURA ELECTRONICA RUC 20000000001'},{type:'2.5.4.97',value:'NTRPE-20000000028'}],candidates:['20000000001','20000000028']},
  {name:'cn-ignored',attributes:[{type:'2.5.4.3',value:'FACTURA ELECTRONICA RUC 20000000001'}],candidates:[]},
  {name:'ou-suffix',attributes:[{type:'2.5.4.11',value:'FACTURA ELECTRONICA RUC 20000000001 EXTRA'}],candidates:[]},
 ])('reports public OU and shared identity candidates without granting trust: $name',({name,attributes,candidates})=>{
  const certificate=forge.pki.createCertificate();certificate.publicKey=forge.pki.certificateFromPem(tls.cert.toString()).publicKey;
  certificate.serialNumber='03';certificate.validity.notBefore=new Date(Date.now()-60000);certificate.validity.notAfter=new Date(Date.now()+86400000);
  certificate.setSubject(attributes);certificate.setIssuer(attributes);certificate.sign(forge.pki.privateKeyFromPem(tls.key.toString()),forge.md.sha256.create());
  const file=resolve(evidence,`synthetic-${name}.cer`);writeFileSync(file,new X509Certificate(forge.pki.certificateToPem(certificate)).raw);
  const report=publicFile(file,true);
  expect(report).toMatchObject({readable:true,trustDecision:'NOT_EVALUATED',publicCertificate:{subjectRucCandidates:candidates}});
  expect(report.publicCertificate.identityAttributes).toEqual(attributes.filter(a=>a.type!=='2.5.4.3').map(a=>({oid:a.type,value:a.value})));
  expect(report).not.toHaveProperty('chainValid');expect(report).not.toHaveProperty('identityMatched');expect(report).not.toHaveProperty('officialCdrVerified');
 });
 it('filters Docker metadata and flags before stdout without leaking a synthetic secret',()=>{
  const id=randomUUID(),name='factuez-gre-diagnostic-'+id.slice(0,8),label='factuez.gre.diagnostic='+id;
  const docker=(args:string[])=>{const result=spawnSync('docker',args,{encoding:'utf8',windowsHide:true,timeout:30000});expect(result.status,'ISOLATED_DOCKER_FAILED').toBe(0);return result.stdout.trim();};
  let container:string|undefined;
  try{
   container=docker(['create','--name',name,'--network','none','--label',label,'--label','com.docker.compose.project=synthetic-only','--label','com.docker.compose.service=sunat-service','-e','SUNAT_PRODUCTION_WORKFLOW_ENABLED=false','-e','SUNAT_BETA_TRANSMISSION_ENABLED=false','-e','INVISIBLE_PASSWORD=SYNTHETIC_NEVER_PRINT','postgres:17-alpine']);
   const report=run(['--read-only','--container',name]);
   expect(report.containers[0]).toMatchObject({project:'synthetic-only',service:'sunat-service',flags:{SUNAT_PRODUCTION_WORKFLOW_ENABLED:'false',SUNAT_BETA_TRANSMISSION_ENABLED:'false'}});
   expect(JSON.stringify(report)).not.toContain('SYNTHETIC_NEVER_PRINT');expect(JSON.stringify(report)).not.toContain('INVISIBLE_PASSWORD');
  }finally{if(container){expect(docker(['inspect','--format','{{index .Config.Labels "factuez.gre.diagnostic"}}',container])).toBe(id);docker(['rm',container]);}}
 });
 it('keeps the shared SOL form instructions unprefixed for SOAP consumers',()=>{
  const source=readFileSync(resolve('apps/web-pwa/app/(workspace)/sunat-settings/page.tsx'),'utf8');
  expect(source).toContain('Usuario secundario. Sin RUC como prefijo.');expect(source).not.toContain('solo o con el RUC');
 });
});
