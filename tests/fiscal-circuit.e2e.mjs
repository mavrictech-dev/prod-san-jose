// Exclusivamente QA 8091; emulador sin Internet, RUC/certificado ficticios.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes, generateKeyPairSync, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../services/sunat-service/package.json',import.meta.url));
const forge=require('node-forge'); const { unzipSync }=require('fflate'); const { SignedXml }=require('xml-crypto'); const { DOMParser }=require('@xmldom/xmldom');
if(!process.argv.includes('--isolated-only')) throw new Error('Use --isolated-only');
const base='http://127.0.0.1:8091';
async function call(path,token,body,method=body?'POST':'GET',key){return fetch(base+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});}
async function json(response,status=200){assert.equal(response.status,status,`HTTP ${response.status}`);return response.json();}
const password=(await readFile(new URL('../.factuez-demo/secrets/initial_admin_password.txt',import.meta.url),'utf8')).trim();
const {accessToken:admin}=await json(await call('/api/v1/auth/login',undefined,{username:'demo.admin',password}));
const catalog=await json(await call('/api/v1/documents/catalog/issuance',admin));assert.equal(catalog.capabilities.demoData,true);assert.equal(catalog.capabilities.fiscalTransmission,false);
const real=catalog.companies.find(c=>c.ruc==='20450819230');assert.ok(real);
const realBefore=await json(await call(`/api/v1/setup/sunat/${real.id}/BETA`,admin));
const suffix=randomBytes(4).toString('hex');const ruc='00'+String(BigInt('0x'+randomBytes(5).toString('hex'))%1000000000n).padStart(9,'0');
const issuer=await json(await call('/api/v1/stations/issuers',admin,{ruc,legalName:`PRUEBA CIRCUITO FICTICIO ${suffix}`,taxAddress:'FICTICIA - NO FISCAL',ubigeo:'200101'}),201);
const branch=await json(await call('/api/v1/stations',admin,{companyId:issuer.id,code:`CQ_${suffix}`,name:`PRUEBA circuito ${suffix}`}),201);
const point=await json(await call(`/api/v1/stations/${branch.id}/points`,admin,{code:`CQ_${suffix}`,name:'PRUEBA transporte local',invoiceSeries:'FQ01',receiptSeries:'BQ01'}),201);
const pair=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});const privateKey=forge.pki.privateKeyFromPem(pair.privateKey);
const cert=forge.pki.createCertificate();cert.publicKey=forge.pki.publicKeyFromPem(pair.publicKey);cert.serialNumber='01';cert.validity.notBefore=new Date(Date.now()-3600000);cert.validity.notAfter=new Date(Date.now()+86400000*7);
cert.setSubject([{name:'commonName',value:'QA FICTICIO NO SUNAT'}]);cert.setIssuer(cert.subject.attributes);cert.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true}]);cert.sign(privateKey,forge.md.sha256.create());
const fakePassword=randomBytes(24).toString('base64url');const p12=Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(privateKey,cert,fakePassword,{algorithm:'aes256'})).getBytes(),'binary');
await json(await call(`/api/v1/setup/sunat/${issuer.id}/BETA`,admin,{expectedRevision:0,certificate:{fileName:'FICTICIO.p12',base64:p12.toString('base64'),password:fakePassword}}),201);p12.fill(0);
const DS='http://www.w3.org/2000/09/xmldsig#';const CBC='urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2';
function verify(xml,rootName,ref){const parsed=new DOMParser().parseFromString(xml,'application/xml');assert.equal(parsed.documentElement.localName,rootName);const nodes=parsed.getElementsByTagNameNS(DS,'Signature');assert.equal(nodes.length,1);const verifier=new SignedXml({publicCert:forge.pki.certificateToPem(cert),getCertFromKeyInfo:()=>null});verifier.loadSignature(nodes[0]);assert.equal(verifier.checkSignature(xml),true);assert.equal(verifier.getSignedReferences().length,1);assert.ok(verifier.getSignedReferences()[0].includes(ref));return parsed.getElementsByTagNameNS(DS,'DigestValue')[0].textContent;}
const cases=[['INVOICE','ACCEPTED','ACCEPTED'],['INVOICE','OBSERVED','ACCEPTED_WITH_OBSERVATIONS'],['INVOICE','REJECTED','REJECTED'],['INVOICE','UNCERTAIN','UNKNOWN'],['INVOICE','INVALID_CDR','UNKNOWN'],['SALES_RECEIPT','ACCEPTED','ACCEPTED'],['SALES_RECEIPT','TRANSIENT_STATUS','ACCEPTED'],['SALES_RECEIPT','REJECTED','REJECTED']];
const proof={ruc,issuerId:issuer.id,branchId:branch.id,documents:[]};const sequences={INVOICE:0,SALES_RECEIPT:0};let restricted;
try{
  restricted=await json(await call('/api/v1/users',admin,{username:`qa.circuit.${suffix}`,fullName:'PRUEBA acceso restringido',password:fakePassword,roles:['CASHIER'],branchIds:[branch.id],emissionPointIds:[point.id],series:point.series.map(s=>s.id)}),201);
  const {accessToken:cashier}=await json(await call('/api/v1/auth/login',undefined,{username:restricted.username,password:fakePassword}));
  for(const [type,scenario,target] of cases){
    const body={emissionPointId:point.id,documentType:type,series:type==='INVOICE'?'FQ01':'BQ01',customer:{identityType:type==='INVOICE'?'6':'0',identityNumber:type==='INVOICE'?'00000000000':'0',legalName:'CLIENTE FICTICIO QA'},lines:[{description:'Diésel B5 PRUEBA CIRCUITO & FIRMA',quantity:'2.5',unitCode:'GLL',unitPriceWithTax:'18.50',taxAffectationCode:'10',igvRate:'18'}]};
    const key=randomUUID();const issued=await json(await call('/api/v1/documents',admin,body,'POST',key),202);const replay=await json(await call('/api/v1/documents',admin,body,'POST',key),202);assert.equal(replay.documentId,issued.documentId);sequences[type]++;
    const path=`/api/v1/fiscal-circuit-qa/${issued.documentId}`;
    assert.equal((await call(path)).status,401);assert.equal((await call(path,cashier,{scenario})).status,403);
    let ready=false;for(let i=0;i<40;i++){const response=await call(path,admin);if(response.status===200){ready=true;await response.arrayBuffer();break;}assert.equal(response.status,409);await response.arrayBuffer();await new Promise(r=>setTimeout(r,500));}assert.ok(ready);
    const initial=await json(await call(path,admin,{scenario}),201);assert.equal(initial.transport,'LOCAL_SIMULATION');assert.equal(initial.fiscalTransmission,false);assert.equal(initial.officialCdr,false);
    assert.equal(initial.xsdValidated,true);assert.equal(initial.xsdProfile,'SUNAT-XSD-20220228-SHA5cac9d93-v1');assert.equal(initial.sunatRulesValidated,false);
    const repeats=await Promise.all([call(path,admin,{scenario}).then(r=>json(r,201)),call(path,admin,{scenario}).then(r=>json(r,201))]);assert.ok(repeats.every(r=>r.id===initial.id));
    let result;for(let i=0;i<120;i++){result=await json(await call(path,admin));if(result.state===target)break;if(['BLOCKED','POLL_LIMIT'].includes(result.state))throw new Error(`Estado inesperado ${result.state}`);await new Promise(r=>setTimeout(r,500));}assert.equal(result.state,target,`Escenario ${scenario}`);
    assert.doesNotMatch(JSON.stringify(result),/Cipher|StorageKey|password/);assert.equal(result.cdrAvailable,target!=='UNKNOWN');
    const xmlResponse=await call(`${path}/xml`,admin);assert.equal(xmlResponse.status,200);assert.match(xmlResponse.headers.get('cache-control'),/no-store/);const xml=await xmlResponse.text();assert.equal(verify(xml,'Invoice',ruc),result.digestValue);
    const requestResponse=await call(`${path}/request`,admin);assert.equal(requestResponse.status,200);const files=unzipSync(Buffer.from(await requestResponse.arrayBuffer()));assert.equal(Object.keys(files).length,1);const requestXml=Buffer.from(Object.values(files)[0]).toString();
    verify(requestXml,type==='INVOICE'?'Invoice':'SummaryDocuments',ruc);
    if(type==='SALES_RECEIPT'){assert.match(result.requestFileName,/-RC-\d{8}-\d+\.zip$/);assert.ok(result.ticket?.startsWith('LOCAL-'));assert.ok(requestXml.includes('<cbc:ConditionCode>1'));assert.ok(result.pollAttempts>=3);}
    const cdrResponse=await call(`${path}/cdr`,admin);assert.equal(cdrResponse.status,target==='UNKNOWN'?409:200);if(target!=='UNKNOWN'){const receipt=unzipSync(Buffer.from(await cdrResponse.arrayBuffer()));assert.ok(Buffer.from(Object.values(receipt)[0]).toString().includes('SIMULADO - NO OFICIAL'));}
    const detail=await json(await call(`/api/v1/documents/${issued.documentId}`,admin));assert.equal(detail.fiscalTransmission,false);assert.equal(detail.immutableSnapshot.number,String(sequences[type]));assert.equal(detail.immutableSnapshot.totals.payableAmount,'46.25');assert.ok(['PENDING','QUEUED','PROCESSING'].includes(detail.sunatStatus));
    assert.equal((await call(path,admin,{scenario:scenario==='ACCEPTED'?'REJECTED':'ACCEPTED'})).status,409);
    if(type==='SALES_RECEIPT'&&scenario==='ACCEPTED'){
      await mkdir('output/pdf',{recursive:true});for(const format of ['ticket','a4']){const response=await call(`${path}/${format}`,admin);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/^application\/pdf/);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');await writeFile(`output/pdf/circuito-${format}-SIMULADO.pdf`,bytes);}
      proof.pdfDocumentId=issued.documentId;proof.digestValue=result.digestValue;
    }
    proof.documents.push({id:issued.documentId,type,scenario,state:result.state,runId:result.id,pollAttempts:result.pollAttempts});console.log(`OK ${type}/${scenario}: ${result.state}; sin otro correlativo ni estado fiscal aceptado`);
  }
  const uncertain=proof.documents.find(d=>d.scenario==='UNCERTAIN');await new Promise(r=>setTimeout(r,6500));assert.equal((await json(await call(`/api/v1/fiscal-circuit-qa/${uncertain.id}`,admin))).state,'UNKNOWN');
  assert.deepEqual(await json(await call(`/api/v1/setup/sunat/${real.id}/BETA`,admin)),realBefore);
  await mkdir('tmp/circuit-qa',{recursive:true});await writeFile('tmp/circuit-qa/proof.json',JSON.stringify(proof,null,2));console.log('OK circuito E2E: 8 escenarios, SOAP/BullMQ/PG/Kong, RC firmado, CDR simulado, QR/hash, RUC real intacto');
}finally{if(restricted)assert.equal((await call(`/api/v1/users/${restricted.id}/access`,admin,{active:false},'PATCH')).status,200);}
