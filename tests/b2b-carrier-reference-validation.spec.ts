import 'reflect-metadata';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,join,resolve,sep} from 'node:path';
import {request,createServer} from 'node:https';
import {NestFactory} from '../services/sunat-service/node_modules/@nestjs/core';
import {CarrierReferenceValidation,PrismaCarrierReferenceOwnerBinding,carrierReferenceLimits} from '../services/sunat-service/src/b2b/carrier-reference-validation';
import {CarrierReferenceValidationModule} from '../services/sunat-service/src/b2b/carrier-reference-validation-http';
import {CARRIER_REQUEST_VERSION,CARRIER_VALIDATION_PATH,carrierReferenceResponse} from '../services/sunat-service/src/b2b/carrier-reference-validation-protocol';
import {HttpCarrierReferenceSignatureCdrValidator} from '../services/billing-service/src/b2b/carrier-reference-validation-http';
import {PinnedBetaIssuerPublicCertificates} from '../services/sunat-service/src/infrastructure/crypto/beta-owner-xml-trust';
import {CertificateTrustService} from '../services/sunat-service/src/infrastructure/crypto/certificate-trust.service';
import {CdrSignatureTrustService} from '../services/sunat-service/src/infrastructure/crypto/cdr-signature-trust.service';
import {XmlSignerService} from '../services/sunat-service/src/infrastructure/crypto/xml-signer.service';
import {buildPublicGuide09Xml,projectPublicGuide09OwnerSnapshot,type PublicGuide09OwnerSnapshot} from '../packages/sunat-core/src/public-guide-profile';
import {fiscalSnapshotSha256 as hash} from '../packages/sunat-core/src/fiscal-note';
import {carrierGuideHttpFixture} from './helpers/carrier-guide-http.fixture';
import {guideSidecarCdrXml} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const execute=promisify(execFile),sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),NOW='2026-10-26T18:00:00.000Z';
let pki:any,root:string,tls:ReturnType<typeof b2bCertificates>;
const cleanup:(()=>Promise<void>)[]=[];
const PKI=`
import json,base64,datetime
from cryptography import x509
from cryptography.x509.oid import NameOID,ObjectIdentifier
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
start=datetime.datetime(2020,1,1); end=datetime.datetime(2035,1,1)
rootkey=rsa.generate_private_key(public_exponent=65537,key_size=2048)
name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'SYNTHETIC REFERENCE TEST ROOT ONLY')])
def usage(ca):return x509.KeyUsage(digital_signature=not ca,content_commitment=False,key_encipherment=False,data_encipherment=False,key_agreement=False,key_cert_sign=ca,crl_sign=ca,encipher_only=False,decipher_only=False)
root=(x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(rootkey.public_key()).serial_number(1).not_valid_before(start).not_valid_after(end).add_extension(x509.BasicConstraints(ca=True,path_length=1),critical=True).add_extension(usage(True),critical=True).add_extension(x509.SubjectKeyIdentifier.from_public_key(rootkey.public_key()),critical=False).add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(rootkey.public_key()),critical=False).sign(rootkey,hashes.SHA256()))
password=b'EPHEMERAL-REFERENCE-ONLY-NOT-CUSTOMER'
def leaf(serial,ruc):
 key=rsa.generate_private_key(public_exponent=65537,key_size=2048)
 subject=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'SYNTHETIC REFERENCE LEAF '+str(serial)),x509.NameAttribute(ObjectIdentifier('2.5.4.97'),'NTRPE-'+ruc)])
 cert=(x509.CertificateBuilder().subject_name(subject).issuer_name(name).public_key(key.public_key()).serial_number(serial).not_valid_before(start).not_valid_after(end).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True).add_extension(usage(False),critical=True).add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()),critical=False).add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(rootkey.public_key()),critical=False).sign(rootkey,hashes.SHA256()))
 return {'pem':cert.public_bytes(serialization.Encoding.PEM).decode(),'p12':base64.b64encode(pkcs12.serialize_key_and_certificates(b'synthetic',key,cert,[root],serialization.BestAvailableEncryption(password))).decode()}
def crl(serial=None,expired=False):
 b=x509.CertificateRevocationListBuilder().issuer_name(name).last_update(start).next_update(datetime.datetime(2021,1,1) if expired else end).add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(rootkey.public_key()),critical=False)
 if serial is not None:b=b.add_revoked_certificate(x509.RevokedCertificateBuilder().serial_number(serial).revocation_date(datetime.datetime(2020,2,1)).build())
 return b.sign(rootkey,hashes.SHA256()).public_bytes(serialization.Encoding.PEM).decode()
print(json.dumps({'root':root.public_bytes(serialization.Encoding.PEM).decode(),'issuer':leaf(2,'20000000001'),'cdr':leaf(3,'20131312955'),'good':crl(),'revokedIssuer':crl(2),'revokedCdr':crl(3),'expiredCrl':crl(expired=True),'password':password.decode()}))
`;
beforeAll(async()=>{
 const generated=await execute('python',['-c',PKI],{timeout:30000,maxBuffer:131072,windowsHide:true});pki=JSON.parse(generated.stdout);
 root=await mkdtemp(join(tmpdir(),'factuez-carrier-validation-'));tls=b2bCertificates();
 for(const [name,bytes] of Object.entries({'roots.pem':pki.root,'issuer.pem':pki.issuer.pem+pki.root,'cdr.pem':pki.cdr.pem+pki.root,'good.crl.pem':pki.good,'revoked-issuer.crl.pem':pki.revokedIssuer,'revoked-cdr.crl.pem':pki.revokedCdr,'expired.crl.pem':pki.expiredCrl}))await writeFile(join(root,name),bytes as string,{mode:0o600});
},60000);
beforeEach(()=>{
 const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'/usr/bin/openssl';if(!existsSync(openssl))throw Error('REAL_OPENSSL_REQUIRED_NO_FAKE_PKI');
 for(const [k,v] of Object.entries({SUNAT_OPENSSL_PATH:openssl,SUNAT_TRUST_STORE_FILE:join(root,'roots.pem'),SUNAT_TRUST_STORE_SHA256:sha(pki.root),SUNAT_CRL_BUNDLE_FILE:join(root,'good.crl.pem'),SUNAT_CRL_BUNDLE_SHA256:sha(pki.good),SUNAT_CDR_SIGNER_CERT_FILE:join(root,'cdr.pem'),SUNAT_CDR_SIGNER_CERT_SHA256:sha(pki.cdr.pem+pki.root)}))vi.stubEnv(k,v);
});
afterEach(async()=>{try{while(cleanup.length)await cleanup.pop()!();}finally{vi.unstubAllEnvs();vi.restoreAllMocks();}});
afterAll(async()=>{if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('factuez-carrier-validation-'))throw Error('UNOWNED_TEST_DIRECTORY');await rm(root,{recursive:true,force:true});});
let originals:{unsigned:string;signed:ReturnType<XmlSignerService['sign']>;cdrUnsigned:string;cdr:string}|undefined;
function fixture(){
 const p=carrierGuideHttpFixture().owned.reference.snapshot;
 const {schemaVersion:_,documentType:__,documentId,issuer,series,number,...body}=p;
 const snapshot:PublicGuide09OwnerSnapshot={schemaVersion:'factuez.public-guide09-issued-owner.v1',companyId:77,branchId:randomUUID(),documentId,operationId:randomUUID(),issuer,series,number,body:{...body,reasonCode:'01',mtcRegistration:'MTC-OWNER-09'}};
 const unsigned=buildPublicGuide09Xml(snapshot).xml,signer=new XmlSignerService();
 const signed=originals?.unsigned===unsigned?originals.signed:signer.sign(unsigned,Buffer.from(pki.issuer.p12,'base64'),pki.password,'DespatchAdvice');
 const expected={issuerRuc:issuer.ruc,documentType:'09' as const,fullNumber:series+'-'+number,requestXmlSha256:sha(signed.xml),requestZipSha256:'b'.repeat(64),issuedAt:snapshot.body.issueDate,receivedAt:NOW};
 const cdrUnsigned=guideSidecarCdrXml(expected),cdr=originals?.unsigned===unsigned&&originals.cdrUnsigned===cdrUnsigned?originals.cdr:signer.sign(cdrUnsigned,Buffer.from(pki.cdr.p12,'base64'),pki.password,'ApplicationResponse').xml;
 originals={unsigned,signed,cdrUnsigned,cdr};
 const input={ownerSnapshot:structuredClone(snapshot),ownerSnapshotSha256:hash(snapshot),projection:projectPublicGuide09OwnerSnapshot(snapshot),projectionSha256:hash(projectPublicGuide09OwnerSnapshot(snapshot)),
  signedXml:Buffer.from(signed.xml),signedXmlSha256:sha(signed.xml),cdrXml:Buffer.from(cdr),cdrSha256:sha(cdr)};
 const row:any={documentId,issuerRuc:issuer.ruc,environment:'BETA',documentType:'09',series,number:BigInt(number),status:'ACCEPTED',immutablePayload:structuredClone(snapshot),digestValue:signed.digestValue,updatedAt:new Date('2026-10-23T16:00:00Z'),
  artifacts:[{kind:'SIGNED_XML',sha256:input.signedXmlSha256},{kind:'CDR_XML',sha256:input.cdrSha256}]};
 const db={fiscalDocument:{findFirst:vi.fn(async()=>structuredClone(row))}};
 const trust=new CertificateTrustService(),cdrTrust=new CdrSignatureTrustService(trust),pin={fingerprint:new X509Certificate(pki.issuer.pem).fingerprint256.replace(/:/g,'').toLowerCase(),revision:'a'.repeat(64)};
 const pins={current:vi.fn(async()=>({...pin}))};
 const certs=new PinnedBetaIssuerPublicCertificates([{issuerRuc:issuer.ruc,fingerprint:pin.fingerprint,path:join(root,'issuer.pem'),sha256:sha(pki.issuer.pem+pki.root)}]);
 const owner=new PrismaCarrierReferenceOwnerBinding(db as any),core=new CarrierReferenceValidation({owner,pins,certificates:certs,trust,cdr:cdrTrust,now:()=>NOW});
 const xml=(value:string,digest?:string)=>{input.signedXml=Buffer.from(value);input.signedXmlSha256=sha(value);row.artifacts[0].sha256=sha(value);if(digest)row.digestValue=digest;};
 const receipt=(value:string)=>{input.cdrXml=Buffer.from(value);input.cdrSha256=sha(value);row.artifacts[1].sha256=sha(value);};
 const resign=(change:(xml:string)=>string)=>{const r=signer.sign(change(unsigned),Buffer.from(pki.issuer.p12,'base64'),pki.password,'DespatchAdvice');xml(r.xml,r.digestValue);};
 const resignCdr=(change:(xml:string)=>string)=>receipt(signer.sign(change(cdrUnsigned),Buffer.from(pki.cdr.p12,'base64'),pki.password,'ApplicationResponse').xml);
 return {snapshot,unsigned,signed,cdrUnsigned,input,row,db,core,trust,cdrTrust,pins,pin,owner,xml,receipt,resign,resignCdr};
}
const body=(f:ReturnType<typeof fixture>)=>({schemaVersion:CARRIER_REQUEST_VERSION,requestId:randomUUID(),environment:'BETA',asOf:NOW,input:{ownerSnapshot:f.input.ownerSnapshot,ownerSnapshotSha256:f.input.ownerSnapshotSha256,
 projection:f.input.projection,projectionSha256:f.input.projectionSha256,signedXmlBase64:f.input.signedXml.toString('base64'),signedXmlSha256:f.input.signedXmlSha256,cdrXmlBase64:f.input.cdrXml.toString('base64'),cdrSha256:f.input.cdrSha256}});
