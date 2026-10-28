import 'reflect-metadata';
import {afterAll,afterEach,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {createHash,randomUUID,X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer,type Server} from 'node:https';
import {B2bRuntimeFiles} from '../packages/service-access/src/b2b-runtime-files';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {bootstrapStandaloneSunatHost} from '../services/sunat-service/src/b2b/host-standalone';
import {loadSunatStandaloneMount} from '../services/sunat-service/src/b2b/host-config';
import {SunatHostCrypto} from '../services/sunat-service/src/b2b/host-crypto';
import {SunatHostKeys} from '../services/sunat-service/src/b2b/host-keys';
import {SecretVault} from '../services/sunat-service/src/infrastructure/crypto/secret-vault';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
const sha=(v:Buffer|string)=>createHash('sha256').update(v).digest('hex'),ruc='20000000001';
const PKI=`
import json,base64,datetime
from cryptography import x509
from cryptography.x509.oid import NameOID,ObjectIdentifier
from cryptography.hazmat.primitives import hashes,serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
start=datetime.datetime(2020,1,1);end=datetime.datetime(2035,1,1)
k=rsa.generate_private_key(public_exponent=65537,key_size=2048);n=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'SYNTHETIC STANDALONE TEST ROOT')])
def usage(ca):return x509.KeyUsage(digital_signature=not ca,content_commitment=False,key_encipherment=False,data_encipherment=False,key_agreement=False,key_cert_sign=ca,crl_sign=ca,encipher_only=False,decipher_only=False)
root=x509.CertificateBuilder().subject_name(n).issuer_name(n).public_key(k.public_key()).serial_number(1).not_valid_before(start).not_valid_after(end).add_extension(x509.BasicConstraints(ca=True,path_length=1),True).add_extension(usage(True),True).add_extension(x509.SubjectKeyIdentifier.from_public_key(k.public_key()),False).sign(k,hashes.SHA256())
def leaf(serial,ruc):
 key=rsa.generate_private_key(public_exponent=65537,key_size=2048);s=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'SYNTHETIC STANDALONE LEAF'),x509.NameAttribute(ObjectIdentifier('2.5.4.97'),'NTRPE-'+ruc)])
 c=x509.CertificateBuilder().subject_name(s).issuer_name(n).public_key(key.public_key()).serial_number(serial).not_valid_before(start).not_valid_after(end).add_extension(x509.BasicConstraints(ca=False,path_length=None),True).add_extension(usage(False),True).add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(k.public_key()),False).sign(k,hashes.SHA256())
 return {'pem':c.public_bytes(serialization.Encoding.PEM).decode(),'p12':base64.b64encode(pkcs12.serialize_key_and_certificates(b'synthetic',key,c,[root],serialization.BestAvailableEncryption(b'SYNTHETIC-PASSWORD'))).decode()}
crl=x509.CertificateRevocationListBuilder().issuer_name(n).last_update(start).next_update(end).add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(k.public_key()),False).sign(k,hashes.SHA256())
print(json.dumps({'root':root.public_bytes(serialization.Encoding.PEM).decode(),'issuer':leaf(2,'20000000001'),'cdr':leaf(3,'20000000010'),'crl':crl.public_bytes(serialization.Encoding.PEM).decode()}))
`;
let pki:any,tls:ReturnType<typeof b2bCertificates>,identity:Server,identityPort:number,authorityReady=true;const roots:string[]=[],cleanups:(()=>Promise<unknown>)[]=[];
const modules={trust:resolve('services/sunat-service/dist/infrastructure/crypto/certificate-trust.service.js'),cdr:resolve('services/sunat-service/dist/infrastructure/crypto/cdr-signature-trust.service.js'),inspector:resolve('services/sunat-service/dist/infrastructure/crypto/certificate-inspector.js')};
beforeAll(async()=>{
 for(const path of Object.values(modules))if(!existsSync(path))throw Error('BUILD_SUNAT_BEFORE_STANDALONE_TEST');
 pki=JSON.parse(execFileSync('python',['-c',PKI],{encoding:'utf8',timeout:30000,maxBuffer:131072,windowsHide:true}));tls=b2bCertificates();
 identity=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  for await(const _ of req){}res.setHeader('Content-Type','application/json');
  const actual=(req.socket as any).getPeerCertificate().fingerprint256.replace(/:/g,'').toLowerCase();
  if(!authorityReady||actual!==fingerprint(tls.other)||req.url!=='/internal/b2b/owner-authority/status'){res.statusCode=403;res.end('{}');return;}
  res.end(JSON.stringify({schemaVersion:'factuez.b2b.owner-authority.v1',environment:'BETA',owner:'fiscal',state:'ASSEMBLED'}));
 });await new Promise<void>(r=>identity.listen(0,'127.0.0.1',r));identityPort=(identity.address() as any).port;
},60000);
afterEach(async()=>{for(const f of cleanups.splice(0))await f();authorityReady=true;vi.restoreAllMocks();
 for(const root of roots.splice(0)){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('factuez-sunat-host-'))throw Error('TEST_ROOT_NOT_OWNED');rmSync(root,{recursive:true,force:true});}
});
afterAll(async()=>{await new Promise<void>(r=>identity.close(()=>r()));});
function mount(){
 const root=mkdtempSync(join(tmpdir(),'factuez-sunat-host-'));chmodSync(root,0o700);roots.push(root);const artifacts=join(root,'artifacts');mkdirSync(artifacts,{mode:0o700});
 const write=(name:string,value:any)=>writeFileSync(join(root,name),Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
 const refs=(prefix:string,cert:Buffer)=>{write(prefix+'-ca.pem',tls.ca);write(prefix+'-cert.pem',cert);write(prefix+'-key.pem',tls.key);return {ca:prefix+'-ca.pem',cert:prefix+'-cert.pem',key:prefix+'-key.pem'};};
 write('roots.pem',pki.root);write('crl.pem',pki.crl);write('issuer.pem',pki.issuer.pem+pki.root);write('cdr.pem',pki.cdr.pem+pki.root);
 const pkcs12=Buffer.from(pki.issuer.p12,'base64');write('issuer.bin',pkcs12);write('password.bin','SYNTHETIC-PASSWORD');write('master.bin',Buffer.alloc(32,7));write('database.bin','SYNTHETIC-DATABASE-PASSWORD');write('database-ca.pem',tls.ca);
 write('carrier-pins.json',{schemaVersion:'factuez.b2b.carrier-reference-pins.v1',environment:'BETA',entries:[]});
 const runtime={schemaVersion:'factuez.b2b.sunat-mounted-runtime.v1',config:{enabled:true,environment:'BETA',deploymentId:randomUUID(),instanceId:randomUUID(),api:{host:'127.0.0.1',port:0},control:{host:'127.0.0.1',port:0},
  peers:{resource:[fingerprint(tls.resource)],billing:[fingerprint(tls.other)],operator:[fingerprint(tls.edge)]}},origins:{identity:'https://127.0.0.1:'+identityPort,billing:'https://127.0.0.1:1'},
  files:{apiTls:refs('api',tls.server),controlTls:refs('control',tls.server),identityTls:refs('identity',tls.resource),billingTls:refs('billing',tls.resource)},allowedRucs:{guide:[ruc],batch:[ruc]},
  issuerPublicPins:[{issuerRuc:ruc,fingerprint:new X509Certificate(pki.issuer.pem).fingerprint256.replace(/:/g,'').toLowerCase(),path:join(root,'issuer.pem'),sha256:sha(pki.issuer.pem+pki.root)}]};
 const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'/usr/bin/openssl';if(!existsSync(openssl))throw Error('REAL_OPENSSL_REQUIRED');
 const host={schemaVersion:'factuez.b2b.sunat-standalone-host.v1',environment:'BETA',profile:'SYNTHETIC',postgres:{host:'synthetic-db.invalid',port:5432,user:'sunat_owner',name:'sunat_synthetic_unit_beta',passwordFile:'database.bin'},
  artifactsRoot:artifacts,vaultKeyFile:'master.bin',carrierPinsFile:'carrier-pins.json',authorityTls:refs('authority',tls.other),pki:{roots:{file:'roots.pem',sha256:sha(pki.root)},crl:{file:'crl.pem',sha256:sha(pki.crl)},cdrSigner:{file:'cdr.pem',sha256:sha(pki.cdr.pem+pki.root)},opensslPath:openssl},
  keys:['LOCAL_GUIDE_ARTIFACT','LOCAL_SYNTHETIC_BATCH'].map(purpose=>({issuerRuc:ruc,purpose,pkcs12File:'issuer.bin',passwordFile:'password.bin',certificateFile:'issuer.pem',pkcs12Sha256:sha(pkcs12),certificateSha256:sha(pki.issuer.pem+pki.root)}))};
 write('sunat-runtime.json',runtime);write('sunat-host.json',host);return {root,write,runtime,host};
}
function database(){
 const db:any={$connect:vi.fn(async()=>{}),$disconnect:vi.fn(async()=>{}),$queryRawUnsafe:vi.fn(async(sql:string)=>{if(!sql.startsWith('SELECT ')||!sql.endsWith('WHERE false'))throw Error('UNEXPECTED_SYNTHETIC_SQL');return [];}),$executeRawUnsafe:vi.fn(async()=>{throw Error('WRITES_FORBIDDEN');})};
 db.$transaction=vi.fn(async(work:any)=>work(db));for(const key of ['fiscalDocument','fiscalBatch','documentArtifact','batchArtifact','cdrLog'])db[key]={findFirst:vi.fn(async()=>null)};
 db.onModuleInit=()=>db.$connect();db.onModuleDestroy=()=>db.$disconnect();return db;
}
describe('SUNAT standalone host with actual offline crypto workers and synthetic mounts',()=>{
 it('does no file, database or network work without explicit enable',async()=>{expect(await bootstrapStandaloneSunatHost({enabled:false,configRoot:'MUST_NOT_READ'})).toBeNull();});
 it('starts the actual isolated DI and all five owner capabilities without legacy producers, signing, sending or DDL',async()=>{
  const m=mount(),db=database(),factory=vi.fn(()=>db),runtime=(await bootstrapStandaloneSunatHost({enabled:true,configRoot:m.root},{prismaFactory:factory,cryptoModules:modules,signals:false}))!;cleanups.push(()=>runtime.close());
  expect(runtime.statusMetadata.capabilities).toHaveLength(5);expect(db.$connect).toHaveBeenCalledOnce();expect(db.$executeRawUnsafe).not.toHaveBeenCalled();
  const port=runtime.application.getHttpServer().address().port,http=new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls.resource,key:tls.key});
  expect(await http.post('/internal/b2b/runtime-status',{})).toMatchObject({owner:'fiscal',state:'ASSEMBLED_AND_STORAGE_CHECKED',fiscalActivation:false});
  await runtime.close();expect(db.$disconnect).toHaveBeenCalledOnce();expect(runtime.maintenance.snapshot()).toMatchObject({state:'PARKED',storageClosed:true});
 });
 it('inspects only fictitious PKCS12 keys in a real bounded worker and erases acquired buffers on release',async()=>{
  const m=mount(),files=new B2bRuntimeFiles(m.root),h=loadSunatStandaloneMount(files,m.root),crypto=new SunatHostCrypto(h.pki,modules);cleanups.push(()=>crypto.close());
  await crypto.assertInfrastructure();const keys=new SunatHostKeys(files,h.keys,crypto.inspector);cleanups.push(()=>keys.close());
  const key=await keys.acquire(ruc,'LOCAL_SYNTHETIC_BATCH');expect(key.p12.length).toBeGreaterThan(1000);await key.dispose();expect(key.p12.every(v=>v===0)).toBe(true);
  await expect(keys.acquire('20615878481','LOCAL_SYNTHETIC_BATCH')).rejects.toThrow('SYNTHETIC_KEY');
 });
 it('rejects a reused administrative certificate, production and real RUC configuration before Prisma construction',async()=>{
  for(const defect of ['certificate','environment','ruc']){
   const m=mount(),factory=vi.fn(()=>database());if(defect==='certificate')m.host.authorityTls=m.runtime.files.identityTls;if(defect==='environment')(m.host as any).environment='PRODUCTION';if(defect==='ruc')m.host.keys[0].issuerRuc='20615878481';m.write('sunat-host.json',m.host);
   await expect(bootstrapStandaloneSunatHost({enabled:true,configRoot:m.root},{prismaFactory:factory,signals:false})).rejects.toThrow('MOUNT_INVALID');expect(factory).not.toHaveBeenCalled();
  }
 });
 it('fails before Prisma if current Identity owner authority is unavailable',async()=>{
  const m=mount(),factory=vi.fn(()=>database());authorityReady=false;
  await expect(bootstrapStandaloneSunatHost({enabled:true,configRoot:m.root},{prismaFactory:factory,cryptoModules:modules,signals:false})).rejects.toThrow('IDENTITY_OWNER_AUTHORITY_REQUIRED');expect(factory).not.toHaveBeenCalled();
 });
 it('destroys an explicitly provided vault key copy without reopening the legacy environment',()=>{
  const master=Buffer.alloc(32,9),vault=new SecretVault(master),context={ruc,environment:'BETA',field:'SYNTHETIC'};master.fill(0);
  const sealed=vault.seal('SYNTHETIC',context);expect(vault.open(sealed,context).toString()).toBe('SYNTHETIC');vault.onModuleDestroy();expect(()=>vault.open(sealed,context)).toThrow('CLOSED');
 });
});
