import 'reflect-metadata';
import { beforeAll,describe,it,expect,vi } from 'vitest';
import { mkdirSync,writeFileSync } from 'node:fs';
import { productionGuidesSolUsername } from '../services/sunat-service/src/production-guides-sol-user';
import { ProductionGuidesRest } from '../services/sunat-service/src/production-guides-transport';
import { ProductionGuidesVaultSecrets } from '../services/sunat-service/src/production-guides-crypto';
import { SunatGreRestAdapter } from '../services/sunat-service/src/infrastructure/sunat/sunat-gre-rest.adapter';
import { validateProductionGuidesResult,productionGuidesSafeMessage,productionGuidesQrUrl } from '../packages/sunat-core/src/production-guides';
import { verifyGuideCdrEvidence } from '../services/sunat-service/src/application/guide-cdr-evidence';
import { renderProductionGuidesPdf } from '../services/sunat-service/src/production-guides-pdf';
import { createGuideSidecarPki,guideSidecarCdrExpected,guideSidecarCdrXml,guideSidecarPackCdr } from './helpers/guide-sidecar-ephemeral-pki.fixture';
import { snapshot09,uuid } from './production-guides.fixture';
import type { ProductionGuidesResult as Result } from '../packages/contracts/src/production-guides';
const url='https://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=SYNTHETIC%2B123%3D';
const ruc=snapshot09().issuer.ruc;
let pki:ReturnType<typeof createGuideSidecarPki>;
beforeAll(()=>{pki=createGuideSidecarPki(ruc);},30000);
function cdr(value:string|null=url,code='0',source:'EXTERNAL_CDR'|'LOCAL_EMULATOR'='EXTERNAL_CDR'){
 const expected={...guideSidecarCdrExpected(),issuerRuc:ruc,source};
 const unsigned=guideSidecarCdrXml(expected,code).replace('</cac:DocumentReference>',`${value===null?'':`<cbc:DocumentDescription>${value.replaceAll('&','&amp;')}</cbc:DocumentDescription>`}</cac:DocumentReference>`);
 const xml=pki.signCdr(unsigned),zip=guideSidecarPackCdr(xml,expected);
 return {expected,unsigned,xml,zip,run:()=>verifyGuideCdrEvidence(expected,zip,pki.cdrVerifier)};
}
function result():Result{return {documentId:uuid(1),snapshotSha256:'a'.repeat(64),state:'ACCEPTED',revision:4,source:'SUNAT_OFFICIAL',officialCdrVerified:true,authorizedForTransfer:false,xmlSha256:'b'.repeat(64),zipSha256:'c'.repeat(64),cdrZipSha256:'d'.repeat(64),responseCode:'0',description:'Guia aceptada',notes:[],qrUrl:url};}
describe('SOL username normalization and bounded ticket diagnostics',()=>{
 it.each(['SECONDARY',ruc+'SECONDARY'])('uses the same username contract in the legacy GRE adapter: %s',async solUser=>{
  const fetcher=vi.fn(async(url:unknown)=>new Response(JSON.stringify(String(url).includes('oauth2')?{access_token:'SYNTHETIC_TOKEN',token_type:'JWT',expires_in:3600}:{codRespuesta:'98'}),{headers:{'content-type':'application/json'}}));
  vi.stubEnv('GRE_EXTERNAL_TRANSMISSION_ENABLED','true');vi.stubGlobal('fetch',fetcher);
  try{
   const adapter=new SunatGreRestAdapter({environment:'PRODUCTION',enabled:true,ruc,solUser,solPassword:'SYNTHETIC_SOL',clientId:uuid(92),clientSecret:'SYNTHETIC_GRE',credentialRevision:1,readiness:{certificateTrusted:true,xsdValidated:true,fiscalRulesValidated:true}});
   expect(await adapter.getStatus(uuid(91))).toEqual({kind:'PROCESSING'});
   expect((fetcher.mock.calls[0] as any)[1].body.get('username')).toBe(ruc+'SECONDARY');
   expect((fetcher.mock.calls[1] as any)[1].headers.authorization).toBe('Bearer SYNTHETIC_TOKEN');
  }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
 });
 it('normalizes stored SOL through its own AAD and wipes the opened synthetic buffers',async()=>{
  const row={revision:1,certificateFingerprint:'a'.repeat(64),certificateSelfSigned:false,certificateExpiresAt:'2099-01-01',certificateCipher:'CERT',certificatePasswordCipher:'CERT_PASS',greClientIdCipher:'SYNTHETIC_CLIENT',greClientSecretCipher:'SYNTHETIC_GRE',solUsernameCipher:'SECONDARY',solPasswordCipher:'SYNTHETIC_SOL'};
  const buffers:Buffer[]=[],contexts:any[]=[];
  const vault={open:(value:string,context:any)=>{const bytes=Buffer.from(value);buffers.push(bytes);contexts.push(context);return bytes;}};
  const secrets=new ProductionGuidesVaultSecrets({$queryRawUnsafe:async()=>[row]} as any,vault as any);
  await secrets.withGre({issuerRuc:ruc,credentialRevision:1,certificateFingerprint:'a'.repeat(64)} as any,async(gre,sol)=>{
   expect(sol.username).toBe(ruc+'SECONDARY');expect(gre.clientSecret).toBe('SYNTHETIC_GRE');expect(sol.password).toBe('SYNTHETIC_SOL');
  });
  expect(contexts.map(c=>c.field)).toEqual(['greClientId','greClientSecret','solUsername','solPassword']);expect(contexts.every(c=>c.ruc===ruc&&c.environment==='PRODUCTION')).toBe(true);
  expect(buffers.every(b=>b.every(v=>v===0))).toBe(true);
 });
 it.each(['SECONDARY',ruc+'SECONDARY'])('normalizes %s without duplication',raw=>expect(productionGuidesSolUsername(ruc,raw)).toBe(ruc+'SECONDARY'));
 it.each(['20000000028OTHER','USER\n',' USER','USER ','a-b','a_b','a@b','',ruc,ruc+ruc+'USER','x'.repeat(42),'A\u0000'])('rejects invalid SOL format without credential diagnostics',raw=>{
  expect(()=>productionGuidesSolUsername(ruc,raw)).toThrow(/^GRE_CREDENTIALS_INVALID$/);
 });
 it.each(['SECONDARY',ruc+'SECONDARY'])('keeps OAuth form and authorization for %s',async username=>{
  let form!:URLSearchParams;
  const http={request:vi.fn(async(i:any)=>{if(i.url.includes('oauth2')){form=new URLSearchParams(i.body.toString());return {status:200,body:Buffer.from(JSON.stringify({token_type:'Bearer',access_token:'SYNTHETIC_TOKEN',expires_in:3600}))};}return {status:200,body:Buffer.from(JSON.stringify({codRespuesta:'99',indCdrGenerado:'0',error:{numError:'1345',desError:'El RUC no es valido'},exc:'secret stack trace',qrUrl:url}))};})};
  const authorize=vi.fn(async()=>{}),rest=new ProductionGuidesRest({http,authorize,credentials:{withGre:async(_g,work)=>work({clientId:'synthetic-client',clientSecret:'SYNTHETIC_SECRET'},{username,password:'SYNTHETIC_PASSWORD'})}});
  const g={issuerRuc:ruc,credentialRevision:1} as any;
  expect(await rest.ticket(g,uuid(91))).toEqual({state:'FAILED_NO_CDR',functionalError:{code:'1345',message:'El RUC no es valido'}});
  expect(Object.fromEntries(form)).toEqual({grant_type:'password',scope:'https://api-cpe.sunat.gob.pe',client_id:'synthetic-client',client_secret:'SYNTHETIC_SECRET',username:ruc+'SECONDARY',password:'SYNTHETIC_PASSWORD'});
  await rest.ticket(g,uuid(91));expect(http.request).toHaveBeenCalledTimes(3);
  await rest.ticket({...g,credentialRevision:2},uuid(91));expect(http.request).toHaveBeenCalledTimes(5);
  expect(authorize.mock.calls.length).toBe(6);
 });
 it.each(['<html>trace</html>','java.lang.NullPointerException at main','password: HIDDEN','token HIDDEN','client_secret: HIDDEN','https://evil.test','a\ntrace','x'.repeat(2049)])('drops unsafe diagnostic %s',v=>expect(productionGuidesSafeMessage(v)).toBeUndefined());
});
describe('authenticated CDR QR interoperability profile',()=>{
 it('extracts only accepted external signed evidence and preserves all bytes',async()=>{const f=cdr(),before=Buffer.from(f.zip),proof=await f.run();expect(proof.qrUrl).toBe(url);expect(proof.responseCode).toBe('0');expect(f.zip).toEqual(before);expect(proof.authorizedForTransfer).toBe(false);});
 it.each([null,'http://e-factura.sunat.gob.pe/v1/contribuyente/gre/comprobantes/descargaqr?hashqr=x',url.replace('e-factura.sunat.gob.pe','e-factura.sunat.gob.pe.evil.test'),url.replace('https://','https://user@'),url.replace('.pe/','.pe:444/'),url+'#fragment',url+'&hashqr=OTHER',url.replace('/descargaqr','/other'),url.replace('hashqr=','redirect='),'https://evil.test/?hashqr=abc',url+'%0A'])('keeps valid CDR but withholds invalid/missing URL %s',async value=>{const f=cdr(value),proof=await f.run();expect(proof.status).toBe('ACCEPTED');expect(proof.qrUrl).toBeUndefined();});
 it.each(['LOCAL_EMULATOR','EXTERNAL_CDR'] as const)('does not add QR to rejected CDR %s',async source=>expect((await cdr(url,'2345',source).run()).qrUrl).toBeUndefined());
 it('does not add QR for synthetic origin',async()=>expect((await cdr(url,'0','LOCAL_EMULATOR').run()).qrUrl).toBeUndefined());
 it('treats duplicate descriptions as unavailable without losing CDR',async()=>{const f=cdr(),xml=pki.signCdr(f.unsigned.replace('</cac:DocumentReference>',`<cbc:DocumentDescription>${url}</cbc:DocumentDescription></cac:DocumentReference>`));expect((await verifyGuideCdrEvidence(f.expected,guideSidecarPackCdr(xml,f.expected),pki.cdrVerifier)).qrUrl).toBeUndefined();});
 it.each(['unsigned','wrong-ruc','wrong-document','tampered'] as const)('rejects %s before exposing a QR',async kind=>{const f=cdr();let xml=f.xml;if(kind==='unsigned')xml=f.unsigned;if(kind==='wrong-ruc')f.expected.issuerRuc='20000000028';if(kind==='wrong-document')f.expected.fullNumber='TQ71-2';if(kind==='tampered')xml=xml.replace('SYNTHETIC','ADULTERADO');await expect(verifyGuideCdrEvidence(f.expected,guideSidecarPackCdr(xml,f.expected),pki.cdrVerifier)).rejects.toThrow();});
});
describe('status validation and A4 renderer',()=>{
 it.each([0,2345,true,false])('rejects non-string responseCode %s',responseCode=>{for(const state of ['ACCEPTED','REJECTED'])expect(()=>validateProductionGuidesResult({...result(),state,responseCode})).toThrow();});
 it('accepts optional v1 metadata and rejects unknown/inconsistent fields',()=>{
  expect(validateProductionGuidesResult(result())).toEqual(result());
  for(const patch of [{injection:'x'},{source:'LOCAL_SYNTHETIC'},{state:'REJECTED'},{officialCdrVerified:false},{qrUrl:'https://evil.test/'},{description:'<script>x</script>'},{responseCode:'2345'},{authorizedForTransfer:true}])expect(()=>validateProductionGuidesResult({...result(),...patch})).toThrow();
  const old=result();delete old.qrUrl;delete old.responseCode;delete old.description;delete old.notes;expect(validateProductionGuidesResult(old)).toEqual(old);
 });
 it('bounds safe CDR text without passing through exception content beyond the bound',()=>{const long='Observacion funcional '.repeat(60).trim();expect(productionGuidesSafeMessage(long)).toBe(long.slice(0,500).trimEnd());expect(productionGuidesSafeMessage(long+' token SECRET')).toBeUndefined();});
 it('renders synthetic evidence PDFs with and without a verified QR for visual inspection',async()=>{
  mkdirSync('output/gre-repair',{recursive:true});const s=snapshot09();
  (s.body as any).items=Array.from({length:18},(_,i)=>({...((s.body as any).items[0]),code:`SYN${i+1}`,description:`BIEN NO FISCALIZADO FICTICIO ${i+1} PARA REVISION DE SALTO DE PAGINA`}));
  const f=cdr(url.replace('SYNTHETIC%2B123%3D','SYNTHETIC'+'A'.repeat(600))),proof=await f.run();
  const accepted={...result(),qrUrl:proof.qrUrl,cdrZipSha256:proof.cdrZipSha256};
  expect(productionGuidesQrUrl(accepted.qrUrl)).toBe(true);
  writeFileSync('output/gre-repair/synthetic-cdr.zip',f.zip);
  writeFileSync('output/gre-repair/synthetic-with-qr.pdf',await renderProductionGuidesPdf(s,accepted));
  writeFileSync('output/gre-repair/synthetic-pending.pdf',await renderProductionGuidesPdf(s,{documentId:s.documentId,snapshotSha256:'a'.repeat(64),state:'TICKET',revision:3,source:'LOCAL_SYNTHETIC',officialCdrVerified:false,authorizedForTransfer:false,ticket:uuid(91)}));
  const rejected=result();delete rejected.qrUrl;
  writeFileSync('output/gre-repair/synthetic-rejected.pdf',await renderProductionGuidesPdf(s,{...rejected,state:'REJECTED',responseCode:'2345',description:'El RUC no es valido'}));
 });
});