async function server(f:ReturnType<typeof fixture>){
 const app=await NestFactory.create(CarrierReferenceValidationModule.isolated(f.core,{billing:[fingerprint(tls.resource)]},()=>NOW),{logger:false,bodyParser:false,
  httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
 app.useBodyParser('json',{limit:carrierReferenceLimits.request,strict:true});await app.listen(0,'127.0.0.1');cleanup.push(()=>app.close());const port=app.getHttpServer().address().port;
 const client=(change:any={})=>new HttpCarrierReferenceSignatureCdrValidator({enabled:true,origin:'https://127.0.0.1:'+port,sunatPeerSha256:fingerprint(tls.server),tls:{ca:tls.ca,cert:tls.resource,key:tls.key},now:()=>NOW,...change});
 const send=(value:any=body(f),peer:'resource'|'edge'|'other'|null='resource',path=CARRIER_VALIDATION_PATH,headers:Record<string,string>={})=>{
  const b=Buffer.from(JSON.stringify(value));return new Promise<{status:number;body:any;headers:any}>((resolve,reject)=>{
   const req=request({hostname:'127.0.0.1',port,path,method:'POST',ca:tls.ca,...(peer?{cert:tls[peer],key:tls.key}:{}),rejectUnauthorized:true,headers:{'Content-Type':'application/json','Content-Length':String(b.length),...headers}},res=>{
    const chunks:Buffer[]=[];res.on('data',x=>chunks.push(x));res.on('end',()=>resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers}));});req.on('error',reject);req.end(b);
  });
 };
 return {app,port,client,send};
}

