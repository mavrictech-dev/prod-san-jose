import 'reflect-metadata';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {request} from 'node:https';
import {NestFactory} from '../services/identity-service/node_modules/@nestjs/core';
import {Module} from '../services/identity-service/node_modules/@nestjs/common';
import {AuthService} from '../services/identity-service/src/application/auth.service';
import {OnpremB2bAdminModule,OnpremAdminHost} from '../services/identity-service/src/b2b/onprem-admin.module';
import {onpremFixture,origin,password} from './helpers/b2b-onprem-admin.fixture';
import {b2bCertificates} from './b2b-tls.fixture';
import {binding} from './b2b-identity.fixture';
class SyntheticNativeIdentity{}
Module({})(SyntheticNativeIdentity);
describe.sequential('native OnPrem controller uses the current Identity guard over synthetic HTTPS',()=>{
 let f:Awaited<ReturnType<typeof onpremFixture>>,app:any,tls:ReturnType<typeof b2bCertificates>,port:number,cookie='',csrf='',made:any;
 const base='/api/v1/b2b-admin';
 async function send(path:string,body:unknown={},opts:{method?:string;origin?:string;csrf?:string;bearer?:string;cookie?:string}={}){
  const bytes=Buffer.from(JSON.stringify(body));
  return new Promise<{status:number;body:any;headers:any}>((ok,no)=>{
   const req=request({hostname:'127.0.0.1',port,path:base+path,method:opts.method??'POST',ca:tls.ca,rejectUnauthorized:true,timeout:5000,
    headers:{Accept:'application/json','Content-Type':'application/json','Content-Length':bytes.length,
     Origin:opts.origin??origin,'Sec-Fetch-Site':'same-origin','X-FactuEz-B2b-Admin':'ONPREM',
     Authorization:opts.bearer??f.req.headers.authorization,...((opts.cookie??cookie)?{Cookie:opts.cookie??cookie}:{}),
     ...((opts.csrf??csrf)?{'X-FactuEz-CSRF':opts.csrf??csrf}:{})}},res=>{
      const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',no);res.on('end',()=>{try{ok({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString()),headers:res.headers});}catch(e){no(e);}});
     });req.on('error',no);req.on('timeout',()=>req.destroy(Error('HTTPS_TEST_TIMEOUT')));req.end(bytes);
  });
 }
 beforeAll(async()=>{
  f=await onpremFixture();tls=b2bCertificates();vi.stubEnv('B2B_ONPREM_ADMIN_ENABLED','false');
  app=await NestFactory.create({module:SyntheticNativeIdentity,imports:[OnpremB2bAdminModule],providers:[{provide:AuthService,useValue:f.auth}]},
   {logger:false,abortOnError:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,minVersion:'TLSv1.2'}});
  await app.listen(0,'127.0.0.1');port=app.getHttpServer().address().port;
 },30000);
 afterAll(async()=>{await app?.close();f?.close();vi.unstubAllEnvs();});
 it('publishes only an explicit disabled status by default and never guesses from an SSO outage',async()=>{
  const r=await send('/status');expect(r.status).toBe(200);expect(r.body).toEqual({profile:'ONPREM',enabled:false,environment:'BETA',authenticated:false});
  expect(r.headers['set-cookie']).toBeUndefined();
  expect((await send('/reauthenticate',{password})).status).toBe(503);
 });
 it('rejects unsigned/forged JWT before reaching any reauth handler',async()=>{
  expect((await send('/status',{}, {bearer:'Bearer not-a-valid-jwt'})).status).toBe(401);
 });
 it('uses the live tested authority and emits a bound Secure HttpOnly SameSite Strict cookie',async()=>{
  // Test-only assembly of the real authority; no guard, password or verifier is replaced.
  app.get(OnpremAdminHost).runtime={authority:f.authority,applications:f.applications,close:()=>f.authority.close()};
  const r=await send('/status');expect(r.status).toBe(200);expect(r.body).toMatchObject({profile:'ONPREM',enabled:true,authenticated:false,serviceOnly:true,readonly:true});
  const set=r.headers['set-cookie'][0];expect(set).toContain('HttpOnly; Secure; SameSite=Strict');expect(set).toContain('Path=/api/v1/b2b-admin');
  cookie=set.split(';')[0];csrf=r.body.csrfToken;
  expect((await send('/applications?environment=BETA',{label:'Attempt',kind:'SERVICE',scopes:['b2b:context:read'],bindings:[binding]})).status).toBe(403);
 });
 it('rejects origin forgery and forged CSRF, accepts only the real reauthentication password',async()=>{
  expect((await send('/reauthenticate',{password},{origin:'https://forged.invalid'})).status).toBe(403);
  expect((await send('/reauthenticate',{password},{csrf:'a'.repeat(43)})).status).toBe(403);
  expect((await send('/reauthenticate',{password:'incorrect-password'})).status).toBe(403);
  expect((await send('/reauthenticate',{password})).status).toBe(200);
 });
 it('creates a readonly SERVICE client once, rotates secrets, and never returns secrets from metadata',async()=>{
  const r=await send('/applications?environment=BETA',{label:'Synthetic native client',kind:'SERVICE',scopes:['b2b:context:read'],bindings:[binding]});
  expect(r.status).toBe(201);made=r.body;expect(made.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const read=await send('/applications/'+made.application.id+'/read?environment=BETA');
  expect(read.status).toBe(200);expect(read.body.application.id).toBe(made.application.id);expect(read.body.clientSecret).toBeUndefined();
  const rotated=await send('/applications/'+made.application.id+'/rotate-secret?environment=BETA',{expectedRevision:1});
  expect(rotated.status).toBe(200);expect(rotated.body.clientSecret).not.toBe(made.clientSecret);
  expect(r.headers['cache-control']).toBe('private, no-store');
  for(const forbidden of [{kind:'USER',scopes:['b2b:context:read']},{kind:'SERVICE',scopes:['b2b:documents:issue']}])
   expect((await send('/applications?environment=BETA',{label:'Unsafe',bindings:[binding],...forbidden})).status).toBe(400);
  expect((await send('/applications?environment=PRODUCTION',{label:'Unsafe',kind:'SERVICE',scopes:['b2b:context:read'],bindings:[binding]})).status).toBe(400);
 });
 it('checks authVersion and active account through the real guard on every subsequent request',async()=>{
  f.row.authVersion++;
  expect((await send('/applications/'+made.application.id+'/read?environment=BETA')).status).toBe(401);
  f.row.authVersion--;f.row.active=false;
  expect((await send('/status')).status).toBe(401);
 });
});
