import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '../services/b2b-api-service/node_modules/@nestjs/core';
import { createB2bIdentityApplication } from '../services/identity-service/src/b2b/application';
import { B2bIntegrationAdmin, B2bIntegrationAdminModule, HttpB2bIntegrationAdminOwner } from '../services/b2b-api-service/src/integration-admin';
import { B2bPrivateHttp } from '../packages/service-access/src/b2b';
import { b2bCertificates, fingerprint } from './b2b-tls.fixture';
import { adminFixture, input, ctx, basic } from './b2b-integration-admin.fixture';

describe('candidate public facade -> fixed private RPC over actual HTTPS/mTLS',()=>{
  let owner:any,api:any,tls:ReturnType<typeof b2bCertificates>,ownerPort:number,apiPort:number;
  const f=adminFixture();
  async function send(port:number,path:string,method='GET',body?:unknown,bearer:string|undefined='human-step-up',peer:'edge'|'resource'|'other'|null='edge',trusted=true,extra:Record<string,string>={}) {
    return new Promise<{status:number;body:any;headers:any}>((done,reject)=>{
      const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
      const req=request({hostname:'127.0.0.1',port,path,method,rejectUnauthorized:true,timeout:5000,
        ...(trusted?{ca:tls.ca}:{}),...(peer?{cert:tls[peer],key:tls.key}:{}),headers:{...(bearer?{Authorization:'Bearer '+bearer}:{}),
          ...(bytes?{'Content-Type':'application/json','Content-Length':bytes.length}:{}),...extra}},res=>{
        const chunks:Buffer[]=[];let size=0;
        res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>16*1024*1024)req.destroy(new Error('Synthetic response bound'));else chunks.push(chunk);});
        res.on('error',reject);res.on('end',()=>{try{done({status:res.statusCode!,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null,headers:res.headers});}catch(e){reject(e);}});
      });req.on('timeout',()=>req.destroy(new Error('Synthetic timeout')));req.on('error',reject);req.end(bytes);
    });
  }
  beforeAll(async()=>{
    tls=b2bCertificates();
    owner=await createB2bIdentityApplication(f.core,{admin:[fingerprint(tls.resource)],resource:[fingerprint(tls.other)],token:[fingerprint(tls.other)]},{ca:tls.ca,cert:tls.server,key:tls.key});
    await owner.listen(0,'127.0.0.1');ownerPort=(owner.getHttpServer().address() as AddressInfo).port;
    const transport=new B2bPrivateHttp('https://127.0.0.1:'+ownerPort,{ca:tls.ca,cert:tls.resource,key:tls.key});
    const core=new B2bIntegrationAdmin(new HttpB2bIntegrationAdminOwner(transport));
    api=await NestFactory.create(B2bIntegrationAdminModule.isolated(core,[fingerprint(tls.edge)]),{logger:false,httpsOptions:{ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true}});
    await api.listen(0,'127.0.0.1');apiPort=(api.getHttpServer().address() as AddressInfo).port;
  },30000);
  afterAll(async()=>{await api?.close();await owner?.close();});
  const base='/b2b/v1/admin/applications',beta='?environment=BETA';
  it('exposes all five exact public endpoints with expected revisions and one-time secrets',async()=>{
    const created=await send(apiPort,base+beta,'POST',input());expect(created.status).toBe(201);expect(created.body).toMatchObject({environment:'BETA',source:'SOURCE',candidateOnly:true});
    const appId=created.body.application.id,secret=created.body.clientSecret;expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const listed=await send(apiPort,base+beta+'&limit=1');expect(listed.status).toBe(200);expect(listed.body.items[0].id).toBe(appId);
    const read=await send(apiPort,base+'/'+appId+beta);expect(read.status).toBe(200);expect(read.body.application.revision).toBe(1);
    const updated=await send(apiPort,base+'/'+appId+beta,'PATCH',{expectedRevision:1,label:'HTTP updated'});expect(updated.status).toBe(200);expect(updated.body.application).toMatchObject({label:'HTTP updated',revision:2});
    const rotated=await send(apiPort,base+'/'+appId+'/rotate-secret'+beta,'POST',{expectedRevision:2});expect(rotated.status).toBe(200);expect(rotated.body.application.revision).toBe(3);expect(rotated.body.clientSecret).not.toBe(secret);
    const stale=await send(apiPort,base+'/'+appId+beta,'PATCH',{expectedRevision:2,enabled:false});expect(stale.status).toBe(409);expect(stale.body.code).toBe('REVISION_CONFLICT');
    for(const result of [listed,read,updated]) { expect(JSON.stringify(result.body)).not.toMatch(/secretHash|password|clientSecret/);expect(JSON.stringify(result.body)).not.toContain(secret);expect(result.headers['cache-control']).toBe('private, no-store');expect(result.headers.pragma).toBe('no-cache'); }
  });
  it('requires approved mTLS peers, rejecting plain TLS and forwarded-role spoofing',async()=>{
    await expect(send(apiPort,base+beta,'GET',undefined,'human-step-up',null)).rejects.toThrow();
    await expect(send(apiPort,base+beta,'GET',undefined,'human-step-up','edge',false)).rejects.toThrow();
    const denied=await send(apiPort,base+beta,'GET',undefined,'human-step-up','other',true,{'X-User-Role':'ADMIN','X-Forwarded-Proto':'https'});expect(denied.status).toBe(403);
    const privateDenied=await send(ownerPort,'/internal/b2b/integration-admin','POST',{action:'LIST',args:{environment:'BETA',limit:1}},'human-step-up','edge');expect(privateDenied.status).toBe(403);
  });
  it('requires a separate current step-up bearer rather than SERVICE scope or asserted claims',async()=>{
    const noBearer=await send(apiPort,base+beta,'GET',undefined,'');expect(noBearer.status).toBe(401);expect(noBearer.headers['www-authenticate']).toBe('Bearer');
    expect((await send(apiPort,base+beta,'GET',undefined,'password-only')).status).toBe(403);
    const made=await f.core.create('human-step-up',input(),ctx()),token=await f.core.token(basic(made.client.id,made.clientSecret!),{grant_type:'client_credentials',scope:'b2b:context:read'},ctx());
    expect((await send(apiPort,base+beta,'GET',undefined,token.access_token)).status).toBe(403);
    const injected=await send(apiPort,base+beta,'POST',{...input(),actor:{kind:'USER',roles:['ADMIN'],stepUpVerified:true}});expect(injected.status).toBe(400);
  });
  it('owner fixed RPC uses admin peers, rejects malformed envelopes/production and returns 200 for create',async()=>{
    for(const body of [{action:'LIST',args:{environment:'PRODUCTION'}},{action:'READ',args:{environment:'BETA',id:'bad'}},{action:'LIST',args:{environment:'BETA',roles:['ADMIN']}},{action:'DELETE',args:{environment:'BETA'}},{action:'LIST',args:{environment:'BETA'},actorId:'forged'}])expect((await send(ownerPort,'/internal/b2b/integration-admin','POST',body,'human-step-up','resource')).status).toBe(400);
    const created=await send(ownerPort,'/internal/b2b/integration-admin','POST',{action:'CREATE',args:{environment:'BETA',body:input()}},'human-step-up','resource');expect(created.status).toBe(200);expect(created.body.clientSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(created.body.client).not.toHaveProperty('secretHash');
    const listed=await send(ownerPort,'/internal/b2b/clients?environment=BETA&limit=1','GET',undefined,'human-step-up','resource');expect(listed.status).toBe(200);expect(listed.body.items).toHaveLength(1);
  });
  it('rejects missing/duplicate BETA, pagination on detail routes and absent mutation revision',async()=>{
    const appId=[...f.store.clients.keys()][0];
    for(const path of [base,base+'?environment=PRODUCTION',base+beta+'&environment=BETA',base+'/'+appId+beta+'&limit=1'])expect((await send(apiPort,path)).status).toBe(400);
    expect((await send(apiPort,base+'/'+appId+beta,'PATCH',{enabled:false})).status).toBe(400);
  });
  it('post-write step-up revocation rolls back through both HTTP hops with no secret returned',async()=>{
    const before=structuredClone(f.store.clients),audits=structuredClone(f.store.audits);f.store.onAudit=()=>{f.state.stepUp=false;};
    try { const r=await send(apiPort,base+beta,'POST',input());expect(r.status).toBe(403);expect(r.body).not.toHaveProperty('clientSecret');expect(f.store.clients).toEqual(before);expect(f.store.audits).toEqual(audits); }
    finally { f.store.onAudit=null;f.state.stepUp=true; }
  });
  it('maps bounded owner quota to public 429 with no credential or internal error detail',async()=>{
    // Use one peer/window; no DB or external service is involved.
    let response:any;for(let n=0;n<31;n++){response=await send(apiPort,base+beta);if(response.status===429)break;}
    expect(response.status).toBe(429);expect(response.body).toMatchObject({code:'RATE_LIMITED',retryable:true});expect(response.headers['retry-after']).toBe('60');expect(response.headers['cache-control']).toBe('private, no-store');
  });
});