describe('carrier reference09: actual full XMLDSig + pinned PKI/CRL + signed CDR, no official claims',()=>{
 it('returns parsed acceptance after genuine OpenSSL chain/CRL and complete document checks, not a Boolean',async()=>{
  const f=fixture(),audit=vi.spyOn(f.trust,'evaluate');const acceptance=await f.core.verify(f.input);
  expect(acceptance).toEqual({environment:'BETA',documentId:f.snapshot.documentId,issuerRuc:f.snapshot.issuer.ruc,fullNumber:'TQ31-9',snapshotSha256:f.input.projectionSha256,cdrSha256:f.input.cdrSha256,responseCode:'0',status:'ACCEPTED',acceptedAt:'2026-10-23T15:31:00.000Z'});
  expect(audit).toHaveBeenCalledTimes(2);expect(f.db.fiscalDocument.findFirst).toHaveBeenCalledTimes(2);expect(f.pins.current).toHaveBeenCalledTimes(2);
  for(const result of audit.mock.results){const proof=await result.value;expect(proof.chainValid).toBe(true);expect(proof.revocation).toBe('VERIFIED_OFFLINE_CRL');expect(proof.blockers).toEqual([]);}
 });
 it.each([
  ['recipient identity',(s:string)=>s.replace('20000000036','20000000028')],
  ['recipient name',(s:string)=>s.replace('CLIENTE FICTICIO','OTRO CLIENTE')],
  ['carrier identity',(s:string)=>s.replace('20000000028','20000000036')],
  ['carrier name',(s:string)=>s.replace('TRANSPORTISTA FICTICIO','OTRO TRANSPORTISTA')],
  ['registration',(s:string)=>s.replace('MTC-OWNER-09','MTC-OTHER-09')],
  ['origin',(s:string)=>s.replace('ORIGEN FICTICIO','OTRO ORIGEN')],
  ['destination',(s:string)=>s.replace('DESTINO FICTICIO','OTRO DESTINO')],
  ['ubigeo',(s:string)=>s.replace('150102','150103')],
  ['description',(s:string)=>s.replace('BIEN &amp; &lt;UNO&gt;','OTRO BIEN')],
  ['quantity',(s:string)=>s.replace('2.0000000001','2.0000000002')],
  ['weight unit',(s:string)=>s.replace('unitCode="KGM"','unitCode="TNE"')],
  ['emission',(s:string)=>s.replace('<cbc:IssueTime>07:00:00','<cbc:IssueTime>07:00:01')],
  ['transfer',(s:string)=>s.replace('2026-10-24','2026-10-25')],
  ['mode',(s:string)=>s.replace('>01</cbc:TransportModeCode>','>02</cbc:TransportModeCode>')],
  ['number',(s:string)=>s.replaceAll('TQ31-9','TQ31-10')],
 ] as const)('rejects a valid signature over changed %s with the same totals and updated hashes',async(_,change)=>{
  const f=fixture();expect(change(f.unsigned)).not.toBe(f.unsigned);f.resign(change);await expect(f.core.verify(f.input)).rejects.toThrow('CARRIER_REFERENCE_VALIDATION_UNAVAILABLE');
 });
 it.each(['companyId','branchId','operationId','documentId'] as const)('anchors non-XML owner metadata %s to the actual stored full record',async key=>{
  const f=fixture();(f.input.ownerSnapshot as any)[key]=key==='companyId'?78:randomUUID();f.input.ownerSnapshotSha256=hash(f.input.ownerSnapshot);
  f.input.projection=projectPublicGuide09OwnerSnapshot(f.input.ownerSnapshot);f.input.projectionSha256=hash(f.input.projection);
  await expect(f.core.verify(f.input)).rejects.toThrow();
 });
 it('rejects digest mismatch, non-second issuance and a partial/private profile without relaxing its grammar',async()=>{
  const f=fixture();f.row.digestValue=Buffer.alloc(32,1).toString('base64');await expect(f.core.verify(f.input)).rejects.toThrow();
  const g=fixture();g.input.ownerSnapshot.body.issueDate='2026-10-23T12:00:00.001Z';g.input.ownerSnapshotSha256=hash(g.input.ownerSnapshot);g.input.projection=projectPublicGuide09OwnerSnapshot(g.input.ownerSnapshot);g.input.projectionSha256=hash(g.input.projection);await expect(g.core.verify(g.input)).rejects.toThrow();
  const h=fixture();(h.input.ownerSnapshot as any).schemaVersion='factuez.numbered-guide-snapshot.v1';await expect(h.core.verify(h.input)).rejects.toThrow();
 });
 it.each(['revokedIssuer','revokedCdr','expiredCrl'])('rejects actual signed offline CRL failure: %s',async kind=>{
  const f=fixture(),name={revokedIssuer:'revoked-issuer.crl.pem',revokedCdr:'revoked-cdr.crl.pem',expiredCrl:'expired.crl.pem'}[kind];
  vi.stubEnv('SUNAT_CRL_BUNDLE_FILE',join(root,name!));vi.stubEnv('SUNAT_CRL_BUNDLE_SHA256',sha(pki[kind]));await expect(f.core.verify(f.input)).rejects.toThrow();
 });
 it('fails closed on unavailable OpenSSL and missing owner signer pins',async()=>{
  const f=fixture();vi.stubEnv('SUNAT_OPENSSL_PATH',join(root,'nonexistent-openssl.exe'));await expect(f.core.verify(f.input)).rejects.toThrow();
  const g=fixture();g.pins.current.mockRejectedValueOnce(Error('NO_ACTIVE_PUBLIC_PIN'));await expect(g.core.verify(g.input)).rejects.toThrow();
 });
 it.each([
  ['signature',(s:string)=>s.replace('FICTITIOUS LOCAL RECEIPT','ALTERED RECEIPT'),false],
  ['receiver',(s:string)=>s.replace('20000000001','20000000028'),true],
  ['document type',(s:string)=>s.replace('>09</cbc:DocumentTypeCode>','>31</cbc:DocumentTypeCode>'),true],
  ['reference',(s:string)=>s.replaceAll('TQ31-9','TQ31-8'),true],
  ['rejection',(s:string)=>s.replace('>0</cbc:ResponseCode>','>99</cbc:ResponseCode>'),true],
  ['future',(s:string)=>s.replaceAll('2026-10-23','2034-10-23'),true],
 ] as const)('rejects CDR %s even after local SHA metadata is updated',async(_,change,resign)=>{
  const f=fixture();if(resign)f.resignCdr(change);else f.receipt(Buffer.from(f.input.cdrXml).toString().replace('FICTITIOUS LOCAL RECEIPT','ALTERED RECEIPT'));
  await expect(f.core.verify(f.input)).rejects.toThrow();
 });
 it('does not accept synthetic local success labels, absent original CDR_XML or unknown/pending owner state',async()=>{
  for(const status of ['QUEUED','SUBMITTED','UNKNOWN']){const f=fixture();f.row.status=status;await expect(f.core.verify(f.input)).rejects.toThrow();}
  const f=fixture();f.row.artifacts[1].kind='CDR_ZIP';await expect(f.core.verify(f.input)).rejects.toThrow();
 });
});

