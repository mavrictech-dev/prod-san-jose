import 'reflect-metadata';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {createServer,request} from 'node:https';
import {NestFactory} from '../services/billing-service/node_modules/@nestjs/core';
import {createB2bIdentityApplication} from '../services/identity-service/src/b2b/application';
import {B2bWebhookAuthority,B2bWebhookAuthorityModule,B2bErrorFilter} from '../services/identity-service/src/b2b/webhook-authority';
import {createWebhookApplication} from '../services/webhook-service/src/application';
import {ReferenceReceiver} from '../services/webhook-service/src/receiver';
import {HttpDeliveryAuthority} from '../services/webhook-service/src/authority';
import {createB2bDraftApplication} from '../services/b2b-api-service/src/draft-application';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {B2bWebhooks,HttpWebhookOwner} from '../services/b2b-api-service/src/webhooks';
import {B2bPrivateHttp,B2bIdentityHttp} from '../packages/service-access/src/b2b';
import {b2bCertificates,fingerprint as fp} from './b2b-tls.fixture';
import {hookFixture,hookEvent} from './b2b-webhooks.fixture';
import {invoiceBinding} from './b2b-read.fixture';
describe('B2B-05 actual private HTTPS chain and signed synthetic loopback receiver',()=>{
  const apps:any[]=[];let tls:ReturnType<typeof b2bCertificates>,f:Awaited<ReturnType<typeof hookFixture>>,port:number,ownerPort:number,receiver:any,secret:string,sub:any,body:any;
  let effects=0;const inbox=new Map<string,string>(),q='?issuerId=1&environment=BETA';
  function wire(port:number,path:string,method:string,payload?:any,headers:Record<string,string>={},cert?:Buffer){const bytes=payload===undefined?undefined:Buffer.isBuffer(payload)?payload:Buffer.from(JSON.stringify(payload));
    return new Promise<any>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert,key:tls.key,rejectUnauthorized:true,timeout:5000,headers:{...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{}),...headers}},res=>{const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('error',reject);res.on('end',()=>{try{const data=Buffer.concat(chunks).toString();resolve({status:res.statusCode,body:data?JSON.parse(data):null});}catch(e){reject(e);}});});req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('Synthetic HTTPS timeout')));req.end(bytes);});}
  const api=(path:string,method='GET',payload?:unknown,headers:Record<string,string>={},peer:'edge'|'other'='edge')=>wire(port,'/b2b/v1'+path,method,payload,{Authorization:'Bearer '+f.token,...headers},tls[peer]);
  beforeAll(async()=>{
    tls=b2bCertificates();f=await hookFixture();const options={ca:tls.ca,cert:tls.server,key:tls.key};
    const verifier=new ReferenceReceiver(()=>[secret],{accept:async(delivery,event,hash)=>{const old=inbox.get(event);if(old&&old!==hash)throw new Error('Event conflict');if(old)return 'DUPLICATE';inbox.set(event,hash);effects++;return 'ACCEPTED';}});
    receiver=createServer({cert:tls.server,key:tls.key,minVersion:'TLSv1.2'},(req,res)=>{const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));req.on('end',async()=>{try{const bytes=Buffer.concat(chunks),json=JSON.parse(bytes.toString());res.setHeader('Content-Type','application/json');if(json.type==='factuez.webhook.challenge.v1')res.end(JSON.stringify({challenge:json.challenge}));else{body=json;await verifier.receive(bytes,req.headers as Record<string,string>);res.end('{"ok":true}');}}catch{res.statusCode=400;res.end('{"ok":false}');}});});await new Promise<void>(resolve=>receiver.listen(0,'127.0.0.1',resolve));
    // Test-only fixed loopback transport. Production HttpsCallbacks ALWAYS rejects loopback.
    f.callbacks.challenge.mockImplementation(async(_id,challenge)=>{const r=await wire(receiver.address().port,'/callback','POST',{type:'factuez.webhook.challenge.v1',challenge});return r.status===200&&r.body.challenge===challenge;});
    f.callbacks.send.mockImplementation(async(_id,bytes,headers)=>{const r=await wire(receiver.address().port,'/callback','POST',bytes,headers);return {status:r.status};});
    const auth=await createB2bIdentityApplication(f.auth.core,{token:[fp(tls.resource)],resource:[fp(tls.resource)],admin:[fp(tls.other)]},options);apps.push(auth);await auth.listen(0,'127.0.0.1');
    const http=(p:number,cert=tls.resource)=>new B2bPrivateHttp('https://127.0.0.1:'+p,{ca:tls.ca,cert,key:tls.key});
    const identity=new B2bIdentityHttp(http(auth.getHttpServer().address().port));f.identity.authenticate.mockImplementation((t,s,k)=>identity.authenticate(t,s,k));
    const authority=await NestFactory.create(B2bWebhookAuthorityModule.isolated(new B2bWebhookAuthority(f.auth.store,{validate:async()=>{}}),[fp(tls.resource)]),{logger:false,httpsOptions:{...options,requestCert:true,rejectUnauthorized:true}});apps.push(authority);authority.useGlobalFilters(new B2bErrorFilter());await authority.listen(0,'127.0.0.1');
    const queued=new HttpDeliveryAuthority(http(authority.getHttpServer().address().port));f.authority.check.mockImplementation((a,b)=>queued.check(a,b));
    const owner=await createWebhookApplication(f.core,{facade:[fp(tls.resource)],billingPublisher:[fp(tls.edge)]},options);apps.push(owner);await owner.listen(0,'127.0.0.1');ownerPort=owner.getHttpServer().address().port;
    const unbound={execute:async()=>{throw new Error('Not part of webhook fixture');},file:async()=>{throw new Error('Not bound');}};
    const edge=await createB2bDraftApplication(new B2bReads(identity,unbound,unbound),new B2bCommands(identity,unbound),[fp(tls.edge)],options,undefined,new B2bWebhooks(identity,new HttpWebhookOwner(http(ownerPort))));apps.push(edge);await edge.listen(0,'127.0.0.1');port=edge.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{for(const app of apps.reverse())await app.close();if(receiver)await new Promise<void>(r=>receiver.close(()=>r()));});
  it('creates and verifies a subscription through Identity/facade/owner with one-time secret',async()=>{
    const r=await api('/webhook-subscriptions'+q,'POST',{label:'ERP sintético',binding:invoiceBinding,destinationId:'erp_approved',events:['document.issued-locally.v1']},{'Idempotency-Key':'http_hook_create_001'});expect(r.status).toBe(201);sub=r.body;secret=sub.signingSecret;expect(secret).toBeTruthy();
    const v=await api('/webhook-subscriptions/'+sub.id+'/verify'+q,'POST',{}, {'Idempotency-Key':'http_hook_verify_001','If-Match':sub.revision});expect(v.status).toBe(200);expect(v.body.verified).toBe(true);sub=v.body;
    const list=await api('/webhook-subscriptions'+q);expect(list.status).toBe(200);expect(list.body.items).toHaveLength(1);expect(JSON.stringify(list.body)).not.toContain(secret);
  });
  it('accepts a Billing peer event, dispatches a signed minimal payload and records consumer effect once',async()=>{
    const event=hookEvent(),r=await wire(ownerPort,'/internal/b2b/webhook-events','POST',event,{},tls.edge);expect(r.status).toBe(200);expect(r.body.accepted).toBe(true);
    expect((await wire(ownerPort,'/internal/b2b/webhook-events','POST',event,{},tls.edge)).status).toBe(200);await f.core.dispatch();expect(effects).toBe(1);expect(body).toMatchObject({eventName:event.eventType,eventId:event.eventId,payload:{provenance:'LOCAL'}});
    const deliveries=await api('/webhook-deliveries'+q);expect(deliveries.status).toBe(200);expect(deliveries.body.items[0].state).toBe('DELIVERED');const id=deliveries.body.items[0].id;
    const detail=await api('/webhook-deliveries/'+id+q);expect(detail.body.history[0].code).toBe('DELIVERED');
  });
  it('rejects facade-as-publisher, unapproved peers, foreign RUC and forged authority',async()=>{
    expect((await wire(ownerPort,'/internal/b2b/webhook-events','POST',hookEvent(),{},tls.resource)).status).toBe(403);
    expect((await api('/webhook-subscriptions'+q,'GET',undefined,{},'other')).status).toBe(403);
    expect((await api('/webhook-subscriptions?issuerId=2&environment=BETA')).status).toBe(404);
    expect((await api('/webhook-subscriptions?issuerId=1&environment=PRODUCTION')).status).toBe(400);
    expect((await api('/webhook-subscriptions/'+sub.id+q,'PATCH',{actor:{kind:'ADMIN'}},{'Idempotency-Key':'http_hook_forge_001','If-Match':sub.revision})).status).toBe(400);
  });
});
