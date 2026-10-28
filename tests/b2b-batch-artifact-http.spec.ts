import 'reflect-metadata';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {request} from 'node:https';
import {NestFactory} from '../services/sunat-service/node_modules/@nestjs/core';
import {BatchLocalArtifactPipeline,createBatchLocalSigner} from '../services/sunat-service/src/application/batch-local-artifacts';
import {BatchArtifactApi} from '../services/sunat-service/src/application/batch-artifact-api';
import {BatchArtifactModule} from '../services/sunat-service/src/batch-artifact-http';
import {B2bBatchArtifacts,B2bBatchArtifactModule,HttpB2bBatchArtifactOwner} from '../services/b2b-api-service/src/batch-artifacts';
import {B2bPrivateHttp} from '../packages/service-access/src/b2b';
import {createGuideSidecarPki,zipSync} from './helpers/guide-sidecar-ephemeral-pki.fixture';
import {supplementCommandFixture,supplementUuid} from './helpers/fiscal-supplement.fixture';
import {cdrXml} from './helpers/beta-document-evidence.fixture';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';

/** Real HTTPS/mTLS + real ephemeral XMLDSig/CDR. Storage and Identity are explicit
 * in-memory ports here; the isolated DB suite exercises actual PostgreSQL owners. */
describe('RC/RA consumer → private fiscal owner original files',()=>{
  let tls:ReturnType<typeof b2bCertificates>,pki:ReturnType<typeof createGuideSidecarPki>,ownerApp:any,app:any,port:number;
  let record:any,cdr:any,source:any,api:BatchArtifactApi,core:BatchLocalArtifactPipeline,revoked=false;
  const data=supplementCommandFixture('RC'),scope={environment:'BETA' as const,issuerRuc:data.doc.issuer.identityNumber,
    companyId:99,branchId:data.doc.branchId!,batchId:data.batch!.documentId};
  const access={token:'synthetic-batch-artifact-token',kind:'SERVICE' as const};
  const principal={kind:'SERVICE' as const,clientId:supplementUuid(50),revision:1,subjectId:null,userAuthRevision:null,environment:'BETA' as const,
    scopes:['b2b:batches:read','b2b:batches:write','b2b:artifacts:read'],bindings:[{issuerId:99,issuerRuc:scope.issuerRuc,environment:'BETA' as const,
      branchId:scope.branchId,pointId:supplementUuid(51),seriesId:supplementUuid(52),documentType:'03' as const}]};
  const identity={authenticate:vi.fn(async()=>{if(revoked)throw new Error('SYNTHETIC_REVOKED');return structuredClone(principal);})};
  const owner={current:async()=>{if(revoked)throw new Error('REVOKED');return {command:structuredClone(data.command),authorizationSha256:'a'.repeat(64)};}};
  const keys={acquire:vi.fn(async(ruc:string,purpose:'LOCAL_SYNTHETIC_BATCH')=>({ruc,purpose,p12:Buffer.from(pki.issuer.pkcs12),password:pki.password,
    certificatePem:pki.issuer.certificatePem,dispose:async()=>{}}))};
  beforeEach(()=>{
    record=null;cdr=null;source=null;revoked=false;keys.acquire.mockClear();identity.authenticate.mockClear();
    const store={transaction:async(_scope:any,work:any)=>work({read:async()=>record,insert:async(r:any)=>{record=r;},readCdr:async()=>cdr,insertCdr:async(r:any)=>{cdr=r;}})};
    core=new BatchLocalArtifactPipeline(owner,store,createBatchLocalSigner(keys),[scope.issuerRuc],{current:async()=>source},pki.cdrVerifier);
    api=new BatchArtifactApi(core);
  });
  beforeAll(async()=>{
    tls=b2bCertificates();pki=createGuideSidecarPki();
    const httpsOptions={ca:tls.ca,cert:tls.server,key:tls.key,requestCert:true,rejectUnauthorized:true,minVersion:'TLSv1.2' as const};
    ownerApp=await NestFactory.create(BatchArtifactModule.isolated({view:(...a:any[])=>api.view(...a as Parameters<BatchArtifactApi['view']>),
      content:(...a:any[])=>api.content(...a as Parameters<BatchArtifactApi['content']>)} as BatchArtifactApi,[fingerprint(tls.resource)]),{logger:false,bodyParser:false,httpsOptions});
    ownerApp.useBodyParser('json',{limit:32768,strict:true});await ownerApp.listen(0,'127.0.0.1');
    const transport=new B2bPrivateHttp(`https://127.0.0.1:${ownerApp.getHttpServer().address().port}`,{ca:tls.ca,cert:tls.resource,key:tls.key});
    app=await NestFactory.create(B2bBatchArtifactModule.isolated(new B2bBatchArtifacts(identity as any,new HttpB2bBatchArtifactOwner(transport)),[fingerprint(tls.edge)]),
      {logger:false,bodyParser:false,httpsOptions});app.useBodyParser('json',{limit:32768,strict:true});await app.listen(0,'127.0.0.1');port=app.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{await app?.close();await ownerApp?.close();});
  const base=`/b2b/v1/batches/${scope.batchId}/local-artifacts`;
  const query='?'+new URLSearchParams(Object.entries(scope).filter(([k])=>k!=='batchId').map(([k,v])=>[k,String(v)])).toString();
  function send(path:string,method='GET',body?:unknown,peer:'edge'|'other'='edge'){
    const bytes=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise<{status:number;body:any;bytes:Buffer;headers:any}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,
        headers:{Authorization:'Bearer '+access.token,'X-FactuEz-Actor-Kind':'SERVICE',...(bytes?{'Content-Type':'application/json','Content-Length':String(bytes.length)}:{})}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{const bytes=Buffer.concat(chunks);try{resolve({status:res.statusCode!,bytes,headers:res.headers,
          body:String(res.headers['content-type']).startsWith('application/json')?JSON.parse(bytes.toString()):null});}catch(e){reject(e);}});
      });req.on('error',reject);req.end(bytes);
    });
  }
  const prepare=()=>send(base,'POST',{scope});
  it('prepares once and returns exact original XML and ZIP, no certificate/key/owner receipt',async()=>{
    const first=await prepare();expect(first.status).toBe(200);expect(first.body.replayed).toBe(false);
    expect((await prepare()).body.replayed).toBe(true);expect(keys.acquire).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.body)).not.toMatch(/PRIVATE KEY|BEGIN CERTIFICATE|password|pkcs12|authorizationSha256|synthetic-batch-artifact-token/);
    for(const artifact of ['xml','zip']){const r=await send(base+'/'+artifact+query);expect(r.status).toBe(200);
      expect(r.bytes).toEqual(artifact==='xml'?Buffer.from(record.signedXml):record.zip);expect(r.headers['x-factuez-source']).toBe('LOCAL_EMULATOR');
      expect(r.headers['cache-control']).toBe('private, no-store');}
  });
  it('missing CDR is 404; only a captured cryptographically verified synthetic original is downloadable',async()=>{
    await prepare();expect((await send(base+'/cdr-zip'+query)).status).toBe(404);
    const xml=pki.signCdr(cdrXml(data.batch!.identifier,'RC',scope.issuerRuc));
    const zip=Buffer.from(zipSync({[`R-${scope.issuerRuc}-${data.batch!.identifier}.xml`]:Buffer.from(xml)},{level:0}));
    source={source:'LOCAL_EMULATOR',zip,receivedAt:'2026-10-03T19:00:00Z'};await core.captureCdr(scope,access);
    expect((await send(base+'/cdr-zip'+query)).bytes).toEqual(zip);expect((await send(base+'/cdr-xml'+query)).bytes).toEqual(Buffer.from(xml));
  });
  it('GET never allocates or signs an unprepared original',async()=>{expect((await send(base+query)).status).toBe(404);expect(keys.acquire).not.toHaveBeenCalled();});
  it('a different pinned-CA peer cannot reach authorization or keys',async()=>{expect((await send(base,'POST',{scope},'other')).status).toBe(403);expect(identity.authenticate).not.toHaveBeenCalled();expect(keys.acquire).not.toHaveBeenCalled();});
  it.each(['duplicate-query','foreign-branch','body-on-get','extra-field','bad-artifact'])('rejects %s and does not sign',async scenario=>{
    const r=scenario==='extra-field'?await send(base,'POST',{scope,accepted:true}):await send(base+(scenario==='bad-artifact'?'/p12':'')+
      (scenario==='duplicate-query'?query+'&environment=BETA':scenario==='foreign-branch'?query.replace(scope.branchId,supplementUuid(999)):query),'GET',scenario==='body-on-get'?{}:undefined);
    expect([400,404,503]).toContain(r.status);expect(keys.acquire).not.toHaveBeenCalled();
  });
  it('revocation denies previously prepared and cached originals',async()=>{await prepare();revoked=true;expect((await send(base+'/xml'+query)).status).toBe(503);expect(keys.acquire).toHaveBeenCalledTimes(1);});
});
