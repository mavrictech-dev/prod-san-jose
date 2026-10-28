import 'reflect-metadata';
import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:https';
import type {AddressInfo} from 'node:net';
import {inspect} from 'node:util';
import {readFileSync} from 'node:fs';
import {B2bPrivateHttp} from '@factuez/service-access/dist/b2b';
import {HttpB2bOwnerBinding} from '@factuez/service-access/dist/b2b-owner-administration';
import {Phase8AdminCapabilities,Phase8AdminOperation,type Phase8AdminDependencies} from '@factuez/service-access/dist/b2b-phase8-admin-wire';
import type {B2bPrincipal} from '@factuez/contracts/b2b-security';
import type {AccessTokenClaims} from '@factuez/contracts';
import {createMailerSmtpOwnerResource} from '../services/mailer-worker/src/b2b/host-smtp';
import {MailerHostSmtpVault} from '../services/mailer-worker/src/b2b/host-smtp.crypto';
import {MailerHostSmtpStore,mailerHostSmtpSchemaVersion} from '../services/mailer-worker/src/b2b/host-smtp.store';
import {B2bPhase8SmtpAdmin} from '../services/mailer-worker/src/b2b/phase8-admin';
import {openMailerSmtpOwnerCapability} from '../services/mailer-worker/src/b2b/host-smtp.context';
import type {MailerSmtpOwnerResource} from '../services/mailer-worker/src/b2b/runtime';
import type {EmailDeliveryPgPool} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import type {StoredSmtpConfiguration} from '../services/mailer-worker/src/smtp-configuration.store';
import {b2bCertificates} from './b2b-tls.fixture';
const binding={issuerId:1,issuerRuc:'20000000001',environment:'BETA' as const,branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01' as const};
const issuer={companyId:1,ruc:binding.issuerRuc};
const settings={host:'smtp.example.com',port:587,tlsMode:'STARTTLS',fromName:'Synthetic',fromAddress:'synthetic@example.com',replyTo:null};
const credentials={username:'synthetic-private-user',password:'synthetic-private-password'};
const input=()=>({expectedRevision:0,settings:{...settings},credentials:{...credentials}});
const database={name:'factuez_mailer_beta',user:'mailer_owner'};
let tls:ReturnType<typeof b2bCertificates>;
const servers:Server[]=[],resources:MailerSmtpOwnerResource[]=[];
beforeAll(()=>{tls=b2bCertificates();},30000);
afterEach(async()=>{for(const r of resources.splice(0))await r.close();for(const s of servers.splice(0))await new Promise<void>(r=>s.close(()=>r()));vi.unstubAllEnvs();vi.restoreAllMocks();});
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
/** SQL protocol fixture, not PostgreSQL. Unknown SQL is rejected; transactions commit isolated copies. */
function pg(){
 let disk={configuration:null as StoredSmtpConfiguration|null,audit:[] as unknown[][]};
 let tail=Promise.resolve();
 const state={database:database.name,role:database.user,ssl:true,version:'TLSv1.3',marker:mailerHostSmtpSchemaVersion,triggers:true,auditFailure:false,rollbackFailure:false,
  beforeWrite:undefined as undefined|(()=>Promise<void>)};
 const calls:{sql:string;values:unknown[]}[]=[],releases:(Error|undefined)[]=[];
 const pool:EmailDeliveryPgPool={end:vi.fn(async()=>{}),connect:vi.fn(async()=>{
  const previous=tail,done=deferred();tail=done.promise;await previous;
  let local=structuredClone(disk),inTransaction=false;
  return {release(error){releases.push(error);done.resolve();},async query<T>(sql:string,values:unknown[]=[]){
   calls.push({sql,values:structuredClone(values)});
   const result=(rows:unknown[]=[],rowCount=rows.length)=>({rows:rows as T[],rowCount});
   if(sql.startsWith('BEGIN')){inTransaction=true;return result();}
   if(sql.startsWith('SET LOCAL'))return result();
   if(sql==='COMMIT'){disk=structuredClone(local);inTransaction=false;return result();}
   if(sql==='ROLLBACK'){if(state.rollbackFailure)throw Error('PRIVATE_DB_ERROR');inTransaction=false;return result();}
   if(sql.includes('FROM pg_stat_ssl'))return result([{database:state.database,role:state.role,ssl:state.ssl,version:state.version}]);
   if(sql.includes('FROM public."B2bHostSmtpPreparedSchema"'))return result([{version:state.marker}]);
   if(sql.includes('WHERE false'))return result();
   if(sql.includes('FROM pg_trigger'))return result(state.triggers?['b2b_host_smtp_immutable','b2b_host_smtp_audit_required','b2b_host_smtp_audit_immutable'].map(name=>({name,enabled:true})):[]);
   if(sql.includes('pg_advisory_xact_lock'))return result();
   if(sql.startsWith('SELECT')&&sql.includes('FROM public."B2bHostSmtpConfiguration"')){
    const data=inTransaction?local:disk,row=data.configuration;
    return result(row&&row.ruc===values[0]&&(values.length===1||row.companyId===values[1])?[structuredClone(row)]:[]);
   }
   if(sql.startsWith('INSERT INTO public."B2bHostSmtpConfiguration"')){
    await state.beforeWrite?.();const [ruc,companyId,configurationCipher,keyVersion,revision]=values;
    if(local.configuration&&(local.configuration.companyId!==companyId||local.configuration.revision!==values[6]))return result([],0);
    local.configuration={ruc,companyId,configurationCipher,keyVersion,revision,updatedAt:new Date()} as StoredSmtpConfiguration;
    return result([structuredClone(local.configuration)],1);
   }
   if(sql.startsWith('INSERT INTO public."B2bHostSmtpConfigurationAudit"')){if(state.auditFailure)throw Error('PRIVATE_AUDIT_ERROR');local.audit.push(values);return result([],1);}
   throw Error('UNEXPECTED_SQL');
  }};
 })};
 return {pool,state,calls,releases,get disk(){return disk;},set disk(value:typeof disk){disk=structuredClone(value);}};
}
async function fixture(){
 const db=pg(),requests:{path:string;body:any;authorization?:string;authorized:boolean}[]=[];
 let valid=true;
 const server=createServer({ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true},async(req,res)=>{
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  requests.push({path:req.url!,body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization,authorized:!!(req.socket as any).authorized});
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({valid}));
 });servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const http=new B2bPrivateHttp(`https://127.0.0.1:${(server.address() as AddressInfo).port}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
 const key=randomBytes(32),resource=createMailerSmtpOwnerResource({pool:db.pool,key,keyVersion:3,approvedHosts:['smtp.example.com'],database,billingHttp:http});resources.push(resource);key.fill(0);
 const caps=new Phase8AdminCapabilities(),service=resource.createOwner(caps);
 const claims:AccessTokenClaims={sub:randomUUID(),username:'synthetic-admin',roles:['ADMIN'],permissions:['document.email','setup.manage'],scope:{kind:'GLOBAL'},authVersion:1,iss:'synthetic',aud:'synthetic',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600};
 const principal:B2bPrincipal={kind:'USER',clientId:randomUUID(),subjectId:claims.sub,userAuthRevision:1,revision:1,scopes:['b2b:mail-config:manage'],bindings:[binding],environment:'BETA'};
 const deps:Phase8AdminDependencies={enabled:true,identity:{authenticate:async()=>structuredClone(principal)},
  authority:{authorize:async()=>({claims:structuredClone(claims),policyRevision:'synthetic-policy-v1',stepUpVerified:true,expiresAt:Date.now()+30000})},
  liveIdentity:{current:async()=>structuredClone(claims)},bindingOwner:new HttpB2bOwnerBinding(http)};
 async function handle(action:'SMTP_READ'|'SMTP_SAVE',payload:Record<string,unknown>={}){
  const operation=await Phase8AdminOperation.open(deps,{token:'synthetic.admin',kind:'USER'},action,{binding,payload});
  return {handle:openMailerSmtpOwnerCapability(caps,operation),operation};
 }
 return {db,resource,caps,service,claims,principal,deps,requests,http,handle,set valid(v:boolean){valid=v;}};
}
describe('B2B09 host SMTP prepared resource',()=>{
 it('constructs inertly, has SELECT-only readiness, and owns no pool lifecycle',async()=>{
  const f=await fixture();expect(f.db.pool.connect).not.toHaveBeenCalled();expect(f.requests).toEqual([]);
  await f.resource.checkStorage();expect(f.db.calls.length).toBeGreaterThan(3);expect(f.db.calls.every(c=>c.sql.startsWith('SELECT'))).toBe(true);
  expect(f.requests).toEqual([]);await f.resource.close();await f.resource.close();expect(f.db.pool.end).not.toHaveBeenCalled();
  await expect(f.resource.checkStorage()).rejects.toThrow('OWNER_UNAVAILABLE');
 });
 it.each(['database','role','ssl','version','marker','triggers'] as const)('fails readiness closed for %s',async field=>{
  const f=await fixture();Object.assign(f.db.state,{[field]:typeof f.db.state[field]==='boolean'?false:'wrong'});
  await expect(f.resource.checkStorage()).rejects.toThrow('STORAGE_NOT_READY');expect(f.db.calls.every(c=>c.sql.startsWith('SELECT'))).toBe(true);
 });
 it('requires a real exact capability, full source binding, current human and current Billing RPC',async()=>{
  const f=await fixture();await expect(f.service.status('1',{})).rejects.toThrow();await expect(f.service.status('1','Bearer synthetic')).rejects.toThrow();
  const read=await f.handle('SMTP_READ'),raw=f.caps.open(read.operation);
  expect(await f.caps.resolve(read.handle,{action:'SMTP_READ',companyId:'1',environment:'BETA',payload:{}})).not.toHaveProperty('currentIssuerB2bOwnerBinding');
  await expect(f.service.status('1',raw)).rejects.toThrow();
  await expect(f.service.save('1',input(),read.handle)).rejects.toThrow();await expect(f.service.status('2',read.handle)).rejects.toThrow();
  f.valid=false;await expect(f.service.status('1',read.handle)).rejects.toThrow();f.valid=true;
  f.claims.roles=[];await expect(f.service.status('1',read.handle)).rejects.toThrow();f.claims.roles=['ADMIN'];
  f.caps.revoke(read.handle);await expect(f.service.status('1',read.handle)).rejects.toThrow();
  expect(f.db.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);
 });
 it('saves only ciphertext plus atomic audit, retains credentials and ignores legacy env',async()=>{
  vi.stubEnv('SMTP_APPROVED_HOSTS','smtp.attacker.com');vi.stubEnv('SMTP_SETTINGS_KEY_FILE','absent');vi.stubEnv('DATABASE_URL','forbidden');
  const f=await fixture(),save=await f.handle('SMTP_SAVE',input());
  const view=await f.service.save('1',input(),save.handle);
  expect(view).toMatchObject({revision:1,configured:true,credentialsConfigured:true,integrity:'VALID',hostnameApproved:true,state:'EXTERNAL_SMTP_DISABLED',readyToSend:false,networkAttempted:false});
  expect(f.db.disk.audit).toHaveLength(1);expect(JSON.stringify(f.db.calls)).not.toContain(credentials.username);expect(JSON.stringify(f.db.calls)).not.toContain(credentials.password);
  const next={expectedRevision:1,settings:{...settings,port:465,tlsMode:'TLS'}};
  const second=await f.handle('SMTP_SAVE',next);expect(await f.service.save('1',next,second.handle)).toMatchObject({revision:2,credentialsConfigured:true});
  expect(f.db.disk.audit[1][4]).toBe(false);
  const read=await f.handle('SMTP_READ');expect(await f.service.status('1',read.handle)).toMatchObject({revision:2,integrity:'VALID'});
  expect(f.requests.every(r=>r.path==='/internal/b2b/validate-bindings'&&r.authorized&&!r.authorization&&JSON.stringify(r.body)===JSON.stringify({bindings:[binding]}))).toBe(true);
  expect(JSON.stringify(view)).not.toContain(credentials.username);expect(JSON.stringify(view)).not.toContain('configurationCipher');
 });
 it('rejects unapproved hosts and invalid TLS combinations before mutation',async()=>{
  const f=await fixture();for(const payload of [{...input(),settings:{...settings,host:'smtp.attacker.com'}},{...input(),settings:{...settings,port:465}},{expectedRevision:0,settings}]){
   const h=await f.handle('SMTP_SAVE',payload);await expect(f.service.save('1',payload,h.handle)).rejects.toThrow();
  }expect(f.db.disk.configuration).toBeNull();
 });
 it('admits one concurrent CAS winner and preserves one audit revision',async()=>{
  const f=await fixture(),a=await f.handle('SMTP_SAVE',input()),b=await f.handle('SMTP_SAVE',input());
  const outcomes=await Promise.allSettled([f.service.save('1',input(),a.handle),f.service.save('1',input(),b.handle)]);
  expect(outcomes.filter(o=>o.status==='fulfilled')).toHaveLength(1);expect(outcomes.find(o=>o.status==='rejected')).toMatchObject({reason:{status:409}});
  expect(f.db.disk.configuration?.revision).toBe(1);expect(f.db.disk.audit).toHaveLength(1);
 });
 it('rolls configuration back if audit fails and sanitizes database errors',async()=>{
  const f=await fixture(),h=await f.handle('SMTP_SAVE',input());f.db.state.auditFailure=true;
  await expect(f.service.save('1',input(),h.handle)).rejects.toThrow('STORAGE_NOT_READY');
  expect(f.db.disk.configuration).toBeNull();expect(f.db.disk.audit).toEqual([]);expect(f.db.calls.some(c=>c.sql==='ROLLBACK')).toBe(true);
 });
 it('rejects a revoked capability before commit even after preparing a write',async()=>{
  const f=await fixture(),h=await f.handle('SMTP_SAVE',input());f.db.state.beforeWrite=async()=>{f.caps.revoke(h.handle);};
  await expect(f.service.save('1',input(),h.handle)).rejects.toThrow();expect(f.db.disk.configuration).toBeNull();expect(f.db.disk.audit).toEqual([]);
 });
 it('reports tampering and refuses credential reuse from a damaged envelope',async()=>{
  const f=await fixture(),h=await f.handle('SMTP_SAVE',input());await f.service.save('1',input(),h.handle);
  const damaged=f.db.disk;damaged.configuration!.configurationCipher=damaged.configuration!.configurationCipher.slice(0,-4)+'aaaa';f.db.disk=damaged;
  const read=await f.handle('SMTP_READ');expect(await f.service.status('1',read.handle)).toMatchObject({integrity:'INVALID',credentialsConfigured:false,settings:null});
  const next={expectedRevision:1,settings},save=await f.handle('SMTP_SAVE',next);await expect(f.service.save('1',next,save.handle)).rejects.toThrow();
 });
 it('drains active work, rejects new admission and leaves the shared pool open',async()=>{
  const f=await fixture(),h=await f.handle('SMTP_SAVE',input()),entered=deferred(),resume=deferred();
  f.db.state.beforeWrite=async()=>{entered.resolve();await resume.promise;};const saving=f.service.save('1',input(),h.handle);await entered.promise;
  let closed=false;const closing=f.resource.close().then(()=>{closed=true;});await Promise.resolve();expect(closed).toBe(false);
  await expect(f.service.status('1',h.handle)).rejects.toThrow('OWNER_UNAVAILABLE');resume.resolve();await saving;await closing;
  expect(f.db.pool.end).not.toHaveBeenCalled();expect(()=>f.resource.createOwner(f.caps)).toThrow();
 });
 it('exposes no transport/remove/audit action and hides custody under inspection',async()=>{
  const f=await fixture();await expect(f.service.remove('1',{},'Bearer synthetic')).rejects.toThrow();await expect(f.service.dryRun('1',{},'Bearer synthetic')).rejects.toThrow();await expect(f.service.audit('1','Bearer synthetic')).rejects.toThrow();
  expect(Object.values(f.resource)).toEqual([]);expect(f.resource).not.toHaveProperty('statusFor');expect(f.resource).not.toHaveProperty('saveFor');expect(inspect(f.resource)).not.toContain('key');expect(inspect(f.service)).not.toContain('password');expect(f.db.calls).toEqual([]);
 });
 it('uses the real Phase8 bridge response projection and revokes the operation handle',async()=>{
  const f=await fixture(),bridge=new B2bPhase8SmtpAdmin(f.deps,f.service,f.caps);
  const result=await bridge.execute({token:'synthetic.admin',kind:'USER'},'SMTP_SAVE',{binding,payload:input()});
  expect(result.data).toMatchObject({revision:1,networkAttempted:false,readyToSend:false});expect(result.data).not.toHaveProperty('settings');
  expect(JSON.stringify(result)).not.toContain(credentials.password);
 });
 it('uses issuer/version-bound authenticated encryption and destroys owned key copies',()=>{
  const key=randomBytes(32),copy=vi.spyOn(Buffer,'from'),vault=new MailerHostSmtpVault(key,1),ownedKey=copy.mock.results[0].value as Buffer;copy.mockRestore();
  const plaintext=Buffer.from('synthetic-secret'),sealed=vault.seal(plaintext,issuer);
  key.fill(0);expect(vault.open(sealed.cipher,1,issuer).toString()).toBe('synthetic-secret');
  expect(vault.seal(plaintext,issuer).cipher).not.toBe(sealed.cipher);expect(()=>vault.open(sealed.cipher,1,{...issuer,companyId:2})).toThrow();
  expect(()=>vault.open(sealed.cipher,2,issuer)).toThrow();expect(Object.values(vault)).toEqual([]);vault.close();
  expect(ownedKey.every(byte=>byte===0)).toBe(true);expect(vault.readiness()).toBe('INVALID');expect(()=>vault.open(sealed.cipher,1,issuer)).toThrow();expect(()=>vault.seal(plaintext,issuer)).toThrow();
 });
 it('keeps schema candidate separate, append-only and audit-enforced without executing it',()=>{
  const sql=readFileSync('services/mailer-worker/src/b2b/host-smtp-schema.candidate.sql','utf8');
  expect(sql).toContain("current_database()<>'factuez_mailer_beta'");expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
  expect(sql).toContain('BEFORE UPDATE OR DELETE ON public."B2bHostSmtpConfigurationAudit"');expect(sql).not.toContain('CREATE TABLE IF NOT EXISTS');
 });

 it('enriches exact real handles opt-in, expires them and clears the bridge binding on exit',async()=>{
  const f=await fixture(),h=await f.handle('SMTP_READ');h.operation.close();
  await expect(f.service.status('1',h.handle)).rejects.toThrow();
  const open=vi.spyOn(f.caps,'open'),bridge=new B2bPhase8SmtpAdmin(f.deps,f.service,f.caps);
  await bridge.execute({token:'synthetic.admin',kind:'USER'},'SMTP_READ',{binding,payload:{}});
  const handle=open.mock.results[0].value as object;
  await expect(f.service.status('1',handle)).rejects.toThrow();
  await expect(f.caps.resolve(handle,{action:'SMTP_READ',companyId:'1',environment:'BETA',payload:{}})).rejects.toThrow();
 });
 it('never treats payload authority metadata as a source issuer proof',async()=>{
  const f=await fixture(),payload={...input(),currentIssuerB2bOwnerBinding:{...binding,issuerId:2}};
  const h=await f.handle('SMTP_SAVE',payload);await expect(f.service.save('1',payload,h.handle)).rejects.toThrow();
  expect(f.db.disk.configuration).toBeNull();
  const row=await f.handle('SMTP_READ');f.valid=false;
  await expect(f.service.status('1',row.handle)).rejects.toThrow();expect(f.db.disk.audit).toEqual([]);
 });
 it('discards a broken rollback connection exactly once',async()=>{
  const db=pg(),store=new MailerHostSmtpStore(db.pool,database);db.state.auditFailure=true;db.state.rollbackFailure=true;
  await expect(store.save(issuer,{cipher:'synthetic-cipher',keyVersion:1},0,randomUUID(),true,async()=>{})).rejects.toThrow('STORAGE_NOT_READY');
  expect(db.releases).toHaveLength(1);expect(db.releases[0]).toBeInstanceOf(Error);
 });
});
