import 'reflect-metadata';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {NestFactory} from '../services/b2b-api-service/node_modules/@nestjs/core';
import {FactuEzB2bClient,type FactuEzB2bOptions} from '../packages/b2b-sdk/src';
import {B2bReceivedAutomation,B2bReceivedAutomationModule} from '../services/b2b-api-service/src/received-automation';
import {B2bPhase8History,B2bPhase8HistoryModule} from '../services/b2b-api-service/src/phase8-history';
import {B2bEmailDeliveryOperations,B2bEmailDeliveriesModule} from '../services/b2b-api-service/src/email-deliveries';
import {historicalSha256} from '../packages/history-core/src';
import {historyFixture} from './b2b-phase8-reports-history.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {id,scope,localSettings,stepUpHandle} from './helpers/b2b-received-automation.fixture';
import type {ReceptionConfigurationSave} from '../packages/b2b-sdk/src/operations-extra-types';

/** Nine public methods, actual HTTP controllers and history reader, ephemeral pinned mTLS.
 * Automation/email owner ports record staged requests; no connector or delivery worker runs. */
describe('B2B08 SDK nine extra operations over real pinned mTLS',()=>{
  let app:any,tls:ReturnType<typeof b2bCertificates>,origin:string,f:ReturnType<typeof historyFixture>,sdk:FactuEzB2bClient;
  let actor:'USER'|'SERVICE',requests:any[],ownerCalls:any[],configRevision:number,storedSettings:ReturnType<typeof localSettings>;
  let mutate:(value:any,path:string)=>any,mutateFile:(response:any,bytes:Buffer)=>Buffer;
  const key='synthetic_extra_key_0001',now='2026-10-01T15:00:00.000Z',runId=id(70),emailId=id(71),documentId=id(72);
  const bearer=vi.fn(async()=>({token:actor==='SERVICE'?f.auth.token:'synthetic-extra-user',actorKind:actor}));
  const options=():FactuEzB2bOptions=>({origin,tls:{ca:tls.ca,cert:tls.edge,key:tls.key,serverCertificateSha256:fingerprint(tls.server)},bearer});
  const write=()=>({idempotencyKey:key,stepUpHandle});
  const counters=()=>({detected:0,imported:0,duplicate:0,rejected:0,xmlPending:0,matches:0,mismatches:0});
  const config=()=>({scope,revision:configRevision,updatedAt:configRevision?now:null,settings:storedSettings,credentialPresence:{mailPassword:false,sireClientSecret:false,solPassword:false},state:'STAGED_LOCAL',runtimeEnabled:false,networkProfile:'LOCAL_ONLY',fiscalAcceptance:'NOT_VERIFIED'});
  const email=()=>({schemaVersion:'factuez.b2b.email-deliveries.v1',environment:'BETA',candidateOnly:true,id:emailId,documentId,binding:f.binding,format:'a4',state:'QUEUED',profile:'NONE',revision:1,createdAt:now,updatedAt:now,errorCode:null,
    attachments:[{kind:'PDF',fileName:'synthetic-current-a4.pdf',mediaType:'application/pdf',sha256:'a'.repeat(64),byteLength:100,representation:'CURRENT_GENERATED',sourceProofSha256:'b'.repeat(64)}],deliveredToClient:false,fiscalAuthority:false,replayed:false});
  beforeAll(async()=>{
    tls=b2bCertificates();
    const identity={authenticate:async(token:string,required:any[],kind:any)=>token===f.auth.token?{...structuredClone(f.p),scopes:[...f.p.scopes,'b2b:received:sync','b2b:email:read','b2b:email:send','b2b:documents:read'],bindings:[f.binding,{issuerId:scope.companyId,issuerRuc:scope.recipientRuc,environment:'BETA',branchId:scope.branchId,pointId:id(2),seriesId:id(3),documentType:'01'}]}:
      {kind,clientId:id(10),revision:1,subjectId:id(11),userAuthRevision:1,environment:'BETA',scopes:required,bindings:[f.binding,{issuerId:scope.companyId,issuerRuc:scope.recipientRuc,environment:'BETA',branchId:scope.branchId,pointId:id(2),seriesId:id(3),documentType:'01'}]}};
    const automation=new B2bReceivedAutomation(identity as any,{execute:async(access,action,input:any)=>{
      ownerCalls.push({access,action,input:structuredClone(input)});
      if(action==='CONFIG_READ')return config();
      if(action==='CONFIG_SAVE'){configRevision=input.payload.expectedRevision+1;storedSettings=input.payload.settings;return config();}
      if(action==='SYNC_CREATE')return {scope,items:[{runId,source:input.payload.source==='ALL'?'MAIL':input.payload.source,status:'QUEUED',revision:input.payload.expectedRevision,dispatch:'NOT_DISPATCHED'}],mode:'LOCAL_FIXTURE',networkProfile:'LOCAL_ONLY',runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'};
      return {scope,run:{runId,source:'MAIL',status:'QUEUED',revision:1,startedAt:null,finishedAt:null,counters:counters(),errorCode:null},runtimeEnabled:false,fiscalAcceptance:'NOT_VERIFIED'};
    }});
    const history=new B2bPhase8History(fallbackIdentity(),{execute:(a,action,input)=>f.reader.execute(a,action as any,input),content:(a,input)=>f.reader.execute(a,'CONTENT',input)});
    function fallbackIdentity(){return {authenticate:(token:string,required:any,kind:any)=>f.identity.authenticate(token,required,kind)};}
    const deliveries=new B2bEmailDeliveryOperations(identity as any,{execute:async(access,action,input:any)=>{ownerCalls.push({access,action,input:structuredClone(input)});return {...email(),...(action==='CREATE'?{format:input.format}:{})};}});
    const peers=[fingerprint(tls.edge)],httpsOptions={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
    app=await NestFactory.create({module:class ExtraSdkHttpTest{},imports:[B2bReceivedAutomationModule.isolated(automation,peers),B2bPhase8HistoryModule.isolated(history,peers),B2bEmailDeliveriesModule.isolated(deliveries,peers)]},{logger:false,httpsOptions});
    app.use((req:any,res:any,next:any)=>{
      const record:any={method:req.method,path:req.url,headers:{...req.headers},body:undefined};requests.push(record);res.on('finish',()=>{record.body=req.body;});
      const json=res.json,send=res.send;res.json=function(value:any){return json.call(this,mutate(structuredClone(value),req.path));};
      res.send=function(value:any){return send.call(this,Buffer.isBuffer(value)?mutateFile(this,Buffer.from(value)):value);};next();
    });
    await app.listen(0,'127.0.0.1');origin=`https://127.0.0.1:${app.getHttpServer().address().port}`;
  },30000);
  beforeEach(()=>{f=historyFixture();actor='USER';requests=[];ownerCalls=[];configRevision=1;storedSettings=localSettings();mutate=v=>v;mutateFile=(_r,b)=>b;bearer.mockClear();sdk=new FactuEzB2bClient(options());});
  afterEach(()=>{f.close();});afterAll(async()=>{await app?.close();});
  const invalid={code:'INVALID_REQUEST'},badResponse={code:'INVALID_RESPONSE'};
  const last=()=>requests.at(-1)!;
  const queryKeys=()=>[...new URL(last().path,origin).searchParams.keys()].sort();
  const rejectMutations=async(call:()=>Promise<unknown>,changes:((v:any)=>void)[])=>{
    for(const change of changes){mutate=v=>{change(v);return v;};await expect(call()).rejects.toMatchObject(badResponse);}mutate=v=>v;
  };
  it('readReceptionConfiguration: USER route, exactly four scope queries and header-only safe proof',async()=>{
    const scopeInput=structuredClone(scope),proof={stepUpHandle};
    const pending=sdk.readReceptionConfiguration(scopeInput,proof);scopeInput.companyId=2;proof.stepUpHandle='changed-after-call';
    const reply=await pending;expect(reply).toMatchObject({action:'CONFIG_READ',runtimeEnabled:false});expect(last().method).toBe('GET');
    expect(new URL(last().path,origin).pathname).toBe('/b2b/v1/admin/received-connectors/1');expect(queryKeys()).toEqual(Object.keys(scope).sort());expect(last().headers['x-factuez-step-up']).toBe(stepUpHandle);expect(last().body).toBeUndefined();
    expect(ownerCalls.at(-1).input.payload).toEqual({stepUpHandle});
    const count=requests.length;actor='SERVICE';await expect(sdk.readReceptionConfiguration(scope,{stepUpHandle})).rejects.toMatchObject({code:'TOKEN_UNAVAILABLE'});expect(requests).toHaveLength(count);actor='USER';
    let getterCalls=0;const hostile=Object.defineProperty({},'stepUpHandle',{enumerable:true,get(){getterCalls++;return stepUpHandle;}});
    await expect(sdk.readReceptionConfiguration(scope,hostile as any)).rejects.toMatchObject(invalid);expect(getterCalls).toBe(0);
    await rejectMutations(()=>sdk.readReceptionConfiguration(scope,{stepUpHandle}),[v=>{v.runtimeEnabled=true;},v=>{v.credentialPresence.mailPassword='FAKE_PASSWORD';},v=>{v.credentials={mailPassword:'FAKE_PASSWORD'};},v=>{v.settings.mailbox.password='FAKE_PASSWORD';},v=>{v.scope.companyId=2;}]);
  });
  it('saveReceptionConfiguration: actual CAS body, key 16..100, credential isolation and revision binding',async()=>{
    const body:ReceptionConfigurationSave={expectedRevision:1,settings:localSettings(),credentials:{mailPassword:'FAKE_PASSWORD'}};
    const pending=sdk.saveReceptionConfiguration(scope,body,write());body.expectedRevision=99;body.credentials!.mailPassword='changed-after-call';body.settings.intervalMinutes=60;
    const reply=await pending;expect(reply.revision).toBe(2);expect(reply.settings.intervalMinutes).toBe(15);
    expect(last().method).toBe('PATCH');expect(last().headers['idempotency-key']).toBe(key);expect(last().headers['x-factuez-step-up']).toBe(stepUpHandle);
    expect(last().body).toEqual({expectedRevision:1,settings:localSettings(),credentials:{mailPassword:'FAKE_PASSWORD'}});expect(JSON.stringify(reply)).not.toContain('FAKE_PASSWORD');
    const call=()=>sdk.saveReceptionConfiguration(scope,{expectedRevision:1,settings:localSettings()},write());
    await rejectMutations(call,[v=>{v.revision=1;},v=>{v.settings.intervalMinutes=30;},v=>{v.fiscalAcceptance='ACCEPTED';},v=>{v.p12='FAKE_P12';}]);
    const count=requests.length;
    for(const idempotencyKey of ['a'.repeat(15),'a'.repeat(101),'bad/key_1234567890'])await expect(sdk.saveReceptionConfiguration(scope,{expectedRevision:1,settings:localSettings()},{stepUpHandle,idempotencyKey})).rejects.toMatchObject(invalid);
    await expect(sdk.saveReceptionConfiguration(scope,{expectedRevision:1,settings:localSettings(),stepUpHandle} as any,write())).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('createReceptionSync: POST 201 preserves staged NOT_DISPATCHED for USER and SERVICE',async()=>{
    const r=await sdk.createReceptionSync(scope,{source:'MAIL',expectedRevision:1},write());expect(r.items[0].dispatch).toBe('NOT_DISPATCHED');expect(last().method).toBe('POST');expect(new URL(last().path,origin).pathname).toBe('/b2b/v1/received-sync-jobs');expect(last().body).toEqual({source:'MAIL',expectedRevision:1});expect(queryKeys()).toEqual(Object.keys(scope).sort());
    actor='SERVICE';await sdk.createReceptionSync(scope,{source:'SIRE',expectedRevision:1},{idempotencyKey:key});expect(last().headers['x-factuez-step-up']).toBeUndefined();expect(ownerCalls.at(-1).input.payload).toEqual({source:'SIRE',expectedRevision:1});
    await rejectMutations(()=>sdk.createReceptionSync(scope,{source:'MAIL',expectedRevision:1},{idempotencyKey:key}),[v=>{v.items[0].dispatch='DISPATCHED';},v=>{v.items[0].revision=2;},v=>{v.items[0].source='SIRE';},v=>{v.items.push({...v.items[0]});},v=>{v.runtimeEnabled=true;}]);
    const count=requests.length;await expect(sdk.createReceptionSync(scope,{source:'MAIL',expectedRevision:0},write())).rejects.toMatchObject(invalid);await expect(sdk.createReceptionSync(scope,{source:'MAIL',expectedRevision:1},{...write(),idempotencyKey:'a'.repeat(101)})).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('readReceptionSync: UUID action path, exact counters, status and no fabricated dispatch',async()=>{
    const r=await sdk.readReceptionSync(scope,runId,{stepUpHandle});expect(r.run.counters).toEqual(counters());expect(new URL(last().path,origin).pathname).toBe('/b2b/v1/received-sync-jobs/'+runId);expect(last().headers['x-factuez-step-up']).toBe(stepUpHandle);expect(last().body).toBeUndefined();
    await rejectMutations(()=>sdk.readReceptionSync(scope,runId),[v=>{v.run.runId=id(99);},v=>{v.run.counters.detected=-1;},v=>{v.run.counters.password='FAKE';},v=>{v.run.credentials='FAKE';},v=>{v.fiscalAcceptance='ACCEPTED';}]);
    const count=requests.length;await expect(sdk.readReceptionSync(scope,'../remote')).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('listHistory: seven-key binding, real owner view and 64-hex keyset cursor',async()=>{
    actor='SERVICE';const r=await sdk.listHistory(f.binding,{take:1});expect(r.data.items[0].recordId).toBe(f.recordId);expect(r.data.nextCursor).toBe(f.recordId);expect(queryKeys()).toEqual([...Object.keys(f.binding),'take'].sort());
    f.tx.historyRecord.findMany.mockResolvedValue([]);const empty=await sdk.listHistory(f.binding,{take:1,afterRecordId:f.recordId});expect(empty.data).toEqual({items:[],nextCursor:null});expect(new URL(last().path,origin).searchParams.get('afterRecordId')).toBe(f.recordId);f.tx.historyRecord.findMany.mockResolvedValue([f.row]);
    await rejectMutations(()=>sdk.listHistory(f.binding,{take:1}),[v=>{v.data.items[0].transmission=true;},v=>{v.data.items[0].companyId=99;},v=>{v.data.nextCursor='a'.repeat(64);},v=>{v.data.items[0].recipient='LEAK';},v=>{v.datasetClass='REAL';}]);
    await expect(sdk.listHistory(f.binding,{take:1,afterRecordId:f.recordId})).rejects.toMatchObject(badResponse);
    const count=requests.length;for(const query of [{take:0},{take:101},{afterRecordId:id(1)},{url:'https://remote.invalid'}])await expect(sdk.listHistory(f.binding,query as any)).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('readHistoricalDocument: actual detail snapshot and quarantine policy, tamper/secret/false-flag rejection',async()=>{
    actor='SERVICE';const r=await sdk.readHistoricalDocument(f.binding,f.recordId);expect(r.data.snapshot).toEqual(f.plan.records[0].snapshot);expect(r.data).not.toHaveProperty('schemaVersion');expect(r.data).not.toHaveProperty('artifactKeys');expect(queryKeys()).toEqual(Object.keys(f.binding).sort());
    await rejectMutations(()=>sdk.readHistoricalDocument(f.binding,f.recordId),[v=>{v.data.snapshot.observations='ALTERED';},v=>{v.data.snapshotSha256='f'.repeat(64);},v=>{v.data.snapshot.ownership.emissionPointId=id(99);},v=>{v.data.transmission=true;},v=>{v.data.countersChanged=true;},v=>{v.readOnly=false;},v=>{v.data.artifactKeys=[{key:'remote/path'}];},v=>{v.data.snapshot.sourceEvidence.authenticity='VERIFIED';},v=>{v.data.snapshot.issuer.credentials='FAKE';}]);
    const count=requests.length;for(const recordId of [id(1),'A'.repeat(64),'a'.repeat(63),'https://remote.invalid/file'])await expect(sdk.readHistoricalDocument(f.binding,recordId)).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('downloadHistoricalArtifact: content digest/MIME/length/disposition and metadata before/after actual bytes',async()=>{
    actor='SERVICE';const r=await sdk.downloadHistoricalArtifact(f.binding,f.recordId,'SIGNED_XML');expect(r.artifact).toEqual(f.row.snapshot.artifacts.find((a:any)=>a.kind==='SIGNED_XML'));expect(r.bytes.toString()).toContain('SIN FIRMA');expect(requests.map(r=>new URL(r.path,origin).pathname)).toEqual([`/b2b/v1/history/documents/${f.recordId}`,`/b2b/v1/history/documents/${f.recordId}/artifacts/SIGNED_XML`,`/b2b/v1/history/documents/${f.recordId}`]);expect(bearer).toHaveBeenCalledTimes(3);
    for(const change of [(res:any,b:Buffer)=>{b[0]^=1;return b;},(res:any,b:Buffer)=>{res.setHeader('X-Content-Sha256','0'.repeat(64));return b;},(res:any,b:Buffer)=>{res.setHeader('Content-Type','application/pdf');return b;},(res:any,b:Buffer)=>{res.setHeader('Content-Disposition','attachment; filename="https://remote.invalid/a.xml"');return b;},(res:any,b:Buffer)=>{res.setHeader('Content-Length',String(b.length-1));return b.subarray(0,-1);}]){
      mutateFile=change;await expect(sdk.downloadHistoricalArtifact(f.binding,f.recordId,'SIGNED_XML')).rejects.toMatchObject({code:'ARTIFACT_INTEGRITY_FAILED'});
    }mutateFile=(_r,b)=>b;
    let details=0;mutate=(v,path)=>{if(path.endsWith(f.recordId)&&++details===2){v.data.snapshot.observations='CHANGED AFTER FILE';v.data.snapshotSha256=historicalSha256(v.data.snapshot);}return v;};
    await expect(sdk.downloadHistoricalArtifact(f.binding,f.recordId,'SIGNED_XML')).rejects.toMatchObject({code:'ARTIFACT_CHANGED'});mutate=v=>v;
    await expect(sdk.downloadHistoricalArtifact(f.binding,f.recordId,'PDF_A4')).rejects.toMatchObject({code:'ARTIFACT_NOT_FOUND'});
    const count=requests.length;for(const kind of ['XML','../SIGNED_XML','https://remote.invalid/a.xml'])await expect(sdk.downloadHistoricalArtifact(f.binding,f.recordId,kind as any)).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('requestDocumentEmail: HTTP 202 with no query and exact body/key, detached recipient and safe metadata',async()=>{
    const body={recipient:'ficticio@pruebas.invalid',format:'a4' as const},binding=structuredClone(f.binding),opts={idempotencyKey:key};const pending=sdk.requestDocumentEmail(binding,documentId,body,opts);body.recipient='changed@pruebas.invalid';binding.issuerId=99;opts.idempotencyKey='changed_key_123456';const r=await pending;
    expect(r).toMatchObject({id:emailId,deliveredToClient:false,profile:'NONE'});expect(last().path).toBe(`/b2b/v1/documents/${documentId}/email-deliveries`);expect(last().headers['idempotency-key']).toBe(key);expect(last().headers['x-factuez-step-up']).toBeUndefined();expect(last().body).toEqual({binding:f.binding,recipient:'ficticio@pruebas.invalid',format:'a4'});expect(JSON.stringify(r)).not.toContain('ficticio@pruebas.invalid');
    await rejectMutations(()=>sdk.requestDocumentEmail(f.binding,documentId,{recipient:'ficticio@pruebas.invalid',format:'a4'},{idempotencyKey:key}),[v=>{v.documentId=id(99);},v=>{v.binding.issuerId=2;},v=>{v.format='ticket';},v=>{v.recipient='LEAK';},v=>{v.deliveredToClient=true;},v=>{v.attachments[0].bytes='LEAK';}]);
    const count=requests.length;await expect(sdk.requestDocumentEmail(f.binding,documentId,{recipient:'bad\r\nBcc:remote@example.invalid',format:'a4'},{idempotencyKey:key})).rejects.toMatchObject(invalid);await expect(sdk.requestDocumentEmail(f.binding,documentId,{recipient:'a@b.invalid',format:'a4'},{idempotencyKey:'a'.repeat(101)})).rejects.toMatchObject(invalid);expect(requests).toHaveLength(count);
  });
  it('readEmailDelivery: HTTP 200 no query, closed metadata, credential-safe errors and TLS pin failure',async()=>{
    const r=await sdk.readEmailDelivery(emailId);expect(r.id).toBe(emailId);expect(last().path).toBe('/b2b/v1/email-deliveries/'+emailId);expect(last().method).toBe('GET');expect(last().body).toBeUndefined();
    await rejectMutations(()=>sdk.readEmailDelivery(emailId),[v=>{v.id=id(99);},v=>{v.fiscalAuthority=true;},v=>{v.recipient='LEAK';},v=>{v.Bearer='FAKE_BEARER';},v=>{v.p12='FAKE_P12';},v=>{v.attachments[0].credentials='FAKE_PASSWORD';},v=>{v.attachments[0].sha256='INVALID';},v=>{v.attachments[0].fileName='https://remote.invalid/a.pdf';}]);
    mutate=v=>({...v,recipient:'FAKE_SECRET_RECIPIENT'});const error=await sdk.readEmailDelivery(emailId).catch(e=>e);expect(error.code).toBe('INVALID_RESPONSE');expect(JSON.stringify(error)).not.toMatch(/FAKE_SECRET|recipient|Bearer|P12/);mutate=v=>v;
    const count=requests.length;const wrongPin=new FactuEzB2bClient({...options(),tls:{...options().tls,serverCertificateSha256:'0'.repeat(64)}});await expect(wrongPin.readEmailDelivery(emailId)).rejects.toMatchObject({code:'TLS_OR_NETWORK_ERROR'});expect(requests).toHaveLength(count);
  });
});


