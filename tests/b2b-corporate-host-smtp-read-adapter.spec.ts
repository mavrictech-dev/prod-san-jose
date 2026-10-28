import {describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {inspect} from 'node:util';
import {MailerHostSmtpVault} from '../services/mailer-worker/src/b2b/host-smtp.crypto';
import {MailerHostSmtpStore,mailerHostSmtpSchemaVersion} from '../services/mailer-worker/src/b2b/host-smtp.store';
import {createCorporateHostSmtpReadAdapter} from '../services/mailer-worker/src/b2b/corporate-host-smtp-read-adapter';
import type {EmailDeliveryPgPool} from '../services/mailer-worker/src/b2b/email-deliveries.store';
import type {StoredSmtpConfiguration} from '../services/mailer-worker/src/smtp-configuration.store';

const issuer={companyId:1,ruc:'20000000001'};
function fixture(){
 const key=randomBytes(32),vault=new MailerHostSmtpVault(key,3);key.fill(0);
 const plain=Buffer.from('{"username":"synthetic-private-user","password":"synthetic-private-password"}');
 const sealed=vault.seal(plain,issuer);plain.fill(0);
 const row:StoredSmtpConfiguration={...issuer,configurationCipher:sealed.cipher,keyVersion:sealed.keyVersion,revision:1,updatedAt:new Date('2025-01-01T00:00:00Z')};
 const calls:{sql:string;values:unknown[]}[]=[];
 const pool:EmailDeliveryPgPool={end:vi.fn(async()=>{}),connect:vi.fn(async()=>({release:vi.fn(),async query<T>(sql:string,values:unknown[]=[]){
  calls.push({sql,values});let rows:unknown[];
  if(sql.includes('FROM pg_stat_ssl'))rows=[{database:'factuez_mailer_beta',role:'mailer_owner',ssl:true,version:'TLSv1.3'}];
  else if(sql.includes('B2bHostSmtpPreparedSchema'))rows=[{version:mailerHostSmtpSchemaVersion}];
  else if(sql.includes('WHERE false'))rows=[];
  else if(sql.includes('FROM pg_trigger'))rows=['b2b_host_smtp_immutable','b2b_host_smtp_audit_required','b2b_host_smtp_audit_immutable'].map(name=>({name,enabled:true}));
  else if(sql.startsWith('SELECT')&&sql.includes('B2bHostSmtpConfiguration'))rows=values[0]===row.ruc&&values[1]===row.companyId?[row]:[];
  else throw Error('unexpected SQL');
  return {rows:rows as T[],rowCount:rows.length};
 }}))};
 const store=new MailerHostSmtpStore(pool,{name:'factuez_mailer_beta',user:'mailer_owner'});
 return {vault,row,pool,calls,adapter:createCorporateHostSmtpReadAdapter(store,vault)};
}
describe('corporate host SMTP read adapter',()=>{
 it('is inert and only reads through the prepared store; decrypts an exact issuer',async()=>{
  const f=fixture();expect(f.pool.connect).not.toHaveBeenCalled();
  const row=await f.adapter.configurations.read(issuer);expect(row).toEqual(f.row);
  const bytes=f.adapter.vault.open(row!.configurationCipher,{...issuer,field:'configuration'});
  expect(JSON.parse(bytes.toString())).toEqual({username:'synthetic-private-user',password:'synthetic-private-password'});bytes.fill(0);
  expect(f.calls.every(c=>c.sql.startsWith('SELECT'))).toBe(true);
  expect(f.calls.at(-1)?.values).toEqual([issuer.ruc,issuer.companyId]);
  expect(Object.keys(f.adapter.configurations)).toEqual(['read']);expect(Object.keys(f.adapter.vault)).toEqual(['open']);
  expect(inspect(f.adapter)).not.toContain('synthetic-private');expect(JSON.stringify(f.adapter)).not.toContain(f.row.configurationCipher);
  f.vault.close();
 });
 it('fails closed for another RUC or company, tampering, bad context and version',async()=>{
  const f=fixture(),c=f.row.configurationCipher,open=f.adapter.vault.open;
  expect(await f.adapter.configurations.read({...issuer,ruc:'20000000002'})).toBeNull();
  expect(await f.adapter.configurations.read({...issuer,companyId:2})).toBeNull();
  for(const context of [{...issuer,ruc:'20000000002',field:'configuration'}, {...issuer,companyId:2,field:'configuration'}, {...issuer,field:'password'}])
   expect(()=>open(c,context as any)).toThrow('EMAIL_SMTP_CONFIGURATION_UNAVAILABLE');
  expect(()=>open(c.replace('v1.3.','v1.4.'),{...issuer,field:'configuration'})).toThrow();
  expect(()=>open(c.slice(0,-1)+(c.endsWith('A')?'B':'A'),{...issuer,field:'configuration'})).toThrow();
  f.vault.close();
 });
 it('rejects mismatched or malformed rows and sanitizes dependency failures',async()=>{
  const f=fixture();
  for(const row of [{...f.row,ruc:'20000000002'}, {...f.row,companyId:2}, {...f.row,keyVersion:4}, {...f.row,revision:0}, {...f.row,configurationCipher:'private-bad'}, {...f.row,updatedAt:new Date(NaN)}]){
   const adapter=createCorporateHostSmtpReadAdapter({read:async()=>row},f.vault);
   await expect(adapter.configurations.read(issuer)).rejects.toThrow('EMAIL_SMTP_CONFIGURATION_UNAVAILABLE');
  }
  const adapter=createCorporateHostSmtpReadAdapter({read:async()=>{throw Error('synthetic-private-error');}},f.vault);
  await expect(adapter.configurations.read(issuer)).rejects.toThrow('EMAIL_SMTP_CONFIGURATION_UNAVAILABLE');
  await expect(adapter.configurations.read({companyId:0,ruc:issuer.ruc})).rejects.toThrow();
  f.vault.close();
 });
});