import 'reflect-metadata';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {request} from 'node:https';
import {B2bReads} from '../services/b2b-api-service/src/read';
import {B2bCommands} from '../services/b2b-api-service/src/commands';
import {createB2bPhase7Application} from '../services/b2b-api-service/src/phase7-application';
import {b2bCertificates,fingerprint} from './b2b-tls.fixture';
import {guideIssueFixture} from './helpers/guide-issue.fixture';

/** Tests the actual factory/parser/TLS and opt-in registration only. The owner
 * probes below are explicit doubles; separate tests exercise real owners/SQL/crypto. */
describe('phase7 candidate composition does not silently discard its write routes',()=>{
  let app:any,tls:ReturnType<typeof b2bCertificates>,port:number;
  const fixture=guideIssueFixture(),token='synthetic-phase7-composition';
  const identity={authenticate:vi.fn(async()=>({kind:'SERVICE' as const,clientId:'00000000-0000-4000-8000-000000000099',
    revision:1,subjectId:null,userAuthRevision:null,environment:'BETA' as const,bindings:[fixture.binding.draft.anchor],
    scopes:['b2b:context:read','b2b:documents:read','b2b:guides:read','b2b:guide-operations:read','b2b:guides:issue','b2b:batches:read','b2b:batches:write']}))};
  const absent={execute:async()=>{throw new Error('UNCONFIGURED_OWNER');},file:async()=>{throw new Error('UNCONFIGURED_OWNER');}};
  const probes={issue:vi.fn(async()=>{throw new Error('PROBE');}),read:vi.fn(async()=>{throw new Error('PROBE');}),
    ready:vi.fn(async()=>{throw new Error('PROBE');}),view:vi.fn(async()=>{throw new Error('PROBE');}),
    content:vi.fn(async()=>{throw new Error('PROBE');}),execute:vi.fn(async()=>{throw new Error('PROBE');})};
  beforeAll(async()=>{
    tls=b2bCertificates();
    app=await createB2bPhase7Application({read:new B2bReads(identity as any,absent,absent),commands:new B2bCommands(identity as any,absent),
      peers:[fingerprint(tls.edge)],tls:{ca:tls.ca,cert:tls.server,key:tls.key},
      phase7:{guideIssuance:probes,guideArtifacts:probes,carrier:probes,batches:probes,batchArtifacts:probes} as any});
    await app.listen(0,'127.0.0.1');port=app.getHttpServer().address().port;
  },30000);
  afterAll(async()=>{await app?.close();});
  function send(path:string,method='GET',body?:unknown,peer:'edge'|'other'='edge'){
    const data=body===undefined?undefined:Buffer.from(JSON.stringify(body));
    return new Promise<{status:number;body:any}>((resolve,reject)=>{
      const req=request({hostname:'127.0.0.1',port,path,method,ca:tls.ca,cert:tls[peer],key:tls.key,rejectUnauthorized:true,
        headers:{Authorization:'Bearer '+token,'X-FactuEz-Actor-Kind':'SERVICE',...(data?{'Content-Type':'application/json','Content-Length':String(data.length)}:{})}},res=>{
        const chunks:Buffer[]=[];res.on('data',c=>chunks.push(c));res.on('end',()=>{try{resolve({status:res.statusCode!,body:JSON.parse(Buffer.concat(chunks).toString())});}catch(e){reject(e);}});
      });req.on('error',reject);req.end(data);
    });
  }
  it('reports installed dedicated modules but preserves fiscal activation and generic reader coverage',async()=>{
    const r=await send('/b2b/v1/capabilities?environment=BETA');expect(r.status).toBe(200);expect(r.body.fiscalActivation).toBe(false);
    for(const id of ['guide-numbered-local','carrier-guide-numbered-local','guide-originals-local','batch-operations-local'])
      expect(r.body.features.find((v:any)=>v.id===id)?.state).toBe('ENABLED');
    expect(r.body.coverage.find((v:any)=>v.type==='31')?.state).toBe('SOURCE_NOT_SUPPORTED');
  });
  it.each([
    '/b2b/v1/guide-drafts/00000000-0000-4000-8000-000000000001/issuance',
    '/b2b/v1/guide-drafts/00000000-0000-4000-8000-000000000001/issuances/00000000-0000-4000-8000-000000000002/artifacts',
    '/b2b/v1/carrier-guide-drafts/00000000-0000-4000-8000-000000000001/ready',
    '/b2b/v1/carrier-guide-drafts/00000000-0000-4000-8000-000000000001/issuance',
    '/b2b/v1/batches/prepare','/b2b/v1/batches/recover',
  ])('registers and permits parser access to exactly the configured route %s',async path=>{
    const calls=probes.execute.mock.calls.length;
    const r=await send(path,'POST',{});expect(path.includes('/batches/')?[503]:[400,428]).toContain(r.status);expect(r.body.code).not.toBe('DRAFT_COMMANDS_ONLY');
    if(path.includes('/batches/'))expect(probes.execute.mock.calls.length).toBe(calls+1);
  });
  it('rejects unconfigured writes and an unpinned peer without calling owners',async()=>{
    const before=probes.issue.mock.calls.length;
    expect((await send('/b2b/v1/production/enable','POST',{})).body.code).toBe('DRAFT_COMMANDS_ONLY');
    expect((await send('/b2b/v1/batches/prepare','POST',{},'other')).status).toBe(403);
    expect(probes.issue.mock.calls.length).toBe(before);
  });
  it('does not enable dedicated features in the old read-only composition',async()=>{
    const c=await new B2bReads(identity as any,absent,absent).capabilities(token,'SERVICE',{environment:'BETA'});
    expect(c.features.find(v=>v.id==='carrier-guide-numbered-local')?.state).toBe('NOT_IMPLEMENTED');
  });
  it('requires every explicit owner instead of a permissive fallback',()=>{
    expect(()=>createB2bPhase7Application({phase7:{}} as any)).toThrow('EXPLICIT_PHASE7_OWNERS_REQUIRED');
  });
});