describe('private SUNAT module and optional Billing client over real HTTPS/mTLS',()=>{
 it('validates from Billing with a fixed endpoint and binds response to every request field/hash',async()=>{
  const f=fixture(),s=await server(f),result=await s.client().verify(f.input);expect(result.snapshotSha256).toBe(f.input.projectionSha256);expect(result.cdrSha256).toBe(f.input.cdrSha256);
  const http=await s.send();expect(http.status).toBe(200);expect(http.headers['cache-control']).toBe('private, no-store');
  expect(JSON.stringify(http.body)).not.toMatch(/PRIVATE KEY|password|certificatePem|storageKey|openssl|verified":true|approved/);
 });
 it('refuses unpinned roles and missing client certificate before owner row lookup',async()=>{
  const f=fixture(),s=await server(f);expect((await s.send(body(f),'edge')).status).toBe(403);expect((await s.send(body(f),'other')).status).toBe(403);
  await expect(s.send(body(f),null)).rejects.toThrow();expect(f.db.fiscalDocument.findFirst).not.toHaveBeenCalled();
 });
 it.each(['extra','url','production','stale','base64','oversize','bearer','query'])('rejects invalid private request %s before validation',async kind=>{
  const f=fixture(),s=await server(f),request:any=body(f);let path=CARRIER_VALIDATION_PATH,headers:any={};
  if(kind==='extra')request.accepted=true;if(kind==='url')request.source='https://external.invalid/cert.pem';if(kind==='production')request.environment='PRODUCTION';
  if(kind==='stale')request.asOf='2020-01-01T00:00:00.000Z';if(kind==='base64')request.input.cdrXmlBase64='!!!!';if(kind==='oversize')request.input.signedXmlBase64='a'.repeat(Math.ceil(carrierReferenceLimits.artifact/3)*4+4);
  if(kind==='bearer')headers.Authorization='Bearer never-use-public-claims';if(kind==='query')path+='?approved=true';
  expect((await s.send(request,'resource',path,headers)).status).toBe(400);expect(f.db.fiscalDocument.findFirst).not.toHaveBeenCalled();
 });
 it('client is disabled by default and refuses a valid-CA server whose pinned identity differs',async()=>{
  const f=fixture(),s=await server(f);await expect(s.client({enabled:undefined}).verify(f.input)).rejects.toThrow('HTTP_VALIDATION_UNAVAILABLE');
  await expect(s.client({sunatPeerSha256:fingerprint(tls.edge)}).verify(f.input)).rejects.toThrow('HTTP_VALIDATION_UNAVAILABLE');expect(f.db.fiscalDocument.findFirst).not.toHaveBeenCalled();
 });
});


describe('carrier reference: independent late checks, policy failure and response fencing',()=>{
 it('rechecks the full authoritative owner after crypto rather than trusting a cached receipt',async()=>{
  const f=fixture(),original=f.db.fiscalDocument.findFirst.getMockImplementation()!;
  f.db.fiscalDocument.findFirst.mockImplementation(async()=>{const row=await original();if(f.db.fiscalDocument.findFirst.mock.calls.length>1)row.updatedAt=new Date('2026-10-24T16:00:00Z');return row;});
  await expect(f.core.verify(f.input)).rejects.toThrow();expect(f.db.fiscalDocument.findFirst).toHaveBeenCalledTimes(2);
 });
 it('rejects an owner input changed across awaits even if a returned acceptance would match the original bytes',async()=>{
  const f=fixture(),original=f.db.fiscalDocument.findFirst.getMockImplementation()!;
  f.db.fiscalDocument.findFirst.mockImplementation(async()=>{const row=await original();if(f.db.fiscalDocument.findFirst.mock.calls.length===2)f.input.cdrXml[1]^=1;return row;});
  await expect(f.core.verify(f.input)).rejects.toThrow();
 });
 it('revokes the active signer slot during verification instead of returning an old pinned result',async()=>{
  const f=fixture();f.pins.current.mockImplementation(async()=>{if(f.pins.current.mock.calls.length>1)throw Error('REVOKED_OWNER_SLOT');return {...f.pin};});
  await expect(f.core.verify(f.input)).rejects.toThrow();
 });
 it('observes a genuine CDR signer revocation introduced after the issuer trust check',async()=>{
  const f=fixture(),evaluate=f.trust.evaluate.bind(f.trust);let calls=0;
  vi.spyOn(f.trust,'evaluate').mockImplementation(async(...args)=>{const proof=await evaluate(...args);if(++calls===1){vi.stubEnv('SUNAT_CRL_BUNDLE_FILE',join(root,'revoked-cdr.crl.pem'));vi.stubEnv('SUNAT_CRL_BUNDLE_SHA256',sha(pki.revokedCdr));}return proof;});
  await expect(f.core.verify(f.input)).rejects.toThrow();expect(calls).toBe(2);
 });
 it('rejects stale public root fingerprint metadata before treating a valid chain as approved',async()=>{
  const f=fixture();vi.stubEnv('SUNAT_TRUST_STORE_SHA256','f'.repeat(64));await expect(f.core.verify(f.input)).rejects.toThrow();
 });
 it('keeps parsed observations from a genuinely signed accepted CDR',async()=>{
  const f=fixture();f.resignCdr(s=>s.replace('<cbc:IssueDate>','<cbc:Note>OBSERVACION FICTICIA</cbc:Note><cbc:IssueDate>'));
  expect((await f.core.verify(f.input)).status).toBe('ACCEPTED_WITH_OBSERVATIONS');
 });
 it('the optional schema port cannot substitute a Boolean for byte-bound XSD evidence',async()=>{
  const f=fixture();const core=new CarrierReferenceValidation({owner:f.owner,pins:f.pins,certificates:{load:async()=>({certificatePem:pki.issuer.pem,chainPems:[pki.root]})},trust:f.trust,cdr:f.cdrTrust,
   xsd:{validate:async()=>({approved:true}) as any},now:()=>NOW});
  await expect(core.verify(f.input)).rejects.toThrow();
 });
 it('client rejects altered nonce, full request hash, acceptance binding, environment, freshness and approval flags from a valid TLS server',async()=>{
  const f=fixture(),acceptance=await f.core.verify(f.input);let change:(v:any)=>void=()=>{};
  const endpoint=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
   const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));const wire=JSON.parse(Buffer.concat(chunks).toString()),response:any=carrierReferenceResponse(wire,acceptance,NOW);
   change(response);res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(response));
  });
  await new Promise<void>(r=>endpoint.listen(0,'127.0.0.1',r));cleanup.push(()=>new Promise<void>((r,j)=>endpoint.close(e=>e?j(e):r())));
  const client=new HttpCarrierReferenceSignatureCdrValidator({enabled:true,origin:'https://127.0.0.1:'+(endpoint.address() as any).port,sunatPeerSha256:fingerprint(tls.server),tls:{ca:tls.ca,cert:tls.resource,key:tls.key},now:()=>NOW});
  for(const mutate of [(v:any)=>{v.requestId=randomUUID();},(v:any)=>{v.requestSha256='f'.repeat(64);},(v:any)=>{v.acceptance={...v.acceptance,snapshotSha256:'f'.repeat(64)};},
   (v:any)=>{v.environment='PRODUCTION';},(v:any)=>{v.verifiedAt='2020-01-01T00:00:00.000Z';},(v:any)=>{v.acceptance={...v.acceptance,approved:true};}]){
   change=mutate;await expect(client.verify(f.input)).rejects.toThrow('CARRIER_REFERENCE_HTTP_VALIDATION_UNAVAILABLE');
  }
 });
 it('sanitizes backend failures without leaking SQL, paths, public pins or credential diagnostics',async()=>{
  const f=fixture(),s=await server(f);f.db.fiscalDocument.findFirst.mockRejectedValue(Error('PRIVATE_SQL PASSWORD=DO_NOT_LEAK C:/vault/private.p12'));
  const denied=await s.send();expect(denied.status).toBe(503);expect(JSON.stringify(denied.body)).not.toMatch(/PRIVATE_SQL|PASSWORD|vault|\.p12/);
  await expect(s.client().verify(f.input)).rejects.toThrow(/^CARRIER_REFERENCE_HTTP_VALIDATION_UNAVAILABLE$/);
 });
});
