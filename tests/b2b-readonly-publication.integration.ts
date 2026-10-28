import {createIdentityReadonlyOwner} from '../services/identity-service/src/b2b/readonly-owner-runtime';
import {createBillingReadonlyOwner} from '../services/billing-service/src/b2b/readonly-owner-runtime';
import {createFiscalReadonlyOwner} from '../services/sunat-service/src/b2b/readonly-owner-runtime';
import 'reflect-metadata';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {request,createServer,type Server} from 'node:https';
import {createServer as netServer} from 'node:net';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createHmac,createHash,generateKeyPairSync,randomBytes,randomUUID} from 'node:crypto';
import {B2bPrivateHttp,B2bIdentityHttp,B2bBindingCatalogueHttp} from '../packages/service-access/src/b2b';
import {ArtifactStore} from '../services/sunat-service/src/infrastructure/artifact-store';
import {HookVault,verifyWebhook} from '../services/webhook-service/src/crypto';
import {HttpDeliveryAuthority} from '../services/webhook-service/src/authority';
import {PostgresHookStore} from '../services/webhook-service/src/store';
import {createWebhookOwnerRuntime} from '../services/webhook-service/src/runtime';
import {bootstrapB2bReadonly} from '../services/b2b-api-service/src/readonly-main';
import {verifyB2bReadonlyOwners} from '../services/b2b-api-service/src/readonly-runtime-assembly';
import {assembleB2bFacade} from '../services/b2b-api-service/src/runtime-assembly';
import {readonlyPostgres} from './helpers/b2b-readonly-postgres';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';

