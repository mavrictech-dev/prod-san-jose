import 'reflect-metadata';
import { beforeAll,afterAll,describe,it,expect } from 'vitest';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { request } from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/billing-service/node_modules/@nestjs/core';
import type { NestExpressApplication } from '../services/identity-service/node_modules/@nestjs/platform-express';
import { createB2bIdentityApplication } from '../services/identity-service/src/b2b/application';
import { B2bContextModule,B2bContextFilter } from '../services/billing-service/src/b2b/http';
import { B2bContextService } from '../services/billing-service/src/b2b/context';
import { B2bBindingCatalogueHttp,B2bIdentityHttp,B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { fixture,input,basic,binding,ctx,id } from './b2b-identity.fixture';
const forge=createRequire(resolve('packages/evidence-core/package.json'))('node-forge');
function certificates(){
  const pki=forge.pki,root=pki.rsa.generateKeyPair(2048),leaf=pki.rsa.generateKeyPair(2048);
  const ca=pki.createCertificate();ca.publicKey=root.publicKey;ca.serialNumber='01';ca.validity.notBefore=new Date(Date.now()-60000);ca.validity.notAfter=new Date(Date.now()+3600000);
  ca.setSubject([{name:'commonName',value:'B2B SYNTHETIC ONLY CA'}]);ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,cRLSign:true}]);ca.sign(root.privateKey,forge.md.sha256.create());
  const make=(serial:string,server=false)=>{const cert=pki.createCertificate();cert.publicKey=leaf.publicKey;cert.serialNumber=serial;cert.validity.notBefore=ca.validity.notBefore;cert.validity.notAfter=ca.validity.notAfter;
    cert.setSubject([{name:'commonName',value:server?'localhost':`synthetic-b2b-${serial}`}]);cert.setIssuer(ca.subject.attributes);
    cert.setExtensions([{name:'basicConstraints',cA:false},{name:'keyUsage',digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:server,clientAuth:!server},
      ...(server?[{name:'subjectAltName',altNames:[{type:2,value:'localhost'},{type:7,ip:'127.0.0.1'}]}]:[])]);cert.sign(root.privateKey,forge.md.sha256.create());return Buffer.from(pki.certificateToPem(cert));};
  return {ca:Buffer.from(pki.certificateToPem(ca)),key:Buffer.from(pki.privateKeyToPem(leaf.privateKey)),server:make('02',true),token:make('03'),admin:make('04'),resource:make('05'),other:make('06')};
}
describe('B2B-02 actual isolated HTTPS/mTLS request chain',()=>{
  let identity:NestExpressApplication,billing:any,tls:ReturnType<typeof certificates>,port:number,billingPort:number;
  const f=fixture();let made:any;
  const fingerprint=(cert:Buffer)=>new X509Certificate(cert).fingerprint256.replace(/:/g,'').toLowerCase();
  beforeAll(async()=>{
    tls=certificates();
    identity=await createB2bIdentityApplication(f.core,{token:[fingerprint(tls.token)],admin:[fingerprint(tls.admin)],resource:[fingerprint(tls.resource)]},{ca:tls.ca,cert:tls.server,key:tls.key});
    await identity.listen(0,'127.0.0.1');port=(identity.getHttpServer().address() as AddressInfo).port;
    const reader=new B2bIdentityHttp(new B2bPrivateHttp(`https://127.0.0.1:${port}`,{ca:tls.ca,cert:tls.resource,key:tls.key}));
    const core=new B2bContextService({resolve:async value=>JSON.stringify(value)===JSON.stringify(binding)?{binding,name:'Synthetic canonical context'}:null},reader);
    billing=await NestFactory.create(B2bContextModule.isolated(core,{context:[fingerprint(tls.resource)],registrar:[fingerprint(tls.admin)]}),{logger:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
    billing.useGlobalFilters(new B2bContextFilter());await billing.listen(0,'127.0.0.1');billingPort=(billing.getHttpServer().address() as AddressInfo).port;
    const catalogue=new B2bBindingCatalogueHttp(new B2bPrivateHttp(`https://127.0.0.1:${billingPort}`,{ca:tls.ca,cert:tls.admin,key:tls.key}));
    f.catalogue.validate.mockImplementation(values=>catalogue.validate(values));
    made=await f.core.create('human-step-up',input(),ctx());
  },30000);
  afterAll(async()=>{await billing?.close();await identity?.close();});
  async function send(path:string,body?:string,headers:Record<string,string>={},peer:'token'|'resource'|'admin'|'other'|null='token',target=()=>port,method='POST',trust=true){
    return new Promise<{status:number;body:any;headers:any}>((done,reject)=>{
      const req=request({hostname:'127.0.0.1',port:target(),path,method,timeout:4000,rejectUnauthorized:true,...(trust?{ca:tls.ca}:{}),...(peer?{cert:tls[peer],key:tls.key}:{}),
        headers:{...(body?{'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body))}:{}),...headers}},res=>{
        const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(chunk));res.on('error',reject);res.on('end',()=>{try{done({status:res.statusCode!,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null,headers:res.headers});}catch(error){reject(error);}});
      });req.on('timeout',()=>req.destroy(new Error('Test timeout')));req.on('error',reject);req.end(body);
    });
  }
  const form='grant_type=client_credentials&scope=b2b%3Acontext%3Aread+b2b%3Acatalog%3Aread';
  async function token(){return send('/b2b/oauth/token',form,{Authorization:basic(made.client.id,made.clientSecret),'Content-Type':'application/x-www-form-urlencoded'});}
  it('issues scoped JWT without refresh token over authenticated TLS',async()=>{
    const response=await token();expect(response.status).toBe(200);expect(response.body).toMatchObject({token_type:'Bearer',expires_in:300});expect(response.body).not.toHaveProperty('refresh_token');expect(response.headers['cache-control']).toBe('private, no-store');
  });
  it('requires trusted server CA and client certificate',async()=>{
    await expect(send('/b2b/oauth/token',form,{},null)).rejects.toThrow();await expect(send('/b2b/oauth/token',form,{},'token',()=>port,'POST',false)).rejects.toThrow();
  });
  it('a trusted but unapproved peer cannot fake forwarded authority',async()=>{
    const response=await send('/b2b/oauth/token',form,{'Content-Type':'application/x-www-form-urlencoded','X-Forwarded-Proto':'https','X-User-Role':'ADMIN'},'other');expect(response.status).toBe(403);
  });
  it('requires both privileged TLS peer and step-up administrator, not SERVICE',async()=>{
    expect((await send('/internal/b2b/clients',JSON.stringify(input()),{Authorization:'Bearer human-step-up'})).status).toBe(403);
    expect((await send('/internal/b2b/clients',JSON.stringify(input()),{Authorization:'Bearer human-password-only'},'admin')).status).toBe(403);
    const response=await send('/internal/b2b/clients',JSON.stringify({...input(),label:'Second synthetic app'}),{Authorization:'Bearer human-step-up'},'admin');expect(response.status).toBe(201);expect(response.body.client).not.toHaveProperty('secretHash');
  });
  it('rejects duplicate form fields, body credentials and password grant',async()=>{
    for(const body of [form+'&scope=b2b%3Acontext%3Aread',form+'&client_secret=unsafe',form.replace('client_credentials','password')]){
      const response=await send('/b2b/oauth/token',body,{Authorization:basic(made.client.id,made.clientSecret),'Content-Type':'application/x-www-form-urlencoded'});expect(response.status).toBe(400);
    }
  });
  it('executes Identity -> private Billing catalogue, and Billing -> fresh Identity authorization',async()=>{
    const access=(await token()).body.access_token;
    const response=await send('/internal/b2b/context',JSON.stringify({binding,kind:'SERVICE'}),{Authorization:'Bearer '+access},'resource',()=>billingPort);
    expect(response.status).toBe(200);expect(response.body.binding).toEqual(binding);expect(response.headers['cache-control']).toBe('private, no-store');
    const denied=await send('/internal/b2b/context',JSON.stringify({binding:{...binding,seriesId:id(88)},kind:'SERVICE'}),{Authorization:'Bearer '+access},'resource',()=>billingPort);expect(denied.status).toBe(404);
  });
  it('registrar catalogue validation has a distinct mTLS permission and rejects mixed contexts',async()=>{
    const body=JSON.stringify({bindings:[binding]});expect((await send('/internal/b2b/validate-bindings',body,{},'resource',()=>billingPort)).status).toBe(403);
    expect((await send('/internal/b2b/validate-bindings',body,{},'admin',()=>billingPort)).status).toBe(200);
    expect((await send('/internal/b2b/validate-bindings',JSON.stringify({bindings:[{...binding,issuerId:2}]}),{},'admin',()=>billingPort)).status).toBe(400);
  });
  it('does not expose PWA login, emission, production or fiscal secrets',async()=>{
    for(const path of ['/api/v1/auth/login','/b2b/v1/document-drafts','/api/v1/setup/sunat','/integration/oauth/token'])expect((await send(path,undefined,{},'resource',()=>port,'GET')).status).toBe(404);
    const response=await send('/internal/b2b/jwks',undefined,{},'resource',()=>port,'GET');expect(response.status).toBe(200);expect(response.body.keys[0]).not.toHaveProperty('d');
  });
  it('HTTP revocation is effective on the next canonical context request',async()=>{
    const access=(await token()).body.access_token;
    const disabled=await send('/internal/b2b/clients/'+made.client.id,JSON.stringify({expectedRevision:1,enabled:false}),{Authorization:'Bearer human-step-up'},'admin',()=>port,'PATCH');expect(disabled.status).toBe(200);
    const response=await send('/internal/b2b/context',JSON.stringify({binding,kind:'SERVICE'}),{Authorization:'Bearer '+access},'resource',()=>billingPort);expect(response.status).toBe(401);
  });
});
