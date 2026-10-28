import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { DEFAULT_PRINT_BRANDING, type AccessTokenClaims } from '../packages/contracts/src';
import { B2bSecurityError, type B2bPrincipal } from '../packages/contracts/src/b2b-security';
import { Phase8AdminCapabilities, Phase8AdminOperation, adminDigest, phase8AdminPolicy,
  type Phase8AdminDependencies } from '../packages/service-access/src/b2b-phase8-admin-wire';
import { B2bPhase8BillingAdmin, BillingPhase8AdminBindingOwner } from '../services/billing-service/src/b2b/phase8-admin';
import { B2bPhase8IdentityAdmin } from '../services/identity-service/src/b2b/phase8-admin';
import { B2bPhase8FiscalAdmin } from '../services/sunat-service/src/b2b/phase8-admin';
import { B2bPhase8SmtpAdmin } from '../services/mailer-worker/src/b2b/phase8-admin';
import { StationAdminService } from '../services/billing-service/src/application/station-admin.service';
import { PrintBrandingService } from '../services/billing-service/src/application/print-branding.service';
import { UserAdministrationService } from '../services/identity-service/src/application/user-administration.service';
import { PasswordService } from '../services/identity-service/src/application/password.service';
import { FiscalConfigurationService } from '../services/sunat-service/src/application/fiscal-configuration.service';
import { SecretVault } from '../services/sunat-service/src/infrastructure/crypto/secret-vault';
import { inspectCertificate } from '../services/sunat-service/src/infrastructure/crypto/certificate-inspector';
import { SmtpConfigurationService } from '../services/mailer-worker/src/smtp-configuration.service';
import { SmtpConfigurationVault } from '../services/mailer-worker/src/smtp-configuration.crypto';
import { PreparedCorporateSmtp } from '../services/mailer-worker/src/smtp-configuration.transport';

const uid='10000000-0000-4000-8000-000000000001',branch='20000000-0000-4000-8000-000000000001';
const point='30000000-0000-4000-8000-000000000001',counter='40000000-0000-4000-8000-000000000001';
const binding={issuerId:1,issuerRuc:'00000000001',environment:'BETA' as const,branchId:branch,pointId:point,seriesId:counter,documentType:'01' as const};
const access={token:'synthetic.delegated.admin',kind:'USER' as const};
const request=(payload:Record<string,unknown>={},id?:string)=>({binding,payload,...(id===undefined?{}:{id})});
beforeEach(()=>{ vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('NETWORK_FORBIDDEN');})); });
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();vi.restoreAllMocks();});
function authorityFixture(enabled=true) {
  const claims:AccessTokenClaims={sub:uid,username:'synthetic-human',roles:['ADMIN'],
    permissions:['setup.manage','series.manage','user.manage','role.manage','sunat.configure','document.email'],
    scope:{kind:'GLOBAL'},authVersion:4,iss:'synthetic-identity',aud:'synthetic-owner',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600};
  const principal:B2bPrincipal={kind:'USER',clientId:'50000000-0000-4000-8000-000000000001',revision:1,
    subjectId:uid,userAuthRevision:4,scopes:[...new Set(Object.values(phase8AdminPolicy).map(v=>v[0]))],bindings:[binding],environment:'BETA'};
  const identity={authenticate:vi.fn(async()=>structuredClone(principal))};
  const authority={authorize:vi.fn(async()=>({claims:structuredClone(claims),policyRevision:'policy-1',stepUpVerified:true as const,expiresAt:Date.now()+60000}))};
  const liveIdentity={current:vi.fn(async()=>structuredClone(claims))};
  const bindingOwner={revalidate:vi.fn(async()=>({binding:structuredClone(binding),revision:'current-owner-1'}))};
  const deps:Phase8AdminDependencies={identity,authority,liveIdentity,bindingOwner,enabled};
  return {claims,principal,identity,authority,liveIdentity,bindingOwner,deps};
}