async function ports(count:number){
 const held:any[]=[],result:number[]=[];
 try{
  for(let port=9000;port<=9099&&result.length<count;port++){
   const s=netServer();try{await new Promise<void>((ok,no)=>{s.once('error',no);s.listen(port,'127.0.0.1',()=>ok());});held.push(s);result.push(port);}catch{s.close();}
  }
  if(result.length!==count)throw Error('REVIEW_LOOPBACK_PORTS_UNAVAILABLE');return result;
 }finally{await Promise.all(held.map(s=>new Promise<void>(r=>s.close(()=>r()))));}
}
describe.sequential('published READONLY + OAuth + persistent webhook profile over real HTTPS/mTLS',()=>{
 const apps:any[]=[];const ownerRuntimes:any[]=[];let db:Awaited<ReturnType<typeof readonlyPostgres>>,tls:ReturnType<typeof b2bCertificates>,p:number[],root:string;
 let api:Awaited<ReturnType<typeof bootstrapB2bReadonly>>,hooks:Awaited<ReturnType<typeof createWebhookOwnerRuntime>>,callback:Server;
 let resources:any,config:any,token:string,subscription:any,secret:string;let callbackCount=0,policyRevision=1;
 const deploymentId=randomUUID(),clientId=randomUUID(),clientSecret=randomBytes(32).toString('base64url'),documentId=randomUUID(),artifactId=randomUUID();
 const binding={issuerId:1,issuerRuc:'10000000001',environment:'BETA',branchId:randomUUID(),pointId:randomUUID(),seriesId:randomUUID(),documentType:'01'};
 const scopes=['b2b:context:read','b2b:catalog:read','b2b:documents:read','b2b:artifacts:read','b2b:webhooks:read','b2b:webhooks:manage'];
 const bytes=Buffer.from('<SYNTHETIC>NOT-OFFICIAL-NOT-SIGNED</SYNTHETIC>');
 const query='?issuerId=1&environment=BETA',env=()=>({B2B_READONLY_API_ENABLED:'true',B2B_PRIVATE_ACCESS:'true',B2B_READONLY_CONFIG_ROOT:root});
 const basic='Basic '+Buffer.from(clientId+':'+clientSecret).toString('base64');
 const policy=(mode:'OPEN'|'PAUSED')=>writeFileSync(join(root,'b2b-operations.json'),JSON.stringify({environment:'BETA',revision:++policyRevision,mode}),{mode:0o600});
 const transport=(port:number,peer:'resource'|'other'='resource')=>new B2bPrivateHttp('https://127.0.0.1:'+port,{ca:tls.ca,cert:tls[peer],key:tls.key});
 function send(path:string,options:{method?:string;body?:string;headers?:Record<string,string>;peer?:'edge'|'resource'|'other'|null;port?:number;token?:string}={}){
  return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((ok,no)=>{
   const peer=options.peer===undefined?'edge':options.peer;
   const req=request({hostname:'127.0.0.1',port:options.port??p[5],path,method:options.method??'GET',ca:tls.ca,rejectUnauthorized:true,minVersion:'TLSv1.2',timeout:10000,
    ...(peer?{cert:tls[peer],key:tls.key}:{}),headers:{Authorization:'Bearer '+(options.token??token),...(options.body?{'Content-Length':String(Buffer.byteLength(options.body))}:{}),...options.headers}},res=>{
     const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('error',no);res.on('end',()=>{
      const data=Buffer.concat(chunks);try{ok({status:res.statusCode!,bytes:data,body:res.headers['content-type']?.includes('application/json')?JSON.parse(data.toString()):null,headers:res.headers});}catch(e){no(e);}
     });
    });req.on('error',no);req.on('timeout',()=>req.destroy(Error('SYNTHETIC_HTTPS_TIMEOUT')));req.end(options.body);
  });
 }
 const oauth=(scope=scopes.join(' '),authorization=basic)=>send('/b2b/oauth/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',scope}).toString(),
  headers:{Authorization:authorization,'Content-Type':'application/x-www-form-urlencoded'}});
 const command=(path:string,body:unknown={},headers:Record<string,string>={})=>send(path,{method:'POST',body:JSON.stringify(body),
  headers:{'Content-Type':'application/json','Idempotency-Key':'synthetic_'+randomBytes(12).toString('hex'),...headers}});
 beforeAll(async()=>{
  tls=b2bCertificates();p=await ports(8);db=await readonlyPostgres();root=mkdtempSync(join(tmpdir(),'factuez-readonly-profile-'));
  const serverTls={ca:tls.ca,cert:tls.server,key:tls.key},resourcePeers=[fingerprint(tls.resource)];
  const pepper=randomBytes(32),key=generateKeyPairSync('rsa',{modulusLength:2048}),other=generateKeyPairSync('rsa',{modulusLength:2048});
  const publicKey=Buffer.from(other.publicKey.export({type:'spki',format:'pem'}));
  // Explicit synthetic enrollment into this NEW database only; no SSO grant is fabricated.
  await db.identity.$executeRawUnsafe('INSERT INTO "B2bClient" ("id","label","kind","enabled","revision","secretHash","scopes","bindings") VALUES ($1::uuid,$2,$3,true,1,$4,$5::jsonb,$6::jsonb)',
   clientId,'SYNTHETIC READONLY CLIENT','SERVICE',createHmac('sha256',pepper).update('secret:'+clientSecret).digest('hex'),JSON.stringify(scopes),JSON.stringify([binding]));
  const ownerOptions=(port:number)=>({enabled:true,B2B_PRIVATE_ACCESS:true,environment:'BETA' as const,deploymentId,
   listen:{host:'127.0.0.1' as const,port},tls:serverTls,callers:resourcePeers});
  const auth=await createIdentityReadonlyOwner({...ownerOptions(p[0]),tokenPeers:[fingerprint(tls.other)],webhookPeers:resourcePeers,
   billingOrigin:'https://127.0.0.1:'+p[1],billingTls:{...serverTls,cert:tls.resource},tokenIssuer:'https://identity.synthetic.invalid'},
   db.identity as any,{signingKey:Buffer.from(key.privateKey.export({type:'pkcs8',format:'pem'})),pepper,humanPublicKey:publicKey,integrationPublicKey:publicKey});
  ownerRuntimes.push(auth);await auth!.start();
  const identity=new B2bIdentityHttp(transport(p[0]));
  await db.billing.companySettings.create({data:{id:1,ruc:binding.issuerRuc,legalName:'SYNTHETIC ONLY',companyType:'QA',economicActivities:[],taxAddress:'SYNTHETIC',ubigeo:'150101',contactEmails:[],environment:'BETA'}});
  await db.billing.branch.create({data:{id:binding.branchId,companyId:1,code:'SYN',name:'SYNTHETIC'}});
  await db.billing.emissionPoint.create({data:{id:binding.pointId,companyId:1,branchId:binding.branchId,code:'0000',name:'SYNTHETIC'}});
  await db.billing.seriesCounter.create({data:{id:binding.seriesId,companyId:1,emissionPointId:binding.pointId,documentType:'INVOICE',series:'F001'}});
  const snapshot={companyId:1,branchId:binding.branchId,environment:'BETA',documentId,documentTypeCode:'01',series:'F001',number:'00000001',fullNumber:'F001-00000001',
   issueDate:'2026-01-02T12:00:00.000Z',currencyCode:'PEN',operationTypeCode:'0101',
   issuer:{identityType:'6',identityNumber:binding.issuerRuc,legalName:'SYNTHETIC ONLY',address:'SYNTHETIC',ubigeo:'150101'},
   customer:{identityType:'6',identityNumber:'00000000002',legalName:'SYNTHETIC ONLY'},
   lines:[{lineNumber:1,productCode:'SYN',description:'SYNTHETIC',unitCode:'NIU',quantity:'1.000',unitValue:'100.000000',unitPriceWithTax:'118.000',lineExtensionAmount:'100.00',igvAmount:'18.00',igvRate:'18.00',taxAffectationCode:'10'}],
   totals:{taxableAmount:'100.00',igvAmount:'18.00',payableAmount:'118.00'}};
  await db.billing.document.create({data:{id:documentId,companyId:1,seriesCounterId:binding.seriesId,emissionPointId:binding.pointId,type:'INVOICE',status:'ISSUED',
   series:'F001',number:1n,fullNumber:'F001-00000001',issueDate:new Date(snapshot.issueDate),customerIdentityType:'6',customerIdentityNumber:'00000000002',
   customerLegalName:'SYNTHETIC ONLY',taxableAmount:'100',igvAmount:'18',payableAmount:'118',immutableSnapshot:snapshot}});
  // Every owner performs its own independent Identity introspection.
  const billingOwner=await createBillingReadonlyOwner({...ownerOptions(p[1]),identityOrigin:'https://127.0.0.1:'+p[0],
   identityTls:{...serverTls,cert:tls.resource},registrar:resourcePeers},db.billing);
  ownerRuntimes.push(billingOwner);await billingOwner!.start();
  mkdirSync(join(root,'artifacts'),{mode:0o700});const storage=new ArtifactStore(join(root,'artifacts')),artifact=await storage.put(documentId,'synthetic.xml',bytes);
  await db.fiscal.fiscalDocument.create({data:{documentId,issuerRuc:binding.issuerRuc,documentType:'01',series:'F001',number:1n,environment:'BETA',billingEventId:randomUUID(),immutablePayload:snapshot}});
  await db.fiscal.documentArtifact.create({data:{id:artifactId,documentId,kind:'SIGNED_XML',mediaType:'application/xml',...artifact,sizeBytes:BigInt(artifact.sizeBytes)}});
  const fiscalOwner=await createFiscalReadonlyOwner({...ownerOptions(p[2]),identityOrigin:'https://127.0.0.1:'+p[0],
   identityTls:{...serverTls,cert:tls.resource},billingOrigin:'https://127.0.0.1:'+p[1],billingTls:{...serverTls,cert:tls.resource},
   artifactsRoot:join(root,'artifacts')},db.fiscal);
  ownerRuntimes.push(fiscalOwner);await fiscalOwner!.start();
  callback=createServer({...serverTls,requestCert:true,rejectUnauthorized:true},(req,res)=>{
   const chunks:Buffer[]=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{
    const raw=Buffer.concat(chunks);
    try{
     if(req.url==='/challenge'){res.setHeader('Content-Type','application/json');res.end(raw);}
     else{verifyWebhook([secret],raw,req.headers as any,Date.now());callbackCount++;res.writeHead(204);res.end();}
    }catch{res.writeHead(400);res.end();}
   });
  });await new Promise<void>(r=>callback.listen(p[7],'127.0.0.1',r));
  const callbackHttp=(path:string,raw:Buffer,headers:Record<string,string>={})=>new Promise<{status:number;body:string}>((ok,no)=>{
   const req=request({hostname:'127.0.0.1',port:p[7],path,method:'POST',...serverTls,cert:tls.resource,rejectUnauthorized:true,
    headers:{'Content-Length':String(raw.length),...headers}},res=>{
    const chunks:Buffer[]=[];res.on('data',b=>chunks.push(b));res.on('end',()=>ok({status:res.statusCode!,body:Buffer.concat(chunks).toString()}));res.on('error',no);
   });req.on('error',no);req.end(raw);
  });
  hooks=await createWebhookOwnerRuntime({enabled:true,deploymentId,instanceId:randomUUID(),database:{query:db.hooks.query.bind(db.hooks),connect:db.hooks.connect.bind(db.hooks),end:async()=>{}},
   identity,authority:new HttpDeliveryAuthority(transport(p[0])),vault:new HookVault(randomBytes(32)),dispatchEnabled:false,
   callbacks:{ids:()=>['synthetic-loopback'],challenge:async(_id,c)=>{const r=await callbackHttp('/challenge',Buffer.from(JSON.stringify({challenge:c})));return r.status===200&&JSON.parse(r.body).challenge===c;},
    send:async(_id,raw,headers)=>{const r=await callbackHttp('/event',raw,headers);return {status:r.status};}},
   peers:{facade:resourcePeers,billingPublisher:[fingerprint(tls.other)]},operatorPeers:[fingerprint(tls.server)],tls:serverTls,host:'127.0.0.1',port:p[3],maintenancePort:p[4]});
  await hooks!.start();
  config={schemaVersion:'factuez.b2b.readonly-runtime.v1',profile:'READONLY_OAUTH_WEBHOOKS',environment:'BETA',approvedForPrivateBeta:true,deploymentId,instanceId:randomUUID(),
   listen:{host:'127.0.0.1',port:p[5],maintenancePort:p[6]},edgePeers:[fingerprint(tls.edge)],operatorPeers:[fingerprint(tls.server)],
   origins:Object.fromEntries(['identity','billing','fiscal','webhooks'].map((owner,i)=>[owner,'https://127.0.0.1:'+p[i]]))};
  for(const [name,value]of Object.entries({'readonly-runtime.json':JSON.stringify(config),'ca.pem':tls.ca,'server.crt':tls.server,'server.key':tls.key,'resource.crt':tls.resource,'resource.key':tls.key,'oauth.crt':tls.other,'oauth.key':tls.key}))
   writeFileSync(join(root,name),value,{mode:0o600});
  policy('PAUSED');api=await bootstrapB2bReadonly(env());resources=Object.fromEntries(Object.entries(config.origins).map(([owner,origin])=>[owner,new B2bPrivateHttp(origin as string,{ca:tls.ca,cert:tls.resource,key:tls.key})]));
 },120000);
 afterAll(async()=>{
  await api?.close();await hooks?.worker.close();await hooks?.app.close();await hooks?.maintenance.closeListener();
  for(const app of apps.reverse())await app.close();
  for(const owner of ownerRuntimes.reverse())await owner?.close();
  if(callback)await new Promise<void>(r=>callback.close(()=>r()));
  await db?.close();
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep)||!basename(root).startsWith('factuez-readonly-profile-'))throw Error('CLEANUP_OUTSIDE_SYNTHETIC_ROOT');rmSync(root,{recursive:true,force:true});}
 },30000);
 it('starts paused with four real storage-checked owners; fullgraph still rejects this subset',async()=>{
  expect(api!.proof.owners).toEqual(['identity','billing','fiscal','webhooks']);expect((await oauth()).status).toBe(503);
  expect(()=>assembleB2bFacade({resources,administrators:{}} as any,{} as any)).toThrow('COMPLETE_B2B_HTTP_OWNER_GRAPH_REQUIRED');
  await expect(verifyB2bReadonlyOwners(resources,randomUUID())).rejects.toThrow('B2B_READONLY_OWNER_NOT_READY');
  policy('OPEN');const r=await oauth();expect(r.status).toBe(200);token=r.body.access_token;
  expect(r.headers['cache-control']).toBe('private, no-store');expect(r.headers.pragma).toBe('no-cache');
 });
 it('relays standard OAuth errors and rejects scope escalation and duplicate form fields',async()=>{
  expect((await oauth(scopes.join(' '),'Basic '+Buffer.from(clientId+':'+randomBytes(32).toString('base64url')).toString('base64'))).body).toEqual({error:'invalid_client'});
  expect((await oauth('b2b:documents:issue')).status).toBe(403);
  const duplicate=await send('/b2b/oauth/token',{method:'POST',body:'grant_type=client_credentials&scope=b2b%3Acontext%3Aread&scope=b2b%3Adocuments%3Aissue',
   headers:{Authorization:basic,'Content-Type':'application/x-www-form-urlencoded'}});expect(duplicate.status).toBe(400);
 });
 it('publishes accurate capabilities and reads the actual Billing snapshot and Fiscal disk original',async()=>{
  const caps=await send('/b2b/v1/capabilities?environment=BETA');
  expect(caps.status).toBe(200);expect(caps.body.publishedProfile.fullGraphReady).toBe(false);expect(caps.body.executionReadiness).toBe('NOT_PROBED');
  for(const id of ['document-drafts','exports','customers','history','integration-admin'])expect(caps.body.features.find((f:any)=>f.id===id).state).toBe('NOT_IMPLEMENTED');
  expect((await send('/b2b/v1/series'+query)).body.items[0].id).toBe(binding.seriesId);
  const document=await send('/b2b/v1/documents/'+documentId+query);expect(document.status).toBe(200);expect(document.body.state.fiscal).toBe('NOT_VERIFIED');
  const file=await send('/b2b/v1/artifacts/'+artifactId+'/content'+query);expect(file.status).toBe(200);expect(file.bytes).toEqual(bytes);
  expect(file.headers['x-content-sha256']).toBe(createHash('sha256').update(bytes).digest('hex'));
  expect((await db.fiscal.$queryRawUnsafe('SELECT count(*)::int AS n FROM "B2bArtifactAudit"'))[0].n).toBe(1);
 });
 it('rejects business mutations, administration, internal ports, mixed issuer and production',async()=>{
  for(const path of ['/document-drafts','/exports','/sales-notes','/admin/applications','/received-documents'])
   expect((await command('/b2b/v1'+path+query)).status).toBe(405);
  expect((await send('/internal/b2b/runtime-status',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}})).status).toBe(405);
  expect((await send('/b2b/v1/documents/'+documentId+'?issuerId=2&environment=BETA')).status).toBe(404);
  expect((await send('/b2b/v1/documents/'+documentId+'?issuerId=1&environment=PRODUCTION')).status).toBe(400);
  expect((await send('/b2b/v1/me',{headers:{'X-FactuEz-Actor-Kind':'USER'}})).status).toBe(503);
 });
 it('requires TLS trust and distinct edge, token and owner certificate permissions',async()=>{
  await expect(send('/b2b/v1/me',{peer:null})).rejects.toThrow();
  expect((await send('/b2b/v1/me',{peer:'resource'})).status).toBe(403);
  expect((await send('/b2b/v1/me',{peer:'other'})).status).toBe(403);
  const denied=await send('/b2b/oauth/token',{port:p[0],peer:'resource',method:'POST',body:new URLSearchParams({grant_type:'client_credentials',scope:'b2b:context:read'}).toString(),
   headers:{Authorization:basic,'Content-Type':'application/x-www-form-urlencoded'}});expect(denied.status).toBe(403);
  await expect(transport(p[1],'other').post('/internal/b2b/read',{kind:'SERVICE',action:'catalog',args:{environment:'BETA'}},token)).rejects.toMatchObject({status:403});
 });
 it('persists webhook subscription and verification through facade to PostgreSQL with real HTTPS challenge',async()=>{
  const r=await command('/b2b/v1/webhook-subscriptions'+query,{binding,label:'SYNTHETIC ONLY',destinationId:'synthetic-loopback',events:['document.issued-locally.v1']});
  expect(r.status).toBe(201);subscription=r.body;secret=r.body.signingSecret;expect(secret).toBeTruthy();
  const verified=await command('/b2b/v1/webhook-subscriptions/'+subscription.id+'/verify'+query,{}, {'If-Match':subscription.revision});
  expect(verified.status).toBe(200);expect(verified.body.verified).toBe(true);
  expect((await db.hooks.query('SELECT count(*)::int AS n FROM "WebhookSubscription"')).rows[0].n).toBe(1);
 });
 it('delivers a synthetic local event through private ingestion and HMAC-signed HTTPS, with durable attempt history',async()=>{
  const event={schemaVersion:'factuez.b2b.v1',eventId:randomUUID(),eventType:'document.issued-locally.v1',operationId:randomUUID(),commandId:randomUUID(),draftId:randomUUID(),
   documentId,context:binding,occurredAt:new Date().toISOString(),snapshotSha256:'a'.repeat(64),fiscalAcceptance:'NOT_ASSERTED'};
  const publisher=transport(p[3],'other');await publisher.post('/internal/b2b/webhook-events',event);
  await publisher.post('/internal/b2b/webhook-events',event);await hooks!.core.dispatch();
  const list=await send('/b2b/v1/webhook-deliveries'+query);expect(list.status).toBe(200);expect(list.body.items).toHaveLength(1);expect(list.body.items[0].state).toBe('DELIVERED');
  const detail=await send('/b2b/v1/webhook-deliveries/'+list.body.items[0].id+query);expect(detail.body.history.length).toBeGreaterThan(0);expect(callbackCount).toBe(1);
  expect((await db.hooks.query('SELECT count(*)::int AS n FROM "WebhookInbox"')).rows[0].n).toBe(1);
 });
 it('keeps subscription and token usable after restarting the facade; projected secrets stay private',async()=>{
  await api!.close();policy('PAUSED');api=await bootstrapB2bReadonly(env());policy('OPEN');
  const r=await send('/b2b/v1/webhook-subscriptions'+query);expect(r.status).toBe(200);expect(r.body.items[0].id).toBe(subscription.id);
  expect(JSON.stringify(r.body)).not.toContain(secret);
  const persisted=await PostgresHookStore.isolated(db.hooks);expect(persisted).toBeTruthy();
 });
 it('immediately honors database revocation for OAuth, downloads and queued webhook delivery',async()=>{
  const event={schemaVersion:'factuez.b2b.v1',eventId:randomUUID(),eventType:'document.issued-locally.v1',operationId:randomUUID(),commandId:randomUUID(),draftId:randomUUID(),
   documentId,context:binding,occurredAt:new Date().toISOString(),snapshotSha256:'b'.repeat(64),fiscalAcceptance:'NOT_ASSERTED'};
  await transport(p[3],'other').post('/internal/b2b/webhook-events',event);
  await db.identity.$executeRawUnsafe('UPDATE "B2bClient" SET "enabled"=false,"revision"="revision"+1 WHERE "id"=$1::uuid',clientId);
  expect((await oauth()).status).toBe(401);expect((await send('/b2b/v1/artifacts/'+artifactId+'/content'+query)).status).toBe(401);
  await hooks!.core.dispatch();expect(callbackCount).toBe(1);
  const states=(await db.hooks.query('SELECT "state" FROM "WebhookDelivery"')).rows.map((v:any)=>v.state);expect(states).toContain('CANCELLED');
 });
 it('fails startup after real owner storage loss; no stale receipt starts a new facade',async()=>{
  await api!.close();api=null;policy('PAUSED');
  await db.fiscal.$executeRawUnsafe('ALTER TABLE "B2bArtifactAudit" RENAME TO "SyntheticAuditOffline"');
  await expect(bootstrapB2bReadonly(env())).rejects.toMatchObject({status:503});
 });
});
