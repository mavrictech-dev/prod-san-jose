import {beforeAll,describe,it,expect,vi} from 'vitest';
import {b2bPostgresOptions,mountedB2bPostgres,type B2bPostgresOptions} from '../packages/service-access/src/b2b-postgres-options';
import {b2bCertificates} from './b2b-tls.fixture';
describe('explicit B2B database TLS, no URL or environment fallback',()=>{
 let cert:ReturnType<typeof b2bCertificates>;beforeAll(()=>{cert=b2bCertificates();},30000);
 const base=():B2bPostgresOptions=>({host:'postgres.synthetic.invalid',port:5432,user:'synthetic_owner',database:'synthetic_beta',password:'SYNTHETIC_ONLY',
  ssl:{ca:cert.ca,rejectUnauthorized:true,minVersion:'TLSv1.2'},max:4,connectionTimeoutMillis:3000,statement_timeout:10000,idleTimeoutMillis:30000});
 it('requires bounded owner connections and clones the CA used for certificate and hostname verification',()=>{
  const input=base(),options=b2bPostgresOptions(input);expect(options.ssl).toMatchObject({rejectUnauthorized:true,minVersion:'TLSv1.2'});expect(options.ssl.ca.equals(input.ssl.ca)).toBe(true);
  expect(options.ssl.ca).not.toBe(input.ssl.ca);expect(options.max).toBe(4);
 });
 it('rejects plaintext, non-CA trust, URL overrides, unsafe timeout and arbitrary connection properties',()=>{
  for(const change of [{ssl:undefined},{ssl:{...base().ssl,rejectUnauthorized:false}},{ssl:{...base().ssl,ca:cert.server}},
   {ssl:{...base().ssl,minVersion:'TLSv1'}},{ssl:{...base().ssl,ca:Buffer.alloc(0)}},{max:100},{statement_timeout:0},
   {connectionString:'postgresql://synthetic.invalid/other?sslmode=disable'},{password:'private\nvalue'},{database:'other/../db'},{host:'postgres; command'}])
   expect(()=>b2bPostgresOptions({...base(),...change} as any)).toThrow('VERIFIED_TLS_REQUIRED');
 });
 it('loads only explicit mounted filenames and zeros its temporary password buffer',()=>{
  const password=Buffer.from('SYNTHETIC_ONLY'),files={secretBytes:vi.fn(()=>password),publicPem:vi.fn(()=>cert.ca)};
  const options=mountedB2bPostgres(files,{host:'postgres',port:5432,user:'synthetic_owner',name:'synthetic_beta',passwordFile:'database.bin'});
  expect(options.password).toBe('SYNTHETIC_ONLY');expect(password.equals(Buffer.alloc(password.length))).toBe(true);expect(files.publicPem).toHaveBeenCalledWith('database-ca.pem');
  expect(()=>mountedB2bPostgres(files,{host:'postgres',port:5432,user:'owner',name:'production',passwordFile:'../password.bin'})).toThrow('MOUNT_REQUIRED');
 });
});