describe('phase8 owner admin authority and ephemeral exact capabilities',()=>{
  it('constructs all owners without I/O and is disabled by default',async()=>{
    const f=authorityFixture();delete f.deps.enabled;
    for(const owner of [new B2bPhase8BillingAdmin(f.deps),new B2bPhase8IdentityAdmin(f.deps),
      new B2bPhase8FiscalAdmin(f.deps),new B2bPhase8SmtpAdmin(f.deps)]) expect(owner).toBeDefined();
    await expect(new B2bPhase8BillingAdmin(f.deps).execute(access,'MASTERS_READ',request())).rejects.toMatchObject({code:'ADMIN_OWNER_DISABLED'});
    expect(f.identity.authenticate).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['authority','liveIdentity','bindingOwner'] as const)('fails closed without %s',async key=>{
    const f=authorityFixture();delete f.deps[key];
    await expect(Phase8AdminOperation.open(f.deps,access,'MASTERS_READ',request())).rejects.toMatchObject({code:'ADMIN_AUTHORITY_UNAVAILABLE'});
  });
  it('never admits SERVICE, forged body authority, arbitrary actions or production',async()=>{
    const f=authorityFixture();
    await expect(Phase8AdminOperation.open(f.deps,{...access,kind:'SERVICE'},'MASTERS_READ',request())).rejects.toThrow();
    await expect(Phase8AdminOperation.open(f.deps,access,'RESET' as never,request())).rejects.toThrow();
    await expect(Phase8AdminOperation.open(f.deps,access,'MASTERS_READ',{...request(),claims:f.claims})).rejects.toThrow();
    await expect(Phase8AdminOperation.open(f.deps,access,'MASTERS_READ',{...request(),binding:{...binding,environment:'PRODUCTION'}})).rejects.toThrow();
    expect(f.authority.authorize).not.toHaveBeenCalled();
  });
  it.each(['subject','revision','global','role','permission','expired','stepup','policy'] as const)('rejects invalid human %s',async defect=>{
    const f=authorityFixture();
    if(defect==='subject')f.claims.sub=branch;
    if(defect==='revision')f.claims.authVersion++;
    if(defect==='global')f.claims.scope={kind:'ASSIGNED',branchIds:[branch],emissionPointIds:[point],series:[counter]};
    if(defect==='role')f.claims.roles=['CASHIER'];
    if(defect==='permission')f.claims.permissions=[];
    if(defect==='expired')f.claims.exp=0;
    if(defect==='stepup')f.authority.authorize.mockResolvedValue({claims:f.claims,policyRevision:'p',stepUpVerified:false as never,expiresAt:Date.now()+1000});
    if(defect==='policy')f.authority.authorize.mockResolvedValue({claims:f.claims,policyRevision:'',stepUpVerified:true,expiresAt:Date.now()+1000});
    await expect(Phase8AdminOperation.open(f.deps,access,'MASTERS_READ',request())).rejects.toThrow();
  });
  it('matches live Identity and rejects policy/binding/token revisions during an operation',async()=>{
    for(const change of ['live','binding','principal','policy']) {
      const f=authorityFixture(),op=await Phase8AdminOperation.open(f.deps,access,'FISCAL_READ',request());
      if(change==='live')f.liveIdentity.current.mockResolvedValue({...f.claims,authVersion:5});
      if(change==='binding')f.bindingOwner.revalidate.mockResolvedValue({binding:{...binding,issuerRuc:'00000000002'},revision:'changed'});
      if(change==='principal')f.principal.revision++;
      if(change==='policy')f.authority.authorize.mockResolvedValue({claims:f.claims,policyRevision:'p2',stepUpVerified:true,expiresAt:Date.now()+1000});
      await expect(op.revalidate()).rejects.toThrow();op.close();
    }
  });
  it('binds a capability to the exact action, company, payload, object and lifetime',async()=>{
    const f=authorityFixture(),p={expectedRevision:0,sol:{username:'synthetic',password:'SECRET'}};
    const op=await Phase8AdminOperation.open(f.deps,access,'FISCAL_SAVE',request(p)),caps=new Phase8AdminCapabilities(),handle=caps.open(op);
    const q={action:'FISCAL_SAVE' as const,companyId:'1',environment:'BETA',payload:p};
    await expect(caps.resolve(handle,q)).resolves.toMatchObject({actorId:uid,issuer:{ruc:binding.issuerRuc}});
    for(const changed of [{...q,companyId:'2'},{...q,environment:'PRODUCTION'},{...q,action:'FISCAL_READ' as const},{...q,payload:{...p,expectedRevision:1}}])
      await expect(caps.resolve(handle,changed)).rejects.toThrow();
    await expect(caps.resolve({},q)).rejects.toThrow();
    op.close();await expect(caps.resolve(handle,q)).rejects.toThrow();
    caps.revoke(handle);await expect(caps.resolve(handle,q)).rejects.toThrow();
    expect(f.authority.authorize.mock.calls[0][0]).toMatchObject({action:'FISCAL_SAVE',payloadDigest:adminDigest(p)});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('expires capabilities and takes an immutable input snapshot without running accessors',async()=>{
    const f=authorityFixture(),p={expectedRevision:0,sol:{username:'synthetic',password:'ORIGINAL'}};
    const op=await Phase8AdminOperation.open(f.deps,access,'FISCAL_SAVE',request(p));
    p.sol.password='CHANGED';expect(op.input.payload.sol).toMatchObject({password:'ORIGINAL'});
    const getter=vi.fn();const invalid=Object.defineProperty({},'binding',{enumerable:true,get:getter});
    await expect(Phase8AdminOperation.open(f.deps,access,'MASTERS_READ',invalid)).rejects.toThrow();expect(getter).not.toHaveBeenCalled();
    vi.spyOn(Date,'now').mockReturnValue(Date.now()+31000);
    await expect(op.revalidate()).rejects.toMatchObject({code:'ADMIN_CAPABILITY_EXPIRED'});op.close();
  });
});

function stationFixture(){
  const state:any={companySettings:[{id:1,ruc:binding.issuerRuc,legalName:'SYNTHETIC',taxAddress:'LOCAL',ubigeo:'200101',
    environment:'BETA',active:true,configVersion:1,contactEmails:[]}],
    branch:[{id:branch,companyId:1,code:'BR',name:'SYNTHETIC BRANCH',active:true,masterRevision:1}],
    emissionPoint:[{id:point,companyId:1,branchId:branch,code:'POINT',name:'SYNTHETIC POINT',active:true,masterRevision:1}],
    seriesCounter:[{id:counter,companyId:1,emissionPointId:point,documentType:'INVOICE',series:'F001',nextNumber:2n,active:true,masterRevision:1}],
    configurationAudit:[]};
  const tx:any={$queryRawUnsafe:vi.fn(async()=>[])};
  const matches=(row:any,where:any={})=>Object.entries(where).every(([k,v]:any)=>v&&typeof v==='object'&&'in' in v?v.in.includes(row[k]):row[k]===v);
  const output=(row:any,args:any)=>!row?null:args.select?Object.fromEntries(Object.keys(args.select).map(k=>[k,row[k]])):
    {...structuredClone(row),...(args.include?{_count:{emissionPoints:1,shifts:0,documents:1}}:{})};
  for(const table of Object.keys(state))tx[table]={
    findUnique:vi.fn(async(a:any)=>output(state[table].find((v:any)=>matches(v,a.where)),a)),
    findUniqueOrThrow:vi.fn(async(a:any)=>{const r=state[table].find((v:any)=>matches(v,a.where));if(!r)throw Error('NOT_FOUND');return output(r,a);}),
    findMany:vi.fn(async(a:any)=>state[table].filter((v:any)=>matches(v,a.where)).map((v:any)=>output(v,a))),
    create:vi.fn(async(a:any)=>{const r={id:table==='companySettings'?2:'60000000-0000-4000-8000-000000000001',configVersion:1,masterRevision:1,active:true,...(table==='seriesCounter'?{nextNumber:1n}:{}),...a.data};state[table].push(r);if(table==='emissionPoint'&&a.data.counters?.create){return {...output(r,a),counters:a.data.counters.create.map((v:any)=>({id:'70000000-0000-4000-8000-000000000001',nextNumber:1n,masterRevision:1,...v}))};}return output(r,a);}),
    update:vi.fn(async(a:any)=>{const r=state[table].find((v:any)=>matches(v,a.where));for(const[k,v]of Object.entries(a.data)as any)r[k]=v&&typeof v==='object'&&'increment'in v?r[k]+v.increment:v;return output(r,a);}),
    count:vi.fn(async()=>0)
  };
  tx.shift={count:vi.fn(async()=>0)};tx.document={count:vi.fn(async()=>1)};
  const prisma:any={...tx,$transaction:vi.fn(async(work:any)=>{
    const saved=structuredClone(state);try{return await work(tx);}catch(e){for(const k of Object.keys(state))state[k]=saved[k];throw e;}
  })};
  const f=authorityFixture();f.deps.bindingOwner=new BillingPhase8AdminBindingOwner(prisma);
  const owner=new StationAdminService(prisma),bridge=new B2bPhase8BillingAdmin(f.deps,{masters:owner});
  return {...f,state,tx,prisma,owner,bridge};
}
describe('phase8 Billing owner administration uses StationAdminService',()=>{
  beforeEach(()=>vi.stubEnv('STATION_MASTER_CRUD_ENABLED','true'));
  it('keeps the actual master env guard',async()=>{
    vi.stubEnv('STATION_MASTER_CRUD_ENABLED','false');const f=stationFixture();
    await expect(f.bridge.execute(access,'MASTERS_READ',request())).rejects.toThrow();
    expect(f.tx.configurationAudit.create).not.toHaveBeenCalled();
  });
  it('revalidates actual Billing ownership and returns only the bound catalogue',async()=>{
    const f=stationFixture();f.state.companySettings.push({...f.state.companySettings[0],id:2,ruc:'00000000002'});
    const r:any=await f.bridge.execute(access,'MASTERS_READ',request());
    expect(r.data.companies.map((v:any)=>v.id)).toEqual([1]);expect(r.data.series[0].nextNumber).toBe('2');
    f.state.emissionPoint[0].companyId=2;
    await expect(f.bridge.execute(access,'MASTERS_READ',request())).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  });
  it('updates through the real transaction/revision/audit and never edits RUC or counters',async()=>{
    const f=stationFixture();
    const r:any=await f.bridge.execute(access,'ISSUER_UPDATE',request({expectedRevision:1,legalName:'CHANGED'},'1'));
    expect(r.data).toMatchObject({legalName:'CHANGED',revision:2});
    expect(f.state.configurationAudit[0]).toMatchObject({actorId:uid,action:'issuer.updated'});
    await expect(f.bridge.execute(access,'ISSUER_UPDATE',request({expectedRevision:1,legalName:'STALE'},'1'))).rejects.toMatchObject({status:409});
    for(const [a,p,id]of [
      ['ISSUER_UPDATE',{expectedRevision:2,ruc:'00000000002'},'1'],
      ['BRANCH_UPDATE',{expectedRevision:1,companyId:2},branch],
      ['SERIES_UPDATE',{expectedRevision:1,nextNumber:1},counter],
      ['SERIES_UPDATE',{expectedRevision:1,series:'F999'},counter],
    ]as const)await expect(f.bridge.execute(access,a,request(p,id))).rejects.toThrow();
    expect(f.state.companySettings[0].ruc).toBe(binding.issuerRuc);expect(f.state.seriesCounter[0].nextNumber).toBe(2n);
  });
  it('restricts ids, parents and caller-controlled operation envelopes',async()=>{
    const f=stationFixture();
    await expect(f.bridge.execute(access,'BRANCH_CREATE',request({companyId:2,code:'XX',name:'OTHER'}))).rejects.toThrow();
    await expect(f.bridge.execute(access,'POINT_UPDATE',request({expectedRevision:1,name:'OTHER'},branch))).rejects.toThrow();
    await expect(f.bridge.execute(access,'OWNER_TRANSFER' as never,request())).rejects.toThrow();
    expect(f.state.configurationAudit).toEqual([]);
  });
  it('creates issuers and branches with the exact real owner audit actor',async()=>{
    const f=stationFixture();
    const r:any=await f.bridge.execute(access,'ISSUER_CREATE',request({ruc:'00000000002',legalName:'SYNTHETIC TWO',taxAddress:'LOCAL TWO',ubigeo:'200101'}));
    expect(r.data).toMatchObject({ruc:'00000000002',environment:'BETA'});
    await f.bridge.execute(access,'BRANCH_CREATE',request({companyId:1,code:'NEW',name:'SYNTHETIC BRANCH'}));
    expect(f.state.configurationAudit.map((v:any)=>v.actorId)).toEqual([uid,uid]);
  });
});

describe('phase8 real branding owner',()=>{
  it('uses the actual write/read/preview core and preserves storage metadata privately',async()=>{
    const f=stationFixture(),root=await mkdtemp(join(tmpdir(),'factuez-owner-admin-print-'));
    vi.stubEnv('PRINT_SETTINGS_ENABLED','true');vi.stubEnv('PRINT_BRANDING_ROOT',root);
    f.prisma.branch.findFirst=vi.fn(async()=>({id:branch,companyId:1,name:'SYNTHETIC BRANCH'}));
    const branding=new PrintBrandingService(f.prisma);await branding.onModuleInit();
    const bridge=new B2bPhase8BillingAdmin(f.deps,{branding});
    const saved:any=await bridge.execute(access,'PRINT_SAVE',request({expectedRevision:0,settings:{...DEFAULT_PRINT_BRANDING,footerNote:'SYNTHETIC NOTE'}}));
    expect(saved.data).toMatchObject({revision:1,effective:{footerNote:'SYNTHETIC NOTE'}});
    expect(JSON.stringify(saved)).not.toMatch(/actorId|storageKey|logoPreviewDataUrl/);
    const read:any=await bridge.execute(access,'PRINT_READ',request());expect(read.data.revision).toBe(1);
    const preview:any=await bridge.execute(access,'PRINT_PREVIEW',request({documentTypeCode:'01',format:'a4'}));
    expect(Buffer.from(preview.data.base64,'base64').subarray(0,4).toString()).toBe('%PDF');
    const profiles=await readdir(join(root,'profiles'));
    expect(JSON.parse(await readFile(join(root,'profiles',profiles[0]),'utf8')).actorId).toBe(uid);
    await expect(bridge.execute(access,'PRINT_SAVE',request({expectedRevision:1,settings:{...DEFAULT_PRINT_BRANDING,certificateFile:'PRIVATE'}}))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

async function fiscalFixture(){
  const f=authorityFixture(),dir=await mkdtemp(join(tmpdir(),'factuez-owner-admin-fiscal-')),key=join(dir,'synthetic.key');
  await writeFile(key,randomBytes(32).toString('hex'),{mode:0o600});vi.stubEnv('APP_MASTER_KEY_FILE',key);
  let row:any=null;const audit:any[]=[];
  const tx:any={$executeRaw:vi.fn(),sunatCredentials:{
    findUnique:vi.fn(async()=>row),
    upsert:vi.fn(async(a:any)=>{row={...row,...(!row?a.create:a.update),revision:!row?1:row.revision+1,updatedAt:new Date()};return row;})
  },fiscalConfigurationAudit:{create:vi.fn(async(a:any)=>{audit.push(a.data);return a.data;}),count:vi.fn(async()=>audit.length),
    findMany:vi.fn(async()=>audit.map((v,i)=>({...v,id:String(i),occurredAt:new Date()})))}};
  const prisma:any={...tx,$transaction:vi.fn(async(work:any)=>{
    if(Array.isArray(work))return Promise.all(work);
    const old=structuredClone(row),before=audit.length;try{return await work(tx);}catch(e){row=old;audit.splice(before);throw e;}
  })};
  const vault=new SecretVault(),caps=new Phase8AdminCapabilities();
  const inspect=vi.fn(async(bytes:Buffer,password:string)=>inspectCertificate(bytes,password));
  const owner=FiscalConfigurationService.createWithOwnerContext(prisma,vault,{inspect}as never,caps);
  const bridge=new B2bPhase8FiscalAdmin(f.deps,owner,caps);
  return {...f,tx,prisma,vault,caps,owner,bridge,inspect,audit,row:()=>row};
}
describe('phase8 fiscal owner same save core',()=>{
  it('encrypts SOL/GRE with real vault, audits real actor and returns metadata only',async()=>{
    const f=await fiscalFixture(),payload={expectedRevision:0,sol:{username:'SYNTHETIC_SOL',password:'FISCAL_SECRET'},gre:{clientId:'SYNTHETIC_GRE',clientSecret:'GRE_SECRET'}};
    const r:any=await f.bridge.execute(access,'FISCAL_SAVE',request(payload));
    expect(r.data).toMatchObject({revision:1,solConfigured:true,greConfigured:true,fiscalTransmission:false});
    expect(JSON.stringify(r)).not.toMatch(/SECRET|SYNTHETIC_SOL|Cipher|StorageKey|clientId|clientSecret|password/);
    const bytes=f.vault.open(f.row().solPasswordCipher,{ruc:binding.issuerRuc,environment:'BETA',field:'solPassword'});
    expect(bytes.toString()).toBe('FISCAL_SECRET');bytes.fill(0);
    expect(f.audit[0]).toMatchObject({actorId:uid,fields:['sol','gre'],revision:1});
    const read:any=await f.bridge.execute(access,'FISCAL_READ',request());expect(read.data.solConfigured).toBe(true);
    const audit:any=await f.bridge.execute(access,'FISCAL_AUDIT',request({page:'1'}));expect(audit.data.items[0].actorId).toBe(uid);
    await expect(f.bridge.execute(access,'FISCAL_SAVE',request(payload))).rejects.toMatchObject({status:409});
    expect(f.row().revision).toBe(1);expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks after preparation and inside the transaction, rolling back on revocation',async()=>{
    const f=await fiscalFixture(),seal=f.vault.seal.bind(f.vault);
    vi.spyOn(f.vault,'seal').mockImplementation((v,c)=>{const r=seal(v,c);f.claims.authVersion++;return r;});
    await expect(f.bridge.execute(access,'FISCAL_SAVE',request({expectedRevision:0,sol:{username:'SYNTHETIC',password:'SECRET'}}))).rejects.toThrow();
    expect(f.tx.sunatCredentials.upsert).not.toHaveBeenCalled();
    const g=await fiscalFixture();
    g.tx.fiscalConfigurationAudit.create.mockImplementation(async(a:any)=>{g.audit.push(a.data);g.claims.authVersion++;return a.data;});
    await expect(g.bridge.execute(access,'FISCAL_SAVE',request({expectedRevision:0,sol:{username:'SYNTHETIC',password:'SECRET'}}))).rejects.toThrow();
    expect(g.row()).toBeNull();expect(g.audit).toEqual([]);
  });
  it('uses the real certificate inspector with a generated synthetic PKCS12; zeroes bytes',async()=>{
    const f=await fiscalFixture(),req=createRequire(new URL('../services/sunat-service/package.json',import.meta.url)),forge=req('node-forge');
    const keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
    const priv=forge.pki.privateKeyFromPem(keys.privateKey),pub=forge.pki.publicKeyFromPem(keys.publicKey),cert=forge.pki.createCertificate();
    cert.publicKey=pub;cert.serialNumber='01';cert.validity.notBefore=new Date(Date.now()-60000);cert.validity.notAfter=new Date(Date.now()+86400000);
    cert.setSubject([{name:'commonName',value:'SYNTHETIC ONLY'}]);cert.setIssuer(cert.subject.attributes);
    cert.setExtensions([{name:'keyUsage',digitalSignature:true}]);cert.sign(priv,forge.md.sha256.create());
    const base64=Buffer.from(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(priv,cert,'SYNTHETIC_P12',{algorithm:'aes256'})).getBytes(),'binary').toString('base64');
    const r:any=await f.bridge.execute(access,'FISCAL_SAVE',request({expectedRevision:0,certificate:{fileName:'synthetic.p12',base64,password:'SYNTHETIC_P12'}}));
    expect(r.data.certificate).toMatchObject({configured:true,selfSigned:true,trustAndRucVerified:false});
    expect(f.inspect).toHaveBeenCalledOnce();expect(f.inspect.mock.calls[0][0].every((v:number)=>v===0)).toBe(true);
    expect(JSON.stringify(r)).not.toContain(base64);expect(JSON.stringify(r)).not.toContain('SYNTHETIC_P12');
  });
  it('rejects resets, official activation, foreign handles and bearer fallback in scoped owner',async()=>{
    const f=await fiscalFixture();
    for(const payload of [{expectedRevision:0,remove:['sol']},{expectedRevision:0,fiscalTransmission:true},
      {expectedRevision:0,sol:{username:'SYNTHETIC',password:'SECRET'},activateOfficial:true}])
      await expect(f.bridge.execute(access,'FISCAL_SAVE',request(payload))).rejects.toThrow();
    await expect(f.owner.status('1','BETA',{})).rejects.toThrow();
    await expect(f.owner.status('1','BETA','Bearer synthetic.delegated.admin')).rejects.toThrow();
    expect(f.tx.sunatCredentials.upsert).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});

async function smtpFixture(){
  const f=authorityFixture(),dir=await mkdtemp(join(tmpdir(),'factuez-owner-admin-smtp-')),key=join(dir,'synthetic.key');
  await writeFile(key,randomBytes(32).toString('hex'),{mode:0o600});vi.stubEnv('SMTP_SETTINGS_KEY_FILE',key);
  vi.stubEnv('SMTP_SETTINGS_KEY_VERSION','1');vi.stubEnv('SMTP_APPROVED_HOSTS','smtp.synthetic.example');
  let row:any=null;const audits:any[]=[];
  const store:any={ready:vi.fn(async()=>true),read:vi.fn(async()=>row),
    save:vi.fn(async(issuer:any,sealed:any,revision:number,actorId:string,replaced:boolean)=>{
      if((row?.revision??0)!==revision)throw new B2bSecurityError(409,'ADMIN_CONFLICT');
      row={...issuer,configurationCipher:sealed.cipher,keyVersion:sealed.keyVersion,revision:revision+1,updatedAt:new Date()};
      audits.push({actorId,replaced,revision:revision+1});return row;
    })};
  const vault=new SmtpConfigurationVault(),caps=new Phase8AdminCapabilities(),transport=new PreparedCorporateSmtp();
  const owner=SmtpConfigurationService.createWithOwnerContext(store,vault,transport,caps);
  return {...f,store,vault,caps,owner,transport,audits,row:()=>row,bridge:new B2bPhase8SmtpAdmin(f.deps,owner,caps)};
}
const smtpPayload={expectedRevision:0,settings:{host:'smtp.synthetic.example',port:587,tlsMode:'STARTTLS',fromName:'SYNTHETIC',fromAddress:'synthetic@example.invalid',replyTo:null},
  credentials:{username:'SMTP_SYNTHETIC_USER',password:'SMTP_SYNTHETIC_SECRET'}};
describe('phase8 SMTP actual service/vault/local transport',()=>{
  it('saves encrypted configuration and audits actor; metadata excludes settings/keys/credentials',async()=>{
    const f=await smtpFixture();
    const r:any=await f.bridge.execute(access,'SMTP_SAVE',request(smtpPayload));
    expect(r.data).toMatchObject({revision:1,configured:true,credentialsConfigured:true,networkAttempted:false,readyToSend:false});
    expect(JSON.stringify(r)).not.toMatch(/SMTP_SYNTHETIC|configurationCipher|keyVersion|settings|smtp.synthetic.example/);
    const b=f.vault.open(f.row().configurationCipher,{companyId:1,ruc:binding.issuerRuc,field:'configuration'});
    expect(JSON.parse(b.toString()).password).toBe('SMTP_SYNTHETIC_SECRET');b.fill(0);
    expect(f.audits[0]).toMatchObject({actorId:uid,replaced:true});
    const read:any=await f.bridge.execute(access,'SMTP_READ',request());expect(read.data.revision).toBe(1);
    await expect(f.bridge.execute(access,'SMTP_SAVE',request(smtpPayload))).rejects.toMatchObject({status:409});
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rechecks identity before persisting after encryption and preserves SMTP permission guards',async()=>{
    const f=await smtpFixture(),seal=f.vault.seal.bind(f.vault);
    vi.spyOn(f.vault,'seal').mockImplementation((v,c)=>{const r=seal(v,c);f.claims.authVersion++;return r;});
    await expect(f.bridge.execute(access,'SMTP_SAVE',request(smtpPayload))).rejects.toThrow();expect(f.store.save).not.toHaveBeenCalled();
    const g=await smtpFixture();g.claims.permissions=g.claims.permissions.filter(p=>p!=='document.email');
    await expect(g.bridge.execute(access,'SMTP_READ',request())).rejects.toThrow();expect(g.store.read).not.toHaveBeenCalled();
  });
  it('rejects string fallback, foreign handles, connection overrides and owner absence',async()=>{
    const f=await smtpFixture();
    await expect(f.owner.status('1','Bearer synthetic.delegated.admin')).rejects.toThrow();
    await expect(f.owner.status('1',{})).rejects.toThrow();
    await expect(f.bridge.execute(access,'SMTP_SAVE',request({...smtpPayload,verify:true}))).rejects.toThrow();
    await expect(new B2bPhase8SmtpAdmin(f.deps).execute(access,'SMTP_READ',request())).rejects.toMatchObject({code:'ADMIN_OWNER_UNAVAILABLE'});
    expect(f.store.save).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
});

describe('phase8 Identity actual user administration owner',()=>{
  function identityFixture(){
    const f=authorityFixture(),target='60000000-0000-4000-8000-000000000001';
    const user={id:target,username:'synthetic-user',fullName:'SYNTHETIC',active:true,lastLoginAt:null,
      passwordHash:'NEVER_RETURN_HASH',roles:[{role:{code:'CASHIER',name:'Cashier'}}],branches:[],emissionPoints:[],series:[]};
    let permissionNames=['document.view'];const audit:any[]=[];
    const tx:any={$queryRawUnsafe:vi.fn(),user:{findMany:vi.fn(async()=>[user]),updateMany:vi.fn()},
      role:{findMany:vi.fn(async()=>[{id:target,code:'CASHIER',name:'Cashier',description:null,secretHash:'NEVER_RETURN',
        permissions:permissionNames.map(name=>({permission:{name}}))}]),
        findUnique:vi.fn(async()=>({id:target,active:true,permissions:permissionNames.map(name=>({permission:{name}})),users:[{userId:target}]}))},
      permission:{findMany:vi.fn(async(a:any)=>a.where.name.in.map((name:string)=>({id:name,name})))},
      rolePermission:{deleteMany:vi.fn(),createMany:vi.fn(async(a:any)=>{permissionNames=a.data.map((v:any)=>v.permissionId);})},
      refreshSession:{updateMany:vi.fn()},auditLog:{create:vi.fn(async(a:any)=>audit.push(a.data))}};
    const prisma:any={...tx,$transaction:vi.fn(async(work:any)=>work(tx))};
    const owner=new UserAdministrationService(prisma,new PasswordService());
    return {...f,tx,audit,bridge:new B2bPhase8IdentityAdmin(f.deps,owner)};
  }
  it('lists through the real owner and never returns owner hashes',async()=>{
    const f=identityFixture(),users:any=await f.bridge.execute(access,'USERS_LIST',request()),roles:any=await f.bridge.execute(access,'ROLES_LIST',request());
    expect(users.data[0].username).toBe('synthetic-user');expect(roles.data[0].code).toBe('CASHIER');
    expect(JSON.stringify([users,roles])).not.toMatch(/NEVER_RETURN|passwordHash|secretHash/);expect(fetch).not.toHaveBeenCalled();
  });
  it('updates roles through actual revision check, revocation and audit; protects ADMIN',async()=>{
    const f=identityFixture();
    const r:any=await f.bridge.execute(access,'ROLES_UPDATE',request({expectedPermissions:['document.view'],permissions:['document.view','document.issue']},'CASHIER'));
    expect(r.data.affectedUsers).toBe(1);expect(f.tx.refreshSession.updateMany).toHaveBeenCalled();
    expect(f.audit[0]).toMatchObject({userId:uid,action:'role.permissions.updated'});
    await expect(f.bridge.execute(access,'ROLES_UPDATE',request({expectedPermissions:[],permissions:[]},'ADMIN'))).rejects.toThrow();
    await expect(f.bridge.execute(access,'ROLES_UPDATE',request({expectedPermissions:[],permissions:[]},'CASHIER'))).rejects.toMatchObject({status:409});
  });
  it('does not pretend user writes are operational without safe owner resource resolver',async()=>{
    const f=identityFixture();
    for(const action of ['USERS_CREATE','USERS_UPDATE']as const)
      await expect(f.bridge.execute(access,action,request({password:'NEVER_RETURN'}))).rejects.toMatchObject({code:'ADMIN_USER_RESOURCE_RESOLVER_REQUIRED'});
    expect(fetch).not.toHaveBeenCalled();
  });
});


describe('phase8 delegated Users CREATE/UPDATE with actual owner resources',()=>{
  function fixture(){
    const f=authorityFixture(),target='60000000-0000-4000-8000-000000000001',roleId='70000000-0000-4000-8000-000000000001';
    let users:any[]=[{id:target,username:'existing-synthetic',fullName:'EXISTING SYNTHETIC',active:true,lastLoginAt:null,authVersion:0,passwordHash:'EXISTING_NOT_RETURNED',
      roles:[{role:{id:roleId,code:'CASHIER',name:'Cashier'}}],branches:[{branchId:branch}],emissionPoints:[{emissionPointId:point}],series:[{series:counter}]}];
    const audits:any[]=[],role={id:roleId,code:'CASHIER',name:'Cashier',active:true};
    const build=(data:any,old:any={})=>({...old,id:old.id??'80000000-0000-4000-8000-000000000001',username:data.username??old.username,
      fullName:data.fullName??old.fullName,passwordHash:data.passwordHash??old.passwordHash,active:data.active??old.active??true,lastLoginAt:null,
      authVersion:old.authVersion===undefined?0:old.authVersion+(data.authVersion?.increment??0),
      roles:data.roles.create.map((v:any)=>({role})),branches:data.branches.create.map((v:any)=>({branchId:v.branchId})),
      emissionPoints:data.emissionPoints.create.map((v:any)=>({emissionPointId:v.emissionPointId})),series:data.series.create.map((v:any)=>({series:v.series}))});
    const tx:any={$queryRawUnsafe:vi.fn(async()=>[]),role:{findMany:vi.fn(async(a:any)=>a.where.code.in.includes('CASHIER')?[role]:[])},
      user:{findMany:vi.fn(async()=>structuredClone(users)),
        findUnique:vi.fn(async(a:any)=>structuredClone(users.find(u=>u.id===a.where.id)??null)),
        create:vi.fn(async(a:any)=>{const row=build(a.data);users.push(row);return structuredClone(row);}),
        update:vi.fn(async(a:any)=>{const i=users.findIndex(v=>v.id===a.where.id);users[i]=build(a.data,users[i]);return structuredClone(users[i]);})},
      auditLog:{create:vi.fn(async(a:any)=>{audits.push(a.data);return a.data;})},
      userRoleAssignment:{deleteMany:vi.fn()},userBranch:{deleteMany:vi.fn()},userEmissionPoint:{deleteMany:vi.fn()},
      userSeries:{deleteMany:vi.fn()},refreshSession:{updateMany:vi.fn()}};
    const prisma:any={...tx,$transaction:vi.fn(async(work:any)=>{const old=structuredClone(users),n=audits.length;
      try{return await work(tx);}catch(e){users=old;audits.splice(n);throw e;}})};
    const passwords=new PasswordService(),caps=new Phase8AdminCapabilities();
    const owner=UserAdministrationService.createWithOwnerResources(prisma,passwords,caps);
    return {...f,target,tx,prisma,passwords,caps,owner,audits,users:()=>users,bridge:new B2bPhase8IdentityAdmin(f.deps,owner,caps)};
  }
  const createPayload=()=>({username:'created-synthetic',fullName:'CREATED SYNTHETIC',password:'Synthetic_password_Only_123!',
    roles:['CASHIER' as const],branchIds:[branch],emissionPointIds:[point],series:[counter]});
  it('creates through actual canDelegate/password hash/transaction/audit without catalogue fabrication',async()=>{
    const f=fixture(),payload=createPayload(),revoke=vi.spyOn(f.caps,'revoke');
    const r:any=await f.bridge.execute(access,'USERS_CREATE',request(payload));
    expect(r.data).toMatchObject({username:payload.username,branchIds:[branch],emissionPointIds:[point],series:[counter]});
    expect(JSON.stringify(r)).not.toMatch(/password|passwordHash|Synthetic_password|assignedByUserId/);
    const created=f.users().find(v=>v.username===payload.username)!;
    expect(created.passwordHash).toMatch(/^scrypt\$/);expect(await f.passwords.verify(payload.password,created.passwordHash)).toBe(true);
    expect(f.audits[0]).toMatchObject({userId:uid,action:'user.created'});
    expect(f.tx.user.create.mock.calls[0][0].data.roles.create[0].assignedByUserId).toBe(uid);
    expect(revoke).toHaveBeenCalledOnce();
    await expect(f.caps.validateUserResources(revoke.mock.calls[0][0],{action:'USERS_CREATE',payload,actor:f.claims,selection:payload})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('updates actual access, increments authVersion, revokes sessions and audits before/after',async()=>{
    const f=fixture(),r:any=await f.bridge.execute(access,'USERS_UPDATE',request({active:false},f.target));
    expect(r.data.active).toBe(false);expect(f.users()[0].authVersion).toBe(1);
    expect(f.tx.refreshSession.updateMany).toHaveBeenCalledWith(expect.objectContaining({where:{userId:f.target,revokedAt:null}}));
    expect(f.audits[0]).toMatchObject({userId:uid,action:'user.access.updated',metadata:{before:{active:true},after:{active:false}}});
    expect(JSON.stringify(r)).not.toMatch(/passwordHash|EXISTING_NOT_RETURNED/);expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['branchIds','emissionPointIds','series']as const)('rejects %s outside the exact live binding before hash/write',async key=>{
    const f=fixture(),payload=createPayload(),hash=vi.spyOn(f.passwords,'hash');
    payload[key]=['90000000-0000-4000-8000-000000000001'];
    await expect(f.bridge.execute(access,'USERS_CREATE',request(payload))).rejects.toMatchObject({code:'ADMIN_USER_RESOURCES_OUTSIDE_BINDING'});
    expect(hash).not.toHaveBeenCalled();expect(f.tx.user.create).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('cannot move a target resource outside binding, reset passwords, or modify its own access',async()=>{
    const f=fixture();
    for(const payload of [{branchIds:['90000000-0000-4000-8000-000000000001']},{series:['F001']},{password:'RESET_FORBIDDEN'},{ownerId:uid}])
      await expect(f.bridge.execute(access,'USERS_UPDATE',request(payload,f.target))).rejects.toThrow();
    await expect(f.bridge.execute(access,'USERS_UPDATE',request({active:false},uid))).rejects.toThrow();
    await expect(f.bridge.execute(access,'USERS_CREATE',request({...createPayload(),resetPassword:true}))).rejects.toThrow();
    expect(f.tx.user.update).not.toHaveBeenCalled();expect(f.tx.user.create).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('revalidates after actual password hashing and prevents a revoked human from writing',async()=>{
    const f=fixture(),hash=f.passwords.hash.bind(f.passwords);
    vi.spyOn(f.passwords,'hash').mockImplementation(async p=>{const result=await hash(p);f.claims.authVersion++;return result;});
    await expect(f.bridge.execute(access,'USERS_CREATE',request(createPayload()))).rejects.toThrow();
    expect(f.tx.user.create).not.toHaveBeenCalled();expect(f.audits).toEqual([]);
  });
  it('revalidates after access audit inside the same transaction and rolls back revocation races',async()=>{
    const f=fixture();
    f.tx.auditLog.create.mockImplementation(async(a:any)=>{f.audits.push(a.data);f.claims.permissions=[];return a.data;});
    await expect(f.bridge.execute(access,'USERS_UPDATE',request({active:false},f.target))).rejects.toThrow();
    expect(f.users()[0]).toMatchObject({active:true,authVersion:0});expect(f.audits).toEqual([]);
  });
  it('does not use string fallback or a missing/different resource resolver',async()=>{
    const f=fixture();
    await expect(f.owner.create(createPayload(),f.claims,'Bearer synthetic.delegated.admin')).rejects.toThrow();
    await expect(f.owner.updateAccess(f.target,{active:false},f.claims,'Bearer synthetic.delegated.admin')).rejects.toThrow();
    const defaultOwner=new UserAdministrationService(f.prisma,f.passwords);
    await expect(new B2bPhase8IdentityAdmin(f.deps,defaultOwner,f.caps).execute(access,'USERS_CREATE',request(createPayload()))).rejects.toThrow();
    const different=UserAdministrationService.createWithOwnerResources(f.prisma,f.passwords,new Phase8AdminCapabilities());
    await expect(new B2bPhase8IdentityAdmin(f.deps,different,f.caps).execute(access,'USERS_UPDATE',request({active:false},f.target))).rejects.toThrow();
    expect(f.tx.user.create).not.toHaveBeenCalled();expect(f.tx.user.update).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('binds resource proof to the exact original payload, operation, target and current actor',async()=>{
    const f=fixture(),payload=createPayload(),op=await Phase8AdminOperation.open(f.deps,access,'USERS_CREATE',request(payload)),handle=f.caps.open(op);
    const q={action:'USERS_CREATE' as const,payload,actor:f.claims,selection:payload};
    await expect(f.caps.validateUserResources(handle,q)).resolves.toBeUndefined();
    for(const changed of [{...q,payload:{...payload,username:'DIFFERENT'}},{...q,actor:{...f.claims,permissions:[]}},
      {...q,id:f.target},{...q,action:'USERS_UPDATE' as const}])
      await expect(f.caps.validateUserResources(handle,changed)).rejects.toThrow();
    f.bindingOwner.revalidate.mockResolvedValue({binding,revision:'ownership-changed'});
    await expect(f.caps.validateUserResources(handle,q)).rejects.toThrow();op.close();f.caps.revoke(handle);
  });
});


describe('phase8 remaining master actions and response/authority boundaries',()=>{
  beforeEach(()=>vi.stubEnv('STATION_MASTER_CRUD_ENABLED','true'));
  it('executes real branch, point and series actions with exact target and original revisions',async()=>{
    const f=stationFixture();
    const branchResult:any=await f.bridge.execute(access,'BRANCH_UPDATE',request({expectedRevision:1,name:'RENAMED SYNTHETIC'},branch));
    expect(branchResult.data).toMatchObject({id:branch,revision:2,name:'RENAMED SYNTHETIC'});
    const pointResult:any=await f.bridge.execute(access,'POINT_UPDATE',request({expectedRevision:1,name:'RENAMED POINT'},point));
    expect(pointResult.data).toMatchObject({id:point,revision:2});
    const created:any=await f.bridge.execute(access,'POINT_CREATE',request({code:'NEW_POINT',name:'SYNTHETIC NEW POINT',invoiceSeries:'F900',receiptSeries:'B900'},branch));
    expect(created.data.series).toHaveLength(2);
    const series:any=await f.bridge.execute(access,'SERIES_CREATE',request({documentType:'INVOICE',series:'F901'},point));
    expect(series.data).toMatchObject({series:'F901',nextNumber:'1'});
    const disabled:any=await f.bridge.execute(access,'SERIES_UPDATE',request({expectedRevision:1,active:false},counter));
    expect(disabled.data).toMatchObject({id:counter,active:false,revision:2,nextNumber:'2'});
    expect(f.state.configurationAudit).toHaveLength(5);expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves real owner permissions for point updates',async()=>{
    const f=stationFixture();f.claims.permissions=f.claims.permissions.filter(v=>v!=='series.manage');
    await expect(f.bridge.execute(access,'POINT_UPDATE',request({expectedRevision:1,name:'FORBIDDEN'},point))).rejects.toThrow();
    expect(f.tx.emissionPoint.update).not.toHaveBeenCalled();
  });
  it('denies missing owners and redacts underlying exception detail per action boundary',async()=>{
    const f=stationFixture();
    await expect(new B2bPhase8BillingAdmin(f.deps).execute(access,'MASTERS_READ',request())).rejects.toMatchObject({code:'ADMIN_OWNER_UNAVAILABLE'});
    vi.spyOn(f.owner,'catalog').mockRejectedValue(new Error('PRIVATE_CIPHER_AND_KEY_FILE_DO_NOT_RETURN'));
    await expect(f.bridge.execute(access,'MASTERS_READ',request())).rejects.toMatchObject({code:'ADMIN_OWNER_REJECTED',message:'ADMIN_OWNER_REJECTED'});
    const g=await smtpFixture();
    vi.spyOn(g.vault,'seal').mockImplementation(()=>{throw Error('PRIVATE_SMTP_PASSWORD_DO_NOT_RETURN');});
    await expect(g.bridge.execute(access,'SMTP_SAVE',request(smtpPayload))).rejects.toMatchObject({code:'ADMIN_OWNER_REJECTED',message:'ADMIN_OWNER_REJECTED'});
  });
  it('rechecks owner enablement and invalidates capabilities revoked during resolution',async()=>{
    const f=authorityFixture(),op=await Phase8AdminOperation.open(f.deps,access,'FISCAL_READ',request());
    f.deps.enabled=false;await expect(op.revalidate()).rejects.toMatchObject({code:'ADMIN_OWNER_DISABLED'});op.close();
    const g=authorityFixture(),other=await Phase8AdminOperation.open(g.deps,access,'FISCAL_READ',request()),caps=new Phase8AdminCapabilities(),handle=caps.open(other);
    g.authority.authorize.mockImplementation(async()=>{caps.revoke(handle);return {claims:g.claims,policyRevision:'policy-1',stepUpVerified:true,expiresAt:Date.now()+60000};});
    await expect(caps.resolve(handle,{action:'FISCAL_READ',companyId:'1',environment:'BETA',payload:{}})).rejects.toMatchObject({code:'INVALID_ADMIN_CAPABILITY'});
    other.close();
  });
});

